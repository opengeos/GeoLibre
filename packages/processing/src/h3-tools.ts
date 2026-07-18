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
  // Union only polygonal geometries: a mixed layer would otherwise aggregate to
  // a GEOMETRYCOLLECTION that `h3_polygon_wkt_to_cells` rejects. The `cells` CTE
  // filters a NULL union result (no polygons survived) so a NULL WKT never
  // reaches the h3 function, which can throw on NULL.
  return (
    `WITH merged AS (SELECT ST_AsText(ST_Union_Agg(geom)) AS wkt FROM ${sourceSql} ` +
    `WHERE geom IS NOT NULL AND ST_GeometryType(geom) IN ('POLYGON', 'MULTIPOLYGON')), ` +
    `cells AS (SELECT unnest(h3_polygon_wkt_to_cells(wkt, ${res})) AS cell FROM merged WHERE wkt IS NOT NULL) ` +
    GRID_SELECT
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

/** Build a FeatureCollection from rows carrying `h3`, optional `count`/`value`, and `geojson`. */
export function rowsToFeatureCollection(rows: Record<string, unknown>[]): FeatureCollection {
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
    features.push({ type: "Feature" as const, geometry, properties });
  }
  return { type: "FeatureCollection", features };
}

const NO_DUCKDB = "This tool requires DuckDB-WASM, which is unavailable in this environment.";

function requireDuckDb(ctx: ProcessingContext): DuckDbCapability {
  if (!ctx.duckdb) throw new Error(NO_DUCKDB);
  return ctx.duckdb;
}

// Mirrors the same helper in vector-tools.ts and registry.ts; intentionally
// duplicated because vector-tools.ts imports from this file, so importing the
// other direction would create a cycle. Keep the three copies in sync.
function getLayer(ctx: ProcessingContext, paramId = "layer"): GeoLibreLayer | undefined {
  const id = ctx.parameters[paramId] as string | undefined;
  return ctx.layers.find((l) => l.id === id);
}

/** Read a numeric parameter, returning NaN when missing or non-numeric. */
function numberParam(ctx: ProcessingContext, id: string): number {
  const raw = ctx.parameters[id];
  if (raw === undefined || raw === null || raw === "") return NaN;
  return typeof raw === "string" ? Number(raw) : (raw as number);
}

/**
 * Read and validate the manual [west, south, east, north] bbox parameters.
 * Logs a clear error and returns null when any value is missing or the box is
 * degenerate (west >= east or south >= north).
 */
function bboxFromParams(ctx: ProcessingContext): [number, number, number, number] | null {
  const west = numberParam(ctx, "west");
  const south = numberParam(ctx, "south");
  const east = numberParam(ctx, "east");
  const north = numberParam(ctx, "north");
  if ([west, south, east, north].some((n) => !Number.isFinite(n))) {
    ctx.log("Error: enter numeric west, south, east, and north values");
    return null;
  }
  if (west >= east || south >= north) {
    ctx.log("Error: bounding box must have west < east and south < north");
    return null;
  }
  return [west, south, east, north];
}

/** Parse the `resolution` param, or auto-suggest from area. Logs + returns null on bad input. */
function resolveResolution(ctx: ProcessingContext, areaKm2: number): number | null {
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
    "Fill an area with H3 hexagons (DuckDB h3 extension). Source: a layer's geometry, a layer's extent, the current map view, or a manual bounding box.",
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
        { value: "bbox", label: "Manual bounding box" },
      ],
    },
    {
      id: "layer",
      label: "Input layer",
      type: "layer",
      required: true,
      // No geometry filter: "extent" fills any layer's bounding box, while
      // "polyfill" needs polygons (validated at run time below). The layer is
      // only required for the layer-based sources, so it stays hidden (and
      // skips required validation) for the viewport and bbox sources.
      visibleWhen: { param: "source", in: ["polyfill", "extent"] },
    },
    {
      id: "west",
      label: "West (min lon)",
      type: "number",
      required: true,
      min: -180,
      max: 180,
      visibleWhen: { param: "source", in: ["bbox"] },
    },
    {
      id: "south",
      label: "South (min lat)",
      type: "number",
      required: true,
      min: -90,
      max: 90,
      visibleWhen: { param: "source", in: ["bbox"] },
    },
    {
      id: "east",
      label: "East (max lon)",
      type: "number",
      required: true,
      min: -180,
      max: 180,
      visibleWhen: { param: "source", in: ["bbox"] },
    },
    {
      id: "north",
      label: "North (max lat)",
      type: "number",
      required: true,
      min: -90,
      max: 90,
      visibleWhen: { param: "source", in: ["bbox"] },
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
      if (bounds[0] >= bounds[2]) {
        // west >= east means the viewport wraps the antimeridian; the rectangle
        // WKT would self-cross and fill the wrong (340deg) span. Bail with a
        // clear message rather than producing wrong cells.
        ctx.log(
          "Error: the map view crosses the antimeridian; pan so it doesn't wrap +/-180, or use a manual bounding box",
        );
        return;
      }
      areaKm2 = bboxAreaKm2(bounds);
      wkt = bboxToWktPolygon(bounds);
    } else if (source === "bbox") {
      const bounds = bboxFromParams(ctx);
      if (!bounds) return;
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
          (f) => f.geometry?.type === "Polygon" || f.geometry?.type === "MultiPolygon",
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
      if (fc.features.length === 0) {
        ctx.log(
          `No H3 cells were produced at resolution ${res}. Try a coarser resolution or a larger area.`,
        );
        return;
      }
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
    if (!H3_AGG_OPS.includes(op as H3AggOp)) {
      ctx.log(`Error: unknown aggregate "${op}"`);
      return;
    }
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
      const sql = buildBinSql(registered.sql, res, op as H3AggOp, field);
      const rows = await duckdb.query(sql);
      const fc = rowsToFeatureCollection(rows);
      if (fc.features.length === 0) {
        ctx.log(
          `No points fell into H3 cells at resolution ${res}. Check the layer has point geometries.`,
        );
        return;
      }
      ctx.log(`Binned points into ${fc.features.length} H3 cell(s) at resolution ${res}`);
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
