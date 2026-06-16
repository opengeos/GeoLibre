/**
 * Pure data helpers for the attribute table's field-statistics summary panel:
 * detect whether a field reads as numeric or text and compute a compact summary
 * for it (count / nulls / min / max / mean / median / std / sum / unique for
 * numbers; count / nulls / unique / most-frequent values for text). Kept free of
 * any rendering or React so they can be unit-tested in isolation, and built on
 * the same `{ properties }` rows and numeric coercion the Charts panel uses so
 * the two panels agree on what counts as a number.
 */

import { numericColumns, toFiniteNumber, type ChartRow } from "./attribute-charts";

export interface NumericFieldStats {
  kind: "numeric";
  /** How many rows hold a finite numeric value. */
  count: number;
  /** Rows whose value is null/undefined or an empty/blank string. */
  nulls: number;
  /** Non-null rows whose value is not a finite number (e.g. stray text). */
  nonNumeric: number;
  /** Distinct finite numeric values. */
  unique: number;
  min: number;
  max: number;
  mean: number;
  median: number;
  /** Sample standard deviation (n − 1); 0 when fewer than two values. */
  std: number;
  sum: number;
}

export interface TextValueCount {
  value: string;
  count: number;
}

export interface TextFieldStats {
  kind: "text";
  /** How many rows hold a non-null, non-blank value. */
  count: number;
  /** Rows whose value is null/undefined or an empty/blank string. */
  nulls: number;
  /** Distinct non-null values (compared as strings). */
  unique: number;
  /** Most frequent values, descending by count then by value. */
  top: TextValueCount[];
}

export type FieldStats = NumericFieldStats | TextFieldStats;

/** How many most-frequent values a text summary lists by default. */
export const DEFAULT_TOP_VALUES = 5;

/** True when a value reads as null for statistics: nullish or a blank string. */
export function isBlank(value: unknown): boolean {
  return value == null || (typeof value === "string" && value.trim() === "");
}

/**
 * Summary statistics for a finite numeric sample. `nulls`/`nonNumeric` default
 * to 0 and let the caller fold in the rows that never produced a number, so this
 * stays a pure reduction over the values it was handed. Returns null only when
 * there are no values to summarize.
 */
export function computeNumericStats(
  values: number[],
  nulls = 0,
  nonNumeric = 0,
): NumericFieldStats | null {
  if (values.length === 0) return null;

  let min = values[0];
  let max = values[0];
  let sum = 0;
  const distinct = new Set<number>();
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
    sum += value;
    distinct.add(value);
  }
  const mean = sum / values.length;

  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];

  // Sample standard deviation (divide by n − 1, matching pandas/Excel STDEV);
  // undefined for a single value, reported as 0.
  let std = 0;
  if (values.length > 1) {
    let sumSq = 0;
    for (const value of values) {
      const diff = value - mean;
      sumSq += diff * diff;
    }
    std = Math.sqrt(sumSq / (values.length - 1));
  }

  return {
    kind: "numeric",
    count: values.length,
    nulls,
    nonNumeric,
    unique: distinct.size,
    min,
    max,
    mean,
    median,
    std,
    sum,
  };
}

/**
 * Summary statistics for a text/categorical field across `rows`: how many rows
 * are populated vs blank, how many distinct values there are, and the
 * `topCount` most frequent values (ties broken alphabetically for a stable
 * order). Values are compared by their string form so mixed types collapse the
 * way the table renders them.
 */
export function computeTextStats(
  rows: ChartRow[],
  key: string,
  topCount: number = DEFAULT_TOP_VALUES,
): TextFieldStats {
  const counts = new Map<string, number>();
  let nulls = 0;
  for (const row of rows) {
    const raw = row.properties[key];
    if (isBlank(raw)) {
      nulls += 1;
      continue;
    }
    const value = String(raw);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  let count = 0;
  for (const n of counts.values()) count += n;

  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, Math.max(0, topCount))
    .map(([value, n]) => ({ value, count: n }));

  return { kind: "text", count, nulls, unique: counts.size, top };
}

/**
 * Summary statistics for one field, choosing the numeric or text shape from the
 * same heuristic the Charts panel uses (`numericColumns`): a field counts as
 * numeric when enough of its populated rows parse as finite numbers. Numeric
 * fields fold their blank and non-numeric row counts into the result. Returns
 * null when `key` is not present, so callers can show an empty state.
 */
export function computeFieldStats(
  rows: ChartRow[],
  key: string,
  topCount: number = DEFAULT_TOP_VALUES,
): FieldStats | null {
  const isNumeric = numericColumns(rows, [key]).length > 0;
  if (!isNumeric) return computeTextStats(rows, key, topCount);

  const values: number[] = [];
  let nulls = 0;
  let nonNumeric = 0;
  for (const row of rows) {
    const raw = row.properties[key];
    if (isBlank(raw)) {
      nulls += 1;
      continue;
    }
    const next = toFiniteNumber(raw);
    if (next === null) nonNumeric += 1;
    else values.push(next);
  }
  return computeNumericStats(values, nulls, nonNumeric);
}

/**
 * Format a statistic for display: integers as-is, other finite numbers to a
 * trimmed fixed precision, with exponential notation for extreme magnitudes so
 * the readout stays compact. Mirrors the Charts panel's axis formatting but
 * keeps a little more precision (means/std are rarely whole numbers).
 */
export function formatStatValue(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (Number.isInteger(value)) return value.toLocaleString();
  const abs = Math.abs(value);
  if (abs !== 0 && (abs < 1e-4 || abs >= 1e9)) return value.toExponential(3);
  return parseFloat(value.toFixed(4)).toLocaleString(undefined, {
    maximumFractionDigits: 4,
  });
}
