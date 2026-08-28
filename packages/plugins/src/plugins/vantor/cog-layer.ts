import type { Map as MaplibreMap } from "maplibre-gl";
import type { LayerManager } from "maplibre-gl-raster";
import type { StacItem } from "./types";
import { isHttpsUrl } from "./utils";

/** The maplibre-gl-raster module surface this layer needs. */
type RasterModule = typeof import("maplibre-gl-raster");

export type CogRenderEngine = "maplibre-gl-raster" | "cog-tiler-wasm" | "titiler";

/**
 * Renders a COG through a host (e.g. GeoLibre's `app.addCogLayer`) instead of
 * the bundled deck.gl pipeline, returning the host layer id. When supplied, the
 * host owns the COG (it appears in the host's Layers panel and the host manages
 * projection/visibility/removal).
 */
export type CogAdder = (
  name: string,
  url: string,
  options?: {
    nodata?: number;
    opacity?: number;
    engine?: CogRenderEngine | "auto";
  },
) => Promise<string>;

export type CogRenderEngineSetter = (engine: CogRenderEngine) => void | Promise<void>;

/**
 * deck.gl's tiled raster rendering (used for COGs) does not support MapLibre's
 * globe projection, so force mercator when a COG is displayed. Mirrors
 * GeoLibre's built-in raster behavior. An idle guard re-applies it because the
 * projection can be reset while a style is still settling.
 */
function ensureMercatorProjection(map: MaplibreMap): void {
  const m = map as unknown as {
    getProjection?: () => { type?: string } | undefined;
    setProjection?: (projection: { type: string }) => void;
    once?: (event: string, listener: () => void) => void;
  };
  const setMercator = () => {
    try {
      if (m.getProjection?.()?.type === "mercator") return;
      m.setProjection?.({ type: "mercator" });
    } catch {
      // MapLibre can reject projection changes while the style is settling;
      // the idle guard retries.
    }
  };
  setMercator();
  m.once?.("idle", setMercator);
}

/**
 * Resolves the maplibre-gl-raster module. Defaults to a dynamic import, but a
 * host (e.g. GeoLibre via `app.getMaplibreGlRaster()`) can supply its own
 * already-loaded instance so the COG pipeline renders on the host's single
 * deck.gl/luma.gl instead of a bundled second copy.
 */
export type RasterLoader = () => Promise<RasterModule>;

export type CogLayerEvent = "layeradd" | "layerremove";

export interface CogLayerEventDetail {
  layerId: string;
  url?: string;
  name?: string;
}

type CogLayerEventHandler = (detail: CogLayerEventDetail) => void;

interface CogLayerEntry {
  itemId: string;
  cogUrl: string;
  name: string;
  visible: boolean;
  opacity: number;
}

/**
 * Renders Vantor COGs on the map by delegating to maplibre-gl-raster's headless
 * {@link LayerManager} (a deck.gl GPU pipeline on a shared MapboxOverlay).
 *
 * maplibre-gl-raster reads GeoTIFFs with `@developmentseed/geotiff`, which
 * groups each RGB overview with its associated mask IFD and composites the mask
 * into the alpha channel. This both fixes the previous crash on COGs that carry
 * an internal GDAL mask ("Unexpected number of channels in raster data: 1",
 * caused by a mask IFD being mistaken for a 1-band overview) and renders nodata
 * regions transparently.
 *
 * maplibre-gl-raster and its deck.gl / luma.gl peers are optional and imported
 * lazily, so this module only pulls them in when a COG is actually visualized.
 */
export class CogLayer {
  private map: MaplibreMap;
  private manager: LayerManager | null = null;
  private managerPromise: Promise<LayerManager> | null = null;
  private activeLayers: CogLayerEntry[] = [];
  private eventHandlers: Map<CogLayerEvent, Set<CogLayerEventHandler>> = new Map();
  private rasterLoader: RasterLoader;
  private cogAdder?: CogAdder;
  private cogRenderEngineSetter?: CogRenderEngineSetter;
  private renderEngine: CogRenderEngine;

  constructor(
    map: MaplibreMap,
    rasterLoader?: RasterLoader,
    cogAdder?: CogAdder,
    renderEngine: CogRenderEngine = "maplibre-gl-raster",
    cogRenderEngineSetter?: CogRenderEngineSetter,
  ) {
    this.map = map;
    this.rasterLoader = rasterLoader ?? (() => import("maplibre-gl-raster"));
    this.cogAdder = cogAdder;
    this.renderEngine = renderEngine;
    this.cogRenderEngineSetter = cogRenderEngineSetter;
  }

  async setRenderEngine(engine: CogRenderEngine): Promise<void> {
    this.renderEngine = engine;
    this.manager?.setEngine(engine);
    if (this.cogAdder && this.activeLayers.length > 0) {
      await this.cogRenderEngineSetter?.(engine);
    }
  }

  getRenderEngine(): CogRenderEngine {
    return this.renderEngine;
  }

  on(event: CogLayerEvent, handler: CogLayerEventHandler): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);
  }

  off(event: CogLayerEvent, handler: CogLayerEventHandler): void {
    this.eventHandlers.get(event)?.delete(handler);
  }

  private emit(event: CogLayerEvent, detail: CogLayerEventDetail): void {
    this.eventHandlers.get(event)?.forEach((handler) => handler(detail));
  }

  private ensureManager(): Promise<LayerManager> {
    if (!this.managerPromise) {
      this.managerPromise = (async () => {
        try {
          const { LayerManager } = await this.rasterLoader();
          // maplibre-gl-raster's map type may come from a different maplibre-gl
          // version than the host app's; the surface we use is identical.
          const manager = new LayerManager(this.map as never, {
            interleaved: true,
          });
          this.manager = manager;
          return manager;
        } catch (e) {
          this.managerPromise = null;
          throw new Error(
            "Failed to initialize COG renderer. Ensure maplibre-gl-raster (and its " +
              "@deck.gl/* and @luma.gl/* peers) are installed. " +
              String(e),
          );
        }
      })();
    }
    return this.managerPromise;
  }

  async addCogLayer(item: StacItem): Promise<void> {
    const cogUrl = this.findCogUrl(item);
    if (!cogUrl) {
      throw new Error(`No COG URL found for item ${item.id}`);
    }

    // Skip if already added
    if (this.activeLayers.some((l) => l.itemId === item.id)) return;

    const name = item.id;

    // Host path (e.g. GeoLibre): the COG becomes a native host-managed layer
    // that shows in the host's Layers panel; the host owns projection/removal.
    // Forward the user's renderer choice to the host. This setting is
    // control-wide in GeoLibre, so changing it may re-render existing COGs.
    if (this.cogAdder) {
      await this.cogAdder(name, cogUrl, {
        nodata: 0,
        engine: this.renderEngine,
      });
      this.activeLayers.push({ itemId: item.id, cogUrl, name, visible: true, opacity: 1 });
      this.emit("layeradd", { layerId: item.id, url: cogUrl, name });
      return;
    }

    // Standalone path: render through the bundled maplibre-gl-raster pipeline.
    const manager = await this.ensureManager();
    manager.setEngine(this.renderEngine);
    // Resolves once the GeoTIFF header has loaded; rejects on load failure.
    await manager.addRaster(cogUrl, {
      id: item.id,
      name,
      zoomTo: false,
      state: { nodata: 0 },
    });

    this.activeLayers.push({ itemId: item.id, cogUrl, name, visible: true, opacity: 1 });
    // Only the deck.gl GPU engine requires mercator; the native WASM/TiTiler
    // engines support MapLibre's globe projection.
    if (this.renderEngine === "maplibre-gl-raster") ensureMercatorProjection(this.map);
    this.emit("layeradd", { layerId: item.id, url: cogUrl, name });
  }

  async removeCogLayer(itemId: string): Promise<void> {
    const existed = this.activeLayers.some((l) => l.itemId === itemId);
    this.activeLayers = this.activeLayers.filter((l) => l.itemId !== itemId);
    this.manager?.removeRaster(itemId);

    if (existed) {
      this.emit("layerremove", { layerId: itemId });
    }
  }

  async removeAll(): Promise<void> {
    const ids = this.activeLayers.map((l) => l.itemId);
    this.activeLayers = [];
    for (const id of ids) {
      this.manager?.removeRaster(id);
    }
    for (const id of ids) {
      this.emit("layerremove", { layerId: id });
    }
  }

  setLayerVisibility(layerId: string, visible: boolean): void {
    const entry = this.activeLayers.find((l) => l.itemId === layerId);
    if (!entry) return;
    entry.visible = visible;
    this.manager?.setVisible(layerId, visible);
  }

  setLayerOpacity(layerId: string, opacity: number): void {
    const entry = this.activeLayers.find((l) => l.itemId === layerId);
    if (!entry) return;
    entry.opacity = Math.max(0, Math.min(1, opacity));
    this.manager?.setState(layerId, { opacity: entry.opacity });
  }

  getLayerEntry(layerId: string): { name: string; visible: boolean; opacity: number } | null {
    const entry = this.activeLayers.find((l) => l.itemId === layerId);
    if (!entry) return null;
    return { name: entry.name, visible: entry.visible, opacity: entry.opacity };
  }

  private findCogUrl(item: StacItem): string | null {
    const assets = item.assets || {};
    if (assets.visual && isHttpsUrl(assets.visual.href)) return assets.visual.href;
    for (const asset of Object.values(assets)) {
      const t = (asset.type || "").toLowerCase();
      if ((t.includes("geotiff") || t.includes("tiff")) && isHttpsUrl(asset.href)) {
        return asset.href;
      }
    }
    return null;
  }

  getActiveLayerIds(): string[] {
    return this.activeLayers.map((l) => l.itemId);
  }

  remove(): void {
    const ids = this.activeLayers.map((l) => l.itemId);
    this.manager?.destroy();
    this.manager = null;
    this.managerPromise = null;
    this.activeLayers = [];
    for (const id of ids) {
      this.emit("layerremove", { layerId: id });
    }
  }
}
