/**
 * Data-driven Print Layout blocks (GH #1324): pure builders that turn a vector
 * layer's attribute rows into the drawable attribute-table and chart specs of
 * {@link LayoutOptions}. Row aggregation reuses the attribute Charts panel's
 * compute helpers, and the atlas page-extent filter reuses the atlas bounds
 * walk, so the page shows exactly what those features hold. Framework-free and
 * unit-testable; the canvas drawing lives in `print-layout.ts`.
 */
import booleanIntersects from "@turf/boolean-intersects";
import { feature, polygon } from "@turf/helpers";
import type { FeatureCollection, Geometry, Position } from "geojson";
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

/** How a data block narrows its rows to the current page extent. */
export type PageFilterMode = "all" | "contained" | "intersecting";

/** Reduce a feature collection to the property-bag rows the builders consume. */
export function layerRows(collection: Pick<FeatureCollection, "features">): ChartRow[] {
  return collection.features.map((f) => ({
    properties: (f.properties ?? {}) as Record<string, unknown>,
  }));
}

/**
 * The three 360° shifts that can carry a feature's longitude box onto the same
 * world copy as a page extent centred on `center`. A page extent comes from the
 * map's unwrapped coordinates, so after panning east it can sit several world
 * copies away from the canonical [-180, 180] range a feature is stored in;
 * testing only `0`/`±360` would reject those before the geometry check runs.
 */
function worldCopyOffsets(featureBounds: AtlasBounds, center: number): number[] {
  const featureCenter = (featureBounds[0] + featureBounds[2]) / 2;
  const nearest = Math.round((center - featureCenter) / 360) * 360;
  return [nearest - 360, nearest, nearest + 360];
}

/**
 * Unwrap a page extent so `west <= east`, the convention `geometryBounds` uses
 * for feature bounds. A page extent can come straight from `map.getBounds()`,
 * which reports `west > east` for a view straddling the antimeridian (west≈170,
 * east≈-170) — taken literally that is the ~340°-wide *other* side of the globe,
 * so both filters would test the wrong strip and drop every dateline feature.
 */
function unwrapBounds(bounds: AtlasBounds): AtlasBounds {
  const [west, south, east, north] = bounds;
  return west > east ? [west, south, east + 360, north] : bounds;
}

/**
 * The rows of the features whose geometry is fully within `bounds` —
 * the per-page filter for atlas data blocks. Takes {@link AtlasFeatureInfo}s
 * (from `collectAtlasFeatures`) rather than raw features so the per-vertex
 * geometry walk runs once per layer, not once per atlas page; features
 * without a usable geometry were already dropped there (they are nowhere on
 * the page). Full containment intentionally excludes features that only clip
 * the page edge, including features spanning multiple pages, which otherwise
 * produces surprising table rows for geometry whose visible sliver is easy to
 * miss.
 */
export function rowsWithinBounds(
  features: readonly AtlasFeatureInfo[],
  pageBounds: AtlasBounds,
): ChartRow[] {
  const bounds = unwrapBounds(pageBounds);
  const center = (bounds[0] + bounds[2]) / 2;
  const rows: ChartRow[] = [];
  for (const info of features) {
    let contained = false;
    for (const offset of worldCopyOffsets(info.bounds, center)) {
      if (
        bounds[0] <= info.bounds[0] + offset &&
        info.bounds[2] + offset <= bounds[2] &&
        bounds[1] <= info.bounds[1] &&
        info.bounds[3] <= bounds[3]
      ) {
        contained = true;
        break;
      }
    }
    if (!contained) continue;
    rows.push({ properties: info.properties });
  }
  return rows;
}

/** Shift longitudes onto the same world copy as an unwrapped page extent. */
function geometryNearLongitude(geometry: Geometry, center: number): Geometry {
  const shiftPosition = (position: Position): Position => {
    const shifted = [...position];
    while (shifted[0] - center > 180) shifted[0] -= 360;
    while (shifted[0] - center < -180) shifted[0] += 360;
    return shifted;
  };
  const shiftCoordinates = (coordinates: unknown): unknown =>
    Array.isArray(coordinates) && typeof coordinates[0] === "number"
      ? shiftPosition(coordinates as Position)
      : (coordinates as unknown[]).map(shiftCoordinates);
  if (geometry.type === "GeometryCollection") {
    return {
      ...geometry,
      geometries: geometry.geometries.map((part) => geometryNearLongitude(part, center)),
    };
  }
  return { ...geometry, coordinates: shiftCoordinates(geometry.coordinates) } as Geometry;
}

/** Rows whose geometry has any point in common with the page extent. */
export function rowsIntersectingBounds(
  features: readonly AtlasFeatureInfo[],
  pageBounds: AtlasBounds,
): ChartRow[] {
  const [west, south, east, north] = unwrapBounds(pageBounds);
  const extent = polygon([
    [
      [west, south],
      [east, south],
      [east, north],
      [west, north],
      [west, south],
    ],
  ]);
  const center = (west + east) / 2;
  return features
    .filter((info) => {
      const overlapOffset = worldCopyOffsets(info.bounds, center).find(
        (offset) =>
          info.bounds[0] + offset <= east &&
          west <= info.bounds[2] + offset &&
          info.bounds[1] <= north &&
          south <= info.bounds[3],
      );
      if (overlapOffset === undefined) return false;
      // The overwhelming common case needs no coordinate walk at all, but the
      // shortcut has to prove the *raw* coordinates already sit in the extent's
      // frame. `info.bounds` is unwrapped by `geometryBounds` (east past 180 for
      // a dateline feature), so a match at offset 0 says nothing about the
      // geometry it was derived from — a 179°→-179° line matches [180.25, 180.75]
      // at offset 0 while its raw coordinates describe the far side of the world.
      const alreadyInFrame =
        overlapOffset === 0 &&
        west >= -180 &&
        east <= 180 &&
        info.bounds[0] >= -180 &&
        info.bounds[2] <= 180;
      const geometry = alreadyInFrame
        ? info.geometry
        : geometryNearLongitude(info.geometry, center);
      // Print Layout runs over arbitrary user-supplied vector data, and unlike
      // the bbox-only filters `booleanIntersects` throws on degenerate geometry
      // (a ring with fewer than four positions, non-finite coordinates). This
      // predicate runs in a render-time `useMemo` on every pan/zoom, so one bad
      // feature must be excluded, not taken down the whole preview.
      try {
        return booleanIntersects(feature(geometry), extent);
      } catch {
        return false;
      }
    })
    .map((info) => ({ properties: info.properties }));
}

/**
 * Select the attribute row belonging to the current atlas coverage feature.
 * `AtlasPage.sourceIndex` is stable across filtering and sorting, and the row
 * array preserves the source collection's order, so the two align directly.
 */
export function rowForAtlasFeature(rows: readonly ChartRow[], sourceIndex: number): ChartRow[] {
  const row = rows[sourceIndex];
  return row ? [row] : [];
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
