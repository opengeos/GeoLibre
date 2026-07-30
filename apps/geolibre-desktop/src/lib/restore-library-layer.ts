// Re-adding a Layer Library entry (issue #1520) puts the saved layer record
// back in the store, which is the whole job for a layer GeoLibre renders itself
// (`MapController.syncLayers` reconciles it like any other). A **control-painted**
// layer is different: the plugin that owns it creates the real MapLibre/deck.gl
// output, and it only does so when its restore pass runs — which normally
// happens once per project load. Without that pass the re-added layer shows in
// the Layers panel and draws nothing.
//
// So a library add re-runs the one restore pass that owns the layer's kind.
// Those functions are store-driven and idempotent (they skip layers their
// control already has and drop control layers the store no longer lists), which
// is exactly what the project-load path relies on, so invoking one for a single
// new layer is safe.

import { isExternalNativeLayerRecord, type GeoLibreLayer } from "@geolibre/core";
import {
  RASTER_SOURCE_KIND,
  restoreLidarLayers,
  restorePlanetaryComputerLayers,
  restoreRasterLayers,
  restoreThreeDTilesLayers,
  restoreVectorLayers,
  VECTOR_SOURCE_KIND,
  type GeoLibreAppAPI,
} from "@geolibre/plugins";

/**
 * `metadata.sourceKind` values of the control-painted layer kinds whose restore
 * pass we can re-run, mapped to that pass. The string keys mirror the values
 * each plugin writes onto its store layers; the two that export a constant use
 * it. A layer whose kind is absent here is left to the store sync, which is
 * correct for every GeoLibre-rendered layer — and for a control-painted kind not
 * listed, it means the layer re-adds unrendered, which is why "Save to My Data"
 * is offered only for the kinds this map (or a plain store add) covers.
 */
const RESTORE_BY_SOURCE_KIND: Record<string, (app: GeoLibreAppAPI) => void | Promise<void>> = {
  [VECTOR_SOURCE_KIND]: restoreVectorLayers,
  [RASTER_SOURCE_KIND]: restoreRasterLayers,
  "planetary-computer-raster": restorePlanetaryComputerLayers,
  "3d-tiles-url": restoreThreeDTilesLayers,
  "lidar-url": restoreLidarLayers,
};

/**
 * Run the plugin restore pass that renders `layer`, if it is control-painted.
 * A no-op for a layer GeoLibre renders itself.
 *
 * @param layer - The layer just added from the Layer Library.
 * @param app - The plugin app API (from `createAppAPI`).
 * @returns Whether a restore pass was dispatched.
 */
export function restoreLibraryLayer(layer: GeoLibreLayer, app: GeoLibreAppAPI): boolean {
  if (!isExternalNativeLayerRecord(layer)) return false;
  const sourceKind = layer.metadata.sourceKind;
  const restore = typeof sourceKind === "string" ? RESTORE_BY_SOURCE_KIND[sourceKind] : undefined;
  if (!restore) return false;
  // The passes are fire-and-forget (they log their own failures); await nothing
  // here so a slow re-ingest never blocks the panel's click handler.
  void Promise.resolve(restore(app)).catch((error: unknown) => {
    console.error("[GeoLibre] Failed to restore a layer added from My Data", error);
  });
  return true;
}
