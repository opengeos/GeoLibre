import type { FeatureCollection } from "geojson";
import bbox from "@turf/bbox";
import type { GeoLibreLayer } from "@geolibre/core";
import type {
  DuckDbCapability,
  DuckDbGeoJsonSource,
  ProcessingAlgorithm,
  ProcessingContext,
} from "./types";
import {
  a5RowsToFeatureCollection,
  buildA5BinSql,
  buildA5CompactSql,
  buildA5ExpandCountSql,
  buildA5ExpandSql,
  buildA5GridFromBboxSql,
  buildA5GridFromSourceSql,
  A5_HARD_CAP,
  A5_MAX_TOOL_RES,
  estimateA5CellCount,
  suggestA5Resolution,
  type A5AggOp,
} from "./a5-tools";
import {
  buildDggridBinSql,
  buildDggridGridFromSourceSql,
  buildDggridGridFromWktSql,
  DEFAULT_DGGRID_GRID_TYPE,
  DGGRID_GRID_TYPE_OPTIONS,
  DGGRID_HARD_CAP,
  DGGRID_MAX_TOOL_RES,
  dggridRowsToFeatureCollection,
  estimateDggridCellCount,
  maxResolutionForDggrid,
  resolveDggridGridType,
  suggestDggridResolution,
  type DggridAggOp,
  type DggridGridType,
} from "./dggrid-tools";
import {
  binPointsToDggal,
  compactDggalFeatureCollection,
  dggalGridFromBbox,
  dggalGridFromFeatureCollection,
  DEFAULT_DGGAL_GRID_TYPE,
  DGGAL_GRID_TYPE_OPTIONS,
  DGGAL_HARD_CAP,
  DGGAL_MAX_TOOL_RES,
  DGGAL_TYPES,
  estimateDggalCellCount,
  estimateDggalExpandCount,
  expandDggalFeatureCollection,
  maxResolutionForDggal,
  resolveDggalGridType,
  suggestDggalResolution,
  tokensFromDggalLayer,
  withDggalDggrs,
  type DggalAggOp,
  type DggalGridType,
} from "./dggal-tools";
import {
  binPointsToS2,
  compactS2FeatureCollection,
  estimateS2CellCount,
  estimateS2ExpandCount,
  expandS2FeatureCollection,
  s2GridFromBbox,
  s2GridFromFeatureCollection,
  suggestS2Resolution,
  tokensFromS2Layer,
  S2_HARD_CAP,
  S2_MAX_TOOL_RES,
  type S2AggOp,
} from "./s2-tools";
import {
  bboxAreaKm2,
  bboxToWktPolygon,
  buildBinSql,
  buildGridFromBboxSql,
  buildGridFromSourceSql,
  buildH3CompactSql,
  buildH3ExpandCountSql,
  buildH3ExpandSql,
  estimateCellCount,
  H3_AGG_OPS,
  H3_HARD_CAP,
  normalizeLonLatBbox,
  rowsToFeatureCollection,
  suggestResolution,
  type H3AggOp,
} from "./h3-tools";

/** Supported DGGS backends for the DGGS Generator / Binning tools. */
export type DggsType = "h3" | "s2" | "a5" | "dggrid" | "dggal";

export const DGGS_TYPES: readonly DggsType[] = ["h3", "s2", "a5", "dggrid", "dggal"];

const DGGS_TYPE_LABEL: Record<DggsType, string> = {
  h3: "H3",
  s2: "S2",
  a5: "A5",
  dggrid: "DGGRID",
  dggal: "DGGAL",
};

/**
 * Max resolution for the selected DGGS type. `subtype` is the DGGRID or DGGAL
 * named type when applicable.
 */
export function maxResolutionForDggs(
  type: DggsType,
  subtype?: DggridGridType | DggalGridType | string,
): number {
  if (type === "s2") return S2_MAX_TOOL_RES;
  if (type === "a5") return A5_MAX_TOOL_RES;
  if (type === "dggrid") return maxResolutionForDggrid(resolveDggridGridType(subtype));
  if (type === "dggal") return maxResolutionForDggal(resolveDggalGridType(subtype));
  return 15;
}

/** DuckDB community extension name required for `type` (S2/DGGAL are client-side). */
export function extensionForDggs(type: DggsType): string | null {
  if (type === "s2" || type === "dggal") return null;
  if (type === "a5") return "a5";
  if (type === "dggrid") return "duck_dggs";
  return "h3";
}

const NO_DUCKDB = "This tool requires DuckDB-WASM, which is unavailable in this environment.";

function requireDuckDb(ctx: ProcessingContext): DuckDbCapability {
  if (!ctx.duckdb) throw new Error(NO_DUCKDB);
  return ctx.duckdb;
}

function getLayer(ctx: ProcessingContext, paramId = "layer"): GeoLibreLayer | undefined {
  const id = ctx.parameters[paramId] as string | undefined;
  return ctx.layers.find((l) => l.id === id);
}

function numberParam(ctx: ProcessingContext, id: string): number {
  const raw = ctx.parameters[id];
  if (raw === undefined || raw === null || raw === "") return NaN;
  return typeof raw === "string" ? Number(raw) : (raw as number);
}

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

function resolveDggsType(ctx: ProcessingContext): DggsType | null {
  const raw = (ctx.parameters.dggsType as string) || "h3";
  if (raw === "h3" || raw === "s2" || raw === "a5" || raw === "dggrid" || raw === "dggal") {
    return raw;
  }
  ctx.log(`Error: unknown DGGS type "${raw}"`);
  return null;
}

function resolveResolution(
  ctx: ProcessingContext,
  type: DggsType,
  areaKm2: number,
  dggridType: DggridGridType = DEFAULT_DGGRID_GRID_TYPE,
  dggalType: DggalGridType = DEFAULT_DGGAL_GRID_TYPE,
): number | null {
  const maxRes = maxResolutionForDggs(type, type === "dggal" ? dggalType : dggridType);
  const raw = ctx.parameters.resolution;
  if (raw === undefined || raw === null || raw === "") {
    const suggested =
      type === "s2"
        ? suggestS2Resolution(areaKm2)
        : type === "a5"
          ? suggestA5Resolution(areaKm2)
          : type === "dggrid"
            ? suggestDggridResolution(areaKm2, undefined, undefined, dggridType)
            : type === "dggal"
              ? suggestDggalResolution(areaKm2, undefined, undefined, dggalType)
              : suggestResolution(areaKm2);
    ctx.log(`Using suggested resolution ${suggested}`);
    return suggested;
  }
  const res = typeof raw === "string" ? Number(raw) : (raw as number);
  if (!Number.isInteger(res) || res < 0 || res > maxRes) {
    ctx.log(
      `Error: resolution must be an integer from 0 to ${maxRes} for ${dggsLabel(type, dggridType, dggalType)}`,
    );
    return null;
  }
  return res;
}

function estimateFor(
  type: DggsType,
  areaKm2: number,
  res: number,
  dggridType: DggridGridType = DEFAULT_DGGRID_GRID_TYPE,
  dggalType: DggalGridType = DEFAULT_DGGAL_GRID_TYPE,
): number {
  if (type === "s2") return estimateS2CellCount(areaKm2, res);
  if (type === "a5") return estimateA5CellCount(areaKm2, res);
  if (type === "dggrid") return estimateDggridCellCount(areaKm2, res, dggridType);
  if (type === "dggal") return estimateDggalCellCount(areaKm2, res, dggalType);
  return estimateCellCount(areaKm2, res);
}

function hardCapFor(type: DggsType): number {
  if (type === "s2") return S2_HARD_CAP;
  if (type === "a5") return A5_HARD_CAP;
  if (type === "dggrid") return DGGRID_HARD_CAP;
  if (type === "dggal") return DGGAL_HARD_CAP;
  return H3_HARD_CAP;
}

const DGGS_TYPE_PARAM = {
  id: "dggsType",
  label: "DGGS type",
  type: "select" as const,
  default: "h3",
  options: [
    { value: "h3", label: "H3" },
    { value: "s2", label: "S2" },
    { value: "a5", label: "A5" },
    { value: "dggrid", label: "DGGRID" },
    { value: "dggal", label: "DGGAL" },
  ],
};

/** Shown only when DGGS type is DGGRID — duck_dggs presets. */
const DGGRID_TYPE_PARAM = {
  id: "dggridType",
  label: "DGGRID type",
  type: "select" as const,
  default: DEFAULT_DGGRID_GRID_TYPE,
  options: DGGRID_GRID_TYPE_OPTIONS,
  visibleWhen: { param: "dggsType", in: ["dggrid"] },
  description:
    "Grid configuration passed to duck_dggs as dggs_params (ISEA/FULLER × aperture × topology).",
};

/** Shown only when DGGS type is DGGAL — DGGRS class presets. */
const DGGAL_TYPE_PARAM = {
  id: "dggalType",
  label: "DGGAL type",
  type: "select" as const,
  default: DEFAULT_DGGAL_GRID_TYPE,
  options: DGGAL_GRID_TYPE_OPTIONS,
  visibleWhen: { param: "dggsType", in: ["dggal"] },
  description: "DGGRS passed to dggal.createDGGRS (ISEA/IVEA/RTEA/HEALPix/GNOSIS).",
};

/**
 * Unwrap dateline-straddling cell rings for MapLibre. H3, S2, and DGGRID only;
 * A5 and DGGAL emit dateline-safe geometry natively.
 */
const FIX_ANTIMERIDIAN_PARAM = {
  id: "fixAntimeridian",
  label: "Fix antimeridian",
  type: "boolean" as const,
  default: true,
  visibleWhen: { param: "dggsType", in: ["h3", "s2", "dggrid"] },
  description: "Unwrap cell rings that cross ±180° longitude.",
};

/**
 * After filling at the requested resolution, merge complete child sets into
 * parents (mixed resolutions). H3, A5, S2, and DGGAL; default off (uniform cells).
 */
const COMPACT_CELLS_PARAM = {
  id: "compactCells",
  label: "Compact cells",
  type: "boolean" as const,
  default: false,
  visibleWhen: { param: "dggsType", in: ["h3", "a5", "s2", "dggal"] },
  description:
    "Merge complete sets of sibling cells into coarser parents (fewer features, mixed resolutions).",
};

function resolveFixAntimeridian(ctx: ProcessingContext, type: DggsType): boolean {
  if (type !== "h3" && type !== "s2" && type !== "dggrid") {
    return false;
  }
  const raw = ctx.parameters.fixAntimeridian;
  // Default checked when the param was never set (e.g. scripted runs).
  if (raw === undefined || raw === null || raw === "") return true;
  return Boolean(raw);
}

function dggsLabel(type: DggsType, dggridType: DggridGridType, dggalType: DggalGridType): string {
  if (type === "dggrid") return dggridType;
  if (type === "dggal") return DGGAL_TYPES[dggalType].className;
  return DGGS_TYPE_LABEL[type];
}

function resolveCompactCells(ctx: ProcessingContext, type: DggsType): boolean {
  if (type !== "h3" && type !== "a5" && type !== "s2" && type !== "dggal") return false;
  return Boolean(ctx.parameters.compactCells);
}

/**
 * Fill an area with DGGS cells. H3/A5/DGGRID use DuckDB-WASM community
 * extensions; S2 (s2js) and DGGAL (dggal WASM) run client-side.
 */
export const createDggsGridTool: ProcessingAlgorithm = {
  id: "dggs-grid",
  name: "DGGS Generator",
  description:
    "Fill an area with DGGS cells (H3, S2, A5, DGGRID, DGGAL). Source: a layer's geometry, a layer's extent, the current map view, or a manual bounding box.",
  group: "DGGS",
  parameters: [
    DGGS_TYPE_PARAM,
    DGGRID_TYPE_PARAM,
    DGGAL_TYPE_PARAM,
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
      // Absolute ceiling is the finest supported DGGS (currently ISEA3H); the
      // dialog narrows the input max for the selected type / subtype.
      id: "resolution",
      label: "Resolution",
      type: "number",
      min: 0,
      max: Math.max(S2_MAX_TOOL_RES, A5_MAX_TOOL_RES, DGGRID_MAX_TOOL_RES, DGGAL_MAX_TOOL_RES),
      step: 1,
      description: "Range depends on DGGS type. Leave blank to auto-pick from the area.",
    },
    COMPACT_CELLS_PARAM,
    FIX_ANTIMERIDIAN_PARAM,
  ],
  run: async (ctx) => {
    const type = resolveDggsType(ctx);
    if (!type) return;
    const source = (ctx.parameters.source as string) || "polyfill";

    let areaKm2: number;
    let areaBbox: [number, number, number, number] | null = null;
    let inputGeojson: FeatureCollection | null = null;
    if (source === "viewport") {
      const bounds = ctx.viewportBounds?.();
      if (!bounds) {
        ctx.log("Error: map viewport is unavailable");
        return;
      }
      if (bounds[0] >= bounds[2]) {
        ctx.log(
          "Error: the map view crosses the antimeridian; pan so it doesn't wrap +/-180, or use a manual bounding box",
        );
        return;
      }
      areaBbox = normalizeLonLatBbox(bounds);
      areaKm2 = bboxAreaKm2(areaBbox);
    } else if (source === "bbox") {
      const bounds = bboxFromParams(ctx);
      if (!bounds) return;
      areaBbox = normalizeLonLatBbox(bounds);
      areaKm2 = bboxAreaKm2(areaBbox);
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
      const bb = normalizeLonLatBbox(bbox(layer.geojson) as [number, number, number, number]);
      areaKm2 = bboxAreaKm2(bb);
      if (source === "extent") areaBbox = bb;
      // A5 `geometry_to_cells` returns [] for a ±180° world ring; use the bbox
      // path (res0 enumeration) when the layer extent is full longitude.
      if (source === "polyfill" && type === "a5" && bb[0] === -180 && bb[2] === 180) {
        areaBbox = bb;
      }
    }

    const dggridType = resolveDggridGridType(ctx.parameters.dggridType);
    const dggalType = resolveDggalGridType(ctx.parameters.dggalType);
    const res = resolveResolution(ctx, type, areaKm2, dggridType, dggalType);
    if (res === null) return;

    const estimate = estimateFor(type, areaKm2, res, dggridType, dggalType);
    const hardCap = hardCapFor(type);
    if (estimate > hardCap) {
      ctx.log(
        `Error: resolution ${res} would generate about ${Math.round(
          estimate,
        ).toLocaleString()} cells (cap ${hardCap.toLocaleString()}). Choose a coarser resolution.`,
      );
      return;
    }

    const fixAntimeridian = resolveFixAntimeridian(ctx, type);
    const compactCells = resolveCompactCells(ctx, type);
    const label = dggsLabel(type, dggridType, dggalType);

    // S2 is entirely client-side (s2js); no DuckDB extension.
    if (type === "s2") {
      try {
        const gridOpts = {
          limit: hardCap,
          unwrap: fixAntimeridian,
          compact: compactCells,
        };
        const fc =
          areaBbox != null
            ? s2GridFromBbox(areaBbox, res, gridOpts)
            : s2GridFromFeatureCollection(inputGeojson!, res, gridOpts);
        if (fc.features.length === 0) {
          ctx.log(
            `No S2 cells were produced at resolution ${res}. Try a finer resolution or a larger area.`,
          );
          return;
        }
        ctx.log(
          `Created ${fc.features.length} S2 cell(s) at resolution ${res}` +
            (compactCells ? " (compacted)" : ""),
        );
        ctx.addResultLayer?.(
          compactCells ? `S2 grid (res ${res}, compact)` : `S2 grid (res ${res})`,
          fc,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.log(`Error: ${message}`);
      }
      return;
    }

    // DGGAL is client-side WASM (dggal); no DuckDB.
    if (type === "dggal") {
      try {
        const fc = await withDggalDggrs(dggalType, (engine) =>
          areaBbox != null
            ? dggalGridFromBbox(engine, areaBbox, res, hardCap, { compact: compactCells })
            : dggalGridFromFeatureCollection(engine, inputGeojson!, res, hardCap, {
                compact: compactCells,
              }),
        );
        if (fc.features.length === 0) {
          ctx.log(
            `No ${label} cells were produced at resolution ${res}. Try a finer resolution or a larger area.`,
          );
          return;
        }
        ctx.log(
          `Created ${fc.features.length} ${label} cell(s) at resolution ${res}` +
            (compactCells ? " (compacted)" : ""),
        );
        ctx.addResultLayer?.(
          compactCells ? `${label} grid (res ${res}, compact)` : `${label} grid (res ${res})`,
          fc,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.log(`Error: ${message}`);
      }
      return;
    }

    const duckdb = requireDuckDb(ctx);
    const extension = extensionForDggs(type);
    let registered: DuckDbGeoJsonSource | null = null;
    try {
      await duckdb.ensureExtensions(["spatial", extension!]);
      let sql: string;
      if (areaBbox) {
        sql =
          type === "a5"
            ? buildA5GridFromBboxSql(areaBbox, res, compactCells)
            : type === "dggrid"
              ? buildDggridGridFromWktSql(bboxToWktPolygon(areaBbox), res, dggridType)
              : buildGridFromBboxSql(areaBbox, res, compactCells);
      } else {
        registered = await duckdb.registerGeoJson(inputGeojson!);
        sql =
          type === "a5"
            ? buildA5GridFromSourceSql(registered.sql, res, compactCells)
            : type === "dggrid"
              ? buildDggridGridFromSourceSql(registered.sql, res, dggridType)
              : buildGridFromSourceSql(registered.sql, res, compactCells);
      }
      const rows = await duckdb.query(sql);
      const fc =
        type === "a5"
          ? a5RowsToFeatureCollection(rows)
          : type === "dggrid"
            ? dggridRowsToFeatureCollection(rows, fixAntimeridian)
            : rowsToFeatureCollection(rows, fixAntimeridian);
      if (fc.features.length === 0) {
        ctx.log(
          `No ${label} cells were produced at resolution ${res}. Try a finer resolution or a larger area.`,
        );
        return;
      }
      ctx.log(
        `Created ${fc.features.length} ${label} cell(s) at resolution ${res}` +
          (compactCells ? " (compacted)" : ""),
      );
      ctx.addResultLayer?.(
        compactCells ? `${label} grid (res ${res}, compact)` : `${label} grid (res ${res})`,
        fc,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.log(`Error: ${message}`);
    } finally {
      await registered?.release();
    }
  },
};

/**
 * Aggregate a point layer into DGGS cells (count, or sum/mean/min/max of a
 * numeric field). Same dialog shape as {@link createDggsGridTool}'s type picker.
 */
export const dggsBinPointsTool: ProcessingAlgorithm = {
  id: "dggs-bin",
  name: "DGGS Binning",
  description:
    "Aggregate a point layer into DGGS cells (count, or sum/mean/min/max of a numeric field).",
  group: "DGGS",
  parameters: [
    DGGS_TYPE_PARAM,
    DGGRID_TYPE_PARAM,
    DGGAL_TYPE_PARAM,
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
      label: "Resolution",
      type: "number",
      min: 0,
      max: Math.max(S2_MAX_TOOL_RES, A5_MAX_TOOL_RES, DGGRID_MAX_TOOL_RES, DGGAL_MAX_TOOL_RES),
      step: 1,
      description: "Range depends on DGGS type. Leave blank to auto-pick from the area.",
    },
    FIX_ANTIMERIDIAN_PARAM,
  ],
  run: async (ctx) => {
    const type = resolveDggsType(ctx);
    if (!type) return;
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
    const dggridType = resolveDggridGridType(ctx.parameters.dggridType);
    const dggalType = resolveDggalGridType(ctx.parameters.dggalType);
    const res = resolveResolution(ctx, type, bboxAreaKm2(bb), dggridType, dggalType);
    if (res === null) return;

    const fixAntimeridian = resolveFixAntimeridian(ctx, type);
    const label = dggsLabel(type, dggridType, dggalType);

    if (type === "s2") {
      const fc = binPointsToS2(layer.geojson, res, op as S2AggOp, field, {
        unwrap: fixAntimeridian,
      });
      if (fc.features.length === 0) {
        ctx.log(
          `No points fell into S2 cells at resolution ${res}. Check the layer has point geometries.`,
        );
        return;
      }
      ctx.log(`Binned points into ${fc.features.length} S2 cell(s) at resolution ${res}`);
      ctx.addResultLayer?.(`S2 bins (res ${res})`, fc);
      return;
    }

    if (type === "dggal") {
      try {
        const fc = await withDggalDggrs(dggalType, (engine) =>
          binPointsToDggal(engine, layer.geojson!, res, op as DggalAggOp, field),
        );
        if (fc.features.length === 0) {
          ctx.log(
            `No points fell into ${label} cells at resolution ${res}. Check the layer has point geometries.`,
          );
          return;
        }
        ctx.log(`Binned points into ${fc.features.length} ${label} cell(s) at resolution ${res}`);
        ctx.addResultLayer?.(`${label} bins (res ${res})`, fc);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.log(`Error: ${message}`);
      }
      return;
    }

    const duckdb = requireDuckDb(ctx);
    const extension = extensionForDggs(type);
    let registered: DuckDbGeoJsonSource | null = null;
    try {
      await duckdb.ensureExtensions(["spatial", extension!]);
      registered = await duckdb.registerGeoJson(layer.geojson);
      const sql =
        type === "a5"
          ? buildA5BinSql(registered.sql, res, op as A5AggOp, field)
          : type === "dggrid"
            ? buildDggridBinSql(registered.sql, res, op as DggridAggOp, field, dggridType)
            : buildBinSql(registered.sql, res, op as H3AggOp, field);
      const rows = await duckdb.query(sql);
      const fc =
        type === "a5"
          ? a5RowsToFeatureCollection(rows)
          : type === "dggrid"
            ? dggridRowsToFeatureCollection(rows, fixAntimeridian)
            : rowsToFeatureCollection(rows, fixAntimeridian);
      if (fc.features.length === 0) {
        ctx.log(
          `No points fell into ${label} cells at resolution ${res}. Check the layer has point geometries.`,
        );
        return;
      }
      ctx.log(`Binned points into ${fc.features.length} ${label} cell(s) at resolution ${res}`);
      ctx.addResultLayer?.(`${label} bins (res ${res})`, fc);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.log(`Error: ${message}`);
    } finally {
      await registered?.release();
    }
  },
};

/** Compact / expand modes for {@link dggsCompactTool}. */
export type DggsCompactMode = "compact" | "expand";

type DggsCompactType = "h3" | "a5" | "s2" | "dggal";

/**
 * Compact a polygon DGGS cell layer, or expand (uncompact) it to a target
 * resolution. Reads cell IDs from a property (`h3` / `a5` / `s2` / `dggal` by
 * default). H3 and A5 use DuckDB; S2 and DGGAL run client-side.
 */
export const dggsCompactTool: ProcessingAlgorithm = {
  id: "dggs-compact",
  name: "DGGS Compact",
  description:
    "Compact DGGS polygon cells, or expand them to a uniform resolution (H3, S2, A5, DGGAL). Input must be a cell layer with an ID property.",
  group: "DGGS",
  parameters: [
    {
      id: "dggsType",
      label: "DGGS type",
      type: "select",
      default: "h3",
      options: [
        { value: "h3", label: "H3" },
        { value: "s2", label: "S2" },
        { value: "a5", label: "A5" },
        { value: "dggal", label: "DGGAL" },
      ],
    },
    DGGAL_TYPE_PARAM,
    {
      id: "mode",
      label: "Mode",
      type: "select",
      default: "compact",
      options: [
        { value: "compact", label: "Compact" },
        { value: "expand", label: "Expand" },
      ],
    },
    {
      id: "layer",
      label: "Input DGGS layer",
      type: "layer",
      required: true,
      geometryFilter: ["polygon"],
      description: "Polygon cell layer from DGGS Generator / Binning (or equivalent).",
    },
    {
      id: "cellField",
      label: "Cell ID field",
      type: "field",
      fieldSource: "layer",
      description: "Defaults to h3, a5, s2, or dggal for the selected type when left blank.",
    },
    {
      id: "resolution",
      label: "Target resolution",
      type: "number",
      min: 0,
      max: Math.max(15, A5_MAX_TOOL_RES, S2_MAX_TOOL_RES, DGGAL_MAX_TOOL_RES),
      step: 1,
      required: true,
      visibleWhen: { param: "mode", in: ["expand"] },
      description: "Resolution to expand to. Must be at least as fine as the input cells.",
    },
    {
      id: "fixAntimeridian",
      label: "Fix antimeridian",
      type: "boolean",
      default: true,
      visibleWhen: { param: "dggsType", in: ["h3", "s2"] },
      description: "Unwrap cell rings that cross ±180° longitude.",
    },
  ],
  run: async (ctx) => {
    const typeRaw = (ctx.parameters.dggsType as string) || "h3";
    if (typeRaw !== "h3" && typeRaw !== "a5" && typeRaw !== "s2" && typeRaw !== "dggal") {
      ctx.log(
        `Error: DGGS Compact currently supports H3, A5, S2, and DGGAL only (got "${typeRaw}")`,
      );
      return;
    }
    const type: DggsCompactType = typeRaw;
    const dggalType = resolveDggalGridType(ctx.parameters.dggalType);
    const mode = ((ctx.parameters.mode as string) || "compact") as DggsCompactMode;
    if (mode !== "compact" && mode !== "expand") {
      ctx.log(`Error: unknown mode "${mode}"`);
      return;
    }

    const layer = getLayer(ctx, "layer");
    if (!layer?.geojson?.features?.length) {
      ctx.log('Error: parameter "layer" has no GeoJSON features');
      return;
    }
    const hasPolygon = layer.geojson.features.some(
      (f) => f.geometry?.type === "Polygon" || f.geometry?.type === "MultiPolygon",
    );
    if (!hasPolygon) {
      ctx.log("Error: input must be a polygon DGGS cell layer");
      return;
    }

    const defaultField =
      type === "a5" ? "a5" : type === "s2" ? "s2" : type === "dggal" ? "dggal" : "h3";
    const cellField =
      typeof ctx.parameters.cellField === "string" && ctx.parameters.cellField.trim()
        ? ctx.parameters.cellField.trim()
        : defaultField;

    const sample = layer.geojson.features.find((f) => f.properties?.[cellField] != null);
    if (!sample) {
      ctx.log(
        `Error: no features have a "${cellField}" property. Pick the cell ID field, or run DGGS Generator first.`,
      );
      return;
    }

    let res = 0;
    if (mode === "expand") {
      const maxRes = maxResolutionForDggs(type, dggalType);
      const raw = ctx.parameters.resolution;
      if (raw === undefined || raw === null || raw === "") {
        ctx.log("Error: enter a target resolution to expand to");
        return;
      }
      res = typeof raw === "string" ? Number(raw) : (raw as number);
      if (!Number.isInteger(res) || res < 0 || res > maxRes) {
        ctx.log(
          `Error: resolution must be an integer from 0 to ${maxRes} for ${dggsLabel(
            type,
            DEFAULT_DGGRID_GRID_TYPE,
            dggalType,
          )}`,
        );
        return;
      }
    }

    const label = dggsLabel(type, DEFAULT_DGGRID_GRID_TYPE, dggalType);
    const emitResult = (fc: FeatureCollection) => {
      if (fc.features.length === 0) {
        ctx.log(
          mode === "compact"
            ? `No ${label} cells were produced by compact. Check the cell ID field.`
            : `No ${label} cells were produced by expand. Check the cell ID field and target resolution.`,
        );
        return;
      }
      const verb = mode === "compact" ? "Compacted" : "Expanded";
      const suffix = mode === "expand" ? ` to res ${res}` : "";
      ctx.log(`${verb} to ${fc.features.length} ${label} cell(s)${suffix}`);
      ctx.addResultLayer?.(
        mode === "compact" ? `${label} compact` : `${label} expand (res ${res})`,
        fc,
      );
    };

    // S2 is client-side (s2js); no DuckDB.
    if (type === "s2") {
      try {
        const fixAntimeridian = resolveFixAntimeridian(ctx, "s2");
        if (mode === "expand") {
          const tokens = tokensFromS2Layer(layer.geojson, cellField);
          const n = estimateS2ExpandCount(tokens, res);
          const hardCap = hardCapFor("s2");
          if (!Number.isFinite(n) || n <= 0) {
            ctx.log(
              `No S2 cells to expand. Check the cell ID field and that cells are coarser than resolution ${res}.`,
            );
            return;
          }
          if (n > hardCap) {
            ctx.log(
              `Error: expanding to resolution ${res} would generate ${Math.round(n).toLocaleString()} cells (cap ${hardCap.toLocaleString()}). Choose a coarser target.`,
            );
            return;
          }
          emitResult(
            expandS2FeatureCollection(layer.geojson, res, {
              cellField,
              unwrap: fixAntimeridian,
            }),
          );
        } else {
          emitResult(
            compactS2FeatureCollection(layer.geojson, {
              cellField,
              unwrap: fixAntimeridian,
            }),
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.log(`Error: ${message}`);
      }
      return;
    }

    // DGGAL is client-side WASM; no DuckDB.
    if (type === "dggal") {
      try {
        await withDggalDggrs(dggalType, (engine) => {
          if (mode === "expand") {
            const tokens = tokensFromDggalLayer(layer.geojson!, cellField);
            const n = estimateDggalExpandCount(engine, tokens, res);
            const hardCap = hardCapFor("dggal");
            if (!Number.isFinite(n) || n <= 0) {
              ctx.log(
                `No ${label} cells to expand. Check the cell ID field, DGGAL type, and that cells are coarser than resolution ${res}.`,
              );
              return;
            }
            if (n > hardCap) {
              ctx.log(
                `Error: expanding to resolution ${res} would generate ${Math.round(n).toLocaleString()} cells (cap ${hardCap.toLocaleString()}). Choose a coarser target.`,
              );
              return;
            }
            emitResult(expandDggalFeatureCollection(engine, layer.geojson!, res, { cellField }));
          } else {
            emitResult(compactDggalFeatureCollection(engine, layer.geojson!, { cellField }));
          }
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.log(`Error: ${message}`);
      }
      return;
    }

    const duckdb = requireDuckDb(ctx);
    let registered: DuckDbGeoJsonSource | null = null;
    try {
      await duckdb.ensureExtensions(["spatial", extensionForDggs(type)!]);
      registered = await duckdb.registerGeoJson(layer.geojson);
      if (mode === "expand") {
        const countSql =
          type === "a5"
            ? buildA5ExpandCountSql(registered.sql, res, cellField)
            : buildH3ExpandCountSql(registered.sql, res, cellField);
        const countRows = await duckdb.query(countSql);
        const n = Number(countRows[0]?.n ?? 0);
        const hardCap = hardCapFor(type);
        if (!Number.isFinite(n) || n <= 0) {
          ctx.log(
            `No ${label} cells to expand. Check the cell ID field and that cells are coarser than resolution ${res}.`,
          );
          return;
        }
        if (n > hardCap) {
          ctx.log(
            `Error: expanding to resolution ${res} would generate ${Math.round(n).toLocaleString()} cells (cap ${hardCap.toLocaleString()}). Choose a coarser target.`,
          );
          return;
        }
      }

      const sql =
        mode === "compact"
          ? type === "a5"
            ? buildA5CompactSql(registered.sql, cellField)
            : buildH3CompactSql(registered.sql, cellField)
          : type === "a5"
            ? buildA5ExpandSql(registered.sql, res, cellField)
            : buildH3ExpandSql(registered.sql, res, cellField);

      const rows = await duckdb.query(sql);
      const fc =
        type === "a5"
          ? a5RowsToFeatureCollection(rows)
          : rowsToFeatureCollection(rows, resolveFixAntimeridian(ctx, type));
      emitResult(fc);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.log(`Error: ${message}`);
    } finally {
      await registered?.release();
    }
  },
};

export const DGGS_TOOLS: ProcessingAlgorithm[] = [
  createDggsGridTool,
  dggsBinPointsTool,
  dggsCompactTool,
];

export function getDggsTool(id: string): ProcessingAlgorithm | undefined {
  return DGGS_TOOLS.find((tool) => tool.id === id);
}
