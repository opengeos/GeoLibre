/**
 * Pure mapping logic behind the interactive raster histogram in the Style
 * panel: where a value sits on the chart, which value a pointer position
 * means, how the two stretch handles stay ordered, and how a per-channel edit
 * lands in the persisted `rasterState.rescale` without changing its shape.
 * Kept free of React and the DOM so the math is unit-testable.
 */

/** A band's histogram: bin counts spread evenly over `[min, max]`. */
export type HistogramStats = {
  min: number;
  max: number;
  histogram: readonly number[];
};

/** A `[low, high]` value window. */
export type ValueRange = [number, number];

/** The lower / upper cut-point handle. */
export type StretchHandle = "min" | "max";

/**
 * Lower / upper percentile maplibre-gl-raster stretches to when
 * `rasterState.rescale` is unset. Mirrored so the handles of an auto-stretched
 * layer sit where the renderer actually clips.
 */
export const AUTO_PERCENTILE_LOW = 0.02;
export const AUTO_PERCENTILE_HIGH = 0.98;

/**
 * The value at each bin boundary: `bins + 1` evenly spaced edges from `min` to
 * `max`, the last pinned to `max` exactly so float drift never leaves the top
 * bin short.
 *
 * @param stats - The band statistics.
 * @returns The bin edges, or an empty array when there are no bins.
 */
export function histogramBinEdges(stats: HistogramStats): number[] {
  const bins = stats.histogram.length;
  if (bins === 0) return [];
  const width = (stats.max - stats.min) / bins;
  return Array.from({ length: bins + 1 }, (_, index) =>
    index === bins ? stats.max : stats.min + index * width,
  );
}

/**
 * Linear-interpolated percentile of a binned band, matching the renderer's
 * auto-stretch so the shaded window for an "auto" layer is the rendered one.
 *
 * @param stats - The band statistics.
 * @param fraction - The percentile in `[0, 1]`.
 * @returns The value at that percentile.
 */
export function histogramPercentile(stats: HistogramStats, fraction: number): number {
  const total = stats.histogram.reduce((sum, count) => sum + count, 0);
  if (total === 0) return fraction < 0.5 ? stats.min : stats.max;
  const span = stats.max - stats.min;
  if (span <= 0) return stats.min;
  const binWidth = span / stats.histogram.length;
  const target = total * fraction;
  let accumulated = 0;
  for (let index = 0; index < stats.histogram.length; index += 1) {
    const count = stats.histogram[index];
    if (accumulated + count >= target) {
      const within = count > 0 ? (target - accumulated) / count : 0;
      return stats.min + (index + within) * binWidth;
    }
    accumulated += count;
  }
  return stats.max;
}

/**
 * The window the renderer stretches to when no explicit range is saved.
 *
 * @param stats - The band statistics.
 * @returns The 2nd-98th percentile window.
 */
export function autoStretchRange(stats: HistogramStats): ValueRange {
  return [
    histogramPercentile(stats, AUTO_PERCENTILE_LOW),
    histogramPercentile(stats, AUTO_PERCENTILE_HIGH),
  ];
}

/**
 * The value span the chart draws: the data range widened to include the
 * active stretch, so a window set past the data (a std-dev stretch, a typed
 * value) still shows both handles instead of pinning them to the edges.
 *
 * @param stats - The band statistics.
 * @param range - The active stretch window, if any.
 * @returns The chart domain, or null when it has no width to draw.
 */
export function histogramDomain(
  stats: HistogramStats,
  range?: ValueRange | null,
): ValueRange | null {
  const values = [stats.min, stats.max];
  if (range) values.push(...range);
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return null;
  const lo = Math.min(...finite);
  const hi = Math.max(...finite);
  return hi > lo ? [lo, hi] : null;
}

/**
 * Where a value sits along a chart of the given width, clamped to the chart.
 *
 * @param value - The data value.
 * @param domain - The chart's value span.
 * @param width - The chart width in pixels.
 * @returns The x offset in `[0, width]`.
 */
export function valueToPixel(value: number, domain: ValueRange, width: number): number {
  const span = domain[1] - domain[0];
  if (!(span > 0) || !Number.isFinite(value)) return 0;
  const fraction = (value - domain[0]) / span;
  return Math.min(1, Math.max(0, fraction)) * width;
}

/**
 * The value a chart x offset stands for, clamped to the domain so a drag past
 * either end stops at the edge.
 *
 * @param pixel - The x offset from the chart's left edge.
 * @param domain - The chart's value span.
 * @param width - The chart width in pixels.
 * @returns The data value in `[domain[0], domain[1]]`.
 */
export function pixelToValue(pixel: number, domain: ValueRange, width: number): number {
  if (!(width > 0) || !Number.isFinite(pixel)) return domain[0];
  const fraction = Math.min(1, Math.max(0, pixel / width));
  return domain[0] + fraction * (domain[1] - domain[0]);
}

/**
 * Rounds a dragged value to a precision that suits the domain: integers for a
 * 0-10000 reflectance band, three decimals for a 0-1 index. Keeps the Min/Max
 * inputs readable instead of showing float noise.
 *
 * @param value - The raw value.
 * @param domain - The chart's value span.
 * @returns The rounded value.
 */
export function roundForDomain(value: number, domain: ValueRange): number {
  const span = domain[1] - domain[0];
  if (!(span > 0) || !Number.isFinite(value)) return value;
  const decimals = Math.min(10, Math.max(0, 3 - Math.floor(Math.log10(span))));
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * The keyboard nudge for one arrow press: a hundredth of the domain.
 *
 * @param domain - The chart's value span.
 * @returns The step size.
 */
export function nudgeStep(domain: ValueRange): number {
  const span = domain[1] - domain[0];
  return span > 0 ? span / 100 : 0;
}

/**
 * Moves one handle to `value`, clamped to the domain and kept strictly on its
 * side of the other handle (a zero-width window would divide by zero in the
 * renderer). The gap is a thousandth of the domain.
 *
 * @param range - The current window.
 * @param handle - Which handle moves.
 * @param value - The requested position.
 * @param domain - The chart's value span.
 * @returns The new window, always `low < high`.
 */
export function moveHandle(
  range: ValueRange,
  handle: StretchHandle,
  value: number,
  domain: ValueRange,
): ValueRange {
  const gap = (domain[1] - domain[0]) / 1000;
  const clamped = Math.min(domain[1], Math.max(domain[0], value));
  if (handle === "min") {
    const low = Math.min(clamped, range[1] - gap);
    return [low, range[1]];
  }
  const high = Math.max(clamped, range[0] + gap);
  return [range[0], high];
}

/**
 * The handle a pointer press on the track should grab: the nearer one, or on
 * a tie the one whose side of the window the press falls on.
 *
 * @param range - The current window.
 * @param value - The value under the pointer.
 * @returns The handle to drag.
 */
export function nearestHandle(range: ValueRange, value: number): StretchHandle {
  const toMin = Math.abs(value - range[0]);
  const toMax = Math.abs(value - range[1]);
  if (toMin === toMax) return value <= range[0] ? "min" : "max";
  return toMin < toMax ? "min" : "max";
}

/**
 * Bar rectangles for the histogram, in chart pixels, heights normalized to
 * the tallest bin. Each bar spans its bin edges as projected on `domain`.
 *
 * @param stats - The band statistics.
 * @param domain - The chart's value span.
 * @param width - The chart width.
 * @param height - The chart height.
 * @returns One `{ x, width, height }` per non-empty bin.
 */
export function histogramBars(
  stats: HistogramStats,
  domain: ValueRange,
  width: number,
  height: number,
): { x: number; width: number; height: number }[] {
  const peak = Math.max(0, ...stats.histogram);
  if (peak === 0) return [];
  const edges = histogramBinEdges(stats);
  const bars: { x: number; width: number; height: number }[] = [];
  stats.histogram.forEach((count, index) => {
    if (count <= 0) return;
    const x0 = valueToPixel(edges[index], domain, width);
    const x1 = valueToPixel(edges[index + 1], domain, width);
    bars.push({ x: x0, width: Math.max(x1 - x0, 0.5), height: (count / peak) * height });
  });
  return bars;
}

/**
 * Writes one channel's window into a `rasterState.rescale` value, keeping the
 * persisted shape: a single-band layer stays a one-pair array, and an RGB
 * layer grows to one pair per channel. Channels with no saved pair (rescale
 * unset, or a single broadcast pair) are filled from `fallbacks` (their
 * current effective window) so editing one channel doesn't move the others.
 *
 * @param rescale - The saved rescale, or null for auto.
 * @param channel - The 0-based channel being edited.
 * @param range - The channel's new window.
 * @param fallbacks - Each channel's effective window today.
 * @returns The new rescale array.
 */
export function setChannelRange(
  rescale: readonly ValueRange[] | null,
  channel: number,
  range: ValueRange,
  fallbacks: readonly ValueRange[],
): ValueRange[] {
  const channels = Math.max(fallbacks.length, channel + 1);
  const next: ValueRange[] = [];
  for (let index = 0; index < channels; index += 1) {
    if (index === channel) {
      next.push([range[0], range[1]]);
      continue;
    }
    // The renderer broadcasts the first pair to channels without their own.
    const saved = rescale && rescale.length > 0 ? (rescale[index] ?? rescale[0]) : undefined;
    const fallback = saved ?? fallbacks[index] ?? range;
    next.push([fallback[0], fallback[1]]);
  }
  return next;
}

/**
 * The window a channel renders with today: its saved pair, the broadcast
 * first pair, or the auto stretch when nothing is saved.
 *
 * @param rescale - The saved rescale, or null for auto.
 * @param channel - The 0-based channel.
 * @param stats - The channel band's statistics, for the auto fallback.
 * @returns The effective window, or null when neither is known.
 */
export function effectiveChannelRange(
  rescale: readonly ValueRange[] | null,
  channel: number,
  stats: HistogramStats | null,
): ValueRange | null {
  if (rescale && rescale.length > 0) {
    const pair = rescale[channel] ?? rescale[0];
    return [pair[0], pair[1]];
  }
  return stats ? autoStretchRange(stats) : null;
}
