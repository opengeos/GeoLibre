import type { Feature } from "geojson";

/**
 * How a freshly matched feature set combines with the existing selection,
 * mirroring QGIS's four selection behaviors: replace the selection, add to
 * it, remove from it, or keep only features in both.
 */
export type SelectionMode = "new" | "add" | "remove" | "intersect";

/** Selection modes in display order. */
export const SELECTION_MODES: readonly SelectionMode[] = ["new", "add", "remove", "intersect"];

/**
 * The id under which a feature participates in the selection model. Mirrors
 * the convention shared by the attribute table and the map highlight
 * (`String(feature.id ?? index)`): the feature's own `id` when present,
 * otherwise its index in the layer's feature array.
 */
export function featureSelectionId(feature: Feature, index: number): string {
  return String(feature.id ?? index);
}

/**
 * Combines the current selection with a freshly matched id set according to
 * `mode`. The result is deduplicated and order-stable: "new" follows the
 * matched order, "add" appends unseen matches after the current ids, and
 * "remove"/"intersect" preserve the current selection's order.
 */
export function applySelectionMode(
  current: readonly string[],
  matched: readonly string[],
  mode: SelectionMode,
): string[] {
  const matchedSet = new Set(matched);
  switch (mode) {
    case "new":
      return Array.from(matchedSet);
    case "add": {
      const merged = new Set(current);
      for (const id of matched) merged.add(id);
      return Array.from(merged);
    }
    case "remove":
      return Array.from(new Set(current.filter((id) => !matchedSet.has(id))));
    case "intersect":
      return Array.from(new Set(current.filter((id) => matchedSet.has(id))));
  }
}

/**
 * The complement of `current` within `allIds` (QGIS "Invert selection"):
 * every feature id not currently selected, in layer order. With an empty
 * selection this selects everything.
 */
export function invertSelection(allIds: readonly string[], current: readonly string[]): string[] {
  const selected = new Set(current);
  return allIds.filter((id) => !selected.has(id));
}
