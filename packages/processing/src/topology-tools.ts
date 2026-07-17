// Data-quality vector tools: geometry validity (DuckDB-WASM Spatial / GEOS)
// and rule-based topology checking (the wbtopology engine inside
// geolibre-wasm). See GeoLibre#1290.
//
// Engines:
// - `check-validity` / `fix-geometries` run on DuckDB-WASM Spatial
//   (`ST_IsValid` / `ST_MakeValid`, GEOS semantics) in the browser, and on
//   GeoPandas/Shapely via the sidecar or Pyodide (`vector_ops.py` implements
//   the same tool ids, with `explain_validity` reasons).
// - `check-topology-rules` runs `topology_rule_validate` from the WASI tool
//   runner (client-only): rule-set checks across features (overlaps, gaps,
//   dangles, endpoint snapping) that SQL-per-row engines don't cover.
//   `topology_rule_autofix` was evaluated and deliberately not exposed: of its
//   four fixable rules only point-to-line projection demonstrably changed
//   anything (dangle/gap/endpoint-snap probes all produced zero changes).
import type {
  Feature,
  FeatureCollection,
  Geometry,
  Position,
} from "geojson";
import type { GeoLibreLayer } from "@geolibre/core";
import type {
  DuckDbCapability,
  ProcessingAlgorithm,
  ProcessingContext,
} from "./types";

// Mirrors the same helper in vector-tools.ts, h3-tools.ts and registry.ts;
// intentionally duplicated because vector-tools.ts imports from this file, so
// importing the other direction would create a cycle. Keep the copies in sync.
function getLayer(
  ctx: ProcessingContext,
  paramId = "layer",
): GeoLibreLayer | undefined {
  const id = ctx.parameters[paramId] as string | undefined;
  return ctx.layers.find((l) => l.id === id);
}

function requireFeatures(ctx: ProcessingContext): FeatureCollection | null {
  const layer = getLayer(ctx);
  if (!layer?.geojson) {
    ctx.log("Error: select a vector layer with GeoJSON data");
    return null;
  }
  if (!layer.geojson.features?.length) {
    ctx.log("Error: the selected layer has no features");
    return null;
  }
  return layer.geojson;
}

const NO_DUCKDB =
  "This tool requires DuckDB-WASM, which is unavailable in this environment.";

function requireDuckDb(ctx: ProcessingContext): DuckDbCapability {
  if (!ctx.duckdb) throw new Error(NO_DUCKDB);
  return ctx.duckdb;
}

/**
 * Return the first coordinate found in a geometry, used to anchor an error
 * marker on a feature whose exact problem location is unknown (GEOS validity
 * is a per-geometry verdict, not a point).
 *
 * @param geometry - Any GeoJSON geometry, or null.
 * @returns The first `[lng, lat]` position, or null for empty geometry.
 */
export function firstCoordinate(geometry: Geometry | null): Position | null {
  if (!geometry) return null;
  if (geometry.type === "GeometryCollection") {
    for (const member of geometry.geometries) {
      const found = firstCoordinate(member);
      if (found) return found;
    }
    return null;
  }
  let cursor: unknown = geometry.coordinates;
  while (Array.isArray(cursor) && Array.isArray(cursor[0])) cursor = cursor[0];
  return Array.isArray(cursor) && typeof cursor[0] === "number"
    ? (cursor as Position)
    : null;
}

/**
 * Property used to correlate DuckDB result rows back to input features.
 * ST_Read does not guarantee row order, so each feature is tagged with its
 * index before registration and the query selects the tag back out.
 */
export const IDX_PROPERTY = "__geolibre_topo_idx";

/**
 * Copy `fc` with each feature's index stored under {@link IDX_PROPERTY}.
 * The copy is shallow per feature: geometry objects are shared, properties
 * are re-created with the tag added.
 */
export function tagFeatureIndexes(fc: FeatureCollection): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: fc.features.map((feature, index) => ({
      ...feature,
      properties: { ...(feature.properties ?? {}), [IDX_PROPERTY]: index },
    })),
  };
}

/**
 * Build the validity query for a registered source. Exported for tests.
 *
 * `fixInvalid` additionally computes `ST_MakeValid` GeoJSON for the invalid
 * rows only, so Fix geometries never rewrites coordinates of already-valid
 * features through a DuckDB round-trip.
 */
export function buildValiditySql(sourceSql: string, fixInvalid: boolean): string {
  const fixed = fixInvalid
    ? `CASE WHEN ST_IsValid(geom) THEN NULL ELSE ST_AsGeoJSON(ST_MakeValid(geom)) END AS fixed`
    : "NULL AS fixed";
  return (
    `SELECT "${IDX_PROPERTY}" AS idx, ST_IsValid(geom) AS valid, ${fixed} ` +
    `FROM ${sourceSql} WHERE geom IS NOT NULL`
  );
}

interface ValidityRow {
  idx: number;
  valid: boolean;
  fixed: Geometry | null;
}

/**
 * Run the validity query and normalize row values (DuckDB may hand back
 * BigInt indexes and JSON strings). Rows whose payload cannot be interpreted
 * are dropped rather than crashing the tool.
 */
async function queryValidity(
  ctx: ProcessingContext,
  fc: FeatureCollection,
  fixInvalid: boolean,
): Promise<ValidityRow[]> {
  const duckdb = requireDuckDb(ctx);
  await duckdb.ensureExtensions(["spatial"]);
  const registered = await duckdb.registerGeoJson(tagFeatureIndexes(fc));
  try {
    const rows = await duckdb.query(buildValiditySql(registered.sql, fixInvalid));
    const result: ValidityRow[] = [];
    for (const row of rows) {
      const idx = Number(row.idx);
      if (!Number.isInteger(idx) || idx < 0 || idx >= fc.features.length) {
        continue;
      }
      let fixed: Geometry | null = null;
      if (typeof row.fixed === "string" && row.fixed.length > 0) {
        try {
          fixed = JSON.parse(row.fixed) as Geometry;
        } catch {
          fixed = null;
        }
      }
      result.push({ idx, valid: Boolean(row.valid), fixed });
    }
    return result;
  } finally {
    await registered.release();
  }
}

/** Whether a repaired geometry is usable (non-empty) as a replacement. */
export function isUsableGeometry(geometry: Geometry | null): boolean {
  if (!geometry) return false;
  if (geometry.type === "GeometryCollection") {
    return geometry.geometries.some((member) => isUsableGeometry(member));
  }
  return Array.isArray(geometry.coordinates) && geometry.coordinates.length > 0;
}

export const checkValidityTool: ProcessingAlgorithm = {
  id: "check-validity",
  name: "Check validity",
  description:
    "Find features with invalid geometry (GEOS rules: self-intersecting rings, holes outside shells, ...) and mark them on the map",
  group: "Data quality",
  supportsSidecar: true,
  parameters: [
    { id: "layer", label: "Input layer", type: "layer", required: true },
  ],
  run: async (ctx) => {
    const fc = requireFeatures(ctx);
    if (!fc) return;
    const rows = await queryValidity(ctx, fc, false);
    const missingGeometry = fc.features.filter((f) => !f.geometry).length;
    const markers: Feature[] = [];
    for (const row of rows) {
      if (row.valid) continue;
      const feature = fc.features[row.idx];
      const anchor = firstCoordinate(feature.geometry);
      if (!anchor) continue;
      markers.push({
        type: "Feature",
        properties: {
          feature_index: row.idx,
          detail: "invalid geometry — run Fix geometries to repair",
        },
        geometry: { type: "Point", coordinates: anchor },
      });
    }
    const checked = rows.length;
    ctx.log(
      `Checked ${checked} feature(s): ${markers.length} invalid` +
        (missingGeometry ? `, ${missingGeometry} without geometry` : ""),
    );
    if (markers.length === 0) {
      ctx.log("No invalid geometries found");
      return;
    }
    ctx.addResultLayer?.("Validity errors", {
      type: "FeatureCollection",
      features: markers,
    });
  },
};

export const fixGeometriesTool: ProcessingAlgorithm = {
  id: "fix-geometries",
  name: "Fix geometries",
  description:
    "Repair invalid geometries with ST_MakeValid (GEOS); valid features pass through untouched",
  group: "Data quality",
  supportsSidecar: true,
  parameters: [
    { id: "layer", label: "Input layer", type: "layer", required: true },
  ],
  run: async (ctx) => {
    const fc = requireFeatures(ctx);
    if (!fc) return;
    const rows = await queryValidity(ctx, fc, true);
    let fixed = 0;
    let unfixable = 0;
    const features = fc.features.slice();
    for (const row of rows) {
      if (row.valid) continue;
      if (!isUsableGeometry(row.fixed)) {
        unfixable += 1;
        continue;
      }
      const original = features[row.idx];
      features[row.idx] = { ...original, geometry: row.fixed! };
      fixed += 1;
    }
    if (fixed === 0 && unfixable === 0) {
      ctx.log("All geometries are already valid — nothing to fix");
      return;
    }
    ctx.log(
      `Fixed ${fixed} invalid geometr${fixed === 1 ? "y" : "ies"}` +
        (unfixable
          ? `; ${unfixable} could not be repaired and were left unchanged`
          : ""),
    );
    ctx.addResultLayer?.("Fixed geometries", {
      type: "FeatureCollection",
      features,
    });
  },
};

// ---------------------------------------------------------------------------
// Topology rules (wbtopology via the geolibre-wasm WASI runner)
// ---------------------------------------------------------------------------

/** Result of one WASI tool run (mirrors `geolibre-wasm/tools`). */
export interface WasmToolRunResult {
  exitCode: number;
  stdout: string[];
  files: Record<string, Uint8Array>;
}

export type WasmToolRunner = (
  tool: string,
  opts: { args?: string[]; input?: Record<string, Uint8Array> },
) => Promise<WasmToolRunResult>;

let wasmRunnerOverride: WasmToolRunner | null = null;

/**
 * Replace the WASI tool runner. Tests inject either a fake or the real
 * geolibre-wasm module initialized from bytes (the default lazy import
 * resolves the .wasm binary by URL, which only works in a bundler/browser).
 *
 * @param runner - The replacement runner, or null to restore the default.
 */
export function setTopologyWasmRunner(runner: WasmToolRunner | null): void {
  wasmRunnerOverride = runner;
}

async function getWasmRunner(): Promise<WasmToolRunner> {
  if (wasmRunnerOverride) return wasmRunnerOverride;
  const module = (await import("geolibre-wasm/tools")) as unknown as {
    runTool: WasmToolRunner;
  };
  return module.runTool;
}

/**
 * The topology rules `topology_rule_validate` understands, in the order the
 * dialog lists them. `default` reflects which checks make sense on an
 * arbitrary layer: connectivity rules (dangles, endpoint snapping, point
 * coverage) are opt-in because every free line end or standalone point would
 * otherwise be flagged.
 */
export const TOPOLOGY_RULES = [
  {
    ruleId: "line_must_not_self_intersect",
    paramId: "ruleSelfIntersect",
    label: "Lines must not self-intersect",
    default: true,
  },
  {
    ruleId: "polygon_must_not_overlap",
    paramId: "ruleOverlap",
    label: "Polygons must not overlap",
    default: true,
  },
  {
    ruleId: "polygon_must_not_have_gaps",
    paramId: "ruleGaps",
    label: "Polygons must not have gaps",
    default: true,
  },
  {
    ruleId: "line_must_not_have_dangles",
    paramId: "ruleDangles",
    label: "Lines must not have dangles",
    default: false,
  },
  {
    ruleId: "point_must_be_covered_by_line",
    paramId: "rulePointCovered",
    label: "Points must be covered by a line",
    default: false,
  },
  {
    ruleId: "line_endpoints_must_snap_within_tolerance",
    paramId: "ruleEndpointSnap",
    label: "Line endpoints must connect within tolerance",
    default: false,
  },
] as const;

/** Summary report emitted by `topology_rule_validate` (--report). */
interface TopologyRuleReport {
  total_violations?: number;
  violations_by_rule?: Record<string, number>;
}

/** Rule ids selected by the tool's boolean parameters. Exported for tests. */
export function selectedRuleIds(parameters: Record<string, unknown>): string[] {
  return TOPOLOGY_RULES.filter((rule) => {
    const value = parameters[rule.paramId];
    return value === undefined ? rule.default : Boolean(value);
  }).map((rule) => rule.ruleId);
}

export const checkTopologyRulesTool: ProcessingAlgorithm = {
  id: "check-topology-rules",
  name: "Check topology rules",
  description:
    "Validate the layer against topology rules (overlaps, gaps, self-intersections, dangles) and mark each violation on the map",
  group: "Data quality",
  parameters: [
    { id: "layer", label: "Input layer", type: "layer", required: true },
    ...TOPOLOGY_RULES.map((rule) => ({
      id: rule.paramId,
      label: rule.label,
      type: "boolean" as const,
      default: rule.default,
    })),
    {
      id: "snapTolerance",
      label: "Snap tolerance",
      type: "number",
      default: 0.0001,
      min: 0,
      step: 0.0001,
      description:
        "For the endpoint rule: how far apart (in layer coordinate units — degrees for WGS84) two line ends may be and still count as connected.",
    },
  ],
  run: async (ctx) => {
    const fc = requireFeatures(ctx);
    if (!fc) return;
    const rules = selectedRuleIds(ctx.parameters);
    if (rules.length === 0) {
      ctx.log("Error: enable at least one topology rule");
      return;
    }
    const snapTolerance = Number(ctx.parameters.snapTolerance ?? 0.0001);
    const runTool = await getWasmRunner();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const { exitCode, stdout, files } = await runTool("topology_rule_validate", {
      args: [
        "--input=/work/input.geojson",
        "--output=/work/violations.geojson",
        "--report=/work/report.json",
        `--rule_set=${rules.join(",")}`,
        `--snap_tolerance=${snapTolerance}`,
      ],
      input: { "input.geojson": encoder.encode(JSON.stringify(fc)) },
    });
    if (exitCode !== 0) {
      ctx.log(
        `Error: topology check failed — ${stdout.join(" ") || `exit code ${exitCode}`}`,
      );
      return;
    }
    let report: TopologyRuleReport = {};
    try {
      report = JSON.parse(decoder.decode(files["report.json"]));
    } catch {
      // Missing/malformed report: fall back to counting the output features.
    }
    let violations: FeatureCollection | null = null;
    try {
      const parsed: unknown = JSON.parse(decoder.decode(files["violations.geojson"]));
      if (
        (parsed as FeatureCollection)?.type === "FeatureCollection" &&
        Array.isArray((parsed as FeatureCollection).features)
      ) {
        violations = parsed as FeatureCollection;
      }
    } catch {
      // handled below
    }
    if (!violations) {
      ctx.log("Error: topology check produced no readable violations output");
      return;
    }
    const total = report.total_violations ?? violations.features.length;
    ctx.log(
      `Checked ${fc.features.length} feature(s) against ${rules.length} rule(s): ${total} violation(s)`,
    );
    for (const [rule, count] of Object.entries(report.violations_by_rule ?? {})) {
      ctx.log(`  ${rule}: ${count}`);
    }
    if (violations.features.length === 0) {
      ctx.log("No topology violations found");
      return;
    }
    ctx.addResultLayer?.("Topology violations", violations);
  },
};

export const TOPOLOGY_TOOLS: ProcessingAlgorithm[] = [
  checkValidityTool,
  fixGeometriesTool,
  checkTopologyRulesTool,
];
