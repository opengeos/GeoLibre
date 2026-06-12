import type { FeatureCollection, Geometry } from "geojson";
import bbox from "@turf/bbox";
import type { GeoLibreLayer } from "@geolibre/core";
import type {
  DuckDbCapability,
  DuckDbGeoJsonSource,
  ProcessingAlgorithm,
  ProcessingContext,
} from "./types";

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

const NO_DUCKDB =
  "This tool requires DuckDB-WASM, which is unavailable in this environment.";

function requireDuckDb(ctx: ProcessingContext): DuckDbCapability {
  if (!ctx.duckdb) throw new Error(NO_DUCKDB);
  return ctx.duckdb;
}

// Mirrors the same helper in vector-tools.ts and registry.ts; intentionally
// duplicated because vector-tools.ts imports from this file, so importing the
// other direction would create a cycle. Keep the three copies in sync.
function getLayer(
  ctx: ProcessingContext,
  paramId = "layer",
): GeoLibreLayer | undefined {
  const id = ctx.parameters[paramId] as string | undefined;
  return ctx.layers.find((l) => l.id === id);
}

/** Parse the `resolution` param, or auto-suggest from area. Logs + returns null on bad input. */
function resolveResolution(
  ctx: ProcessingContext,
  areaKm2: number,
): number | null {
  const raw = ctx.parameters.resolution;
  if (raw === undefined || raw === null || raw === "") {
    const suggested = suggestResolution(areaKm2);
    ctx.log(`Using suggested resolution ${suggested}`);
    return suggested;
  }
  const res = typeof raw === "string" ? Number(raw) : (raw as number);
  if (!Number.isInteger(res) || res < 0 || res > 15) {
    ctx.log("Error: resolution must be an integer from 0 to 15");
    return null;
  }
  return res;
}

export const createH3GridTool: ProcessingAlgorithm = {
  id: "h3-grid",
  name: "Create H3 grid",
  description:
    "Fill an area with H3 hexagons (DuckDB h3 extension). Source: a layer's geometry, a layer's extent, or the current map view.",
  group: "H3",
  parameters: [
    {
      id: "source",
      label: "Area source",
      type: "select",
      default: "polyfill",
      options: [
        { value: "polyfill", label: "Layer geometry (polyfill)" },
        { value: "extent", label: "Layer extent (bbox)" },
        { value: "viewport", label: "Map viewport" },
      ],
    },
    {
      id: "layer",
      label: "Input layer",
      type: "layer",
      required: true,
      // No geometry filter: "extent" fills any layer's bounding box, while
      // "polyfill" needs polygons (validated at run time below).
      visibleWhen: { param: "source", in: ["polyfill", "extent"] },
    },
    {
      id: "resolution",
      label: "Resolution (0-15)",
      type: "number",
      min: 0,
      max: 15,
      step: 1,
      description: "Leave blank to auto-pick from the area.",
    },
  ],
  run: async (ctx) => {
    const duckdb = requireDuckDb(ctx);
    const source = (ctx.parameters.source as string) || "polyfill";

    let areaKm2: number;
    let wkt: string | null = null;
    let inputGeojson: FeatureCollection | null = null;
    if (source === "viewport") {
      const bounds = ctx.viewportBounds?.();
      if (!bounds) {
        ctx.log("Error: map viewport is unavailable");
        return;
      }
      areaKm2 = bboxAreaKm2(bounds);
      wkt = bboxToWktPolygon(bounds);
    } else {
      const layer = getLayer(ctx, "layer");
      if (!layer?.geojson?.features?.length) {
        ctx.log('Error: parameter "layer" has no GeoJSON features');
        return;
      }
      if (source === "polyfill") {
        const hasPolygon = layer.geojson.features.some(
          (f) =>
            f.geometry?.type === "Polygon" ||
            f.geometry?.type === "MultiPolygon",
        );
        if (!hasPolygon) {
          ctx.log(
            'Error: polyfill needs a polygon layer; use the "Layer extent" source for point or line layers',
          );
          return;
        }
      }
      inputGeojson = layer.geojson;
      const bb = bbox(layer.geojson) as [number, number, number, number];
      areaKm2 = bboxAreaKm2(bb);
      if (source === "extent") wkt = bboxToWktPolygon(bb);
    }

    const res = resolveResolution(ctx, areaKm2);
    if (res === null) return;

    const estimate = estimateCellCount(areaKm2, res);
    if (estimate > H3_HARD_CAP) {
      ctx.log(
        `Error: resolution ${res} would generate about ${Math.round(
          estimate,
        ).toLocaleString()} cells (cap ${H3_HARD_CAP.toLocaleString()}). Choose a coarser resolution.`,
      );
      return;
    }

    await duckdb.ensureExtensions(["spatial", "h3"]);
    let registered: DuckDbGeoJsonSource | null = null;
    try {
      let sql: string;
      if (wkt) {
        sql = buildGridFromWktSql(wkt, res);
      } else {
        registered = await duckdb.registerGeoJson(inputGeojson!); // non-null: polyfill path only runs after the layer guard above set inputGeojson
        sql = buildGridFromSourceSql(registered.sql, res);
      }
      const rows = await duckdb.query(sql);
      const fc = rowsToFeatureCollection(rows);
      ctx.log(`Created ${fc.features.length} H3 cell(s) at resolution ${res}`);
      ctx.addResultLayer?.(`H3 grid (res ${res})`, fc);
    } finally {
      await registered?.release();
    }
  },
};

export const binPointsTool: ProcessingAlgorithm = {
  id: "h3-bin-points",
  name: "Bin points to H3",
  description:
    "Aggregate a point layer into H3 cells (count, or sum/mean/min/max of a numeric field).",
  group: "H3",
  parameters: [
    {
      id: "layer",
      label: "Input point layer",
      type: "layer",
      required: true,
      geometryFilter: ["point"],
    },
    {
      id: "aggOp",
      label: "Aggregate",
      type: "select",
      default: "count",
      options: [
        { value: "count", label: "Count" },
        { value: "sum", label: "Sum" },
        { value: "mean", label: "Mean" },
        { value: "min", label: "Min" },
        { value: "max", label: "Max" },
      ],
    },
    {
      id: "field",
      label: "Field",
      type: "field",
      fieldSource: "layer",
      required: true,
      visibleWhen: { param: "aggOp", notIn: ["count"] },
      description: "Numeric field to aggregate.",
    },
    {
      id: "resolution",
      label: "Resolution (0-15)",
      type: "number",
      min: 0,
      max: 15,
      step: 1,
      description: "Leave blank to auto-pick from the area.",
    },
  ],
  run: async (ctx) => {
    const duckdb = requireDuckDb(ctx);
    const layer = getLayer(ctx, "layer");
    if (!layer?.geojson?.features?.length) {
      ctx.log('Error: parameter "layer" has no GeoJSON features');
      return;
    }
    const op = (ctx.parameters.aggOp as string) || "count";
    const field = ctx.parameters.field as string | undefined;
    if (op !== "count" && !field) {
      ctx.log(`Error: select a numeric field to ${op}`);
      return;
    }

    const bb = bbox(layer.geojson) as [number, number, number, number];
    const res = resolveResolution(ctx, bboxAreaKm2(bb));
    if (res === null) return;

    await duckdb.ensureExtensions(["spatial", "h3"]);
    const registered = await duckdb.registerGeoJson(layer.geojson);
    try {
      const sql = buildBinSql(registered.sql, res, op, field);
      const rows = await duckdb.query(sql);
      const fc = rowsToFeatureCollection(rows);
      ctx.log(
        `Binned points into ${fc.features.length} H3 cell(s) at resolution ${res}`,
      );
      ctx.addResultLayer?.(`H3 bins (res ${res})`, fc);
    } finally {
      await registered.release();
    }
  },
};

export const H3_TOOLS: ProcessingAlgorithm[] = [createH3GridTool, binPointsTool];

export function getH3Tool(id: string): ProcessingAlgorithm | undefined {
  return H3_TOOLS.find((tool) => tool.id === id);
}
