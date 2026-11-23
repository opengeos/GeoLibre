import type { VectorStyleStop } from "@geolibre/core";

export interface HistogramBin {
  /** Inclusive lower bound of this bin. */
  min: number;
  /** Upper bound of this bin (inclusive on the final bin). */
  max: number;
  /** Number of features falling into this bin. */
  count: number;
  /** Bin midpoint used to map onto the graduated stop ramp. */
  midpoint: number;
  /** Resolved fill color from the graduated stops. */
  color: string;
}

export interface GraduatedHistogramData {
  bins: HistogramBin[];
  min: number;
  max: number;
  maxCount: number;
  totalCount: number;
  /** Normalized `[0, 1]` horizontal positions for each numeric stop threshold. */
  breakPositions: Array<{ value: number; position: number; color: string }>;
}

/**
 * Resolve the graduated color for a numeric value against sorted stops using
 * step-interval semantics (matching the style panel's graduated ramp).
 */
export function colorForGraduatedValue(
  value: number,
  stops: readonly VectorStyleStop[],
  fallbackColor = "#2563eb",
): string {
  const numericStops = stops
    .map((stop) => ({ value: Number(stop.value), color: stop.color }))
    .filter((stop) => Number.isFinite(stop.value))
    .sort((a, b) => a.value - b.value);
  if (numericStops.length === 0) return fallbackColor;
  let chosen = numericStops[0].color;
  for (const stop of numericStops) {
    if (value >= stop.value) chosen = stop.color;
    else break;
  }
  return chosen;
}

/**
 * Bin finite numeric attribute values into `binCount` equal-width histogram
 * buckets colored by the graduated symbology stops, plus normalized stop break
 * positions in `[0, 1]`. Returns `null` when no finite numeric values exist.
 */
export function computeGraduatedHistogram(
  values: readonly unknown[] | undefined,
  stops: readonly VectorStyleStop[],
  binCount = 20,
): GraduatedHistogramData | null {
  if (!values || values.length === 0) return null;
  const numeric: number[] = [];
  for (const raw of values) {
    if (typeof raw === "number" && Number.isFinite(raw)) {
      numeric.push(raw);
    } else if (typeof raw === "string" && raw.trim() !== "") {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) numeric.push(parsed);
    }
  }
  if (numeric.length === 0) return null;

  let min = numeric[0];
  let max = numeric[0];
  for (let i = 1; i < numeric.length; i += 1) {
    if (numeric[i] < min) min = numeric[i];
    if (numeric[i] > max) max = numeric[i];
  }

  const clampedBins = Math.max(1, Math.min(60, Math.floor(binCount)));
  if (min === max) {
    const color = colorForGraduatedValue(min, stops);
    const breakPositions = stops
      .map((s) => ({ value: Number(s.value), color: s.color }))
      .filter((s) => Number.isFinite(s.value))
      .map((s) => ({ value: s.value, position: 0.5, color: s.color }));
    return {
      bins: [{ min, max, count: numeric.length, midpoint: min, color }],
      min,
      max,
      maxCount: numeric.length,
      totalCount: numeric.length,
      breakPositions,
    };
  }

  const span = max - min;
  const width = span / clampedBins;
  const counts = new Uint32Array(clampedBins);
  for (const value of numeric) {
    const idx = Math.min(clampedBins - 1, Math.max(0, Math.floor((value - min) / width)));
    counts[idx] += 1;
  }

  let maxCount = 0;
  const bins: HistogramBin[] = [];
  for (let i = 0; i < clampedBins; i += 1) {
    const count = counts[i];
    if (count > maxCount) maxCount = count;
    const binMin = min + i * width;
    const binMax = i === clampedBins - 1 ? max : min + (i + 1) * width;
    const midpoint = (binMin + binMax) / 2;
    bins.push({
      min: binMin,
      max: binMax,
      count,
      midpoint,
      color: colorForGraduatedValue(midpoint, stops),
    });
  }

  const breakPositions = stops
    .map((s) => ({ value: Number(s.value), color: s.color }))
    .filter((s) => Number.isFinite(s.value) && s.value >= min && s.value <= max)
    .sort((a, b) => a.value - b.value)
    .map((s) => ({
      value: s.value,
      position: (s.value - min) / span,
      color: s.color,
    }));

  return {
    bins,
    min,
    max,
    maxCount,
    totalCount: numeric.length,
    breakPositions,
  };
}
