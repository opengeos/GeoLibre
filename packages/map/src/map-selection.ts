import type { GeoLibreLayer } from "@geolibre/core";
import type { MapEngine } from "./map-engine";

/**
 * The features to highlight for the current selection: the full multi-select
 * set when present, otherwise the single anchor (or none). Shared by the
 * selection effect and the map/basemap style-load handlers so a style reload
 * never collapses a multi-selection down to its anchor.
 */
export function resolveHighlightIds(state: {
  selectedFeatureIds: string[];
  selectedFeatureId: string | null;
}): string[] {
  if (state.selectedFeatureIds.length > 0) return state.selectedFeatureIds;
  return state.selectedFeatureId ? [state.selectedFeatureId] : [];
}

/**
 * The stable fit key for a selection, or null when nothing is highlighted.
 *
 * Key on the whole selection set, not just the anchor: a Shift-range pick
 * keeps the anchor fixed while adding features, so an anchor-only key would
 * never re-fit. Any change to the set re-triggers the fit to frame them all.
 * Serialize structurally rather than joining on a delimiter: feature and
 * layer ids are free-form strings, so any separator could appear inside one
 * (["a,b"] vs ["a","b"]) and collide two different selections into one key.
 *
 * Args:
 *   state: The store selection fields.
 *
 * Returns:
 *   The JSON key over the layer id and highlighted feature ids, or null.
 */
export function selectionFitKey(state: {
  selectedLayerId: string | null;
  selectedFeatureIds: string[];
  selectedFeatureId: string | null;
}): string | null {
  const highlightIds = resolveHighlightIds(state);
  return state.selectedLayerId && highlightIds.length > 0
    ? JSON.stringify([state.selectedLayerId, highlightIds])
    : null;
}

/** Apply the store selection to any map engine and return its stable fit key. */
export function applySelectionHighlight(
  engine: MapEngine | null | undefined,
  layers: GeoLibreLayer[],
  selectedLayerId: string | null,
  selectedFeatureId: string | null,
  selectedFeatureIds: string[],
  zoomToSelectedFeature: boolean,
  previousKey: string | null,
  restoring: boolean,
): string | null {
  const layer = layers.find((item) => item.id === selectedLayerId);
  // Highlight the full multi-selection (attribute table Ctrl/Shift picks).
  const highlightIds = resolveHighlightIds({
    selectedFeatureIds,
    selectedFeatureId,
  });
  const nextKey = selectionFitKey({ selectedLayerId, selectedFeatureIds, selectedFeatureId });
  const fit = Boolean(!restoring && zoomToSelectedFeature && nextKey && nextKey !== previousKey);
  engine?.highlightFeature(layer, highlightIds.length > 0 ? highlightIds : null, { fit });
  // Do not consume the key while fitting is disabled. If the user selects a
  // row first and then enables "Zoom to selection", that transition must fit
  // the already-selected feature instead of looking like a duplicate request.
  return zoomToSelectedFeature ? nextKey : null;
}
