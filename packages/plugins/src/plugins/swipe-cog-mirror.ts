import type { Map as MapLibreMap } from "maplibre-gl";
import type { CogLayerControl } from "maplibre-gl-components";
import {
  clearMirrorCogLayers,
  createSwipeCogMirrorControl,
  mirrorAddCogLayer,
  type SwipeCogRasterSnapshot,
} from "./maplibre-components";

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
 * touches the main deck overlay or the app store.
 */
export class SwipeCogMirror {
  private map: MapLibreMap;
  private control: CogLayerControl | null = null;
  private controlPromise: Promise<CogLayerControl | null> | null = null;
  private destroyed = false;
  // The last-rendered set, so redundant syncs (e.g. on slider drag) are skipped
  // and a stale in-flight sync can detect it was superseded.
  private fingerprint = "";

  constructor(map: MapLibreMap) {
    this.map = map;
  }

  /** The comparison map this mirror renders onto (identity check for reuse). */
  getMap(): MapLibreMap {
    return this.map;
  }

  private ensureControl(): Promise<CogLayerControl | null> {
    if (this.destroyed) return Promise.resolve(null);
    this.controlPromise ??= createSwipeCogMirrorControl(this.map).then(
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
   * Renders exactly `desired` on the comparison map. Rebuilds the mirror's
   * layers whenever the set (or any raster's visualization) changes, matching
   * the main map. A no-op when nothing changed.
   *
   * @param desired - The rasters that should render on the comparison side.
   */
  async sync(desired: SwipeCogRasterSnapshot[]): Promise<void> {
    const fingerprint = JSON.stringify(
      desired.map((raster) => [
        raster.id,
        raster.url,
        raster.opacity,
        raster.bands,
        raster.colormap,
        raster.rescaleMin,
        raster.rescaleMax,
        raster.nodata,
      ]),
    );
    if (fingerprint === this.fingerprint) return;
    this.fingerprint = fingerprint;

    const control = await this.ensureControl();
    if (!control || this.destroyed) return;

    clearMirrorCogLayers(control);
    for (const raster of desired) {
      // Bail if a newer sync superseded this one (or the mirror was destroyed)
      // while awaiting the previous addLayer.
      if (this.destroyed || this.fingerprint !== fingerprint) return;
      try {
        await mirrorAddCogLayer(control, raster);
      } catch (error) {
        console.debug("[GeoLibre] swipe COG mirror: addLayer", error);
      }
    }
  }

  /** Removes the mirror control from the comparison map. */
  destroy(): void {
    this.destroyed = true;
    this.fingerprint = "";
    const control = this.control;
    this.control = null;
    this.controlPromise = null;
    if (control) this.tryRemoveControl(control);
  }

  private tryRemoveControl(control: CogLayerControl): void {
    try {
      this.map.removeControl(control);
    } catch (error) {
      // The comparison map may already be gone (removed by the swipe control).
      console.debug("[GeoLibre] swipe COG mirror: removeControl", error);
    }
  }
}
