import {
  applySelectionMode,
  featureSelectionId,
  invertSelection,
  useAppStore,
  type GeoLibreLayer,
  type SelectionMode,
} from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import type { Feature, FeatureCollection } from "geojson";

/**
 * Actions on the live feature selection (#1314), shared by the Edit menu and
 * the layer panel's context menu. The selection always lives on the active
 * layer (`selectedLayerId`), so these act on that layer's features.
 */

/** The layer currently holding the selection, when its features are loaded. */
export function selectionHolderLayer(): GeoLibreLayer | null {
  const store = useAppStore.getState();
  const layer = store.layers.find((l) => l.id === store.selectedLayerId);
  return layer?.geojson?.features ? layer : null;
}

/** The selected features of the active layer, in layer order. */
function selectedFeatures(): { layer: GeoLibreLayer; features: Feature[] } | null {
  const layer = selectionHolderLayer();
  if (!layer) return null;
  const selected = new Set(useAppStore.getState().selectedFeatureIds);
  const features = (layer.geojson?.features ?? []).filter((feature, index) =>
    selected.has(featureSelectionId(feature, index)),
  );
  return { layer, features };
}

/**
 * Applies a matched id set to the live selection under the given mode and
 * returns the resulting selection size. Combines with the current selection
 * only when the target layer already holds it (ids are per-layer, so a
 * cross-layer combine would mix unrelated features). Otherwise `current` is
 * empty: "new"/"add" start a fresh selection on the target layer, while
 * "remove"/"intersect" necessarily yield an empty one — the dialogs guard
 * this by forcing mode "new" when the target layer does not hold the
 * selection (SelectionModeField's disableCombineModes). `selectLayer` runs
 * before `selectFeatures` because it clears the selection as a side effect.
 */
export function applyMatchedSelection(
  targetLayerId: string,
  matchedIds: string[],
  mode: SelectionMode,
): number {
  const store = useAppStore.getState();
  const current = store.selectedLayerId === targetLayerId ? store.selectedFeatureIds : [];
  const next = applySelectionMode(current, matchedIds, mode);
  if (store.selectedLayerId !== targetLayerId) store.selectLayer(targetLayerId);
  store.selectFeatures(next);
  return next.length;
}

/**
 * QGIS "Invert selection": select every unselected feature of the active
 * layer. With nothing selected this selects all features.
 */
export function invertLayerSelection(): void {
  const layer = selectionHolderLayer();
  if (!layer) return;
  const store = useAppStore.getState();
  const allIds = (layer.geojson?.features ?? []).map(featureSelectionId);
  store.selectFeatures(invertSelection(allIds, store.selectedFeatureIds));
}

/** Clear the selection (keeps the layer active). */
export function clearFeatureSelection(): void {
  useAppStore.getState().selectFeature(null);
}

/** Fit the map to the selected features (re-using the highlight overlay). */
export function zoomToSelection(controller: MapController | null): void {
  const store = useAppStore.getState();
  const layer = selectionHolderLayer();
  if (!layer || store.selectedFeatureIds.length === 0) return;
  controller?.highlightFeature(layer, store.selectedFeatureIds, { fit: true });
}

/**
 * Materialize the selected features as a new GeoJSON layer. Returns the new
 * layer's id, or null when nothing is selected. `layerName` is the translated
 * display name supplied by the caller.
 */
export function exportSelectionAsLayer(layerName: string): string | null {
  const result = selectedFeatures();
  if (!result || result.features.length === 0) return null;
  const collection: FeatureCollection = {
    type: "FeatureCollection",
    features: result.features,
  };
  return useAppStore.getState().addGeoJsonLayer(layerName, collection);
}
