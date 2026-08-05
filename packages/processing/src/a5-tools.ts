import type { FeatureCollection, Geometry } from "geojson";
import { bboxToWktPolygon, normalizeLonLatBbox, sqlIdent, sqlStr } from "./h3-tools";

/**
 * Approximate average A5 cell area (km²) at resolutions 0..30.
 * A5 cells are equal-area; counts grow by 4× per level from 12 root cells
 * (earth surface ≈ 5.101×10⁸ km²). Used only for auto-suggest / hard-cap
 * estimates before the DuckDB query runs.
 */
export const A5_AVG_AREA_KM2: number[] = Array.from({ length: 31 }, (_, res) => {
  return 510_065_621.724 / (12 * 4 ** res);
});

/** Soft target used when auto-suggesting a resolution. */
export const A5_TARGET_CELLS = 10_000;
/** Finest resolution the auto-suggester will pick. */
export const A5_MAX_SUGGESTED_RES = 12;
/** Hard ceiling: a grid larger than this aborts rather than running away. */
export const A5_HARD_CAP = 200_000;
/**
 * Max resolution offered in the processing dialog. Matches A5's
 * `MAX_RESOLUTION` (0–30); level 31 does not exist in the encoding.
 */
export const A5_MAX_TOOL_RES = 30;
/**
 * Max longitude span (degrees) per `a5_geometry_to_cells` call. Wider rings
 * (especially ±180) return empty or dateline-only cells in DuckDB A5.
 */
export const A5_MAX_POLYFILL_LON_SPAN = 90;

/** Estimated number of A5 cells covering `areaKm2` at `res`. */
export function estimateA5CellCount(areaKm2: number, res: number): number {
  const cellArea = A5_AVG_AREA_KM2[res];
  if (cellArea === undefined) return Number.POSITIVE_INFINITY;
  return areaKm2 / cellArea;
}

/** Finest resolution whose estimated cell count stays <= the target. */
export function suggestA5Resolution(
  areaKm2: number,
  targetCells = A5_TARGET_CELLS,
  maxRes = A5_MAX_SUGGESTED_RES,
): number {
  const capped = Math.min(maxRes, A5_MAX_TOOL_RES);
  for (let res = capped; res >= 0; res -= 1) {
    if (estimateA5CellCount(areaKm2, res) <= targetCells) return res;
  }
  return 0;
}

const GRID_SELECT =
  "SELECT a5_u64_to_hex(cell) AS a5, " +
  "CAST(ST_AsGeoJSON(a5_cell_to_geometry(cell)) AS VARCHAR) AS geojson FROM cells";

/**
 * Expand a compacted covering from `a5_geometry_to_cells` to a uniform
 * resolution. Without this, fully covered parents stay at coarser levels and
 * the output mixes cell sizes.
 */
function cellsFromGeomExpr(geomSql: string, res: number): string {
  return `unnest(a5_uncompact(a5_geometry_to_cells(${geomSql}, ${res}), ${res}))`;
}

/**
 * All cells at `res` from the 12 resolution-0 roots. Prefer this for full
 * longitude (±180): `a5_geometry_to_cells` returns an empty list for a single
 * world ring, and longitude strips also under-cover (gaps at poles / seams).
 */
function cellsFromRes0Expr(res: number): string {
  return `unnest(a5_uncompact(a5_get_res0_cells(), ${res}))`;
}

/** Wrap a `SELECT … AS cell` query; optionally `a5_compact` the result. */
function finalizeA5Cells(rawSelect: string, compact: boolean): string {
  if (!compact) {
    return `WITH cells AS (${rawSelect}) ` + GRID_SELECT;
  }
  return (
    `WITH raw AS (${rawSelect}), ` +
    `arr AS (SELECT list(cell) AS cells FROM raw), ` +
    `cells AS (SELECT unnest(a5_compact(cells)) AS cell FROM arr) ` +
    GRID_SELECT
  );
}

/** Grid SQL from a polygon WKT literal (used for bbox / viewport sources). */
export function buildA5GridFromWktSql(wkt: string, res: number, compact = false): string {
  return finalizeA5Cells(
    `SELECT ${cellsFromGeomExpr(`ST_GeomFromText(${sqlStr(wkt)})`, res)} AS cell`,
    compact,
  );
}

/**
 * Grid SQL from a lon/lat bbox.
 *
 * - Full longitude (`[-180, 180]` after normalize): enumerate via
 *   {@link cellsFromRes0Expr}, optionally filtering by latitude.
 * - Spans wider than {@link A5_MAX_POLYFILL_LON_SPAN}: slice into strips
 *   (a single wide ring returns empty or incomplete cells from DuckDB A5).
 * - Narrower spans: one WKT polyfill.
 */
export function buildA5GridFromBboxSql(
  bbox: [number, number, number, number],
  res: number,
  compact = false,
): string {
  const [w, s, e, n] = normalizeLonLatBbox(bbox);
  if (w === -180 && e === 180) {
    // Full globe in longitude. Filter by cell centroid latitude when the view
    // is not essentially ±90 (e.g. Web Mercator max ~±85).
    const fullLat = s <= -89.999 && n >= 89.999;
    if (fullLat) {
      return finalizeA5Cells(`SELECT ${cellsFromRes0Expr(res)} AS cell`, compact);
    }
    return finalizeA5Cells(
      `SELECT cell FROM (SELECT ${cellsFromRes0Expr(res)} AS cell) ` +
        `WHERE list_extract(a5_cell_to_lonlat(cell), 2) BETWEEN ${s} AND ${n}`,
      compact,
    );
  }
  const lonSpan = e - w;
  if (lonSpan <= A5_MAX_POLYFILL_LON_SPAN) {
    return buildA5GridFromWktSql(bboxToWktPolygon([w, s, e, n]), res, compact);
  }
  const parts = Math.ceil(lonSpan / A5_MAX_POLYFILL_LON_SPAN);
  const step = lonSpan / parts;
  const selects: string[] = [];
  for (let i = 0; i < parts; i += 1) {
    const left = w + i * step;
    const right = w + (i + 1) * step;
    const wkt = bboxToWktPolygon([left, s, right, n]);
    selects.push(`SELECT ${cellsFromGeomExpr(`ST_GeomFromText(${sqlStr(wkt)})`, res)} AS cell`);
  }
  return finalizeA5Cells(`SELECT DISTINCT cell FROM (${selects.join(" UNION ALL ")})`, compact);
}

/**
 * Grid SQL that unions all geometry from a registered source into one
 * (multi)polygon and fills it (used for the polyfill source). `sourceSql` is a
 * FROM-able expression whose geometry column is `geom` (DuckDB `ST_Read`).
 */
export function buildA5GridFromSourceSql(sourceSql: string, res: number, compact = false): string {
  // Union only polygonal geometries: a mixed layer would otherwise aggregate to
  // a GEOMETRYCOLLECTION that a5_geometry_to_cells rejects. The outer select
  // filters a NULL union result so a NULL geometry never reaches the a5 function.
  return finalizeA5Cells(
    `SELECT ${cellsFromGeomExpr("g", res)} AS cell FROM (` +
      `SELECT ST_Union_Agg(geom) AS g FROM ${sourceSql} ` +
      `WHERE geom IS NOT NULL AND ST_GeometryType(geom) IN ('POLYGON', 'MULTIPOLYGON')` +
      `) merged WHERE g IS NOT NULL`,
    compact,
  );
}

/** Supported point-binning aggregate operations (same set as H3 binning). */
export type A5AggOp = "count" | "sum" | "mean" | "min" | "max";

const AGG_FN: Record<Exclude<A5AggOp, "count">, string> = {
  sum: "sum",
  mean: "avg",
  min: "min",
  max: "max",
};

/**
 * Aggregate point geometry from `sourceSql` into A5 cells. Mirrors
 * {@link buildBinSql} but uses `a5_lonlat_to_cell` (lon, lat order) and
 * `a5_cell_to_geometry` for boundaries.
 */
export function buildA5BinSql(sourceSql: string, res: number, op: A5AggOp, field?: string): string {
  const fn = op === "count" ? undefined : AGG_FN[op];
  const aggSelect = fn && field ? `, ${fn}(CAST(${sqlIdent(field)} AS DOUBLE)) AS value` : "";
  const aggOut = fn && field ? ", value" : "";
  return (
    `WITH pts AS (SELECT ST_Centroid(geom) AS pt` +
    (field ? `, ${sqlIdent(field)}` : "") +
    ` FROM ${sourceSql} ` +
    `WHERE geom IS NOT NULL AND ST_GeometryType(geom) IN ('POINT', 'MULTIPOINT')), ` +
    `binned AS (SELECT a5_lonlat_to_cell(ST_X(pt), ST_Y(pt), ${res}) AS cell, ` +
    `count(*) AS count${aggSelect} FROM pts GROUP BY cell) ` +
    `SELECT a5_u64_to_hex(cell) AS a5, count${aggOut}, ` +
    `CAST(ST_AsGeoJSON(a5_cell_to_geometry(cell)) AS VARCHAR) AS geojson FROM binned`
  );
}

/**
 * Collect A5 cell IDs (hex strings) from `cellField` on `sourceSql` into an array.
 */
function a5CellArrayCte(sourceSql: string, cellField: string): string {
  const f = sqlIdent(cellField);
  return (
    `input AS (SELECT DISTINCT a5_hex_to_u64(CAST(${f} AS VARCHAR)) AS cell FROM ${sourceSql} ` +
    `WHERE ${f} IS NOT NULL AND CAST(${f} AS VARCHAR) <> ''), ` +
    `arr AS (SELECT list(cell) AS cells FROM input)`
  );
}

/** Compact A5 cells from a polygon cell layer (IDs in `cellField`, default `a5`). */
export function buildA5CompactSql(sourceSql: string, cellField = "a5"): string {
  return (
    `WITH ${a5CellArrayCte(sourceSql, cellField)}, ` +
    `cells AS (SELECT unnest(a5_compact(cells)) AS cell FROM arr) ` +
    GRID_SELECT
  );
}

/** Expand (uncompact) A5 cells to a uniform `res`. */
export function buildA5ExpandSql(sourceSql: string, res: number, cellField = "a5"): string {
  return (
    `WITH ${a5CellArrayCte(sourceSql, cellField)}, ` +
    `cells AS (SELECT unnest(a5_uncompact(cells, ${res})) AS cell FROM arr) ` +
    GRID_SELECT
  );
}

/** Count of cells that {@link buildA5ExpandSql} would emit (for the hard-cap guard). */
export function buildA5ExpandCountSql(sourceSql: string, res: number, cellField = "a5"): string {
  return (
    `WITH ${a5CellArrayCte(sourceSql, cellField)} ` +
    `SELECT coalesce(len(a5_uncompact(cells, ${res})), 0) AS n FROM arr`
  );
}

/** Parse a DuckDB `ST_AsGeoJSON` cell (VARCHAR or already-decoded JSON object). */
function geometryFromGeoJsonCell(raw: unknown): Geometry | null {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as Geometry;
    } catch {
      return null;
    }
  }
  if (raw && typeof raw === "object" && "type" in raw) {
    return raw as Geometry;
  }
  return null;
}

/** Build a FeatureCollection from rows carrying `a5`, optional `count`/`value`, and `geojson`. */
export function a5RowsToFeatureCollection(rows: Record<string, unknown>[]): FeatureCollection {
  const features = [];
  for (const row of rows) {
    const geometry = geometryFromGeoJsonCell(row.geojson);
    if (!geometry) continue;
    const properties: Record<string, unknown> = { a5: String(row.a5) };
    if (row.count !== undefined && row.count !== null) {
      properties.count = Number(row.count);
    }
    if (row.value !== undefined && row.value !== null) {
      properties.value = Number(row.value);
    }
    features.push({
      type: "Feature" as const,
      geometry,
      properties,
    });
  }
  return { type: "FeatureCollection", features };
}
