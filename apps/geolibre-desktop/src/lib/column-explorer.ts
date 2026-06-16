/**
 * Pure data helpers for the Column Explorer panel: roll every field of a layer
 * into a compact, at-a-glance summary (type, populated vs null, unique count,
 * numeric range, and a small distribution) the way MotherDuck's column explorer
 * does. This composes the existing field-statistics and chart helpers rather
 * than recomputing anything, so the explorer agrees with the Statistics and
 * Charts panels on what counts as a number. Kept free of any rendering or React
 * so it can be unit-tested in isolation.
 */

import {
  computeHistogram,
  numericValues,
  type ChartRow,
  type HistogramResult,
} from "./attribute-charts";
import { computeFieldStats, type FieldStats } from "./attribute-stats";

/** Bins used for a numeric column's distribution sparkline. */
export const COLUMN_EXPLORER_BINS = 12;
/** How many most-frequent values a text column lists in the explorer. */
export const COLUMN_EXPLORER_TOP_VALUES = 8;

export interface ColumnSummary {
  /** The field name. */
  key: string;
  /** Numeric or text statistics (count / nulls / unique / …). */
  stats: FieldStats;
  /**
   * Equal-width distribution of the field's finite numeric values, for the
   * sparkline. Null for text fields (which show their top values instead) and
   * when there is nothing to bin.
   */
  histogram: HistogramResult | null;
  /** Total rows considered (populated + null), for the fill ratio. */
  total: number;
}

/**
 * Summarize one field across `rows`: its statistics (numeric or text, chosen by
 * the same heuristic the Statistics/Charts panels use) plus a numeric
 * distribution when the field reads as numeric. Returns null only when the field
 * yields no statistics at all, so callers can skip it.
 */
export function summarizeColumn(
  rows: ChartRow[],
  key: string,
): ColumnSummary | null {
  const stats = computeFieldStats(rows, key, COLUMN_EXPLORER_TOP_VALUES);
  if (!stats) return null;
  const histogram =
    stats.kind === "numeric"
      ? computeHistogram(numericValues(rows, key), COLUMN_EXPLORER_BINS)
      : null;
  return { key, stats, histogram, total: rows.length };
}

/**
 * Summarize every field in `columns`, preserving their given order and dropping
 * any that yield no statistics. The single pass each column makes over `rows` is
 * synchronous, matching the in-memory feature sets the attribute table holds.
 */
export function summarizeColumns(
  rows: ChartRow[],
  columns: string[],
): ColumnSummary[] {
  const summaries: ColumnSummary[] = [];
  for (const key of columns) {
    const summary = summarizeColumn(rows, key);
    if (summary) summaries.push(summary);
  }
  return summaries;
}

/**
 * Rows that hold a value for the field (total minus nulls). For a numeric field
 * this includes the rows whose value was non-numeric text, which still count as
 * populated even though they are excluded from the numeric statistics.
 */
export function populatedCount(summary: ColumnSummary): number {
  return summary.total - summary.stats.nulls;
}
