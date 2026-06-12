import buffer from "@turf/buffer";
import centroid from "@turf/centroid";
import convex from "@turf/convex";
import dissolve from "@turf/dissolve";
import envelope from "@turf/envelope";
import simplify from "@turf/simplify";
import intersect from "@turf/intersect";
import difference from "@turf/difference";
import union from "@turf/union";
import booleanIntersects from "@turf/boolean-intersects";
import booleanContains from "@turf/boolean-contains";
import booleanWithin from "@turf/boolean-within";
import { featureCollection } from "@turf/helpers";
import type {
  Feature,
  FeatureCollection,
  GeoJsonProperties,
  Geometry,
  Polygon,
  MultiPolygon,
} from "geojson";
import type { GeoLibreLayer } from "@geolibre/core";
import type { GeometryFamily, ProcessingAlgorithm, ProcessingContext } from "./types";
import { createH3GridTool, binPointsTool } from "./h3-tools";

/** Upper bound on input×overlay pairs for the main-thread intersection loop. */
const MAX_CLIENT_PAIRS = 250_000;

function getLayer(
  ctx: ProcessingContext,
  paramId = "layer",
): GeoLibreLayer | undefined {
  const layerId = ctx.parameters[paramId] as string | undefined;
  return ctx.layers.find((l) => l.id === layerId);
}

function requireFeatures(
  ctx: ProcessingContext,
  paramId = "layer",
): FeatureCollection | undefined {
  const layer = getLayer(ctx, paramId);
  if (!layer?.geojson?.features?.length) {
    ctx.log(`Error: parameter "${paramId}" has no GeoJSON features`);
    return undefined;
  }
  return layer.geojson;
}

function numberParam(
  ctx: ProcessingContext,
  id: string,
  fallback: number,
): number {
  const raw = ctx.parameters[id];
  const value = typeof raw === "string" ? Number(raw) : (raw as number);
  return Number.isFinite(value) ? value : fallback;
}

/** True when a feature's geometry belongs to the given family. */
function isFamily(geometry: Geometry | null, family: GeometryFamily): boolean {
  const type = geometry?.type;
  if (!type) return false;
  if (family === "point") return type === "Point" || type === "MultiPoint";
  if (family === "line")
    return type === "LineString" || type === "MultiLineString";
  return type === "Polygon" || type === "MultiPolygon";
}

/** Collect every polygon/multipolygon feature from a collection. */
function polygonFeatures(
  fc: FeatureCollection,
): Feature<Polygon | MultiPolygon>[] {
  return fc.features.filter((f) =>
    isFamily(f.geometry, "polygon"),
  ) as Feature<Polygon | MultiPolygon>[];
}

/** Split Polygon/MultiPolygon features into single-part Polygon features. */
function explodeToPolygons(features: Feature[]): Feature<Polygon>[] {
  const result: Feature<Polygon>[] = [];
  for (const feature of features) {
    const geometry = feature.geometry;
    if (geometry?.type === "Polygon") {
      result.push(feature as Feature<Polygon>);
    } else if (geometry?.type === "MultiPolygon") {
      for (const coordinates of geometry.coordinates) {
        result.push({
          type: "Feature",
          properties: feature.properties ?? {},
          geometry: { type: "Polygon", coordinates },
        });
      }
    }
  }
  return result;
}

/** Merge all polygons of a collection into a single (multi)polygon feature. */
function mergePolygons(
  fc: FeatureCollection,
): Feature<Polygon | MultiPolygon> | null {
  const polys = polygonFeatures(fc);
  if (!polys.length) return null;
  let merged: Feature<Polygon | MultiPolygon> = polys[0];
  for (let i = 1; i < polys.length; i += 1) {
    const next = union(featureCollection([merged, polys[i]]));
    // Turf can return null for degenerate/self-intersecting geometry; keep the
    // last good accumulation rather than aborting the whole merge.
    if (next) merged = next as Feature<Polygon | MultiPolygon>;
  }
  return merged;
}

export const bufferTool: ProcessingAlgorithm = {
  id: "buffer",
  name: "Buffer",
  description: "Create a buffer polygon around each feature by a fixed distance",
  group: "Geometry",
  supportsSidecar: true,
  parameters: [
    { id: "layer", label: "Input layer", type: "layer", required: true },
    {
      id: "distance",
      label: "Distance",
      type: "number",
      required: true,
      default: 1,
      min: 0,
      step: 0.1,
    },
    {
      id: "units",
      label: "Units",
      type: "select",
      default: "kilometers",
      options: [
        { value: "kilometers", label: "Kilometers" },
        { value: "meters", label: "Meters" },
        { value: "miles", label: "Miles" },
      ],
    },
  ],
  run: (ctx) => {
    const fc = requireFeatures(ctx);
    if (!fc) return;
    const distance = numberParam(ctx, "distance", 1);
    const units = (ctx.parameters.units as string) || "kilometers";
    const buffered = buffer(fc, distance, {
      units: units as "kilometers" | "meters" | "miles",
    });
    const features = ((buffered?.features ?? []) as Feature[]).filter((f) =>
      Boolean(f?.geometry),
    );
    ctx.log(`Buffered ${features.length} feature(s) by ${distance} ${units}`);
    ctx.addResultLayer?.("Buffer", featureCollection(features));
  },
};

export const centroidsTool: ProcessingAlgorithm = {
  id: "centroids",
  name: "Centroids",
  description: "Compute the centroid point of each feature",
  group: "Geometry",
  supportsSidecar: true,
  parameters: [
    { id: "layer", label: "Input layer", type: "layer", required: true },
  ],
  run: (ctx) => {
    const fc = requireFeatures(ctx);
    if (!fc) return;
    const features = fc.features
      .filter((f) => f.geometry)
      .map((f) => centroid(f, { properties: f.properties ?? {} }));
    ctx.log(`Computed ${features.length} centroid(s)`);
    ctx.addResultLayer?.("Centroids", featureCollection(features));
  },
};

export const convexHullTool: ProcessingAlgorithm = {
  id: "convex-hull",
  name: "Convex hull",
  description: "Compute the convex hull enclosing all features",
  group: "Geometry",
  supportsSidecar: true,
  parameters: [
    { id: "layer", label: "Input layer", type: "layer", required: true },
  ],
  run: (ctx) => {
    const fc = requireFeatures(ctx);
    if (!fc) return;
    const hull = convex(fc);
    if (!hull) {
      ctx.log("Error: unable to compute a convex hull for this layer");
      return;
    }
    ctx.log("Computed convex hull");
    ctx.addResultLayer?.("Convex hull", featureCollection([hull]));
  },
};

export const dissolveTool: ProcessingAlgorithm = {
  id: "dissolve",
  name: "Dissolve",
  description:
    "Merge polygon features into a single geometry, optionally grouped by a field",
  group: "Geometry",
  supportsSidecar: true,
  parameters: [
    {
      id: "layer",
      label: "Input layer",
      type: "layer",
      required: true,
      geometryFilter: ["polygon"],
    },
    {
      id: "field",
      label: "Dissolve field (optional)",
      type: "string",
      description: "Property name to group features by before dissolving",
    },
  ],
  run: (ctx) => {
    const fc = requireFeatures(ctx);
    if (!fc) return;
    // Turf's dissolve only accepts single Polygon features, so explode any
    // MultiPolygon into its constituent Polygons first (mirroring the sidecar,
    // which handles both through GeoPandas) rather than dropping them.
    const polys = explodeToPolygons(fc.features);
    if (!polys.length) {
      ctx.log("Error: Dissolve requires polygon features");
      return;
    }
    const field = (ctx.parameters.field as string)?.trim();
    const dissolved = dissolve(featureCollection(polys), {
      propertyName: field || undefined,
    });
    ctx.log(
      `Dissolved ${polys.length} polygon(s) into ${dissolved.features.length} feature(s)`,
    );
    ctx.addResultLayer?.("Dissolve", dissolved);
  },
};

export const boundingBoxTool: ProcessingAlgorithm = {
  id: "bounding-box",
  name: "Bounding box",
  description: "Compute the rectangular envelope of all features",
  group: "Geometry",
  supportsSidecar: true,
  parameters: [
    { id: "layer", label: "Input layer", type: "layer", required: true },
  ],
  run: (ctx) => {
    const fc = requireFeatures(ctx);
    if (!fc) return;
    const box = envelope(fc);
    ctx.log("Computed bounding box");
    ctx.addResultLayer?.("Bounding box", featureCollection([box]));
  },
};

export const simplifyTool: ProcessingAlgorithm = {
  id: "simplify",
  name: "Simplify",
  description: "Reduce the number of vertices using Douglas-Peucker",
  group: "Geometry",
  supportsSidecar: true,
  parameters: [
    { id: "layer", label: "Input layer", type: "layer", required: true },
    {
      id: "tolerance",
      label: "Tolerance (degrees)",
      type: "number",
      default: 0.01,
      min: 0,
      step: 0.001,
    },
    {
      id: "highQuality",
      label: "High quality",
      type: "boolean",
      default: false,
    },
  ],
  run: (ctx) => {
    const fc = requireFeatures(ctx);
    if (!fc) return;
    const tolerance = numberParam(ctx, "tolerance", 0.01);
    const highQuality = Boolean(ctx.parameters.highQuality);
    const simplified = simplify(fc, { tolerance, highQuality, mutate: false });
    ctx.log(
      `Simplified ${simplified.features.length} feature(s) (tolerance ${tolerance})`,
    );
    ctx.addResultLayer?.("Simplify", simplified);
  },
};

/**
 * Shared engine for two-layer polygon overlay operations
 * (clip, intersection, difference). Each input feature is combined with the
 * merged overlay geometry via the supplied Turf operation.
 */
function overlay(
  ctx: ProcessingContext,
  op: (
    a: Feature<Polygon | MultiPolygon>,
    b: Feature<Polygon | MultiPolygon>,
  ) => Feature<Polygon | MultiPolygon> | null,
  resultName: string,
  keepProperties: boolean,
): void {
  const input = requireFeatures(ctx, "layer");
  const overlayFc = requireFeatures(ctx, "overlay");
  if (!input || !overlayFc) return;
  const inputPolys = polygonFeatures(input);
  const overlayGeom = mergePolygons(overlayFc);
  if (!inputPolys.length || !overlayGeom) {
    ctx.log("Error: both layers must contain polygon features");
    return;
  }
  const results: Feature[] = [];
  for (const feature of inputPolys) {
    const result = op(feature, overlayGeom);
    if (result?.geometry) {
      result.properties = keepProperties ? (feature.properties ?? {}) : {};
      results.push(result);
    }
  }
  ctx.log(`${resultName}: produced ${results.length} feature(s)`);
  ctx.addResultLayer?.(resultName, featureCollection(results));
}

export const clipTool: ProcessingAlgorithm = {
  id: "clip",
  name: "Clip",
  description:
    "Clip the input layer to the area covered by an overlay layer (keeps input attributes)",
  group: "Overlay",
  supportsSidecar: true,
  parameters: [
    {
      id: "layer",
      label: "Input layer",
      type: "layer",
      required: true,
      geometryFilter: ["polygon"],
    },
    {
      id: "overlay",
      label: "Overlay (clip) layer",
      type: "layer",
      required: true,
      geometryFilter: ["polygon"],
    },
  ],
  run: (ctx) =>
    overlay(
      ctx,
      (a, b) =>
        intersect(featureCollection([a, b])) as Feature<
          Polygon | MultiPolygon
        > | null,
      "Clip",
      true,
    ),
};

export const intersectionTool: ProcessingAlgorithm = {
  id: "intersection",
  name: "Intersection",
  description: "Keep only the areas where both polygon layers overlap",
  group: "Overlay",
  supportsSidecar: true,
  parameters: [
    {
      id: "layer",
      label: "Input layer",
      type: "layer",
      required: true,
      geometryFilter: ["polygon"],
    },
    {
      id: "overlay",
      label: "Overlay layer",
      type: "layer",
      required: true,
      geometryFilter: ["polygon"],
    },
  ],
  run: (ctx) => {
    const input = requireFeatures(ctx, "layer");
    const overlayFc = requireFeatures(ctx, "overlay");
    if (!input || !overlayFc) return;
    const inputPolys = polygonFeatures(input);
    const overlayPolys = polygonFeatures(overlayFc);
    if (!inputPolys.length || !overlayPolys.length) {
      ctx.log("Error: both layers must contain polygon features");
      return;
    }
    // This pairwise loop runs on the main thread; cap it so very large layers
    // cannot freeze the browser tab. Use the sidecar engine for bigger jobs.
    const pairs = inputPolys.length * overlayPolys.length;
    if (pairs > MAX_CLIENT_PAIRS) {
      ctx.log(
        `Error: intersection needs ${pairs} comparisons (limit ${MAX_CLIENT_PAIRS}); use the Sidecar engine for large layers`,
      );
      return;
    }
    // Unlike Clip (which keeps only input attributes), Intersection carries
    // merged attributes from both layers, so pair each input feature with each
    // overlay feature rather than a dissolved overlay geometry. This mirrors
    // the sidecar's gpd.overlay(how="intersection").
    const results: Feature[] = [];
    for (const a of inputPolys) {
      for (const b of overlayPolys) {
        const piece = intersect(featureCollection([a, b])) as Feature<
          Polygon | MultiPolygon
        > | null;
        if (piece?.geometry) {
          piece.properties = {
            ...(a.properties ?? {}),
            ...(b.properties ?? {}),
          };
          results.push(piece);
        }
      }
    }
    ctx.log(`Intersection: produced ${results.length} feature(s)`);
    ctx.addResultLayer?.("Intersection", featureCollection(results));
  },
};

export const differenceTool: ProcessingAlgorithm = {
  id: "difference",
  name: "Difference",
  description: "Remove the overlay layer's area from the input layer",
  group: "Overlay",
  supportsSidecar: true,
  parameters: [
    {
      id: "layer",
      label: "Input layer",
      type: "layer",
      required: true,
      geometryFilter: ["polygon"],
    },
    {
      id: "overlay",
      label: "Overlay layer",
      type: "layer",
      required: true,
      geometryFilter: ["polygon"],
    },
  ],
  run: (ctx) =>
    overlay(
      ctx,
      (a, b) =>
        difference(featureCollection([a, b])) as Feature<
          Polygon | MultiPolygon
        > | null,
      "Difference",
      true,
    ),
};

export const unionTool: ProcessingAlgorithm = {
  id: "union",
  name: "Union",
  description: "Merge two polygon layers into a single combined geometry",
  group: "Overlay",
  supportsSidecar: true,
  parameters: [
    {
      id: "layer",
      label: "Input layer",
      type: "layer",
      required: true,
      geometryFilter: ["polygon"],
    },
    {
      id: "overlay",
      label: "Overlay layer",
      type: "layer",
      required: true,
      geometryFilter: ["polygon"],
    },
  ],
  run: (ctx) => {
    const input = requireFeatures(ctx, "layer");
    const overlayFc = requireFeatures(ctx, "overlay");
    if (!input || !overlayFc) return;
    const a = mergePolygons(input);
    const b = mergePolygons(overlayFc);
    if (!a || !b) {
      ctx.log("Error: both layers must contain polygon features");
      return;
    }
    const merged = union(featureCollection([a, b]));
    if (!merged) {
      ctx.log("Error: unable to compute union");
      return;
    }
    const result: Feature<Polygon | MultiPolygon, GeoJsonProperties> = {
      ...merged,
      properties: {},
    };
    ctx.log("Union: produced 1 feature");
    ctx.addResultLayer?.("Union", featureCollection([result]));
  },
};

/** Spatial relationship used to match input features against join features. */
type SpatialPredicate = "intersects" | "within" | "contains";
type SpatialJoinHow = "inner" | "left";

/** Valid spatial-join predicates/join-types; kept in sync with the backend guard. */
const SPATIAL_JOIN_PREDICATES: SpatialPredicate[] = [
  "intersects",
  "within",
  "contains",
];
const SPATIAL_JOIN_HOW: SpatialJoinHow[] = ["inner", "left"];

/**
 * Raw predicate test, mirroring GeoPandas `sjoin(predicate=...)` semantics (the
 * relationship reads left→right): `within` is "input within join", `contains`
 * is "input contains join". Throws on geometries Turf cannot evaluate (e.g. a
 * GeometryCollection).
 */
function rawPredicate(
  input: Feature,
  join: Feature,
  predicate: SpatialPredicate,
): boolean {
  if (predicate === "within") return booleanWithin(input, join);
  if (predicate === "contains") return booleanContains(input, join);
  return booleanIntersects(input, join);
}

/**
 * Like {@link rawPredicate} but treats an unevaluable pair as a non-match rather
 * than letting the exception abort the whole run. Safe for positive predicates
 * (a pair that can't be evaluated simply doesn't match); the complement
 * (`disjoint`) must instead distinguish "no match" from "couldn't evaluate".
 */
function matchesPredicate(
  input: Feature,
  join: Feature,
  predicate: SpatialPredicate,
): boolean {
  try {
    return rawPredicate(input, join, predicate);
  } catch {
    return false;
  }
}

export const spatialJoinTool: ProcessingAlgorithm = {
  id: "spatial-join",
  name: "Spatial join",
  description:
    "Attach attributes from a join layer to each input feature based on a spatial relationship",
  group: "Join",
  supportsSidecar: true,
  parameters: [
    { id: "layer", label: "Input layer", type: "layer", required: true },
    { id: "overlay", label: "Join layer", type: "layer", required: true },
    {
      id: "predicate",
      label: "Spatial relationship",
      type: "select",
      default: "intersects",
      options: [
        { value: "intersects", label: "Intersects" },
        { value: "within", label: "Within" },
        { value: "contains", label: "Contains" },
      ],
    },
    {
      id: "how",
      label: "Join type",
      type: "select",
      default: "inner",
      options: [
        { value: "inner", label: "Inner (keep only matched features)" },
        { value: "left", label: "Left (keep all input features)" },
      ],
    },
  ],
  run: (ctx) => {
    const input = requireFeatures(ctx, "layer");
    if (!input) return;
    const joinLayer = getLayer(ctx, "overlay");
    if (!joinLayer) {
      ctx.log('Error: parameter "overlay" has no layer selected');
      return;
    }
    const inputFeatures = input.features.filter((f) => f.geometry);
    if (!inputFeatures.length) {
      ctx.log("Error: input layer has no features with geometry");
      return;
    }
    // Validate up front so unknown values fail loudly instead of silently
    // coercing to a default, matching the backend's ValueError guard.
    const predicate = (ctx.parameters.predicate as string) || "intersects";
    if (!SPATIAL_JOIN_PREDICATES.includes(predicate as SpatialPredicate)) {
      ctx.log(
        `Error: unknown predicate '${predicate}'; expected ${SPATIAL_JOIN_PREDICATES.join(", ")}`,
      );
      return;
    }
    const how = (ctx.parameters.how as string) || "inner";
    if (!SPATIAL_JOIN_HOW.includes(how as SpatialJoinHow)) {
      ctx.log(
        `Error: unknown join type '${how}'; expected ${SPATIAL_JOIN_HOW.join(", ")}`,
      );
      return;
    }
    // An empty join layer is still well-defined: a left join keeps every input
    // feature unchanged, an inner join yields nothing (mirrors gpd.sjoin).
    const joinFeatures = (joinLayer.geojson?.features ?? []).filter(
      (f) => f.geometry,
    );
    // This pairwise test runs on the main thread; cap it so very large layers
    // cannot freeze the browser tab. Use the Sidecar engine for bigger jobs.
    const pairs = inputFeatures.length * joinFeatures.length;
    if (pairs > MAX_CLIENT_PAIRS) {
      ctx.log(
        `Error: spatial join needs ${pairs} comparisons (limit ${MAX_CLIENT_PAIRS}); use the Sidecar engine for large layers`,
      );
      return;
    }
    // Collect every join-layer attribute key so unmatched left-join rows get a
    // null for each one. This keeps the output schema consistent with matched
    // rows and mirrors GeoPandas, which fills NaN (→ null in GeoJSON) there.
    // Only the left path consumes this, so skip the scan for inner joins.
    const nullJoinProps: GeoJsonProperties = {};
    if (how === "left") {
      for (const j of joinFeatures) {
        for (const key of Object.keys(j.properties ?? {})) {
          nullJoinProps[key] = null;
        }
      }
    }
    const results: Feature[] = [];
    for (const feature of inputFeatures) {
      const matches = joinFeatures.filter((j) =>
        matchesPredicate(feature, j, predicate as SpatialPredicate),
      );
      if (!matches.length) {
        // Left join keeps unmatched input features; inner join drops them,
        // mirroring gpd.sjoin(how=...). Null-fill the join columns so the
        // schema matches matched rows and the sidecar.
        if (how === "left") {
          results.push({
            type: "Feature",
            geometry: feature.geometry,
            properties: { ...nullJoinProps, ...(feature.properties ?? {}) },
          });
        }
        continue;
      }
      // One output feature per match, like GeoPandas sjoin. Input attributes win
      // on name collisions (the sidecar instead suffixes them _left/_right).
      // Build a fresh feature (no `id`) so a one-to-many join does not emit
      // duplicate feature ids, which would corrupt MapLibre feature state.
      for (const match of matches) {
        results.push({
          type: "Feature",
          geometry: feature.geometry,
          properties: {
            ...(match.properties ?? {}),
            ...(feature.properties ?? {}),
          },
        });
      }
    }
    ctx.log(`Spatial join: produced ${results.length} feature(s)`);
    ctx.addResultLayer?.("Spatial join", featureCollection(results));
  },
};

/** Comparison operators for the Select by value tool; kept in sync with the backend. */
const SELECT_VALUE_OPERATORS = new Set([
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "starts-with",
  "is-null",
  "is-not-null",
]);

/** Stable JSON for arrays/objects (sorted keys) so both engines stringify alike. */
function stableStringify(value: unknown): string {
  // JSON.stringify(undefined) is the value `undefined`, which would join to "" in
  // an array (e.g. "[1,,3]"); emit "null" to match Python's None ("[1,null,3]").
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const body = Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
    .join(",");
  return `{${body}}`;
}

/**
 * Parse a string to a finite number accepting exactly the forms Python's
 * `float()` does — decimal/scientific notation only (no hex/octal/binary),
 * surrounding whitespace allowed — so the client and Python numeric coercion
 * agree. (`Number("0x10")` is 16 and `parseFloat("0x10")` is 0, but
 * `float("0x10")` raises, so neither built-in matches.) Returns NaN otherwise.
 */
function parseFiniteNumber(text: string): number {
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text.trim())) return NaN;
  return Number(text);
}

/** Render a GeoJSON property value as a string, matching the backend's `_value_to_string`. */
function valueToString(value: unknown): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  // Arrays/objects: canonical JSON (sorted keys), matching json.dumps on the
  // Python side, so eq/contains agree across engines for non-scalar values.
  if (value !== null && typeof value === "object") return stableStringify(value);
  return String(value);
}

/**
 * Evaluate one feature's attribute value against an operator and the user's
 * input string. Comparisons are numeric only when both sides are finite
 * numbers, otherwise string-based. Empty values (null/undefined/NaN/empty
 * string) match only the is-empty/is-not-empty operators (SQL-like). Mirrors
 * `_match_value` in the Python backend so all three engines agree.
 */
function matchesValue(value: unknown, operator: string, raw: string): boolean {
  const isEmpty =
    value === null ||
    value === undefined ||
    (typeof value === "number" && Number.isNaN(value)) ||
    valueToString(value) === "";
  if (operator === "is-null") return isEmpty;
  if (operator === "is-not-null") return !isEmpty;
  if (isEmpty) return false;

  const sv = valueToString(value);
  if (operator === "contains") return sv.toLowerCase().includes(raw.toLowerCase());
  if (operator === "starts-with")
    return sv.toLowerCase().startsWith(raw.toLowerCase());

  // Numeric comparison only when the value and the input both parse as numbers.
  // Use parseFiniteNumber (not Number()) so we accept exactly what Python's
  // float() does — decimal/scientific only, no hex/octal/binary — keeping the
  // client and Python engines in agreement.
  const vNum = typeof value === "number" ? value : parseFiniteNumber(sv);
  const rNum = parseFiniteNumber(raw);
  const numeric =
    typeof value !== "boolean" &&
    Number.isFinite(vNum) &&
    Number.isFinite(rNum);
  const a: number | string = numeric ? vNum : sv;
  const b: number | string = numeric ? rNum : raw;
  switch (operator) {
    case "eq":
      return a === b;
    case "neq":
      return a !== b;
    case "gt":
      return a > b;
    case "gte":
      return a >= b;
    case "lt":
      return a < b;
    case "lte":
      return a <= b;
    default:
      return false;
  }
}

export const selectByValueTool: ProcessingAlgorithm = {
  id: "select-by-value",
  name: "Select by value",
  description:
    "Extract features whose attribute value matches a condition into a new layer",
  group: "Select",
  supportsSidecar: true,
  parameters: [
    { id: "layer", label: "Input layer", type: "layer", required: true },
    {
      id: "field",
      label: "Field",
      type: "field",
      fieldSource: "layer",
      required: true,
    },
    {
      id: "operator",
      label: "Operator",
      type: "select",
      default: "eq",
      options: [
        { value: "eq", label: "= (equals)" },
        { value: "neq", label: "≠ (not equals)" },
        { value: "gt", label: "> (greater than)" },
        { value: "gte", label: "≥ (greater than or equal)" },
        { value: "lt", label: "< (less than)" },
        { value: "lte", label: "≤ (less than or equal)" },
        { value: "contains", label: "contains (text)" },
        { value: "starts-with", label: "starts with (text)" },
        { value: "is-null", label: "is empty" },
        { value: "is-not-null", label: "is not empty" },
      ],
    },
    {
      id: "value",
      label: "Value",
      type: "string",
      required: true,
      description: "Compared as a number when both sides are numeric.",
      // Hidden (and so skipped by required validation) for the operators that
      // ignore a value; required and form-validated for all the others.
      visibleWhen: { param: "operator", notIn: ["is-null", "is-not-null"] },
    },
  ],
  run: (ctx) => {
    const fc = requireFeatures(ctx, "layer");
    if (!fc) return;
    const field = (ctx.parameters.field as string)?.trim();
    if (!field) {
      ctx.log("Error: a field is required");
      return;
    }
    const operator = (ctx.parameters.operator as string) || "eq";
    if (!SELECT_VALUE_OPERATORS.has(operator)) {
      ctx.log(`Error: unknown operator '${operator}'`);
      return;
    }
    const raw = (ctx.parameters.value as string) ?? "";
    const needsValue = operator !== "is-null" && operator !== "is-not-null";
    if (needsValue && raw === "") {
      ctx.log("Error: a value is required for this operator");
      return;
    }
    // A field absent from every feature is treated as all-empty (schemaless
    // GeoJSON), so is-empty matches everything and the rest match nothing —
    // rather than erroring. matchesValue handles the missing value per feature.
    const selected = fc.features.filter((f) =>
      matchesValue(f.properties?.[field], operator, raw),
    );
    ctx.log(
      `Select by value: ${selected.length} of ${fc.features.length} feature(s) matched`,
    );
    ctx.addResultLayer?.("Select by value", featureCollection(selected));
  },
};

/** Select by location adds "disjoint" (the complement of intersects). */
type SelectLocationPredicate = SpatialPredicate | "disjoint";

/** Spatial predicates for Select by location; kept in sync with the backend. */
const SELECT_LOCATION_PREDICATES = new Set<SelectLocationPredicate>([
  "intersects",
  "within",
  "contains",
  "disjoint",
]);

export const selectByLocationTool: ProcessingAlgorithm = {
  id: "select-by-location",
  name: "Select by location",
  description:
    "Extract features by their spatial relationship to a second layer into a new layer",
  group: "Select",
  supportsSidecar: true,
  parameters: [
    { id: "layer", label: "Input layer", type: "layer", required: true },
    { id: "overlay", label: "Filter layer", type: "layer", required: true },
    {
      id: "predicate",
      label: "Spatial relationship",
      type: "select",
      default: "intersects",
      options: [
        { value: "intersects", label: "Intersects" },
        { value: "within", label: "Within" },
        { value: "contains", label: "Contains" },
        { value: "disjoint", label: "Disjoint (no intersection)" },
      ],
    },
  ],
  run: (ctx) => {
    const input = requireFeatures(ctx, "layer");
    if (!input) return;
    const filterLayer = getLayer(ctx, "overlay");
    if (!filterLayer) {
      ctx.log('Error: parameter "overlay" has no layer selected');
      return;
    }
    // A non-vector layer (raster/tile) has no `geojson`; that's distinct from an
    // empty-but-valid filter layer, so reject it rather than silently treating
    // it as an empty filter (which would select everything for disjoint).
    if (!filterLayer.geojson) {
      ctx.log("Error: the filter layer has no vector data");
      return;
    }
    const predicateInput = (ctx.parameters.predicate as string) || "intersects";
    if (
      !SELECT_LOCATION_PREDICATES.has(predicateInput as SelectLocationPredicate)
    ) {
      ctx.log(`Error: unknown predicate '${predicateInput}'`);
      return;
    }
    const predicate = predicateInput as SelectLocationPredicate;
    const inputFeatures = input.features.filter((f) => f.geometry);
    const filterFeatures = filterLayer.geojson.features.filter((f) => f.geometry);
    if (!inputFeatures.length) {
      ctx.log("Error: input layer has no features with geometry");
      return;
    }
    // This pairwise test runs on the main thread; cap it so very large layers
    // cannot freeze the browser tab. Use the Sidecar engine for bigger jobs.
    const pairs = inputFeatures.length * filterFeatures.length;
    if (pairs > MAX_CLIENT_PAIRS) {
      ctx.log(
        `Error: select by location needs ${pairs} comparisons (limit ${MAX_CLIENT_PAIRS}); use the Sidecar engine for large layers`,
      );
      return;
    }
    // "disjoint" selects features that intersect nothing; the others select
    // features matching the predicate against any filter feature. With an empty
    // filter layer nothing matches, so disjoint keeps everything and the rest
    // keep nothing — matching the backend.
    // In the else branch TS narrows `predicate` to SpatialPredicate, so this is
    // checked — no cast — and would error if the "disjoint" guard were removed.
    const test: SpatialPredicate =
      predicate === "disjoint" ? "intersects" : predicate;
    // For disjoint, a feature dropped only because a pair was unevaluable is not
    // a confident result; count those to warn the user (the sidecar, via
    // GeoPandas, can evaluate geometries Turf cannot, e.g. GeometryCollections).
    let unevaluableDropped = 0;
    const selected = inputFeatures.filter((f) => {
      let matchesAny = false;
      let unevaluable = false;
      for (const g of filterFeatures) {
        try {
          if (rawPredicate(f, g, test)) {
            matchesAny = true;
            break;
          }
        } catch {
          // Turf can't evaluate this pair (e.g. a GeometryCollection).
          unevaluable = true;
        }
      }
      // For positive predicates an unevaluable pair is just a non-match. For the
      // complement (disjoint) we must NOT claim "no intersection" when a pair
      // couldn't be checked, so require every pair to have been evaluable.
      if (predicate === "disjoint") {
        if (!matchesAny && unevaluable) unevaluableDropped += 1;
        return !matchesAny && !unevaluable;
      }
      return matchesAny;
    });
    // Report the total the user sees in the layer list; note any geometry-less
    // features that were skipped (the sidecar drops them too).
    const skipped = input.features.length - inputFeatures.length;
    ctx.log(
      `Select by location: ${selected.length} of ${input.features.length} feature(s) matched` +
        (skipped > 0 ? ` (${skipped} skipped, no geometry)` : ""),
    );
    if (unevaluableDropped > 0) {
      ctx.log(
        `Note: ${unevaluableDropped} feature(s) excluded from disjoint because Turf could not evaluate their geometry; use the Sidecar engine for full support`,
      );
    }
    ctx.addResultLayer?.("Select by location", featureCollection(selected));
  },
};

export const VECTOR_TOOLS: ProcessingAlgorithm[] = [
  bufferTool,
  centroidsTool,
  convexHullTool,
  dissolveTool,
  boundingBoxTool,
  simplifyTool,
  clipTool,
  intersectionTool,
  differenceTool,
  unionTool,
  spatialJoinTool,
  selectByValueTool,
  selectByLocationTool,
  createH3GridTool,
  binPointsTool,
];

export function getVectorTool(id: string): ProcessingAlgorithm | undefined {
  return VECTOR_TOOLS.find((tool) => tool.id === id);
}
