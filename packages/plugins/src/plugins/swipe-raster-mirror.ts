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

/**
 * The mirror-control operations {@link SwipeRasterMirror} depends on. Injectable
 * so tests can exercise the diffing logic with fakes instead of a real
 * RasterControl + deck.gl overlay (the same seam SwipeCogMirrorDeps gives the
 * sibling COG mirror).
 */
export interface SwipeRasterMirrorDeps {
  createControl: (map: MapLibreMap) => Promise<RasterControl | null>;
  addRaster: (control: RasterControl, snapshot: SwipeRasterSnapshot) => Promise<string | null>;
  removeRaster: (control: RasterControl, mirrorId: string) => void;
  removeControl: (map: MapLibreMap, control: RasterControl) => void;
}

const DEFAULT_DEPS: SwipeRasterMirrorDeps = {
  createControl: async (map) => {
    const { RasterControl: RasterControlClass } = await import("maplibre-gl-raster");
    const control = new RasterControlClass({
      collapsed: true,
      engine: "maplibre-gl-raster",
      interleaved: true,
    });
    map.addControl(control);
    // Hide the panel rather than detaching it, matching hideRasterControl in
    // maplibre-raster.ts: the mirror only contributes its deck overlay, and
    // onRemove expects to unmount its own container.
    const container = control.getContainer();
    if (container) container.style.display = "none";
    return control;
  },
  addRaster: (control, snapshot) =>
    control.addRaster(snapshot.url, {
      name: snapshot.name,
      state: { ...snapshot.state, visible: true, opacity: snapshot.opacity },
      zoomTo: false,
    }),
  removeRaster: (control, mirrorId) => control.removeRaster(mirrorId),
  removeControl: (map, control) => map.removeControl(control),
};

/** Mirrors maplibre-gl-raster's deck.gl rasters onto the swipe comparison map. */
export class SwipeRasterMirror {
  private control: RasterControl | null = null;
  private controlPromise: Promise<RasterControl | null> | null = null;
  private applied = new Map<string, { mirrorId: string; fingerprint: string }>();
  private syncChain: Promise<void> = Promise.resolve();
  private destroyed = false;

  constructor(
    private readonly map: MapLibreMap,
    private readonly deps: SwipeRasterMirrorDeps = DEFAULT_DEPS,
  ) {}

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
        this.deps.removeControl(this.map, control);
      } catch (error) {
        console.debug("[GeoLibre] swipe raster mirror: removeControl", error);
      }
    }
  }

  private ensureControl(): Promise<RasterControl | null> {
    if (this.destroyed) return Promise.resolve(null);
    this.controlPromise ??= this.deps.createControl(this.map).then(
      (control) => {
        if (this.destroyed) return null;
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
        for (const { mirrorId } of this.applied.values()) {
          this.deps.removeRaster(this.control, mirrorId);
        }
        this.applied.clear();
      }
      return;
    }

    const control = await this.ensureControl();
    if (!control || this.destroyed) return;
    const desiredIds = new Set(desired.map(({ id }) => id));
    for (const [id, entry] of [...this.applied]) {
      if (!desiredIds.has(id)) {
        this.deps.removeRaster(control, entry.mirrorId);
        this.applied.delete(id);
      }
    }

    for (const raster of desired) {
      if (this.destroyed) return;
      const fingerprint = JSON.stringify([raster.url, raster.state, raster.opacity]);
      const existing = this.applied.get(raster.id);
      if (existing?.fingerprint === fingerprint) continue;
      if (existing) {
        // Drop the entry with the mirror it names: leaving it would let a later
        // sync with the same fingerprint skip a raster whose re-add failed
        // below, so the comparison map would stay missing it.
        this.deps.removeRaster(control, existing.mirrorId);
        this.applied.delete(raster.id);
      }
      try {
        const mirrorId = await this.deps.addRaster(control, raster);
        if (mirrorId && !this.destroyed) this.applied.set(raster.id, { mirrorId, fingerprint });
      } catch (error) {
        console.debug("[GeoLibre] swipe raster mirror: addRaster", error);
      }
    }
  }
}
