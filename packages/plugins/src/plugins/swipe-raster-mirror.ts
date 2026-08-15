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
  setOpacity: (control: RasterControl, mirrorId: string, opacity: number) => void;
  removeRaster: (control: RasterControl, mirrorId: string) => void;
  removeControl: (map: MapLibreMap, control: RasterControl) => void;
}

// The non-opacity part of a mirrored raster; a change here needs a reload
// (re-add), whereas an opacity-only change is applied in place. The store keeps
// opacity on the layer, not in metadata.rasterState (see serializableRasterState
// in raster-layer-sync.ts), so the two never overlap.
function structuralFingerprint(raster: SwipeRasterSnapshot): string {
  return JSON.stringify([raster.url, raster.state]);
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
  setOpacity: (control, mirrorId, opacity) => control.setRasterState(mirrorId, { opacity }),
  removeRaster: (control, mirrorId) => control.removeRaster(mirrorId),
  removeControl: (map, control) => map.removeControl(control),
};

/** Mirrors maplibre-gl-raster's deck.gl rasters onto the swipe comparison map. */
export class SwipeRasterMirror {
  private control: RasterControl | null = null;
  private controlPromise: Promise<RasterControl | null> | null = null;
  private applied = new Map<string, { mirrorId: string; fingerprint: string; opacity: number }>();
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
    if (control) this.tryRemoveControl(control);
  }

  private tryRemoveControl(control: RasterControl): void {
    try {
      this.deps.removeControl(this.map, control);
    } catch (error) {
      // The comparison map may already be gone (removed by the swipe control).
      console.debug("[GeoLibre] swipe raster mirror: removeControl", error);
    }
  }

  private ensureControl(): Promise<RasterControl | null> {
    if (this.destroyed) return Promise.resolve(null);
    this.controlPromise ??= this.deps.createControl(this.map).then(
      (control) => {
        if (this.destroyed) {
          // Mounted after destroy(): that call saw no control to remove, so
          // this one has to unmount itself or its overlay stays on the map.
          if (control) this.tryRemoveControl(control);
          return null;
        }
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
      const fingerprint = structuralFingerprint(raster);
      const existing = this.applied.get(raster.id);
      if (existing?.fingerprint === fingerprint) {
        // Same data and visualization; only opacity may have changed, and that
        // is a live patch rather than a reload (no re-fetch, no flash).
        if (existing.opacity !== raster.opacity) {
          this.deps.setOpacity(control, existing.mirrorId, raster.opacity);
          existing.opacity = raster.opacity;
        }
        continue;
      }
      if (existing) {
        // Drop the entry with the mirror it names: leaving it would let a later
        // sync with the same fingerprint skip a raster whose re-add failed
        // below, so the comparison map would stay missing it.
        this.deps.removeRaster(control, existing.mirrorId);
        this.applied.delete(raster.id);
      }
      try {
        const mirrorId = await this.deps.addRaster(control, raster);
        if (mirrorId && !this.destroyed) {
          this.applied.set(raster.id, { mirrorId, fingerprint, opacity: raster.opacity });
        }
      } catch (error) {
        console.debug("[GeoLibre] swipe raster mirror: addRaster", error);
      }
    }
  }
}
