import type { Map as MapLibreMap } from "maplibre-gl";
import type { RasterControl, RasterLayerState } from "maplibre-gl-raster";

export interface SwipeRasterSnapshot {
  id: string;
  name: string;
  url: string;
  visible: boolean;
  opacity: number;
  state: Partial<RasterLayerState>;
}

/** Mirrors maplibre-gl-raster's deck.gl rasters onto the swipe comparison map. */
export class SwipeRasterMirror {
  private control: RasterControl | null = null;
  private controlPromise: Promise<RasterControl | null> | null = null;
  private applied = new Map<string, { mirrorId: string; fingerprint: string }>();
  private syncChain: Promise<void> = Promise.resolve();
  private destroyed = false;

  constructor(private readonly map: MapLibreMap) {}

  getMap(): MapLibreMap {
    return this.map;
  }

  sync(desired: SwipeRasterSnapshot[]): Promise<void> {
    this.syncChain = this.syncChain.catch(() => {}).then(() => this.reconcile(desired));
    return this.syncChain;
  }

  destroy(): void {
    this.destroyed = true;
    this.applied.clear();
    const control = this.control;
    this.control = null;
    this.controlPromise = null;
    if (control) {
      try {
        this.map.removeControl(control);
      } catch (error) {
        console.debug("[GeoLibre] swipe raster mirror: removeControl", error);
      }
    }
  }

  private ensureControl(): Promise<RasterControl | null> {
    if (this.destroyed) return Promise.resolve(null);
    this.controlPromise ??= import("maplibre-gl-raster").then(
      ({ RasterControl }) => {
        if (this.destroyed) return null;
        const control = new RasterControl({
          collapsed: true,
          engine: "maplibre-gl-raster",
          interleaved: true,
        });
        this.map.addControl(control);
        control.getContainer()?.remove();
        this.control = control;
        return control;
      },
      (error: unknown) => {
        this.controlPromise = null;
        console.warn("[GeoLibre] swipe raster mirror: control load", error);
        return null;
      },
    );
    return this.controlPromise;
  }

  private async reconcile(desired: SwipeRasterSnapshot[]): Promise<void> {
    if (this.destroyed) return;
    if (desired.length === 0) {
      if (this.control) {
        for (const { mirrorId } of this.applied.values()) this.control.removeRaster(mirrorId);
        this.applied.clear();
      }
      return;
    }

    const control = await this.ensureControl();
    if (!control || this.destroyed) return;
    const desiredIds = new Set(desired.map(({ id }) => id));
    for (const [id, entry] of [...this.applied]) {
      if (!desiredIds.has(id)) {
        control.removeRaster(entry.mirrorId);
        this.applied.delete(id);
      }
    }

    for (const raster of desired) {
      if (this.destroyed) return;
      const fingerprint = JSON.stringify([raster.url, raster.state, raster.opacity]);
      const existing = this.applied.get(raster.id);
      if (existing?.fingerprint === fingerprint) continue;
      if (existing) control.removeRaster(existing.mirrorId);
      try {
        const mirrorId = await control.addRaster(raster.url, {
          name: raster.name,
          state: { ...raster.state, visible: true, opacity: raster.opacity },
          zoomTo: false,
        });
        if (!this.destroyed) this.applied.set(raster.id, { mirrorId, fingerprint });
      } catch (error) {
        console.debug("[GeoLibre] swipe raster mirror: addRaster", error);
      }
    }
  }
}
