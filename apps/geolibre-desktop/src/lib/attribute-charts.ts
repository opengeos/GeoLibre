/**
 * Pure data helpers for the attribute Charts panel: numeric-column detection,
 * histogram binning, and scatter extraction. Kept free of any rendering or React
 * so they can be unit-tested in isolation; the SVG drawing lives in the dialog
 * component. Operates on the same `{ properties }` rows the attribute table
 * already builds for both GeoJSON and DuckDB query layers.
 */

export type ChartType = "histogram" | "scatter" | "bar" | "line" | "box" | "pie";

/** A row as seen by the chart helpers — only its property bag matters. */
export interface ChartRow {
  properties: Record<string, unknown>;
}

export const MIN_HISTOGRAM_BINS = 1;
export const MAX_HISTOGRAM_BINS = 50;
export const DEFAULT_HISTOGRAM_BINS = 10;
/** A field is offered as a bar category only if it has at most this many
 * distinct values (so high-cardinality id/text columns are excluded). */
export const MAX_CATEGORY_CARDINALITY = 50;
/** The bar chart renders at most this many categories (top-N by value). */
export const MAX_BAR_CATEGORIES = 20;
/** The pie chart renders at most this many slices; the rest fold into "(other)". */
export const MAX_PIE_SLICES = 8;

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
export function computeHistogram(values: number[], binCount: number): HistogramResult | null {
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

/** Cap on scatter points actually rendered, to bound SVG node count. */
export const MAX_SCATTER_POINTS = 2000;

export interface ScatterResult {
  /** Points to render — a leading sample capped at `MAX_SCATTER_POINTS`. */
  points: ScatterPoint[];
  /** All valid (x, y) pairs; `points` is a sample of these when capped. */
  total: number;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

/**
 * Extract the (x, y) pairs where both columns hold a finite number. Returns null
 * when no row has both. Extents span every valid pair. When there are more than
 * `maxPoints`, `points` is an **evenly strided** subset (not the leading rows)
 * so a huge — and often spatially-ordered — layer renders a representative
 * sample rather than just its first features; `total` reports the full count.
 */
export function computeScatter(
  rows: ChartRow[],
  xKey: string,
  yKey: string,
  maxPoints: number = MAX_SCATTER_POINTS,
): ScatterResult | null {
  const all: ScatterPoint[] = [];
  let xMin = 0;
  let xMax = 0;
  let yMin = 0;
  let yMax = 0;
  for (const row of rows) {
    const x = toFiniteNumber(row.properties[xKey]);
    const y = toFiniteNumber(row.properties[yKey]);
    if (x === null || y === null) continue;
    if (all.length === 0) {
      xMin = xMax = x;
      yMin = yMax = y;
    } else {
      if (x < xMin) xMin = x;
      if (x > xMax) xMax = x;
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
    }
    all.push({ x, y });
  }
  if (all.length === 0) return null;

  let points = all;
  if (all.length > maxPoints) {
    const stride = Math.ceil(all.length / maxPoints);
    points = all.filter((_, index) => index % stride === 0);
  }
  return { points, total: all.length, xMin, xMax, yMin, yMax };
}

/**
 * Format a numeric axis label compactly: integers as-is, otherwise up to 3
 * significant-ish decimals with trailing zeros trimmed. Large/small magnitudes
 * fall back to exponential so labels stay short.
 */
export function formatAxisValue(value: number): string {
  if (!Number.isFinite(value)) return "";
  const abs = Math.abs(value);
  // Exponential for extreme magnitudes — checked before the integer path so a
  // huge integer (e.g. 9e15) doesn't print 16 digits and overflow the label.
  if (abs !== 0 && (abs < 1e-3 || abs >= 1e7)) {
    return value.toExponential(1);
  }
  if (Number.isInteger(value)) return String(value);
  return parseFloat(value.toFixed(3)).toString();
}

// A column also counts as categorical only when its distinct values are few:
// at most this many in absolute terms, OR at most this fraction of its non-null
// rows. This rejects mostly-unique id/text columns and continuous numeric fields
// (which have ~one distinct value per row) while still accepting genuine
// enumerations even in small datasets.
const CATEGORY_ABSOLUTE_LIMIT = 15;
const CATEGORY_RATIO = 0.5;

/**
 * Columns suitable as a bar-chart category: a field whose non-null values have
 * between one and `MAX_CATEGORY_CARDINALITY` distinct entries AND are repetitive
 * enough to be a category rather than an id (see the limits above). Low-
 * cardinality numeric codes (e.g. a year or class id) qualify; a continuous
 * numeric field or a unique-per-row text column does not.
 */
export function categoricalColumns(
  rows: ChartRow[],
  columns: string[],
  maxCardinality: number = MAX_CATEGORY_CARDINALITY,
): string[] {
  return columns.filter((key) => {
    const distinct = new Set<string>();
    let nonNull = 0;
    for (const row of rows) {
      const raw = row.properties[key];
      if (raw == null || raw === "") continue;
      nonNull += 1;
      distinct.add(String(raw));
      if (distinct.size > maxCardinality) return false;
    }
    if (distinct.size < 1) return false;
    // A field where every populated row is unique is an id, not a category —
    // reject it even in a small sample where the limit below would let it pass.
    if (nonNull > 1 && distinct.size === nonNull) return false;
    const limit = Math.max(CATEGORY_ABSOLUTE_LIMIT, nonNull * CATEGORY_RATIO);
    return distinct.size <= limit;
  });
}

export type BarAggregation = "count" | "sum" | "mean";

export interface BarDatum {
  label: string;
  /** The aggregated value the bar's length encodes. */
  value: number;
  /** How many rows fell into this category (independent of aggregation). */
  count: number;
}

export interface BarResult {
  bars: BarDatum[];
  /** Largest bar value, for scaling (>= 0). */
  maxValue: number;
  /** Smallest bar value; negative when sum/mean produce negatives. */
  minValue: number;
  /** Categories dropped past the top-N cap. */
  truncated: number;
}

/**
 * Group rows by a category field and aggregate. `count` tallies rows per
 * category; `sum`/`mean` reduce the finite values of `valueKey`. Bars are sorted
 * by value descending and capped at `maxBars` (the remainder is reported in
 * `truncated`). Null/blank category values are bucketed as "(blank)". Returns
 * null when there are no rows, or — for `sum`/`mean` — when no category has any
 * numeric value to aggregate (those categories are dropped rather than shown as
 * misleading zero bars).
 */
export function computeBar(
  rows: ChartRow[],
  categoryKey: string,
  aggregation: BarAggregation,
  valueKey: string | null,
  maxBars: number = MAX_BAR_CATEGORIES,
): BarResult | null {
  const groups = new Map<string, { count: number; sum: number; numericCount: number }>();
  for (const row of rows) {
    const raw = row.properties[categoryKey];
    const label = raw == null || raw === "" ? "(blank)" : String(raw);
    const group = groups.get(label) ?? { count: 0, sum: 0, numericCount: 0 };
    group.count += 1;
    if (aggregation !== "count" && valueKey) {
      const value = toFiniteNumber(row.properties[valueKey]);
      if (value !== null) {
        group.sum += value;
        group.numericCount += 1;
      }
    }
    groups.set(label, group);
  }
  if (groups.size === 0) return null;

  const all: BarDatum[] = [...groups.entries()]
    // For sum/mean, drop categories with no numeric samples rather than show a
    // misleading zero bar that could also displace a real category from top-N.
    .filter(([, group]) => aggregation === "count" || group.numericCount > 0)
    .map(([label, group]) => {
      let value = group.count;
      if (aggregation === "sum") value = group.sum;
      else if (aggregation === "mean") value = group.sum / group.numericCount;
      return { label, value, count: group.count };
    });
  if (all.length === 0) return null;
  all.sort((a, b) => b.value - a.value);

  const bars = all.slice(0, Math.max(1, maxBars));
  let maxValue = 0;
  let minValue = 0;
  for (const bar of bars) {
    if (bar.value > maxValue) maxValue = bar.value;
    if (bar.value < minValue) minValue = bar.value;
  }
  return { bars, maxValue, minValue, truncated: Math.max(0, all.length - bars.length) };
}

export interface PieSlice {
  label: string;
  /** The slice's share of the whole (count, or summed value). */
  value: number;
  /** How many rows fell into this slice. */
  count: number;
}

export interface PieResult {
  slices: PieSlice[];
  /** Sum of every slice value (the whole the slices divide). */
  total: number;
  /** Rows folded into the trailing "(other)" slice (0 when none). */
  otherCount: number;
}

/**
 * Group rows by a category field into pie slices. `count` tallies rows per
 * category; any other aggregation sums the finite values of `valueKey`. Because
 * a pie shows parts of a whole, only positive contributions are kept (negative
 * or zero sums are dropped). Slices are sorted by value descending and capped at
 * `maxSlices`; the remainder is merged into a single "(other)" slice rather than
 * dropped. Null/blank category values bucket as "(blank)". Returns null when no
 * positive slice survives.
 */
export function computePie(
  rows: ChartRow[],
  categoryKey: string,
  aggregation: BarAggregation,
  valueKey: string | null,
  maxSlices: number = MAX_PIE_SLICES,
): PieResult | null {
  const groups = new Map<string, { count: number; sum: number }>();
  for (const row of rows) {
    const raw = row.properties[categoryKey];
    const label = raw == null || raw === "" ? "(blank)" : String(raw);
    const group = groups.get(label) ?? { count: 0, sum: 0 };
    group.count += 1;
    if (aggregation !== "count" && valueKey) {
      const value = toFiniteNumber(row.properties[valueKey]);
      if (value !== null) group.sum += value;
    }
    groups.set(label, group);
  }
  if (groups.size === 0) return null;

  const all = [...groups.entries()]
    .map(([label, group]) => ({
      label,
      value: aggregation === "count" ? group.count : group.sum,
      count: group.count,
    }))
    .filter((slice) => slice.value > 0);
  if (all.length === 0) return null;
  all.sort((a, b) => b.value - a.value);

  // Floor at 2 so there is always a named slice plus the overflow bucket; a
  // limit of 1 would put every row under "(other)", which is meaningless.
  const limit = Math.max(2, maxSlices);
  let slices: PieSlice[] = all;
  let otherCount = 0;
  if (all.length > limit) {
    const head = all.slice(0, limit - 1);
    const tail = all.slice(limit - 1);
    const otherValue = tail.reduce((sum, slice) => sum + slice.value, 0);
    otherCount = tail.reduce((sum, slice) => sum + slice.count, 0);
    // Avoid a duplicate label (and a React key collision) if the data already
    // has a real "(other)" category among the shown slices.
    const foldLabel = head.some((slice) => slice.label === "(other)")
      ? "(other categories)"
      : "(other)";
    slices = [...head, { label: foldLabel, value: otherValue, count: otherCount }];
  }
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  if (total <= 0) return null;
  return { slices, total, otherCount };
}

export interface LinePoint {
  /** Original row index (x position). */
  index: number;
  value: number;
}

export interface LineResult {
  points: LinePoint[];
  min: number;
  max: number;
  /** Total row count, so x can span the full feature order. */
  length: number;
}

/**
 * The finite values of a numeric field plotted against original row order.
 * Rows without a finite value are skipped (leaving a gap), keeping each point's
 * x at its true feature index. Returns null when no row has a value.
 *
 * Like the other compute helpers, this runs synchronously over every row and is
 * meant for the in-memory feature sets the attribute table already holds; it
 * does not page very large layers (the rendered marker count is capped in the
 * dialog, but the path spans all points).
 */
export function computeLine(rows: ChartRow[], key: string): LineResult | null {
  const points: LinePoint[] = [];
  let min = Infinity;
  let max = -Infinity;
  let index = 0;
  for (const row of rows) {
    const value = toFiniteNumber(row.properties[key]);
    if (value !== null) {
      points.push({ index, value });
      if (value < min) min = value;
      if (value > max) max = value;
    }
    index += 1;
  }
  if (points.length === 0) return null;
  return { points, min, max, length: rows.length };
}

export interface BoxResult {
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
  count: number;
}

/** Linear-interpolation quantile of an already-sorted, non-empty array. */
function quantileSorted(sorted: number[], p: number): number {
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * p;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sorted[base + 1];
  return next === undefined ? sorted[base] : sorted[base] + rest * (next - sorted[base]);
}

/**
 * Five-number summary (min, Q1, median, Q3, max) of a set of values. Returns
 * null when empty. Sorts a copy of all values synchronously — intended for the
 * attribute table's in-memory feature sets, not as a pager for arbitrarily
 * large query results.
 */
export function computeBox(values: number[]): BoxResult | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    min: sorted[0],
    q1: quantileSorted(sorted, 0.25),
    median: quantileSorted(sorted, 0.5),
    q3: quantileSorted(sorted, 0.75),
    max: sorted[sorted.length - 1],
    count: sorted.length,
  };
}
