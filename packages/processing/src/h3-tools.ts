import type { FeatureCollection, Geometry } from "geojson";

/** Average area (km^2) of an H3 cell at each resolution 0..15 (official values). */
export const H3_AVG_AREA_KM2: number[] = [
  4_357_449.416078381, 609_788.441794133, 86_801.780398997, 12_393.434655088,
  1_770.347654491, 252.903858182, 36.129062164, 5.16129336, 0.737327598,
  0.105332513, 0.015047502, 0.002149643, 0.000307092, 0.00004387, 0.000006267,
  0.000000895,
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
  const width = Math.abs(e - w) * kmPerDegLon;
  const height = Math.abs(n - s) * KM_PER_DEG_LAT;
  return Math.max(width * height, 0);
}

/** Estimated number of H3 cells covering `areaKm2` at `res`. */
export function estimateCellCount(areaKm2: number, res: number): number {
  return areaKm2 / H3_AVG_AREA_KM2[res];
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

function sqlStr(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlIdent(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/** A closed POLYGON WKT ring for a [west, south, east, north] bbox. */
export function bboxToWktPolygon(bbox: [number, number, number, number]): string {
  const [w, s, e, n] = bbox;
  return `POLYGON((${w} ${s}, ${e} ${s}, ${e} ${n}, ${w} ${n}, ${w} ${s}))`;
}

const GRID_SELECT =
  "SELECT h3_h3_to_string(cell) AS h3, " +
  "ST_AsGeoJSON(ST_GeomFromText(h3_cell_to_boundary_wkt(cell))) AS geojson FROM cells";

/** Grid SQL from a polygon WKT literal (used for bbox / viewport sources). */
export function buildGridFromWktSql(wkt: string, res: number): string {
  return (
    `WITH cells AS (SELECT unnest(h3_polygon_wkt_to_cells(${sqlStr(wkt)}, ${res})) AS cell) ` +
    GRID_SELECT
  );
}

/**
 * Grid SQL that unions all geometry from a registered source into one
 * (multi)polygon and fills it (used for the polyfill source). `sourceSql` is a
 * FROM-able expression whose geometry column is `geom` (DuckDB `ST_Read`).
 */
export function buildGridFromSourceSql(sourceSql: string, res: number): string {
  return (
    `WITH merged AS (SELECT ST_AsText(ST_Union_Agg(geom)) AS wkt FROM ${sourceSql}), ` +
    `cells AS (SELECT unnest(h3_polygon_wkt_to_cells((SELECT wkt FROM merged), ${res})) AS cell) ` +
    GRID_SELECT
  );
}

const AGG_FN: Record<string, string> = {
  sum: "sum",
  mean: "avg",
  min: "min",
  max: "max",
};

/**
 * Aggregate point geometry from `sourceSql` (geometry column `geom`) into H3
 * cells. `op` is one of count/sum/mean/min/max; a field is required for all but
 * count.
 */
export function buildBinSql(
  sourceSql: string,
  res: number,
  op: string,
  field?: string,
): string {
  const fn = AGG_FN[op];
  const aggSelect =
    fn && field ? `, ${fn}(CAST(${sqlIdent(field)} AS DOUBLE)) AS value` : "";
  const aggOut = fn && field ? ", value" : "";
  return (
    `WITH pts AS (SELECT * FROM ${sourceSql} ` +
    `WHERE geom IS NOT NULL AND ST_GeometryType(geom) = 'POINT'), ` +
    `binned AS (SELECT h3_latlng_to_cell(ST_Y(geom), ST_X(geom), ${res}) AS cell, ` +
    `count(*) AS count${aggSelect} FROM pts GROUP BY cell) ` +
    `SELECT h3_h3_to_string(cell) AS h3, count${aggOut}, ` +
    `ST_AsGeoJSON(ST_GeomFromText(h3_cell_to_boundary_wkt(cell))) AS geojson FROM binned`
  );
}

/** Build a FeatureCollection from rows carrying `h3`, optional `count`/`value`, and `geojson`. */
export function rowsToFeatureCollection(
  rows: Record<string, unknown>[],
): FeatureCollection {
  const features = [];
  for (const row of rows) {
    const raw = row.geojson;
    if (typeof raw !== "string") continue;
    const geometry = JSON.parse(raw) as Geometry;
    const properties: Record<string, unknown> = { h3: row.h3 };
    if (row.count !== undefined && row.count !== null) {
      properties.count = Number(row.count);
    }
    if (row.value !== undefined && row.value !== null) {
      properties.value = Number(row.value);
    }
    features.push({ type: "Feature" as const, geometry, properties });
  }
  return { type: "FeatureCollection", features };
}
