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

import {
  controlRendersLayer,
  isExternalNativeLayerRecord,
  type GeoLibreLayer,
} from "@geolibre/core";
import {
  LIDAR_SOURCE_KIND,
  PLANETARY_COMPUTER_SOURCE_KIND,
  RASTER_SOURCE_KIND,
  restoreLidarLayers,
  restorePlanetaryComputerLayers,
  restoreRasterLayers,
  restoreThreeDTilesLayers,
  restoreVectorLayers,
  THREE_D_TILES_SOURCE_KIND,
  VECTOR_SOURCE_KIND,
  type GeoLibreAppAPI,
} from "@geolibre/plugins";

/**
 * `metadata.sourceKind` values of the control-painted layer kinds whose restore
 * pass we can re-run, mapped to that pass. Every key is the constant its own
 * plugin writes onto the store layer — never a copy of the literal — because the
 * failure mode of a drifted key is silent: "Save to My Data" simply stops
 * appearing for that layer type, and an entry saved earlier re-adds unrendered.
 *
 * A layer whose kind is absent here is left to the store sync, which is correct
 * for every GeoLibre-rendered layer; for a control-painted kind, being absent is
 * what makes `canRestoreLibraryLayer` refuse to offer it in the first place.
 */
const RESTORE_BY_SOURCE_KIND: Record<string, (app: GeoLibreAppAPI) => void | Promise<void>> = {
  [VECTOR_SOURCE_KIND]: restoreVectorLayers,
  [RASTER_SOURCE_KIND]: restoreRasterLayers,
  [PLANETARY_COMPUTER_SOURCE_KIND]: restorePlanetaryComputerLayers,
  [THREE_D_TILES_SOURCE_KIND]: restoreThreeDTilesLayers,
  [LIDAR_SOURCE_KIND]: restoreLidarLayers,
};

/** The restore pass that renders `layer`, or undefined when it needs none. */
function restorePassFor(
  layer: GeoLibreLayer,
): ((app: GeoLibreAppAPI) => void | Promise<void>) | undefined {
  const sourceKind = layer.metadata.sourceKind;
  return typeof sourceKind === "string" ? RESTORE_BY_SOURCE_KIND[sourceKind] : undefined;
}

/**
 * Whether re-adding `layer` from the Layer Library will actually render it. The
 * map's own sync rebuilds most external-native layers straight from the store
 * record — PMTiles, Esri Wayback, basemap-control and web-service rasters, the
 * generic raster-tile path, and the GeoJSON fall-through. Only a custom-render
 * layer ({@link controlRendersLayer}) needs its control to recreate the map
 * output, and for those we need a restore pass for that kind.
 *
 * This is the capability `canSaveLayerToLibrary` gates "Save to My Data" on, so
 * a layer that would re-add blank is never offered in the first place. Adding a
 * kind to {@link RESTORE_BY_SOURCE_KIND} therefore also makes it saveable — the
 * two cannot drift apart.
 *
 * @param layer - The layer being considered for the library.
 * @returns Whether the layer can be re-added and rendered.
 */
export function canRestoreLibraryLayer(layer: GeoLibreLayer): boolean {
  if (!isExternalNativeLayerRecord(layer)) return true;
  return !controlRendersLayer(layer) || restorePassFor(layer) !== undefined;
}

/**
 * Run the plugin restore pass that renders `layer`, if it is control-painted and
 * needs one. A no-op for a layer the map sync rebuilds from the record.
 *
 * **Does not wait for the layer to appear.** Four of the five passes are
 * `(app) => void` and fire their real work into a floating `void (async () =>
 * …)()` internally (see `restoreVectorLayers`), so awaiting them only spans the
 * dispatch; only `restoreLidarLayers` returns a real promise. Making this
 * genuinely awaitable means changing those plugins' signatures, which the
 * project-load path shares — out of scope here, so the caller's busy flag covers
 * the dispatch window rather than the full re-ingest.
 *
 * @param layer - The layer just added from the Layer Library.
 * @param app - The plugin app API (from `createAppAPI`).
 * @returns Resolves once the pass has been dispatched (immediately when none was
 *   needed). The passes log their own per-layer failures.
 */
export async function restoreLibraryLayer(
  layer: GeoLibreLayer,
  app: GeoLibreAppAPI,
): Promise<void> {
  if (!isExternalNativeLayerRecord(layer)) return;
  const restore = restorePassFor(layer);
  if (!restore) return;
  try {
    await restore(app);
  } catch (error) {
    console.error("[GeoLibre] Failed to restore a layer added from My Data", error);
  }
}
