// Data-quality vector tools: geometry validity (DuckDB-WASM Spatial / GEOS)
// and rule-based topology checking (the wbtopology engine inside
// geolibre-wasm). See GeoLibre#1290.
//
// Engines:
// - `check-validity` / `fix-geometries` run on DuckDB-WASM Spatial
//   (`ST_IsValid` / `ST_MakeValid`, GEOS semantics) in the browser, and on
//   GeoPandas/Shapely via the sidecar or Pyodide (`vector_ops.py` implements
//   the same tool ids, with `explain_validity` reasons).
// - `check-topology-rules` / `fix-topology` run `topology_rule_validate` /
//   `topology_rule_autofix` from the WASI tool runner (client-only): rule-set
//   checks across features (overlaps, gaps, dangles, endpoint snapping) that
//   SQL-per-row engines don't cover. Autofix requires geolibre-wasm >= 0.9.0
//   (whitebox-wasm#9/#10 made endpoint/dangle fixes real); the gaps rule still
//   has no automatic fix, so `fix-topology` does not offer it (see
//   FIXABLE_TOPOLOGY_RULES).
import type { Feature, FeatureCollection, Geometry, Position } from "geojson";
import type { GeoLibreLayer } from "@geolibre/core";
import type { DuckDbCapability, ProcessingAlgorithm, ProcessingContext } from "./types";

// Mirrors the same helper in vector-tools.ts, h3-tools.ts and registry.ts;
// intentionally duplicated because vector-tools.ts imports from this file, so
// importing the other direction would create a cycle. Keep the copies in sync.
function getLayer(ctx: ProcessingContext, paramId = "layer"): GeoLibreLayer | undefined {
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

const NO_DUCKDB = "This tool requires DuckDB-WASM, which is unavailable in this environment.";

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
  return firstPositionIn(geometry.coordinates);
}

/**
 * Depth-first search for the first `[x, y]` leaf in a coordinates array.
 * Unlike a naive "descend the first branch" walk, empty siblings are skipped,
 * so `Polygon [[], [ring]]`-shaped nesting still yields a coordinate.
 */
function firstPositionIn(node: unknown): Position | null {
  if (!Array.isArray(node)) return null;
  if (typeof node[0] === "number") return node as Position;
  for (const child of node) {
    const found = firstPositionIn(child);
    if (found) return found;
  }
  return null;
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

/**
 * Whether a geometry is usable (contains at least one actual coordinate).
 * Recursive rather than a top-level length check so nested-empty shapes like
 * `Polygon [[]]` count as empty — matching Shapely's `is_empty` on the
 * sidecar, which this file's parity messaging depends on.
 */
export function isUsableGeometry(geometry: Geometry | null): boolean {
  if (!geometry) return false;
  if (geometry.type === "GeometryCollection") {
    return geometry.geometries.some((member) => isUsableGeometry(member));
  }
  return firstPositionIn(geometry.coordinates) !== null;
}

export const checkValidityTool: ProcessingAlgorithm = {
  id: "check-validity",
  name: "Check validity",
  description:
    "Find features with invalid geometry (GEOS rules: self-intersecting rings, holes outside shells, ...) and mark them on the map",
  group: "Data quality",
  supportsSidecar: true,
  parameters: [{ id: "layer", label: "Input layer", type: "layer", required: true }],
  run: async (ctx) => {
    const fc = requireFeatures(ctx);
    if (!fc) return;
    const rows = await queryValidity(ctx, fc, false);
    // Mirror the sidecar's definition of "without geometry" (null OR empty),
    // so the two engines report the same counts for the same layer.
    const missingGeometry = fc.features.filter((f) => !isUsableGeometry(f.geometry)).length;
    const markers: Feature[] = [];
    let invalid = 0;
    for (const row of rows) {
      if (row.valid) continue;
      const feature = fc.features[row.idx];
      if (!isUsableGeometry(feature.geometry)) continue;
      // Counted even if no marker location resolves, so the summary never
      // understates the problem (matches the sidecar).
      invalid += 1;
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
    const checked = fc.features.length - missingGeometry;
    // Rows can be dropped by queryValidity (unparseable payloads) or omitted
    // by the reader; surface the gap instead of silently understating counts.
    const evaluated = rows.filter((row) => isUsableGeometry(fc.features[row.idx].geometry)).length;
    if (evaluated < checked) {
      ctx.log(
        `Warning: ${checked - evaluated} feature(s) could not be evaluated and are not counted as invalid`,
      );
    }
    ctx.log(
      `Checked ${checked} feature(s): ${invalid} invalid` +
        (missingGeometry ? `, ${missingGeometry} without geometry` : ""),
    );
    if (invalid === 0) {
      ctx.log("No invalid geometries found");
      return;
    }
    if (markers.length === 0) return;
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
  parameters: [{ id: "layer", label: "Input layer", type: "layer", required: true }],
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
        (unfixable ? `; ${unfixable} could not be repaired and were left unchanged` : ""),
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
      ctx.log(`Error: topology check failed — ${stdout.join(" ") || `exit code ${exitCode}`}`);
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

/**
 * The subset of {@link TOPOLOGY_RULES} that `topology_rule_autofix` can
 * actually repair (as of geolibre-wasm 0.9.0 / whitebox-wasm 0.5.0):
 * cross-feature endpoint snapping, dangle snap/projection, and point-to-line
 * projection. `polygon_must_not_have_gaps` is accepted by the engine but
 * never produces changes, so it is not offered here.
 */
export const FIXABLE_TOPOLOGY_RULES = [
  {
    ruleId: "line_endpoints_must_snap_within_tolerance",
    paramId: "ruleEndpointSnap",
    label: "Snap nearly-connected line endpoints",
    default: true,
  },
  {
    ruleId: "line_must_not_have_dangles",
    paramId: "ruleDangles",
    label: "Repair dangles (snap or project onto nearby geometry)",
    default: true,
  },
  {
    ruleId: "point_must_be_covered_by_line",
    paramId: "rulePointCovered",
    label: "Project points onto the nearest line",
    default: false,
  },
] as const;

/**
 * The subset of `topology_rule_autofix`'s change report (--change_report)
 * this tool consumes; the wire shape carries more fields (dry_run,
 * action_type, target_fid, state hashes) that the UI does not surface.
 */
interface TopologyChangeReport {
  total_changes?: number;
  changes_by_rule?: Record<string, number>;
  change_log?: { detail?: string }[];
}

/** Fixable rule ids selected by the tool's boolean parameters. Exported for tests. */
export function selectedFixableRuleIds(parameters: Record<string, unknown>): string[] {
  return FIXABLE_TOPOLOGY_RULES.filter((rule) => {
    const value = parameters[rule.paramId];
    return value === undefined ? rule.default : Boolean(value);
  }).map((rule) => rule.ruleId);
}

/** Longest change-log tail worth echoing into the dialog log. */
const MAX_CHANGE_LOG_LINES = 20;

export const fixTopologyTool: ProcessingAlgorithm = {
  id: "fix-topology",
  name: "Fix topology",
  description:
    "Automatically repair topology violations: snap nearly-connected line endpoints, fix dangles, and project points onto lines. Free ends with nothing nearby are left unchanged.",
  group: "Data quality",
  parameters: [
    { id: "layer", label: "Input layer", type: "layer", required: true },
    ...FIXABLE_TOPOLOGY_RULES.map((rule) => ({
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
        "How far (in layer coordinate units — degrees for WGS84) geometry may move to connect.",
    },
    {
      id: "dryRun",
      label: "Preview only (dry run)",
      type: "boolean",
      default: false,
      description: "Report the fixes that would be applied without creating a repaired layer.",
    },
  ],
  run: async (ctx) => {
    const fc = requireFeatures(ctx);
    if (!fc) return;
    const rules = selectedFixableRuleIds(ctx.parameters);
    if (rules.length === 0) {
      ctx.log("Error: enable at least one fixable topology rule");
      return;
    }
    const snapTolerance = Number(ctx.parameters.snapTolerance ?? 0.0001);
    const dryRun = Boolean(ctx.parameters.dryRun ?? false);
    const runTool = await getWasmRunner();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    // dry_run is passed explicitly: the engine defaults it to true, and an
    // accidental preview here would look like a run that fixed nothing.
    const { exitCode, stdout, files } = await runTool("topology_rule_autofix", {
      args: [
        "--input=/work/input.geojson",
        "--output=/work/fixed.geojson",
        "--change_report=/work/changes.json",
        `--rule_set=${rules.join(",")}`,
        `--snap_tolerance=${snapTolerance}`,
        `--dry_run=${dryRun}`,
      ],
      input: { "input.geojson": encoder.encode(JSON.stringify(fc)) },
    });
    if (exitCode !== 0) {
      ctx.log(`Error: topology fix failed — ${stdout.join(" ") || `exit code ${exitCode}`}`);
      return;
    }
    let report: TopologyChangeReport | null = null;
    try {
      report = JSON.parse(decoder.decode(files["changes.json"]));
    } catch {
      // Missing/malformed change report: the run itself succeeded, so fall
      // through and still deliver the output layer rather than discarding a
      // possibly real fix behind a "no violations" message.
      ctx.log("Warning: the change report could not be read; fix details are unavailable");
    }
    if (report) {
      const total = report.total_changes ?? 0;
      ctx.log(
        `${dryRun ? "Would apply" : "Applied"} ${total} fix(es) across ${rules.length} rule(s)`,
      );
      for (const [rule, count] of Object.entries(report.changes_by_rule ?? {})) {
        if (count > 0) ctx.log(`  ${rule}: ${count}`);
      }
      const log = report.change_log ?? [];
      for (const change of log.slice(0, MAX_CHANGE_LOG_LINES)) {
        if (change.detail) ctx.log(`  ${change.detail}`);
      }
      if (log.length > MAX_CHANGE_LOG_LINES) {
        ctx.log(`  ... and ${log.length - MAX_CHANGE_LOG_LINES} more`);
      }
      if (total === 0) {
        ctx.log(
          "No fixable violations found — free ends and T-junctions are reported by Check topology rules but have no safe automatic fix",
        );
        return;
      }
    }
    if (dryRun) return;
    let fixed: FeatureCollection | null = null;
    try {
      const parsed: unknown = JSON.parse(decoder.decode(files["fixed.geojson"]));
      if (
        (parsed as FeatureCollection)?.type === "FeatureCollection" &&
        Array.isArray((parsed as FeatureCollection).features)
      ) {
        fixed = parsed as FeatureCollection;
      }
    } catch {
      // handled below
    }
    if (!fixed) {
      ctx.log("Error: topology fix produced no readable output layer");
      return;
    }
    ctx.addResultLayer?.("Fixed topology", fixed);
  },
};

export const TOPOLOGY_TOOLS: ProcessingAlgorithm[] = [
  checkValidityTool,
  fixGeometriesTool,
  checkTopologyRulesTool,
  fixTopologyTool,
];
