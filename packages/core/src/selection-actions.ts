import { useAppStore } from "./store";
import { applySelectionMode, type SelectionMode } from "./selection";

/**
 * Store-touching selection helpers. Kept out of `selection.ts` so that module
 * stays a pure, directly testable set of functions over id arrays.
 */

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
 *
 * Lives in `@geolibre/core` rather than the app so the layer-panel dialogs and
 * the map's drawing gestures (`@geolibre/map`) share one copy of this rule
 * instead of two that can drift apart.
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
