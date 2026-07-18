/**
 * Data-driven Print Layout blocks (GH #1324): pure builders that turn a vector
 * layer's attribute rows into the drawable attribute-table and chart specs of
 * {@link LayoutOptions}. Row aggregation reuses the attribute Charts panel's
 * compute helpers, and the atlas page-extent filter reuses the atlas bounds
 * walk, so the page shows exactly what those features hold. Framework-free and
 * unit-testable; the canvas drawing lives in `print-layout.ts`.
 */
import type { FeatureCollection } from "geojson";
import {
  computeBar,
  computeLine,
  computePie,
  toFiniteNumber,
  type BarAggregation,
  type ChartRow,
} from "./attribute-charts";
import { type AtlasBounds, type AtlasFeatureInfo } from "./print-atlas";
import { paletteColor } from "../components/panels/charts/chart-colors";
import type { DataChartData } from "./print-layout";

/** Hard ceiling on table rows drawn on the page. */
export const MAX_TABLE_ROWS = 50;
/** Default table row limit offered by the dialog. */
export const DEFAULT_TABLE_ROWS = 10;
/** Columns shown when the user has not picked any explicitly. */
export const DEFAULT_TABLE_COLUMNS = 4;

/** Reduce a feature collection to the property-bag rows the builders consume. */
export function layerRows(collection: Pick<FeatureCollection, "features">): ChartRow[] {
  return collection.features.map((feature) => ({
    properties: (feature.properties ?? {}) as Record<string, unknown>,
  }));
}

/**
 * Whether two `[west, south, east, north]` boxes overlap (touching counts).
 * The two boxes need not share a longitude convention: `geometryBounds`
 * returns shifted boxes (east > 180) for antimeridian-crossing features, and
 * `map.getBounds()` can return unwrapped longitudes near the dateline, so the
 * test also tries `b` shifted by ±360° — the same ground box, one world copy
 * over. (A box that is degenerate `west > east` without being unwrapped is
 * not supported, matching the print-extent tool's documented limitation.)
 */
export function boundsIntersect(a: AtlasBounds, b: AtlasBounds): boolean {
  if (a[1] > b[3] || b[1] > a[3]) return false;
  for (const offset of [0, -360, 360]) {
    if (a[0] <= b[2] + offset && b[0] + offset <= a[2]) return true;
  }
  return false;
}

/**
 * The rows of the features whose geometry bounding box intersects `bounds` —
 * the per-page filter for atlas data blocks. Takes {@link AtlasFeatureInfo}s
 * (from `collectAtlasFeatures`) rather than raw features so the per-vertex
 * geometry walk runs once per layer, not once per atlas page; features
 * without a usable geometry were already dropped there (they are nowhere on
 * the page). A bbox test (not an exact intersection) matches how atlas pages
 * themselves are framed.
 */
export function rowsWithinBounds(
  features: readonly AtlasFeatureInfo[],
  bounds: AtlasBounds,
): ChartRow[] {
  const rows: ChartRow[] = [];
  for (const info of features) {
    if (!boundsIntersect(info.bounds, bounds)) continue;
    rows.push({ properties: info.properties });
  }
  return rows;
}

/** Format one attribute value for a table cell (blank for null/undefined). */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

/** Whether an attribute value counts as missing for sorting purposes. */
function isMissing(value: unknown): boolean {
  return value === null || value === undefined || value === "";
}

/** Numeric-aware attribute comparison; missing values sort last. */
function compareCells(a: unknown, b: unknown): number {
  const aMissing = isMissing(a);
  const bMissing = isMissing(b);
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;
  const an = toFiniteNumber(a);
  const bn = toFiniteNumber(b);
  if (an !== null && bn !== null) return an === bn ? 0 : an < bn ? -1 : 1;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

export interface TableBlockConfig {
  /** Columns to show, in order. */
  columns: string[];
  /** Attribute to order rows by; blank keeps the source row order. */
  sortField?: string;
  /** Reverse the sort (missing values always sort last). */
  sortDescending?: boolean;
  /** Row limit (clamped to 1..{@link MAX_TABLE_ROWS}). */
  maxRows?: number;
}

export interface TableBlockData {
  columns: string[];
  /** Cell display strings, aligned with {@link columns}. */
  rows: string[][];
  /** Source rows beyond the limit (0 when everything fit). */
  truncated: number;
}

/**
 * Build the table block's display data: sort, cap to the row limit, and
 * stringify cells. Returns null when there are no rows or no columns, so the
 * dialog can skip the block entirely instead of drawing an empty panel.
 */
export function buildTableBlock(rows: ChartRow[], config: TableBlockConfig): TableBlockData | null {
  if (rows.length === 0 || config.columns.length === 0) return null;
  let ordered = rows;
  const { sortField } = config;
  if (sortField) {
    const sign = config.sortDescending ? -1 : 1;
    ordered = [...rows].sort((a, b) => {
      const av = a.properties[sortField];
      const bv = b.properties[sortField];
      const cmp = compareCells(av, bv);
      // Missing values stay last in both directions (same convention as the
      // atlas page sort), so only present-vs-present flips with the sign.
      return isMissing(av) || isMissing(bv) ? cmp : cmp * sign;
    });
  }
  const requested = Math.trunc(config.maxRows ?? DEFAULT_TABLE_ROWS);
  const limit = Number.isFinite(requested)
    ? Math.max(1, Math.min(MAX_TABLE_ROWS, requested))
    : DEFAULT_TABLE_ROWS;
  const shown = ordered.slice(0, limit);
  return {
    columns: config.columns,
    rows: shown.map((row) => config.columns.map((column) => cellText(row.properties[column]))),
    truncated: Math.max(0, ordered.length - shown.length),
  };
}

export type ChartBlockType = "bar" | "pie" | "line";

export interface ChartBlockConfig {
  type: ChartBlockType;
  /** Grouping field (bar/pie). */
  categoryField?: string;
  /** How bar/pie values reduce their groups. */
  aggregation?: BarAggregation;
  /** Numeric field summed/averaged (bar/pie) or plotted (line). */
  valueField?: string;
}

/**
 * Build the chart block's drawable data from attribute rows, reusing the
 * Charts panel's aggregation helpers (top-N capping and the "(other)" fold
 * included) and its categorical palette. Returns null when the configuration
 * is incomplete or no chartable data survives, so nothing is drawn.
 */
export function buildChartBlock(rows: ChartRow[], config: ChartBlockConfig): DataChartData | null {
  if (rows.length === 0) return null;
  if (config.type === "line") {
    if (!config.valueField) return null;
    const line = computeLine(rows, config.valueField);
    if (!line) return null;
    return { kind: "line", ...line, color: paletteColor(0) };
  }
  if (!config.categoryField) return null;
  const aggregation = config.aggregation ?? "count";
  const valueField = aggregation === "count" ? null : (config.valueField ?? null);
  if (aggregation !== "count" && !valueField) return null;
  if (config.type === "pie") {
    const pie = computePie(rows, config.categoryField, aggregation, valueField);
    if (!pie) return null;
    return {
      kind: "pie",
      slices: pie.slices.map((slice, i) => ({
        label: slice.label,
        value: slice.value,
        color: paletteColor(i),
      })),
      total: pie.total,
    };
  }
  const bar = computeBar(rows, config.categoryField, aggregation, valueField);
  if (!bar) return null;
  return {
    kind: "bar",
    bars: bar.bars.map((datum, i) => ({
      label: datum.label,
      value: datum.value,
      color: paletteColor(i),
    })),
    maxValue: bar.maxValue,
    minValue: bar.minValue,
    truncated: bar.truncated,
  };
}
