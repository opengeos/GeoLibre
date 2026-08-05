import type { FeatureCollection, Geometry } from "geojson";
import { unwrapAntimeridianGeometry } from "./antimeridian";
import { sqlIdent, sqlStr } from "./h3-tools";

/**
 * Default DGGRID orientation (ISEA/FULLER pole) used by duck_dggs examples:
 * https://duckdb.org/community_extensions/extensions/duck_dggs
 */
const DGGRID_DEFAULT_ORIENT = "0.0, 58.3971459, 11.2" as const;

/**
 * Named DGGRID types exposed in DGGS Generator / Binning. Ranges match the
 * standard DGGRID_TYPES table; `dggs_params` maps each name onto duck_dggs.
 */
export const DGGRID_GRID_TYPES = [
  "SUPERFUND",
  "PLANETRISK",
  "ISEA3H",
  "ISEA4H",
  "ISEA4T",
  "ISEA4D",
  "ISEA43H",
  "ISEA7H",
  "IGEO7",
  "FULLER3H",
  "FULLER4H",
  "FULLER4T",
  "FULLER4D",
  "FULLER43H",
  "FULLER7H",
] as const;
export type DggridGridType = (typeof DGGRID_GRID_TYPES)[number];

export const DEFAULT_DGGRID_GRID_TYPE: DggridGridType = "ISEA4H";

/** Resolution bounds + duck_dggs configuration for a named DGGRID type. */
export type DggridGridSpec = {
  minRes: number;
  maxRes: number;
  defaultRes: number;
  /** Pure aperture (ignored when `apertureSequence` is set, except as a fallback). */
  aperture: 3 | 4 | 7;
  projection: "ISEA" | "FULLER";
  topology: "HEXAGON" | "TRIANGLE" | "DIAMOND";
  /**
   * Mixed-aperture sequence (digits 3/4/7). When set, SQL uses the 8-arg
   * `dggs_params(..., true, sequence)` overload.
   */
  apertureSequence?: string;
};

/**
 * Specs for every named type. SUPERFUND = two aperture-4 then fifteen
 * aperture-3 (Appendix E); PLANETRISK = `433347…7` (Appendix F); ISEA43H /
 * FULLER43H default to MIXED43 with zero leading aperture-4 levels (pure
 * aperture 3 geometrically). IGEO7 uses the canonical ISEA aperture-7 hex grid.
 */
export const DGGRID_GRID_SPECS: Record<DggridGridType, DggridGridSpec> = {
  SUPERFUND: {
    minRes: 0,
    maxRes: 17,
    defaultRes: 9,
    aperture: 3,
    projection: "FULLER",
    topology: "HEXAGON",
    // Two aperture-4 + fifteen aperture-3 (EPA Superfund_500m).
    apertureSequence: "44333333333333333",
  },
  PLANETRISK: {
    minRes: 0,
    maxRes: 22,
    defaultRes: 13,
    aperture: 7,
    projection: "ISEA",
    topology: "HEXAGON",
    apertureSequence: "43334777777777777777777",
  },
  ISEA3H: {
    minRes: 0,
    maxRes: 35,
    defaultRes: 20,
    aperture: 3,
    projection: "ISEA",
    topology: "HEXAGON",
  },
  ISEA4H: {
    minRes: 0,
    maxRes: 29,
    defaultRes: 16,
    aperture: 4,
    projection: "ISEA",
    topology: "HEXAGON",
  },
  ISEA4T: {
    minRes: 0,
    maxRes: 29,
    defaultRes: 15,
    aperture: 4,
    projection: "ISEA",
    topology: "TRIANGLE",
  },
  ISEA4D: {
    minRes: 0,
    maxRes: 29,
    defaultRes: 16,
    aperture: 4,
    projection: "ISEA",
    topology: "DIAMOND",
  },
  ISEA43H: {
    minRes: 0,
    maxRes: 18,
    defaultRes: 10,
    // MIXED43 with dggs_num_aperture_4_res = 0 → all aperture 3.
    aperture: 3,
    projection: "ISEA",
    topology: "HEXAGON",
  },
  ISEA7H: {
    minRes: 0,
    maxRes: 21,
    defaultRes: 11,
    aperture: 7,
    projection: "ISEA",
    topology: "HEXAGON",
  },
  IGEO7: {
    minRes: 0,
    maxRes: 20,
    defaultRes: 12,
    aperture: 7,
    projection: "ISEA",
    topology: "HEXAGON",
  },
  FULLER3H: {
    minRes: 0,
    maxRes: 35,
    defaultRes: 20,
    aperture: 3,
    projection: "FULLER",
    topology: "HEXAGON",
  },
  FULLER4H: {
    minRes: 0,
    maxRes: 30,
    defaultRes: 16,
    aperture: 4,
    projection: "FULLER",
    topology: "HEXAGON",
  },
  FULLER4T: {
    minRes: 0,
    maxRes: 29,
    defaultRes: 15,
    aperture: 4,
    projection: "FULLER",
    topology: "TRIANGLE",
  },
  FULLER4D: {
    minRes: 0,
    maxRes: 30,
    defaultRes: 16,
    aperture: 4,
    projection: "FULLER",
    topology: "DIAMOND",
  },
  FULLER43H: {
    minRes: 0,
    maxRes: 18,
    defaultRes: 10,
    aperture: 3,
    projection: "FULLER",
    topology: "HEXAGON",
  },
  FULLER7H: {
    minRes: 0,
    maxRes: 21,
    defaultRes: 11,
    aperture: 7,
    projection: "FULLER",
    topology: "HEXAGON",
  },
};

/** Aperture used by each preset (drives pure-grid cell-count estimates). */
export const DGGRID_GRID_APERTURE: Record<DggridGridType, 3 | 4 | 7> = Object.fromEntries(
  DGGRID_GRID_TYPES.map((t) => [t, DGGRID_GRID_SPECS[t].aperture]),
) as Record<DggridGridType, 3 | 4 | 7>;

function dggsParamsSql(spec: DggridGridSpec): string {
  const head = `'${spec.projection}', ${spec.aperture}, '${spec.topology}', ${DGGRID_DEFAULT_ORIENT}`;
  if (spec.apertureSequence) {
    return `dggs_params(${head}, true, '${spec.apertureSequence}')`;
  }
  return `dggs_params(${head})`;
}

/** SQL `dggs_params(...)` fragment for each named type. */
export const DGGRID_GRID_PARAMS_SQL: Record<DggridGridType, string> = Object.fromEntries(
  DGGRID_GRID_TYPES.map((t) => [t, dggsParamsSql(DGGRID_GRID_SPECS[t])]),
) as Record<DggridGridType, string>;

const DGGRID_GRID_TYPE_LABEL: Record<DggridGridType, string> = {
  SUPERFUND: "SUPERFUND",
  PLANETRISK: "PLANETRISK",
  ISEA3H: "ISEA3H",
  ISEA4H: "ISEA4H",
  ISEA4T: "ISEA4T",
  ISEA4D: "ISEA4D",
  ISEA43H: "ISEA43H",
  ISEA7H: "ISEA7H",
  IGEO7: "IGEO7",
  FULLER3H: "FULLER3H",
  FULLER4H: "FULLER4H",
  FULLER4T: "FULLER4T",
  FULLER4D: "FULLER4D",
  FULLER43H: "FULLER43H",
  FULLER7H: "FULLER7H",
};

/** Labels shown in the processing dialog. */
export const DGGRID_GRID_TYPE_OPTIONS: { value: DggridGridType; label: string }[] =
  DGGRID_GRID_TYPES.map((value) => ({ value, label: DGGRID_GRID_TYPE_LABEL[value] }));

export function resolveDggridGridType(raw: unknown): DggridGridType {
  if (typeof raw === "string" && (DGGRID_GRID_TYPES as readonly string[]).includes(raw)) {
    return raw as DggridGridType;
  }
  return DEFAULT_DGGRID_GRID_TYPE;
}

/** Max resolution allowed for a DGGRID named type. */
export function maxResolutionForDggrid(
  gridType: DggridGridType = DEFAULT_DGGRID_GRID_TYPE,
): number {
  return DGGRID_GRID_SPECS[gridType].maxRes;
}

/** Soft target used when auto-suggesting a resolution. */
export const DGGRID_TARGET_CELLS = 10_000;
/** Finest resolution the auto-suggester will pick. */
export const DGGRID_MAX_SUGGESTED_RES = 12;
/** Hard ceiling: a grid larger than this aborts rather than running away. */
export const DGGRID_HARD_CAP = 200_000;
/**
 * Absolute finest resolution across exposed DGGRID types (ISEA3H / FULLER3H).
 * The dialog narrows this per selected {@link DggridGridType}.
 */
export const DGGRID_MAX_TOOL_RES = Math.max(
  ...DGGRID_GRID_TYPES.map((t) => DGGRID_GRID_SPECS[t].maxRes),
);
/**
 * Cap on sample-grid axes when polyfilling. duck_dggs has no polygon cover
 * function, so the generator densifies the envelope and maps points → cells.
 */
export const DGGRID_SAMPLE_AXIS_CAP = 500;

const EARTH_AREA_KM2 = 510_065_621.724;

/** Approximate global cell count at `res` for a named type. */
export function dggridCellCountAtRes(res: number, gridType: DggridGridType): number {
  const spec = DGGRID_GRID_SPECS[gridType];
  if (spec.apertureSequence) {
    let prod = 1;
    const seq = spec.apertureSequence;
    for (let i = 0; i < res; i += 1) {
      const digit = Number(seq[i] ?? seq[seq.length - 1] ?? spec.aperture);
      prod *= digit;
    }
    return 10 * prod + 2;
  }
  return 10 * spec.aperture ** res + 2;
}

/** Approximate average cell area (km²) at `res` for an aperture-N icosahedral grid. */
export function dggridAvgCellAreaKm2(res: number, aperture: 3 | 4 | 7): number {
  return EARTH_AREA_KM2 / (10 * aperture ** res + 2);
}

/** Approximate average cell area (km²) at res for aperture-4 icosahedral grids. */
export const DGGRID_AVG_AREA_KM2_A4: number[] = Array.from(
  { length: DGGRID_MAX_TOOL_RES + 1 },
  (_, res) => dggridAvgCellAreaKm2(res, 4),
);

/** Approximate average cell area (km²) at res for aperture-3 hexagon grids. */
export const DGGRID_AVG_AREA_KM2_A3: number[] = Array.from(
  { length: DGGRID_MAX_TOOL_RES + 1 },
  (_, res) => dggridAvgCellAreaKm2(res, 3),
);

/** @deprecated Prefer {@link DGGRID_AVG_AREA_KM2_A4}; kept for existing imports. */
export const DGGRID_AVG_AREA_KM2 = DGGRID_AVG_AREA_KM2_A4;

/** Estimated number of DGGRID cells covering `areaKm2` at `res`. */
export function estimateDggridCellCount(
  areaKm2: number,
  res: number,
  gridType: DggridGridType = DEFAULT_DGGRID_GRID_TYPE,
): number {
  const spec = DGGRID_GRID_SPECS[gridType];
  if (!Number.isInteger(res) || res < spec.minRes || res > spec.maxRes) {
    return Number.POSITIVE_INFINITY;
  }
  return areaKm2 / (EARTH_AREA_KM2 / dggridCellCountAtRes(res, gridType));
}

/** Finest resolution whose estimated cell count stays <= the target. */
export function suggestDggridResolution(
  areaKm2: number,
  targetCells = DGGRID_TARGET_CELLS,
  maxRes = DGGRID_MAX_SUGGESTED_RES,
  gridType: DggridGridType = DEFAULT_DGGRID_GRID_TYPE,
): number {
  const capped = Math.min(maxRes, maxResolutionForDggrid(gridType));
  for (let res = capped; res >= 0; res -= 1) {
    if (estimateDggridCellCount(areaKm2, res, gridType) <= targetCells) return res;
  }
  return 0;
}

function paramsSql(gridType: DggridGridType): string {
  return DGGRID_GRID_PARAMS_SQL[gridType];
}

/**
 * Sample-based covering: densify the geometry envelope, keep points that
 * intersect it, map each to a seqnum via `geo_to_seqnum`, then emit boundaries.
 * duck_dggs ([docs](https://duckdb.org/community_extensions/extensions/duck_dggs))
 * only converts POINT → cell; there is no H3-style polygon polyfill.
 *
 * When the envelope would need more than {@link DGGRID_SAMPLE_AXIS_CAP} samples
 * on an axis, the step is scaled up so the series still spans the full bbox
 * (large areas may be under-sampled rather than clipped mid-extent).
 *
 * @param areaSelectSql SQL for the `_dggs_area` CTE body, e.g.
 *   `SELECT ST_GeomFromText(...) AS g` or `SELECT g FROM (...) WHERE g IS NOT NULL`.
 */
function cellsCteFromGeom(areaSelectSql: string, res: number, gridType: DggridGridType): string {
  const cap = DGGRID_SAMPLE_AXIS_CAP;
  const p = paramsSql(gridType);
  return (
    `WITH _dggs_area AS (${areaSelectSql}), ` +
    `_dggs_meta AS (` +
    `SELECT ST_XMin(g) AS w, ST_YMin(g) AS s, ST_XMax(g) AS e, ST_YMax(g) AS n, g, ` +
    // Half the characteristic length scale (km) → degrees (~111.32 km/deg),
    // raised enough that ≤ cap samples cover each axis end-to-end.
    `GREATEST(dggs_cls_km(${res}, ${p}) / 222.64, (e - w) / ${cap}, (n - s) / ${cap}, 1e-5) AS step ` +
    `FROM _dggs_area), ` +
    `_dggs_grid AS (` +
    `SELECT ST_Point(w + i * step, s + j * step) AS pt, g FROM _dggs_meta, ` +
    `generate_series(0, CAST(CEIL((e - w) / step) AS BIGINT)) AS t(i), ` +
    `generate_series(0, CAST(CEIL((n - s) / step) AS BIGINT)) AS u(j)), ` +
    `_dggs_pts AS (` +
    `SELECT pt FROM _dggs_grid WHERE ST_Intersects(pt, g) ` +
    `UNION ALL SELECT ST_Centroid(g) FROM _dggs_meta WHERE g IS NOT NULL), ` +
    `cells AS (SELECT DISTINCT geo_to_seqnum(pt, ${res}, ${p}) AS cell FROM _dggs_pts WHERE pt IS NOT NULL)`
  );
}

function gridSelect(res: number, gridType: DggridGridType): string {
  const p = paramsSql(gridType);
  return (
    `SELECT CAST(cell AS VARCHAR) AS dggrid, ` +
    `CAST(ST_AsGeoJSON(seqnum_to_boundary(cell, ${res}, ${p})) AS VARCHAR) AS geojson FROM cells`
  );
}

/** Grid SQL from a polygon WKT literal (bbox / viewport sources). */
export function buildDggridGridFromWktSql(
  wkt: string,
  res: number,
  gridType: DggridGridType = DEFAULT_DGGRID_GRID_TYPE,
): string {
  return (
    `${cellsCteFromGeom(`SELECT ST_GeomFromText(${sqlStr(wkt)}) AS g`, res, gridType)} ` +
    gridSelect(res, gridType)
  );
}

/**
 * Grid SQL that unions polygonal geometry from a registered source, then
 * sample-covers it (polyfill source).
 */
export function buildDggridGridFromSourceSql(
  sourceSql: string,
  res: number,
  gridType: DggridGridType = DEFAULT_DGGRID_GRID_TYPE,
): string {
  const merged =
    `SELECT g FROM (` +
    `SELECT ST_Union_Agg(geom) AS g FROM ${sourceSql} ` +
    `WHERE geom IS NOT NULL AND ST_GeometryType(geom) IN ('POLYGON', 'MULTIPOLYGON')` +
    `) WHERE g IS NOT NULL`;
  return `${cellsCteFromGeom(merged, res, gridType)} ` + gridSelect(res, gridType);
}

/** Supported point-binning aggregate operations. */
export type DggridAggOp = "count" | "sum" | "mean" | "min" | "max";

const AGG_FN: Record<Exclude<DggridAggOp, "count">, string> = {
  sum: "sum",
  mean: "avg",
  min: "min",
  max: "max",
};

/**
 * Aggregate point geometry into DGGRID cells via `geo_to_seqnum`. Boundaries
 * come from `seqnum_to_boundary`.
 */
export function buildDggridBinSql(
  sourceSql: string,
  res: number,
  op: DggridAggOp,
  field?: string,
  gridType: DggridGridType = DEFAULT_DGGRID_GRID_TYPE,
): string {
  const fn = op === "count" ? undefined : AGG_FN[op];
  const aggSelect = fn && field ? `, ${fn}(CAST(${sqlIdent(field)} AS DOUBLE)) AS value` : "";
  const aggOut = fn && field ? ", value" : "";
  const p = paramsSql(gridType);
  return (
    `WITH pts AS (SELECT ST_Centroid(geom) AS pt` +
    (field ? `, ${sqlIdent(field)}` : "") +
    ` FROM ${sourceSql} ` +
    `WHERE geom IS NOT NULL AND ST_GeometryType(geom) IN ('POINT', 'MULTIPOINT')), ` +
    `binned AS (SELECT geo_to_seqnum(pt, ${res}, ${p}) AS cell, ` +
    `count(*) AS count${aggSelect} FROM pts GROUP BY cell) ` +
    `SELECT CAST(cell AS VARCHAR) AS dggrid, count${aggOut}, ` +
    `CAST(ST_AsGeoJSON(seqnum_to_boundary(cell, ${res}, ${p})) AS VARCHAR) AS geojson FROM binned`
  );
}

/** Build a FeatureCollection from rows carrying `dggrid`, optional aggregates, and `geojson`. */
export function dggridRowsToFeatureCollection(
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
      continue;
    }
    const properties: Record<string, unknown> = { dggrid: String(row.dggrid) };
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
