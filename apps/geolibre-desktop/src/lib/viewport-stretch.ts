/**
 * Range math shared by the two viewport-stretch callers: the manual "apply"
 * button in `RasterSymbologySection` and the automatic camera-idle loop in
 * `useRasterViewportStretch`. Both stretch the same way, so the methods live
 * here rather than being duplicated per caller.
 */

export type ViewportStretchMethod = "minmax" | "percentile" | "stddev";

/**
 * The stretch method a persisted `rasterState` selects, falling back to
 * `minmax` for a missing or unrecognised value. One place to widen if a fourth
 * method is ever added, rather than a separate literal check per reader.
 */
export function normalizeStretchMethod(value: unknown): ViewportStretchMethod {
  return value === "percentile" || value === "stddev" ? value : "minmax";
}

/**
 * The samples in a raster window reading that are safe to compute a stretch
 * from. `readRasterWindow` leaves NoData pixels at their sentinel value, and a
 * sentinel like -9999 is perfectly finite, so filtering on `Number.isFinite`
 * alone drags a min/max stretch down to the fill value and washes the layer
 * out. Unreadable tiles come back as NaN and drop out here too.
 */
export function stretchSamples(
  reading: { values: number[]; nodata: number | null } | null | undefined,
): number[] {
  if (!reading) return [];
  const { nodata } = reading;
  return reading.values.filter(
    (value) => Number.isFinite(value) && (nodata === null || value !== nodata),
  );
}

/**
 * Rescale range for the sampled viewport values under the given method:
 * `minmax` spans the full sample, `percentile` clips to the 5th/95th, and
 * `stddev` spans two deviations either side of the mean. Callers pass a
 * non-empty array of usable values, as `stretchSamples` returns.
 */
export function viewportRange(values: number[], method: ViewportStretchMethod): [number, number] {
  const sorted = [...values].sort((a, b) => a - b);
  if (method === "minmax") return [sorted[0], sorted[sorted.length - 1]];
  if (method === "percentile") return [percentile(sorted, 0.05), percentile(sorted, 0.95)];
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  const deviation = Math.sqrt(variance);
  return [mean - 2 * deviation, mean + 2 * deviation];
}

/** Linear-interpolated percentile of an already-ascending array. */
export function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 1) return sorted[0];
  const position = fraction * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * weight;
}

/**
 * Whether a raster layer's state asks for the automatic viewport stretch.
 *
 * `viewportStretchAuto` alone is not enough. It is not cleared when the layer
 * switches to RGB or becomes classified, and both of those own `rescale` on
 * different terms: RGB expects one min/max pair per channel (`rescaleEntryCount`
 * in core), and a classified layer derives its range from its breaks. Writing a
 * single-entry range into either desyncs it on every camera idle.
 *
 * While the auto stretch lived inside `ViewportStretchControls` this gating was
 * implicit, because the panel returns early for RGB and renders the control
 * only when `!classified`, so the effect unmounted. A shell-level hook is
 * always mounted and has to check both conditions itself.
 */
export function wantsAutoStretch(rasterState: unknown, classified: boolean): boolean {
  if (!rasterState || typeof rasterState !== "object" || Array.isArray(rasterState)) return false;
  const raw = rasterState as Record<string, unknown>;
  if (raw.viewportStretchAuto !== true) return false;
  if (raw.mode === "rgb") return false;
  return !classified;
}
