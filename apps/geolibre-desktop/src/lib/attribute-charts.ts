/**
 * Pure data helpers for the attribute Charts panel: numeric-column detection,
 * histogram binning, and scatter extraction. Kept free of any rendering or React
 * so they can be unit-tested in isolation; the SVG drawing lives in the dialog
 * component. Operates on the same `{ properties }` rows the attribute table
 * already builds for both GeoJSON and DuckDB query layers.
 */

export type ChartType = "histogram" | "scatter";

/** A row as seen by the chart helpers — only its property bag matters. */
export interface ChartRow {
  properties: Record<string, unknown>;
}

export const MIN_HISTOGRAM_BINS = 1;
export const MAX_HISTOGRAM_BINS = 50;
export const DEFAULT_HISTOGRAM_BINS = 10;

/**
 * Parse a value into a finite number, or null when it cannot be one. Numeric
 * strings (`"42"`, `" 3.5 "`) are accepted; empty/blank, boolean, null, NaN and
 * Infinity are rejected so they never enter a chart.
 */
export function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const next = Number(trimmed);
    return Number.isFinite(next) ? next : null;
  }
  return null;
}

/**
 * Columns suitable for charting: a key counts as numeric when it has at least
 * two finite-number values and those make up at least half of its non-null
 * values (so an id-like column of mostly strings with a stray number is
 * excluded). Returned in the order the columns were given.
 */
export function numericColumns(rows: ChartRow[], columns: string[]): string[] {
  return columns.filter((key) => {
    let numeric = 0;
    let nonNull = 0;
    for (const row of rows) {
      const raw = row.properties[key];
      if (raw == null || raw === "") continue;
      nonNull += 1;
      if (toFiniteNumber(raw) !== null) numeric += 1;
    }
    return numeric >= 2 && numeric >= nonNull / 2;
  });
}

/** Pull the finite numeric values of one column out of the rows. */
export function numericValues(rows: ChartRow[], key: string): number[] {
  const values: number[] = [];
  for (const row of rows) {
    const next = toFiniteNumber(row.properties[key]);
    if (next !== null) values.push(next);
  }
  return values;
}

export interface HistogramBin {
  /** Inclusive lower edge. */
  x0: number;
  /** Exclusive upper edge (inclusive for the final bin). */
  x1: number;
  count: number;
}

export interface HistogramResult {
  bins: HistogramBin[];
  min: number;
  max: number;
  /** How many values were binned. */
  total: number;
  /** The tallest bin's count, for scaling the y axis. */
  maxCount: number;
}

/**
 * Bin a set of values into `binCount` equal-width buckets. Returns null when
 * there are no values. When every value is identical (min === max) a single
 * bin holding them all is returned, avoiding a zero-width divide.
 */
export function computeHistogram(
  values: number[],
  binCount: number,
): HistogramResult | null {
  if (values.length === 0) return null;

  let min = values[0];
  let max = values[0];
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }

  if (min === max) {
    return {
      bins: [{ x0: min, x1: max, count: values.length }],
      min,
      max,
      total: values.length,
      maxCount: values.length,
    };
  }

  const requested = Math.trunc(binCount);
  // Clamp a finite request into range (so 0 → 1, not the default); fall back to
  // the default only for a non-finite request (NaN/Infinity).
  const count = Number.isFinite(requested)
    ? Math.max(MIN_HISTOGRAM_BINS, Math.min(MAX_HISTOGRAM_BINS, requested))
    : DEFAULT_HISTOGRAM_BINS;
  const width = (max - min) / count;
  const bins: HistogramBin[] = Array.from({ length: count }, (_, i) => ({
    x0: min + i * width,
    x1: i === count - 1 ? max : min + (i + 1) * width,
    count: 0,
  }));

  for (const value of values) {
    // Clamp so the maximum value lands in the last bin rather than index `count`.
    const index = Math.min(count - 1, Math.floor((value - min) / width));
    bins[index].count += 1;
  }

  let maxCount = 0;
  for (const bin of bins) {
    if (bin.count > maxCount) maxCount = bin.count;
  }

  return { bins, min, max, total: values.length, maxCount };
}

export interface ScatterPoint {
  x: number;
  y: number;
}

export interface ScatterResult {
  points: ScatterPoint[];
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

/**
 * Extract the (x, y) pairs where both columns hold a finite number. Returns null
 * when no row has both. Single-axis degenerate ranges (all x equal, etc.) are
 * left to the renderer to pad.
 */
export function computeScatter(
  rows: ChartRow[],
  xKey: string,
  yKey: string,
): ScatterResult | null {
  const points: ScatterPoint[] = [];
  for (const row of rows) {
    const x = toFiniteNumber(row.properties[xKey]);
    const y = toFiniteNumber(row.properties[yKey]);
    if (x === null || y === null) continue;
    points.push({ x, y });
  }
  if (points.length === 0) return null;

  let xMin = points[0].x;
  let xMax = points[0].x;
  let yMin = points[0].y;
  let yMax = points[0].y;
  for (const point of points) {
    if (point.x < xMin) xMin = point.x;
    if (point.x > xMax) xMax = point.x;
    if (point.y < yMin) yMin = point.y;
    if (point.y > yMax) yMax = point.y;
  }

  return { points, xMin, xMax, yMin, yMax };
}

/**
 * Format a numeric axis label compactly: integers as-is, otherwise up to 3
 * significant-ish decimals with trailing zeros trimmed. Large/small magnitudes
 * fall back to exponential so labels stay short.
 */
export function formatAxisValue(value: number): string {
  if (!Number.isFinite(value)) return "";
  if (Number.isInteger(value)) return String(value);
  const abs = Math.abs(value);
  if (abs !== 0 && (abs < 1e-3 || abs >= 1e6)) {
    return value.toExponential(1);
  }
  return parseFloat(value.toFixed(3)).toString();
}
