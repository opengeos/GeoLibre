// ArcgisEngine layer: terrain, elevation and COG DEM terrain.
// The ArcgisEngine layer chain is documented in arcgis-engine.ts.

import { registerCogDemSource, type CogDemSourceRegistration } from "./cog-dem-source";
import { createCogElevationLayer } from "./arcgis-cog-terrain";
import type { ArcgisElevationLayer, ArcgisSceneSdk } from "./arcgis-sdk";
import { ArcgisEngineBase } from "./arcgis-engine-base";

/**
 * Esri's global terrain, the same service the SDK's `"world-elevation"` ground
 * resolves to. Publicly readable: terrain needs no API key.
 */
export const ARCGIS_WORLD_ELEVATION_URL =
  "https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer";

/**
 * The SDK's tiled elevation layer, optionally exaggerated. The SDK has no
 * exaggeration setting; its documented route is a `BaseElevationLayer`
 * subclass that scales each tile's heights, built once per SDK.
 */
const exaggeratedElevationClasses = new WeakMap<
  ArcgisSceneSdk,
  new (properties?: Record<string, unknown>) => ArcgisElevationLayer
>();

function createElevationLayer(scene: ArcgisSceneSdk, exaggeration: number): ArcgisElevationLayer {
  if (exaggeration === 1)
    return new scene.ElevationLayer({ url: ARCGIS_WORLD_ELEVATION_URL, listMode: "hide" });
  let Exaggerated = exaggeratedElevationClasses.get(scene);
  if (!Exaggerated) {
    type Self = ArcgisElevationLayer & {
      exaggeration: number;
      source: ArcgisElevationLayer;
      addResolvingPromise(promise: Promise<unknown>): void;
      fullExtent: unknown;
    };
    Exaggerated = scene.BaseElevationLayer.createSubclass({
      properties: { exaggeration: 1 },
      load(this: Self) {
        this.source = new scene.ElevationLayer({ url: ARCGIS_WORLD_ELEVATION_URL });
        this.addResolvingPromise(
          this.source.load().then(() => {
            this.tileInfo = this.source.tileInfo;
            this.spatialReference = this.source.spatialReference;
            this.fullExtent = this.source.fullExtent;
          }),
        );
      },
      fetchTile(this: Self, level: number, row: number, col: number, options?: unknown) {
        return this.source.fetchTile(level, row, col, options).then((data) => {
          const factor = this.exaggeration;
          for (let i = 0; i < data.values.length; i++) data.values[i] *= factor;
          return data;
        });
      },
    });
    exaggeratedElevationClasses.set(scene, Exaggerated);
  }
  return new Exaggerated({ exaggeration, listMode: "hide" });
}

/**
 * ArcgisEngine layer: scene terrain, elevation layers, exaggeration and COG
 * DEM terrain.
 */
export abstract class ArcgisEngineTerrain extends ArcgisEngineBase {
  private terrain = false;

  private exaggeration = 1;

  protected cogTerrain: CogDemSourceRegistration | null = null;

  private cogTerrainUrl: string | null = null;

  protected cogTerrainRequest = 0;

  private elevation: ArcgisElevationLayer | null = null;

  setTerrainLabel(): void {}

  // ------------------------------------------------------------------ terrain

  isTerrainEnabled(): boolean {
    return this.terrain;
  }

  /**
   * Drape the scene over Esri's world elevation. On a MapView the choice is
   * only recorded: the canvas swaps in a SceneView when the project's terrain
   * preference changes, and the new engine applies it.
   */
  setTerrainEnabled(enabled: boolean): boolean {
    if (!this.view) return false;
    this.terrain = enabled;
    // Preferences re-apply on every change; only a real transition rebuilds.
    if (enabled && this.canDrape() !== (this.elevation !== null)) this.applyElevation();
    else if (!enabled && this.elevation) this.removeElevation();
    return true;
  }

  getTerrainExaggeration(): number {
    return this.exaggeration;
  }

  setTerrainExaggeration(exaggeration: number): void {
    const next = Math.max(0, Math.min(10, exaggeration));
    if (next === this.exaggeration) return;
    this.exaggeration = next;
    // Tiles already fetched carry the old heights; a new layer refetches them.
    this.applyElevation();
  }

  private canDrape(): boolean {
    return this.view?.type === "3d" && Boolean(this.map?.ground && this.options.scene);
  }

  private applyElevation(): void {
    this.removeElevation();
    const ground = this.map?.ground;
    const scene = this.options.scene;
    if (!this.terrain || !this.canDrape() || !ground || !scene) return;
    this.elevation = this.cogTerrain
      ? createCogElevationLayer(scene, this.cogTerrain, this.exaggeration)
      : createElevationLayer(scene, this.exaggeration);
    ground.layers.add(this.elevation);
  }

  protected removeElevation(): void {
    const layer = this.elevation;
    if (!layer) return;
    this.elevation = null;
    const ground = this.map?.ground;
    if (ground?.layers.includes(layer)) ground.layers.remove(layer);
    // The exaggerated subclass owns the layer it reads its tiles from, and
    // destroying the outer layer does not destroy it.
    (layer as { source?: ArcgisElevationLayer }).source?.destroy();
    layer.destroy();
  }

  getTerrainCogSource(): string | null {
    return this.cogTerrainUrl;
  }

  hasCustomTerrainSource(): boolean {
    return this.cogTerrain !== null;
  }

  private openCogDem = registerCogDemSource;

  async setTerrainCogSource(source: string | Blob | null, band = 1): Promise<boolean> {
    if (!this.view) return false;
    const normalized = typeof source === "string" ? source.trim() || null : source;
    const request = ++this.cogTerrainRequest;
    let registration: CogDemSourceRegistration | null;
    try {
      registration = normalized ? await this.openCogDem(normalized, band) : null;
    } catch (error) {
      if (request !== this.cogTerrainRequest || !this.view) return false;
      throw error;
    }
    if (request !== this.cogTerrainRequest || !this.view) {
      registration?.dispose();
      return false;
    }
    const previous = this.cogTerrain;
    this.cogTerrain = registration;
    this.cogTerrainUrl = typeof normalized === "string" ? normalized : null;
    this.applyElevation();
    previous?.dispose();
    this.options.onTerrainSourceChange?.(normalized, band);
    return true;
  }
}
