import type { FeatureCollection, Geometry } from "geojson";
import { unwrapAntimeridianGeometry } from "./antimeridian";
import type { ProcessingAlgorithm } from "./types";

/** Average area (km^2) of an H3 cell at each resolution 0..15 (official values). */
export const H3_AVG_AREA_KM2: number[] = [
  4_357_449.416078381, 609_788.441794133, 86_801.780398997, 12_393.434655088, 1_770.347654491,
  252.903858182, 36.129062164, 5.16129336, 0.737327598, 0.105332513, 0.015047502, 0.002149643,
  0.000307092, 0.00004387, 0.000006267, 0.000000895,
];

/** Soft target used when auto-suggesting a resolution. */
export const H3_TARGET_CELLS = 10_000;
/** Finest resolution the auto-suggester will pick. */
export const H3_MAX_SUGGESTED_RES = 12;
/** Hard ceiling: a grid larger than this aborts rather than running away. */
export const H3_HARD_CAP = 200_000;

const KM_PER_DEG_LAT = 110.574;
const KM_PER_DEG_LON_EQ = 111.32;

/** Rough planar area (km^2) of a [west, south, east, north] bbox. */
export function bboxAreaKm2(bbox: [number, number, number, number]): number {
  const [w, s, e, n] = bbox;
  const midLat = (s + n) / 2;
  const kmPerDegLon = KM_PER_DEG_LON_EQ * Math.cos((midLat * Math.PI) / 180);
  // Handle a bbox that crosses the antimeridian (west > east, e.g. a viewport
  // returning west=170, east=-170): wrap the longitude span into [0, 360) so the
  // area isn't inflated ~17x and the hard-cap guard doesn't falsely trip.
  let lonSpan = e - w;
  if (lonSpan < 0) lonSpan += 360;
  const width = lonSpan * kmPerDegLon;
  const height = Math.abs(n - s) * KM_PER_DEG_LAT;
  return Math.max(width * height, 0);
}

/** Estimated number of H3 cells covering `areaKm2` at `res`. */
export function estimateCellCount(areaKm2: number, res: number): number {
  const cellArea = H3_AVG_AREA_KM2[res];
  // Fail safe for an out-of-range resolution: return Infinity so a downstream
  // cap check (`estimate > H3_HARD_CAP`) trips rather than silently passing on a
  // `NaN` comparison. Internal callers validate the range first via
  // `resolveResolution`; this guards external callers.
  if (cellArea === undefined) return Number.POSITIVE_INFINITY;
  return areaKm2 / cellArea;
}

/** Finest resolution whose estimated cell count stays <= the target. */
export function suggestResolution(
  areaKm2: number,
  targetCells = H3_TARGET_CELLS,
  maxRes = H3_MAX_SUGGESTED_RES,
): number {
  for (let res = maxRes; res >= 0; res -= 1) {
    if (estimateCellCount(areaKm2, res) <= targetCells) return res;
  }
  return 0;
}

export function sqlStr(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function sqlIdent(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/** A closed POLYGON WKT ring for a [west, south, east, north] bbox. */
export function bboxToWktPolygon(bbox: [number, number, number, number]): string {
  const [w, s, e, n] = bbox;
  return `POLYGON((${w} ${s}, ${e} ${s}, ${e} ${n}, ${w} ${n}, ${w} ${s}))`;
}

/**
 * Clamp a lon/lat bbox into WGS84. Spans wider than 180° of longitude (typical
 * zoomed-out MapLibre viewports / world copies) collapse to [-180, 180].
 * Edges outside ±180° also collapse to the full-width path so clipping does
 * not silently drop coverage (e.g. west=-190, east=-10).
 * Callers that polyfill must still split that full-width ring — DuckDB H3
 * treats `POLYGON((-180 … 180 …))` as a dateline sliver (~tens of cells).
 */
export function normalizeLonLatBbox(
  bbox: [number, number, number, number],
): [number, number, number, number] {
  let [west, south, east, north] = bbox;
  south = Math.max(-90, Math.min(90, south));
  north = Math.max(-90, Math.min(90, north));
  if (south > north) [south, north] = [north, south];

  let lonSpan = east - west;
  if (lonSpan < 0) lonSpan += 360;
  if (lonSpan > 180 || west < -180 || east > 180 || west > 180 || east < -180) {
    return [-180, south, 180, north];
  }

  west = Math.max(-180, Math.min(180, west));
  east = Math.max(-180, Math.min(180, east));
  return [west, south, east, north];
}

const GRID_SELECT =
  "SELECT h3_h3_to_string(cell) AS h3, " +
  "ST_AsGeoJSON(ST_GeomFromText(h3_cell_to_boundary_wkt(cell))) AS geojson FROM cells";

/**
 * Prefer the experimental polyfill with overlap containment. The legacy
 * `h3_polygon_wkt_to_cells` (center containment) returns an empty list when the
 * polygon is smaller than a cell, and also for near-global ±180° rings that
 * H3's center algorithm mishandles.
 */
function polyfillUnnest(wktSql: string, res: number): string {
  return `unnest(h3_polygon_wkt_to_cells_experimental(${wktSql}, ${res}, 'overlap'))`;
}

/** Wrap a `SELECT … AS cell` query; optionally `h3_compact_cells` the result. */
function finalizeH3Cells(rawSelect: string, compact: boolean): string {
  if (!compact) {
    return `WITH cells AS (${rawSelect}) ` + GRID_SELECT;
  }
  return (
    `WITH raw AS (${rawSelect}), ` +
    `arr AS (SELECT list(cell) AS cells FROM raw), ` +
    `cells AS (SELECT unnest(h3_compact_cells(cells)) AS cell FROM arr) ` +
    GRID_SELECT
  );
}

/** Grid SQL from a polygon WKT literal (used for bbox / viewport sources). */
export function buildGridFromWktSql(wkt: string, res: number, compact = false): string {
  return finalizeH3Cells(`SELECT ${polyfillUnnest(sqlStr(wkt), res)} AS cell`, compact);
}

/**
 * Grid SQL from a lon/lat bbox. After {@link normalizeLonLatBbox}, a whole-world
 * request is [-180, s, 180, n]; a single ring polyfills to a dateline sliver, so
 * that case is split into western/eastern hemispheres and unioned.
 */
export function buildGridFromBboxSql(
  bbox: [number, number, number, number],
  res: number,
  compact = false,
): string {
  const [w, s, e, n] = normalizeLonLatBbox(bbox);
  if (w === -180 && e === 180) {
    const left = bboxToWktPolygon([-180, s, 0, n]);
    const right = bboxToWktPolygon([0, s, 180, n]);
    return finalizeH3Cells(
      `SELECT DISTINCT cell FROM (` +
        `SELECT ${polyfillUnnest(sqlStr(left), res)} AS cell ` +
        `UNION ALL ` +
        `SELECT ${polyfillUnnest(sqlStr(right), res)} AS cell` +
        `)`,
      compact,
    );
  }
  return buildGridFromWktSql(bboxToWktPolygon([w, s, e, n]), res, compact);
}

/**
 * Grid SQL that unions all geometry from a registered source into one
 * (multi)polygon and fills it (used for the polyfill source). `sourceSql` is a
 * FROM-able expression whose geometry column is `geom` (DuckDB `ST_Read`).
 */
export function buildGridFromSourceSql(sourceSql: string, res: number, compact = false): string {
  // Union only polygonal geometries: a mixed layer would otherwise aggregate to
  // a GEOMETRYCOLLECTION that the H3 polyfill rejects. The `cells` CTE
  // filters a NULL union result (no polygons survived) so a NULL WKT never
  // reaches the h3 function, which can throw on NULL.
  return finalizeH3Cells(
    `SELECT ${polyfillUnnest("wkt", res)} AS cell FROM (` +
      `SELECT ST_AsText(ST_Union_Agg(geom)) AS wkt FROM ${sourceSql} ` +
      `WHERE geom IS NOT NULL AND ST_GeometryType(geom) IN ('POLYGON', 'MULTIPOLYGON')` +
      `) merged WHERE wkt IS NOT NULL`,
    compact,
  );
}

/** Supported point-binning aggregate operations. */
export type H3AggOp = "count" | "sum" | "mean" | "min" | "max";

/** Valid aggregate operations, used to validate the `aggOp` parameter. */
export const H3_AGG_OPS: readonly H3AggOp[] = ["count", "sum", "mean", "min", "max"];

const AGG_FN: Record<Exclude<H3AggOp, "count">, string> = {
  sum: "sum",
  mean: "avg",
  min: "min",
  max: "max",
};

/**
 * Aggregate point geometry from `sourceSql` (geometry column `geom`) into H3
 * cells. `op` is one of count/sum/mean/min/max; a field is required for all but
 * count. Both `POINT` and `MULTIPOINT` geometries are binned (by centroid).
 */
export function buildBinSql(sourceSql: string, res: number, op: H3AggOp, field?: string): string {
  const fn = op === "count" ? undefined : AGG_FN[op];
  const aggSelect = fn && field ? `, ${fn}(CAST(${sqlIdent(field)} AS DOUBLE)) AS value` : "";
  const aggOut = fn && field ? ", value" : "";
  // ST_Centroid handles both POINT (centroid is the point itself) and
  // MULTIPOINT, so MultiPoint features are binned by their centroid rather than
  // being silently dropped by an `ST_X`/`ST_Y`-on-a-point-only filter.
  return (
    `WITH pts AS (SELECT ST_Centroid(geom) AS pt` +
    (field ? `, ${sqlIdent(field)}` : "") +
    ` FROM ${sourceSql} ` +
    `WHERE geom IS NOT NULL AND ST_GeometryType(geom) IN ('POINT', 'MULTIPOINT')), ` +
    `binned AS (SELECT h3_latlng_to_cell(ST_Y(pt), ST_X(pt), ${res}) AS cell, ` +
    `count(*) AS count${aggSelect} FROM pts GROUP BY cell) ` +
    `SELECT h3_h3_to_string(cell) AS h3, count${aggOut}, ` +
    `ST_AsGeoJSON(ST_GeomFromText(h3_cell_to_boundary_wkt(cell))) AS geojson FROM binned`
  );
}

/**
 * Collect H3 cell IDs from `cellField` on `sourceSql` into an array.
 * `sourceSql` is a FROM-able expression (DuckDB `ST_Read`) with that column.
 */
function h3CellArrayCte(sourceSql: string, cellField: string): string {
  const f = sqlIdent(cellField);
  return (
    `input AS (SELECT DISTINCT h3_string_to_h3(CAST(${f} AS VARCHAR)) AS cell FROM ${sourceSql} ` +
    `WHERE ${f} IS NOT NULL AND CAST(${f} AS VARCHAR) <> ''), ` +
    `arr AS (SELECT list(cell) AS cells FROM input)`
  );
}

/** Compact H3 cells from a polygon cell layer (IDs in `cellField`, default `h3`). */
export function buildH3CompactSql(sourceSql: string, cellField = "h3"): string {
  return (
    `WITH ${h3CellArrayCte(sourceSql, cellField)}, ` +
    `cells AS (SELECT unnest(h3_compact_cells(cells)) AS cell FROM arr) ` +
    GRID_SELECT
  );
}

/**
 * Expand (uncompact) H3 cells to a uniform `res`. Cells already finer than
 * `res` are rejected by the H3 extension.
 */
export function buildH3ExpandSql(sourceSql: string, res: number, cellField = "h3"): string {
  return (
    `WITH ${h3CellArrayCte(sourceSql, cellField)}, ` +
    `cells AS (SELECT unnest(h3_uncompact_cells(cells, ${res})) AS cell FROM arr) ` +
    GRID_SELECT
  );
}

/** Count of cells that {@link buildH3ExpandSql} would emit (for the hard-cap guard). */
export function buildH3ExpandCountSql(sourceSql: string, res: number, cellField = "h3"): string {
  return (
    `WITH ${h3CellArrayCte(sourceSql, cellField)} ` +
    `SELECT coalesce(len(h3_uncompact_cells(cells, ${res})), 0) AS n FROM arr`
  );
}

/** Build a FeatureCollection from rows carrying `h3`, optional `count`/`value`, and `geojson`. */
export function rowsToFeatureCollection(
  rows: Record<string, unknown>[],
  fixAntimeridian = true,
): FeatureCollection {
  const features = [];
  for (const row of rows) {
    const raw = row.geojson;
    if (typeof raw !== "string") continue;
    let geometry: Geometry;
    try {
      geometry = JSON.parse(raw) as Geometry;
    } catch {
      // ST_AsGeoJSON should always emit valid JSON; skip a row rather than
      // throwing out of this exported pure helper if it ever does not.
      continue;
    }
    const properties: Record<string, unknown> = { h3: String(row.h3) };
    if (row.count !== undefined && row.count !== null) {
      properties.count = Number(row.count);
    }
    if (row.value !== undefined && row.value !== null) {
      properties.value = Number(row.value);
    }
    features.push({
      type: "Feature" as const,
      geometry: fixAntimeridian ? unwrapAntimeridianGeometry(geometry) : geometry,
      properties,
    });
  }
  return { type: "FeatureCollection", features };
}

export const H3_TOOLS: ProcessingAlgorithm[] = [];

export function getH3Tool(id: string): ProcessingAlgorithm | undefined {
  return H3_TOOLS.find((tool) => tool.id === id);
}
