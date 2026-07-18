import type { Map as MapLibreMap } from "maplibre-gl";
import type { CogLayerControl } from "maplibre-gl-components";
import {
  clearMirrorCogLayers,
  createSwipeCogMirrorControl,
  mirrorAddCogLayer,
  mirrorRemoveCogLayer,
  mirrorSetCogOpacity,
  type SwipeCogRasterSnapshot,
} from "./maplibre-components";

// The non-opacity visualization of a mirrored raster; a change here needs a
// reload (re-add), whereas an opacity-only change is applied in place.
function structuralFingerprint(raster: SwipeCogRasterSnapshot): string {
  return JSON.stringify([
    raster.url,
    raster.bands,
    raster.colormap,
    raster.rescaleMin,
    raster.rescaleMax,
    raster.nodata,
  ]);
}

interface MirroredEntry {
  /** The mirror control's own layer id (for opacity/remove). */
  mirrorId: string;
  /** Last-applied structural fingerprint (reload trigger). */
  structFp: string;
  /** Last-applied opacity. */
  opacity: number;
}

/**
 * The mirror-control operations {@link SwipeCogMirror} depends on. Injectable so
 * tests can exercise the diffing/serialization logic with fakes instead of a
 * real CogLayerControl + deck.gl overlay.
 */
export interface SwipeCogMirrorDeps {
  createControl: (map: MapLibreMap) => Promise<CogLayerControl | null>;
  addLayer: (control: CogLayerControl, snapshot: SwipeCogRasterSnapshot) => Promise<string | null>;
  setOpacity: (control: CogLayerControl, mirrorLayerId: string, opacity: number) => void;
  removeLayer: (control: CogLayerControl, mirrorLayerId: string) => void;
  clearLayers: (control: CogLayerControl) => void;
  removeControl: (map: MapLibreMap, control: CogLayerControl) => void;
}

const DEFAULT_DEPS: SwipeCogMirrorDeps = {
  createControl: (map) => createSwipeCogMirrorControl(map),
  addLayer: (control, snapshot) => mirrorAddCogLayer(control, snapshot),
  setOpacity: (control, id, opacity) => mirrorSetCogOpacity(control, id, opacity),
  removeLayer: (control, id) => mirrorRemoveCogLayer(control, id),
  clearLayers: (control) => clearMirrorCogLayers(control),
  removeControl: (map, control) => map.removeControl(control),
};

/**
 * Renders a copy of GeoLibre's deck.gl COG rasters onto the Layer Swipe
 * comparison map, so a raster assigned to the right (or both) side of the swipe
 * shows there. The comparison map's canvas is already clipped to the swipe
 * region by the swipe control, so the mirror inherits that clip for free and
 * only decides *which* rasters to render.
 *
 * The main map keeps rendering its rasters through the normal CogLayerControl;
 * the swipe provider hides right-only rasters there. This mirror is an
 * independent, hidden CogLayerControl bound to the comparison map, so it never
 * touches the main deck overlay or the app store. It diffs per raster id so an
 * opacity nudge (or an edit to one of several mirrored rasters) does not tear
 * down and reload the others.
 */
export class SwipeCogMirror {
  private map: MapLibreMap;
  private deps: SwipeCogMirrorDeps;
  private control: CogLayerControl | null = null;
  private controlPromise: Promise<CogLayerControl | null> | null = null;
  private destroyed = false;
  // The mirrored rasters, keyed by store raster id.
  private applied = new Map<string, MirroredEntry>();
  // Serialises overlapping sync() calls: adds share the control's form state, so
  // two syncs must not interleave their configure+addLayer.
  private syncChain: Promise<void> = Promise.resolve();

  constructor(map: MapLibreMap, deps: SwipeCogMirrorDeps = DEFAULT_DEPS) {
    this.map = map;
    this.deps = deps;
  }

  /** The comparison map this mirror renders onto (identity check for reuse). */
  getMap(): MapLibreMap {
    return this.map;
  }

  private ensureControl(): Promise<CogLayerControl | null> {
    if (this.destroyed) return Promise.resolve(null);
    this.controlPromise ??= this.deps.createControl(this.map).then(
      (control) => {
        if (this.destroyed) {
          if (control) this.tryRemoveControl(control);
          return null;
        }
        this.control = control;
        return control;
      },
      (error: unknown) => {
        this.controlPromise = null;
        console.warn("[GeoLibre] swipe COG mirror: control load", error);
        return null;
      },
    );
    return this.controlPromise;
  }

  /**
   * Reconciles the comparison map's mirrored rasters to `desired`: adds new
   * ones, drops removed ones, reloads a raster whose visualization changed, and
   * applies an opacity-only change in place (no reload / flash).
   *
   * @param desired - The rasters that should render on the comparison side.
   */
  sync(desired: SwipeCogRasterSnapshot[]): Promise<void> {
    // Serialise: chain after any in-flight sync so their sequential adds (which
    // share the control's form state) never interleave.
    this.syncChain = this.syncChain.catch(() => {}).then(() => this.reconcile(desired));
    return this.syncChain;
  }

  private async reconcile(desired: SwipeCogRasterSnapshot[]): Promise<void> {
    if (this.destroyed) return;

    // Nothing to mirror: don't mount a real CogLayerControl/deck overlay on the
    // comparison map just to render zero layers (the common no-COG case).
    if (desired.length === 0) {
      if (this.control && this.applied.size > 0) {
        this.deps.clearLayers(this.control);
        this.applied.clear();
      }
      return;
    }

    const control = await this.ensureControl();
    if (!control || this.destroyed) return;

    const desiredIds = new Set(desired.map((raster) => raster.id));
    for (const [id, entry] of [...this.applied]) {
      if (!desiredIds.has(id)) {
        this.deps.removeLayer(control, entry.mirrorId);
        this.applied.delete(id);
      }
    }

    for (const raster of desired) {
      if (this.destroyed) return;
      const structFp = structuralFingerprint(raster);
      const existing = this.applied.get(raster.id);

      if (existing && existing.structFp === structFp) {
        // Same data + visualization; only opacity may have changed.
        if (existing.opacity !== raster.opacity) {
          this.deps.setOpacity(control, existing.mirrorId, raster.opacity);
          existing.opacity = raster.opacity;
        }
        continue;
      }

      // New raster, or a structural change that needs a reload.
      if (existing) {
        this.deps.removeLayer(control, existing.mirrorId);
        this.applied.delete(raster.id);
      }
      try {
        const mirrorId = await this.deps.addLayer(control, raster);
        if (mirrorId && !this.destroyed) {
          this.applied.set(raster.id, {
            mirrorId,
            structFp,
            opacity: raster.opacity,
          });
        }
      } catch (error) {
        console.debug("[GeoLibre] swipe COG mirror: addLayer", error);
      }
    }
  }

  /** Removes the mirror control from the comparison map. */
  destroy(): void {
    this.destroyed = true;
    this.applied.clear();
    const control = this.control;
    this.control = null;
    this.controlPromise = null;
    if (control) this.tryRemoveControl(control);
  }

  private tryRemoveControl(control: CogLayerControl): void {
    try {
      this.deps.removeControl(this.map, control);
    } catch (error) {
      // The comparison map may already be gone (removed by the swipe control).
      console.debug("[GeoLibre] swipe COG mirror: removeControl", error);
    }
  }
}
