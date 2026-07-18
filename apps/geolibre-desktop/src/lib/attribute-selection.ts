/**
 * Pure row-selection logic for the attribute table. Kept free of React/store
 * dependencies so the branching (plain / Ctrl-toggle / Shift-range / Shift+Ctrl
 * merge / anchor fallback) can be unit-tested directly.
 */

export interface RowSelectionInput {
  /** The feature id of the clicked row. */
  featureId: string;
  /** Feature ids in the table's current sorted/filtered order. */
  sortedIds: string[];
  /** The current multi-selection. */
  selectedIds: string[];
  /** The current anchor (last primary pick), or null when nothing is selected. */
  anchorId: string | null;
  /** Ctrl/Cmd was held: toggle the clicked row in/out of the selection. */
  additive: boolean;
  /** Shift was held: select the contiguous range from the anchor. */
  range: boolean;
}

export interface RowSelectionResult {
  /** The next selection set. */
  ids: string[];
  /** The next anchor (always a member of `ids`, or null when `ids` is empty). */
  anchor: string | null;
}

/**
 * Compute the next selection for a modifier-aware row click.
 *
 * - plain click: select just the clicked row (it becomes the anchor).
 * - Ctrl/Cmd click: toggle the clicked row; deselecting the anchor moves the
 *   anchor to the last remaining id.
 * - Shift click: select the contiguous range from the anchor to the clicked
 *   row over `sortedIds`, keeping the anchor fixed so repeated Shift-clicks
 *   grow/shrink one range. With Ctrl also held the range merges with the
 *   existing selection instead of replacing it. Falls back to a single select
 *   when there is no usable anchor.
 *
 * @param input Clicked row, current selection/anchor, sorted order, modifiers.
 * @returns The next selection set and anchor.
 */
export function computeRowSelection(input: RowSelectionInput): RowSelectionResult {
  const { featureId, sortedIds, selectedIds, anchorId, additive, range } = input;

  if (range) {
    const anchorIndex = anchorId != null ? sortedIds.indexOf(anchorId) : -1;
    const clickedIndex = sortedIds.indexOf(featureId);
    if (anchorIndex === -1 || clickedIndex === -1) {
      return { ids: [featureId], anchor: featureId };
    }
    const [from, to] =
      anchorIndex <= clickedIndex ? [anchorIndex, clickedIndex] : [clickedIndex, anchorIndex];
    const rangeIds = sortedIds.slice(from, to + 1);
    const merged = additive ? [...selectedIds, ...rangeIds] : rangeIds;
    return { ids: [...new Set(merged)], anchor: anchorId };
  }

  if (additive) {
    const next = selectedIds.includes(featureId)
      ? selectedIds.filter((id) => id !== featureId)
      : [...selectedIds, featureId];
    // Adding a row anchors it; removing one keeps the existing anchor when it
    // survives (so a following Shift-range still starts from the right row) and
    // only falls back to the last id when the anchor itself was removed.
    const anchor = next.includes(featureId)
      ? featureId
      : anchorId != null && next.includes(anchorId)
        ? anchorId
        : (next.at(-1) ?? null);
    return { ids: next, anchor };
  }

  return { ids: [featureId], anchor: featureId };
}
