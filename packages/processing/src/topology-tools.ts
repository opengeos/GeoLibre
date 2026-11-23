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
// - `fix-polygon-overlaps` / `fill-polygon-gaps` repair the two polygon
//   coverage rules wbtopology cannot fix, client-side with polyclip-ts (the
//   clipper behind @turf/union and @turf/difference).
import difference from "@turf/difference";
import { featureCollection } from "@turf/helpers";
import union from "@turf/union";
import type {
  Feature,
  FeatureCollection,
  Geometry,
  MultiPolygon,
  Polygon,
  Position,
} from "geojson";
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

// ---------------------------------------------------------------------------
// Polygon overlap and gap autofix (client-side, polyclip-ts via Turf)
// ---------------------------------------------------------------------------
//
// wbtopology reports overlaps and gaps but has no automatic fix for either, so
// these two tools repair polygon coverages directly with the same robust
// polygon clipping library (polyclip-ts, through @turf/union and
// @turf/difference) that the Union and Difference vector tools use.

type PolygonFeature = Feature<Polygon | MultiPolygon>;
type BBox = [number, number, number, number];

/** WGS84 mean radius used by `@turf/area`, so areas match the other vector tools. */
const EARTH_RADIUS_M = 6371008.8;

function ringGeodesicArea(ring: Position[]): number {
  // Spherical excess formula (Chamberlain and Duquette), as in @turf/area.
  const n = ring.length;
  if (n <= 2) return 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const lower = ring[i];
    const middle = ring[(i + 1) % n];
    const upper = ring[(i + 2) % n];
    total += (((upper[0] - lower[0]) * Math.PI) / 180) * Math.sin((middle[1] * Math.PI) / 180);
  }
  return Math.abs((total * EARTH_RADIUS_M * EARTH_RADIUS_M) / 2);
}

/**
 * Geodesic area of a polygon or multipolygon in square metres (holes
 * subtracted), using the same formula and earth radius as `@turf/area`.
 *
 * @param geometry - A Polygon or MultiPolygon in WGS84 longitude/latitude.
 * @returns The area in square metres.
 */
export function polygonGeodesicArea(geometry: Polygon | MultiPolygon): number {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  let area = 0;
  for (const rings of polygons) {
    rings.forEach((ring, index) => {
      area += index === 0 ? ringGeodesicArea(ring) : -ringGeodesicArea(ring);
    });
  }
  return Math.max(0, area);
}

function isPolygonFeature(feature: Feature): feature is PolygonFeature {
  return feature.geometry?.type === "Polygon" || feature.geometry?.type === "MultiPolygon";
}

function geometryBBox(geometry: Polygon | MultiPolygon): BBox {
  const box: BBox = [Infinity, Infinity, -Infinity, -Infinity];
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  for (const rings of polygons) {
    for (const [x, y] of rings[0] ?? []) {
      if (x < box[0]) box[0] = x;
      if (y < box[1]) box[1] = y;
      if (x > box[2]) box[2] = x;
      if (y > box[3]) box[3] = y;
    }
  }
  return box;
}

function bboxesIntersect(a: BBox, b: BBox): boolean {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

function asFeature(geometry: Polygon | MultiPolygon): PolygonFeature {
  return { type: "Feature", properties: {}, geometry };
}

/** Which polygon keeps an overlapping area. */
export type OverlapRule = "largest" | "smallest" | "attribute" | "first";

export interface ResolveOverlapsOptions {
  rule: OverlapRule;
  /** For `rule: "attribute"`: the field whose value ranks the polygons. */
  priorityField?: string;
  /** For `rule: "attribute"`: whether the highest value wins (default) or the lowest. */
  priorityOrder?: "high" | "low";
}

export interface ResolveOverlapsResult {
  collection: FeatureCollection;
  /** Polygon features whose geometry changed. */
  modified: number;
  /** Polygon features entirely covered by higher-priority polygons, so removed. */
  removed: number;
}

function isMissingValue(value: unknown): boolean {
  return value === null || value === undefined || value === "";
}

function compareValues(a: unknown, b: unknown): number {
  const aNum = typeof a === "number" ? a : Number(a);
  const bNum = typeof b === "number" ? b : Number(b);
  if (Number.isFinite(aNum) && Number.isFinite(bNum)) return aNum - bNum;
  return String(a).localeCompare(String(b));
}

/**
 * Resolve overlaps in a polygon layer: every area covered by more than one
 * polygon is kept by exactly one of them, chosen by `rule`, and cut out of the
 * others. Polygons are processed in priority order, and each keeps only what
 * the higher-priority polygons already processed have not claimed.
 *
 * - `largest` / `smallest`: the polygon with the larger / smaller original
 *   (geodesic) area wins.
 * - `attribute`: ranked by `priorityField` (highest first unless
 *   `priorityOrder` is `"low"`); features with no value rank last.
 * - `first`: the earlier feature in the layer wins.
 *
 * Ties keep layer order. Non-polygon features pass through untouched; a
 * polygon covered completely by higher-priority polygons is removed.
 *
 * @param fc - The input layer.
 * @param options - The rule deciding which polygon keeps a shared area.
 * @returns The repaired collection (original feature order) and counts.
 */
export function resolvePolygonOverlaps(
  fc: FeatureCollection,
  options: ResolveOverlapsOptions,
): ResolveOverlapsResult {
  const polygons: { index: number; feature: PolygonFeature; area: number; box: BBox }[] = [];
  fc.features.forEach((feature, index) => {
    if (!isPolygonFeature(feature) || !isUsableGeometry(feature.geometry)) return;
    polygons.push({
      index,
      feature,
      area: polygonGeodesicArea(feature.geometry),
      box: geometryBBox(feature.geometry),
    });
  });
  const order = polygons.slice();
  if (options.rule === "largest") {
    order.sort((a, b) => b.area - a.area || a.index - b.index);
  } else if (options.rule === "smallest") {
    order.sort((a, b) => a.area - b.area || a.index - b.index);
  } else if (options.rule === "attribute") {
    const field = options.priorityField ?? "";
    const sign = options.priorityOrder === "low" ? 1 : -1;
    order.sort((a, b) => {
      const av = a.feature.properties?.[field];
      const bv = b.feature.properties?.[field];
      const aMissing = isMissingValue(av);
      const bMissing = isMissingValue(bv);
      // Missing values rank last whatever the direction.
      if (aMissing || bMissing) {
        return aMissing === bMissing ? a.index - b.index : aMissing ? 1 : -1;
      }
      return sign * compareValues(av, bv) || a.index - b.index;
    });
  }

  const claimed: { geometry: Polygon | MultiPolygon; box: BBox }[] = [];
  const output = new Map<number, Feature | null>();
  let modified = 0;
  let removed = 0;
  for (const entry of order) {
    const blockers = claimed.filter((c) => bboxesIntersect(c.box, entry.box));
    let geometry: Polygon | MultiPolygon | null = entry.feature.geometry;
    if (blockers.length > 0) {
      const result = difference(
        featureCollection<Polygon | MultiPolygon>([
          entry.feature,
          ...blockers.map((b) => asFeature(b.geometry)),
        ]),
      );
      geometry = result?.geometry ?? null;
      if (geometry && isUsableGeometry(geometry)) {
        // A blocker that only touched the polygon leaves its area unchanged:
        // keep the original coordinates rather than the clipper's rewrite.
        if (polygonGeodesicArea(geometry) < entry.area * (1 - 1e-9)) modified += 1;
        else geometry = entry.feature.geometry;
      }
    }
    if (!geometry || !isUsableGeometry(geometry)) {
      removed += 1;
      output.set(entry.index, null);
      continue;
    }
    output.set(entry.index, { ...entry.feature, geometry });
    claimed.push({ geometry, box: geometryBBox(geometry) });
  }

  const features: Feature[] = [];
  fc.features.forEach((feature, index) => {
    if (!output.has(index)) {
      features.push(feature);
      return;
    }
    const replaced = output.get(index);
    if (replaced) features.push(replaced);
  });
  return { collection: { type: "FeatureCollection", features }, modified, removed };
}

export interface FillGapsResult {
  collection: FeatureCollection;
  /** Gaps merged into a neighbouring polygon. */
  filled: number;
  /** Enclosed gaps left open because they exceed the area threshold. */
  skippedLarge: number;
  /** Holes bounded by a single polygon (its own interior ring), left alone. */
  skippedHoles: number;
}

function pointSegmentDistance(p: Position, a: Position, b: Position): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSq = dx * dx + dy * dy;
  let t = lengthSq === 0 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function distanceToBoundary(p: Position, geometry: Polygon | MultiPolygon): number {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  let best = Infinity;
  for (const rings of polygons) {
    for (const ring of rings) {
      for (let i = 0; i + 1 < ring.length; i++) {
        const d = pointSegmentDistance(p, ring[i], ring[i + 1]);
        if (d < best) best = d;
      }
    }
  }
  return best;
}

/** Great-circle length of a segment in metres (haversine). */
function segmentLengthM(a: Position, b: Position): number {
  const toRad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toRad;
  const dLng = (b[0] - a[0]) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Coordinate tolerance (degrees) for "this gap edge lies on that polygon's boundary". */
const SHARED_EDGE_TOLERANCE = 1e-8;

function polygonVertices(geometry: Polygon | MultiPolygon): Position[] {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return polygons.flat(2);
}

/**
 * Split segment a-b at every vertex in `vertices` lying strictly inside it.
 *
 * @param a - Segment start.
 * @param b - Segment end.
 * @param vertices - Candidate split points.
 * @returns The segment's points in order, from `a` to `b`.
 */
function splitSegmentAt(a: Position, b: Position, vertices: Position[]): Position[] {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return [a, b];
  const cuts: { t: number; p: Position }[] = [];
  for (const p of vertices) {
    const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSq;
    if (t <= 1e-12 || t >= 1 - 1e-12) continue;
    if (pointSegmentDistance(p, a, b) > SHARED_EDGE_TOLERANCE) continue;
    cuts.push({ t, p });
  }
  cuts.sort((x, y) => x.t - y.t);
  return [a, ...cuts.map((c) => c.p), b];
}

/**
 * Fill gaps in a polygon coverage. A gap is an area completely enclosed by the
 * layer's polygons but covered by none of them (a hole in the union of the
 * layer). Each gap no larger than `maxArea` square metres is merged into the
 * neighbouring polygon sharing the longest stretch of its boundary. Holes
 * bounded entirely by one polygon (its own interior ring) are deliberate
 * holes, not gaps, and are left alone, as are slivers open to the outside of
 * the coverage, which have no enclosing boundary to detect.
 *
 * @param fc - The input layer.
 * @param maxArea - Largest gap to fill, in square metres; 0 or less fills every enclosed gap.
 * @returns The repaired collection (original feature order) and counts.
 */
export function fillPolygonGaps(fc: FeatureCollection, maxArea: number): FillGapsResult {
  const polygons: { index: number; feature: PolygonFeature; box: BBox }[] = [];
  fc.features.forEach((feature, index) => {
    if (!isPolygonFeature(feature) || !isUsableGeometry(feature.geometry)) return;
    polygons.push({ index, feature, box: geometryBBox(feature.geometry) });
  });
  const unchanged: FillGapsResult = {
    collection: fc,
    filled: 0,
    skippedLarge: 0,
    skippedHoles: 0,
  };
  if (polygons.length === 0) return unchanged;
  const merged =
    polygons.length === 1
      ? polygons[0].feature
      : union(featureCollection<Polygon | MultiPolygon>(polygons.map((p) => p.feature)));
  if (!merged) return unchanged;
  const parts =
    merged.geometry.type === "Polygon"
      ? [merged.geometry.coordinates]
      : merged.geometry.coordinates;

  const additions = new Map<number, Polygon[]>();
  let filled = 0;
  let skippedLarge = 0;
  let skippedHoles = 0;
  for (const rings of parts) {
    for (const hole of rings.slice(1)) {
      const gap: Polygon = { type: "Polygon", coordinates: [hole] };
      if (maxArea > 0 && polygonGeodesicArea(gap) > maxArea) {
        skippedLarge += 1;
        continue;
      }
      const box = geometryBBox(gap);
      const neighbours = polygons.filter((p) => bboxesIntersect(p.box, box));
      // Each gap edge is a piece of exactly one polygon's boundary: credit its
      // length to the polygon whose boundary its midpoint lies on.
      // The union merges collinear edges, so first split each gap edge at
      // every neighbour vertex lying on it.
      const neighbourVertices = neighbours.flatMap((n) => polygonVertices(n.feature.geometry));
      const shared = new Map<number, number>();
      for (let i = 0; i + 1 < hole.length; i++) {
        const pieces = splitSegmentAt(hole[i], hole[i + 1], neighbourVertices);
        for (let j = 0; j + 1 < pieces.length; j++) {
          const a = pieces[j];
          const b = pieces[j + 1];
          const mid: Position = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
          let owner: number | null = null;
          let best = SHARED_EDGE_TOLERANCE;
          for (const n of neighbours) {
            const d = distanceToBoundary(mid, n.feature.geometry);
            if (d <= best) {
              best = d;
              owner = n.index;
            }
          }
          if (owner === null) continue;
          shared.set(owner, (shared.get(owner) ?? 0) + segmentLengthM(a, b));
        }
      }
      if (shared.size < 2) {
        // Bounded by one polygon only: an interior ring of that polygon.
        skippedHoles += 1;
        continue;
      }
      let winner = -1;
      let longest = -Infinity;
      for (const [index, length] of shared) {
        // Ties (within a millimetre) go to the earlier feature, for determinism.
        if (length > longest + 1e-3 || (Math.abs(length - longest) <= 1e-3 && index < winner)) {
          winner = index;
          longest = Math.max(length, longest);
        }
      }
      const list = additions.get(winner) ?? [];
      list.push(gap);
      additions.set(winner, list);
      filled += 1;
    }
  }

  if (filled === 0) return { ...unchanged, skippedLarge, skippedHoles };
  const features = fc.features.map((feature, index) => {
    const gaps = additions.get(index);
    if (!gaps || !isPolygonFeature(feature)) return feature;
    const grown = union(
      featureCollection<Polygon | MultiPolygon>([feature, ...gaps.map((g) => asFeature(g))]),
    );
    return grown ? { ...feature, geometry: grown.geometry } : feature;
  });
  return {
    collection: { type: "FeatureCollection", features },
    filled,
    skippedLarge,
    skippedHoles,
  };
}

export const fixPolygonOverlapsTool: ProcessingAlgorithm = {
  id: "fix-polygon-overlaps",
  name: "Fix polygon overlaps",
  description:
    "Remove overlaps between polygons: each overlapping area is kept by one polygon (largest, smallest, first, or by attribute priority) and cut out of the others",
  group: "Data quality",
  parameters: [
    {
      id: "layer",
      label: "Input layer",
      type: "layer",
      required: true,
      geometryFilter: ["polygon"],
    },
    {
      id: "rule",
      label: "Overlap goes to",
      type: "select",
      default: "largest",
      options: [
        { value: "largest", label: "Largest polygon" },
        { value: "smallest", label: "Smallest polygon" },
        { value: "attribute", label: "Attribute priority" },
        { value: "first", label: "First feature in the layer" },
      ],
    },
    {
      id: "priorityField",
      label: "Priority field",
      type: "field",
      visibleWhen: { param: "rule", in: ["attribute"] },
      description: "Features with no value rank last.",
    },
    {
      id: "priorityOrder",
      label: "Priority order",
      type: "select",
      default: "high",
      visibleWhen: { param: "rule", in: ["attribute"] },
      options: [
        { value: "high", label: "Highest value wins" },
        { value: "low", label: "Lowest value wins" },
      ],
    },
  ],
  run: async (ctx) => {
    const fc = requireFeatures(ctx);
    if (!fc) return;
    const rule = String(ctx.parameters.rule ?? "largest") as OverlapRule;
    const priorityField = ctx.parameters.priorityField as string | undefined;
    if (rule === "attribute" && !priorityField) {
      ctx.log("Error: choose a priority field");
      return;
    }
    const result = resolvePolygonOverlaps(fc, {
      rule,
      priorityField,
      priorityOrder: ctx.parameters.priorityOrder === "low" ? "low" : "high",
    });
    if (result.modified === 0 && result.removed === 0) {
      ctx.log("No overlapping polygons found");
      return;
    }
    ctx.log(
      `Trimmed ${result.modified} polygon(s)` +
        (result.removed ? `; removed ${result.removed} completely covered polygon(s)` : ""),
    );
    ctx.addResultLayer?.("Overlaps fixed", result.collection);
  },
};

export const fillPolygonGapsTool: ProcessingAlgorithm = {
  id: "fill-polygon-gaps",
  name: "Fill polygon gaps",
  description:
    "Fill gaps enclosed by a polygon layer: each gap up to a maximum area is merged into the neighbouring polygon that shares the longest boundary with it",
  group: "Data quality",
  parameters: [
    {
      id: "layer",
      label: "Input layer",
      type: "layer",
      required: true,
      geometryFilter: ["polygon"],
    },
    {
      id: "maxArea",
      label: "Maximum gap area (m²)",
      type: "number",
      default: 0,
      min: 0,
      step: 1,
      description:
        "Gaps larger than this stay open; 0 fills every enclosed gap. Holes inside a single polygon are never filled.",
    },
  ],
  run: async (ctx) => {
    const fc = requireFeatures(ctx);
    if (!fc) return;
    const maxArea = Number(ctx.parameters.maxArea ?? 0);
    const result = fillPolygonGaps(fc, Number.isFinite(maxArea) ? maxArea : 0);
    if (result.skippedLarge) {
      ctx.log(`${result.skippedLarge} gap(s) larger than the maximum area were left open`);
    }
    if (result.skippedHoles) {
      ctx.log(`${result.skippedHoles} hole(s) inside a single polygon were left alone`);
    }
    if (result.filled === 0) {
      ctx.log("No gaps to fill");
      return;
    }
    ctx.log(`Filled ${result.filled} gap(s)`);
    ctx.addResultLayer?.("Gaps filled", result.collection);
  },
};

export const TOPOLOGY_TOOLS: ProcessingAlgorithm[] = [
  checkValidityTool,
  fixGeometriesTool,
  checkTopologyRulesTool,
  fixTopologyTool,
  fixPolygonOverlapsTool,
  fillPolygonGapsTool,
];
