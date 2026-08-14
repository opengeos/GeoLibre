/** Manual y-axis bounds; null on either end means "follow the data". */
export interface ChartDomain {
  min: number | null;
  max: number | null;
}

/**
 * The y-axis range to plot: the data's own extent, with either end replaced by
 * a manual bound.
 *
 * Its own module rather than a helper inside the chart component so it can be
 * tested directly — the component's imports reach the plugin barrel, which
 * needs a DOM. The edge cases here are all invisible on screen (a chart with the
 * wrong range just looks empty) but each has a wrong answer that silently hides
 * every reading.
 *
 * @param values - Every plotted value; must be non-empty.
 * @param domain - Manual bounds, null on an end that follows the data.
 * @returns The range to hand to the y scale, never inverted or zero-height.
 */
export function resolveChartDomain(
  values: number[],
  domain: ChartDomain,
): { min: number; max: number } {
  // Reduce instead of Math.min/max(...values) so a large multi-point series
  // cannot blow the argument-spread stack limit.
  let min = values[0];
  let max = values[0];
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }

  // Bounds arrive mid-typing and from the user in either order. A reversed
  // *pair* is a typo, so read it as the range the user meant.
  let { min: pinnedMin, max: pinnedMax } = domain;
  if (pinnedMin != null && pinnedMax != null && pinnedMin > pinnedMax) {
    [pinnedMin, pinnedMax] = [pinnedMax, pinnedMin];
  }
  // A manual bound overrides the data on that end only, so one end can be
  // pinned while the other keeps following the series.
  if (pinnedMin != null) min = pinnedMin;
  if (pinnedMax != null) max = pinnedMax;

  // Only one bound can still be inverted here (a reversed pair was normalized
  // above), and it is pinned while the other end came from the data. Collapse
  // the data-derived end onto the pinned one rather than swapping them: a swap
  // would turn the user's floor into the ceiling and clip every reading out of
  // view, which reads as an empty chart with no explanation.
  if (min > max) {
    if (pinnedMax == null) max = min;
    else min = max;
  }
  if (min === max) {
    // Pad a flat series (or a pinned single-value domain) so the value sits
    // mid-axis with room to read, and so the scale never divides by zero.
    min -= 1;
    max += 1;
  }
  return { min, max };
}
