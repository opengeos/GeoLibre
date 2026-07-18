import buffer from "@turf/buffer";
import centroid from "@turf/centroid";
import convex from "@turf/convex";
import dissolve from "@turf/dissolve";
import envelope from "@turf/envelope";
import flatten from "@turf/flatten";
import simplify from "@turf/simplify";
import intersect from "@turf/intersect";
import difference from "@turf/difference";
import union from "@turf/union";
import voronoiDiagram from "@turf/voronoi";
import tin from "@turf/tin";
import sector from "@turf/sector";
import circle from "@turf/circle";
import distance from "@turf/distance";
import bbox from "@turf/bbox";
import booleanIntersects from "@turf/boolean-intersects";
import booleanContains from "@turf/boolean-contains";
import booleanWithin from "@turf/boolean-within";
import { featureCollection } from "@turf/helpers";
import type {
  BBox,
  Feature,
  FeatureCollection,
  GeoJsonProperties,
  Geometry,
  LineString,
  Point,
  Polygon,
  Position,
  MultiPolygon,
} from "geojson";
import { layerJoinKey, type GeoLibreLayer } from "@geolibre/core";
import type { GeometryFamily, ProcessingAlgorithm, ProcessingContext } from "./types";
import { createH3GridTool, binPointsTool } from "./h3-tools";
import { TOPOLOGY_TOOLS } from "./topology-tools";

/** Upper bound on input×overlay pairs for the main-thread pairwise loops. */
export const MAX_CLIENT_PAIRS = 250_000;

function getLayer(ctx: ProcessingContext, paramId = "layer"): GeoLibreLayer | undefined {
  const layerId = ctx.parameters[paramId] as string | undefined;
  return ctx.layers.find((l) => l.id === layerId);
}

function requireFeatures(ctx: ProcessingContext, paramId = "layer"): FeatureCollection | undefined {
  const layer = getLayer(ctx, paramId);
  if (!layer?.geojson?.features?.length) {
    ctx.log(`Error: parameter "${paramId}" has no GeoJSON features`);
    return undefined;
  }
  return layer.geojson;
}

function numberParam(ctx: ProcessingContext, id: string, fallback: number): number {
  const raw = ctx.parameters[id];
  const value = typeof raw === "string" ? Number(raw) : (raw as number);
  return Number.isFinite(value) ? value : fallback;
}

/** True when a feature's geometry belongs to the given family. */
function isFamily(geometry: Geometry | null, family: GeometryFamily): boolean {
  const type = geometry?.type;
  if (!type) return false;
  if (family === "point") return type === "Point" || type === "MultiPoint";
  if (family === "line") return type === "LineString" || type === "MultiLineString";
  return type === "Polygon" || type === "MultiPolygon";
}

/** Collect every polygon/multipolygon feature from a collection. */
function polygonFeatures(fc: FeatureCollection): Feature<Polygon | MultiPolygon>[] {
  return fc.features.filter((f) => isFamily(f.geometry, "polygon")) as Feature<
    Polygon | MultiPolygon
  >[];
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
function mergePolygons(fc: FeatureCollection): Feature<Polygon | MultiPolygon> | null {
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

/** Summary statistics for Aggregate by attribute; kept in sync with the backend. */
const AGGREGATE_STATS = new Set(["count", "sum", "mean", "min", "max", "median"]);

/**
 * Coerce a property value to a finite number the way pandas' ``to_numeric`` does
 * for the aggregate engine: real numbers pass through, booleans map to 1/0 (as
 * pandas' `to_numeric` does), numeric strings parse (decimal/scientific only —
 * see {@link parseFiniteNumber}), and everything else (null, NaN, text, objects)
 * becomes null and is skipped by the reducers, matching pandas' default skipna
 * behaviour.
 */
function toNumeric(value: unknown): number | null {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const n = parseFiniteNumber(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Reduce a group's numeric values with one statistic, mirroring pandas:
 * ``sum`` of an empty group is 0 (skipna), while ``mean``/``min``/``max``/
 * ``median`` of an empty group are null (NaN → null in GeoJSON). ``count`` is
 * handled by the caller (it counts features, not numeric values).
 */
function computeStat(nums: number[], statistic: string): number | null {
  if (statistic === "sum") return nums.reduce((a, b) => a + b, 0);
  if (!nums.length) return null;
  if (statistic === "mean") return nums.reduce((a, b) => a + b, 0) / nums.length;
  // reduce, not Math.min/max(...nums): the spread passes every element as an
  // argument and a tens-of-thousands-element group would exceed the engine's
  // argument-count limit and throw.
  if (statistic === "min") return nums.reduce((a, b) => (a < b ? a : b));
  if (statistic === "max") return nums.reduce((a, b) => (a > b ? a : b));
  if (statistic === "median") {
    const sorted = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return null;
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
    const features = ((buffered?.features ?? []) as Feature[]).filter((f) => Boolean(f?.geometry));
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
  parameters: [{ id: "layer", label: "Input layer", type: "layer", required: true }],
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
  parameters: [{ id: "layer", label: "Input layer", type: "layer", required: true }],
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
  description: "Merge polygon features into a single geometry, optionally grouped by a field",
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
    ctx.log(`Dissolved ${polys.length} polygon(s) into ${dissolved.features.length} feature(s)`);
    ctx.addResultLayer?.("Dissolve", dissolved);
  },
};

export const boundingBoxTool: ProcessingAlgorithm = {
  id: "bounding-box",
  name: "Bounding box",
  description: "Compute the rectangular envelope of all features",
  group: "Geometry",
  supportsSidecar: true,
  parameters: [{ id: "layer", label: "Input layer", type: "layer", required: true }],
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
    ctx.log(`Simplified ${simplified.features.length} feature(s) (tolerance ${tolerance})`);
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
      (a, b) => intersect(featureCollection([a, b])) as Feature<Polygon | MultiPolygon> | null,
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
      (a, b) => difference(featureCollection([a, b])) as Feature<Polygon | MultiPolygon> | null,
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
const SPATIAL_JOIN_PREDICATES: SpatialPredicate[] = ["intersects", "within", "contains"];
const SPATIAL_JOIN_HOW: SpatialJoinHow[] = ["inner", "left"];

/**
 * Raw predicate test, mirroring GeoPandas `sjoin(predicate=...)` semantics (the
 * relationship reads left→right): `within` is "input within join", `contains`
 * is "input contains join". Throws on geometries Turf cannot evaluate (e.g. a
 * GeometryCollection).
 */
function rawPredicate(input: Feature, join: Feature, predicate: SpatialPredicate): boolean {
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
function matchesPredicate(input: Feature, join: Feature, predicate: SpatialPredicate): boolean {
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
      ctx.log(`Error: unknown join type '${how}'; expected ${SPATIAL_JOIN_HOW.join(", ")}`);
      return;
    }
    // An empty join layer is still well-defined: a left join keeps every input
    // feature unchanged, an inner join yields nothing (mirrors gpd.sjoin).
    const joinFeatures = (joinLayer.geojson?.features ?? []).filter((f) => f.geometry);
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

/**
 * Match key for the Attribute join tool: empty values (null/undefined/NaN/empty
 * string) never match a row, mirroring a SQL/pandas NaN join key. Non-empty
 * values are keyed stringified, so a numeric `5` and the string `"5"` join
 * (both render `"5"`) while a zero-padded code like `"01001"` only matches
 * another `"01001"`. Delegates to `@geolibre/core`'s {@link layerJoinKey} —
 * the persistent-join engine's key — so the two client-side joins cannot
 * drift; the backend's ``_attribute_join_key`` remains the Python mirror.
 */
const attributeJoinKey = layerJoinKey;

/**
 * Join types accepted by the Attribute join tool. Kept local (rather than
 * reusing the spatial join's set) so a future spatial-join-only option cannot
 * silently become valid here; kept in sync with the backend's `_ATTRIBUTE_JOIN_HOW`.
 */
const ATTRIBUTE_JOIN_HOW = ["inner", "left"] as const;

export const attributeJoinTool: ProcessingAlgorithm = {
  id: "attribute-join",
  name: "Attribute join",
  description:
    "Attach attributes from a join layer (a table) onto each input feature where a key field matches, without using geometry. One-to-one: the first matching join row wins.",
  group: "Join",
  supportsSidecar: true,
  parameters: [
    { id: "layer", label: "Target layer", type: "layer", required: true },
    {
      id: "overlay",
      label: "Join layer (table)",
      type: "layer",
      required: true,
      description: "The layer whose attributes are brought over. Its geometry is ignored.",
    },
    {
      id: "target_field",
      label: "Target key field",
      type: "field",
      fieldSource: "layer",
      required: true,
    },
    {
      id: "join_field",
      label: "Join key field",
      type: "field",
      fieldSource: "overlay",
      required: true,
    },
    {
      id: "how",
      label: "Join type",
      type: "select",
      default: "left",
      options: [
        { value: "left", label: "Left (keep all target features)" },
        { value: "inner", label: "Inner (keep only matched features)" },
      ],
    },
    {
      id: "fields",
      label: "Fields to bring over (optional)",
      type: "string",
      description:
        "Comma-separated join fields to copy. Leave blank to bring over every join field except the key.",
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
    const targetField = (ctx.parameters.target_field as string)?.trim();
    if (!targetField) {
      ctx.log("Error: a target key field is required");
      return;
    }
    const joinField = (ctx.parameters.join_field as string)?.trim();
    if (!joinField) {
      ctx.log("Error: a join key field is required");
      return;
    }
    const how = (ctx.parameters.how as string) || "left";
    if (!ATTRIBUTE_JOIN_HOW.includes(how as (typeof ATTRIBUTE_JOIN_HOW)[number])) {
      ctx.log(`Error: unknown join type '${how}'; expected ${ATTRIBUTE_JOIN_HOW.join(", ")}`);
      return;
    }
    // An empty join layer is well-defined: a left join keeps every target
    // feature (no columns added), an inner join yields nothing.
    const joinFeatures = (joinLayer.geojson?.features ?? []).filter(Boolean);

    // Collect every join-layer attribute key in first-seen order so the output
    // schema is deterministic across both engines.
    const joinKeysOrder: string[] = [];
    const joinKeySet = new Set<string>();
    for (const jf of joinFeatures) {
      for (const key of Object.keys(jf.properties ?? {})) {
        if (!joinKeySet.has(key)) {
          joinKeySet.add(key);
          joinKeysOrder.push(key);
        }
      }
    }

    const fieldsRaw = (ctx.parameters.fields as string)?.trim();
    const requestedFields = fieldsRaw
      ? fieldsRaw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : null;
    let selectedFields: string[];
    // An empty array (e.g. fields = "," or ", ,") means the user effectively
    // left the field blank, so fall through to the default rather than erroring.
    if (requestedFields && requestedFields.length > 0) {
      selectedFields = requestedFields.filter((f) => joinKeySet.has(f));
      const missing = requestedFields.filter((f) => !joinKeySet.has(f));
      if (missing.length) {
        ctx.log(`Note: join field(s) not found and skipped: ${missing.join(", ")}`);
      }
      if (!selectedFields.length) {
        ctx.log("Error: none of the requested join fields exist in the join layer");
        return;
      }
    } else {
      // Default: bring over every join field except the key (which would just
      // duplicate the target key column).
      selectedFields = joinKeysOrder.filter((k) => k !== joinField);
      // A join layer that carries only the key column transfers no attributes;
      // warn so the user isn't left thinking a silent no-op succeeded.
      if (joinFeatures.length && !selectedFields.length) {
        ctx.log("Note: no fields to bring over (join layer only contains the key column)");
      }
    }

    // First-match lookup: when several join rows share a key, the first wins.
    const lookup = new Map<string, GeoJsonProperties>();
    for (const jf of joinFeatures) {
      const key = attributeJoinKey(jf.properties?.[joinField]);
      if (key === null) continue;
      if (!lookup.has(key)) lookup.set(key, jf.properties ?? {});
    }

    // Null-fill the brought-over columns for unmatched left-join rows so the
    // output schema stays consistent (mirrors the spatial join and the sidecar).
    const nullFill: GeoJsonProperties = {};
    for (const f of selectedFields) nullFill[f] = null;

    let matched = 0;
    const results: Feature[] = [];
    for (const feature of input.features) {
      const key = attributeJoinKey(feature.properties?.[targetField]);
      const joinProps = key === null ? undefined : lookup.get(key);
      if (!joinProps) {
        if (how === "left") {
          results.push({
            type: "Feature",
            ...(feature.id !== undefined ? { id: feature.id } : {}),
            // Target attributes win on a name collision with a null-filled column.
            properties: { ...nullFill, ...(feature.properties ?? {}) },
            geometry: feature.geometry,
          });
        }
        continue;
      }
      matched += 1;
      const picked: GeoJsonProperties = {};
      for (const f of selectedFields) {
        picked[f] = joinProps[f] !== undefined ? joinProps[f] : null;
      }
      results.push({
        type: "Feature",
        ...(feature.id !== undefined ? { id: feature.id } : {}),
        // Target attributes win on name collisions with brought-over fields.
        properties: { ...picked, ...(feature.properties ?? {}) },
        geometry: feature.geometry,
      });
    }
    ctx.log(
      `Attribute join: ${matched} of ${input.features.length} feature(s) matched; produced ${results.length} feature(s)`,
    );
    ctx.addResultLayer?.("Attribute join", featureCollection(results));
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
  if (operator === "starts-with") return sv.toLowerCase().startsWith(raw.toLowerCase());

  // Numeric comparison only when the value and the input both parse as numbers.
  // Use parseFiniteNumber (not Number()) so we accept exactly what Python's
  // float() does — decimal/scientific only, no hex/octal/binary — keeping the
  // client and Python engines in agreement.
  const vNum = typeof value === "number" ? value : parseFiniteNumber(sv);
  const rNum = parseFiniteNumber(raw);
  const numeric = typeof value !== "boolean" && Number.isFinite(vNum) && Number.isFinite(rNum);
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
  description: "Extract features whose attribute value matches a condition into a new layer",
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
    const selected = fc.features.filter((f) => matchesValue(f.properties?.[field], operator, raw));
    ctx.log(`Select by value: ${selected.length} of ${fc.features.length} feature(s) matched`);
    ctx.addResultLayer?.("Select by value", featureCollection(selected));
  },
};

/** Select by location adds "disjoint" (the complement of intersects). */
export type SelectLocationPredicate = SpatialPredicate | "disjoint";

/** Spatial predicates for Select by location; kept in sync with the backend. */
export const SELECT_LOCATION_PREDICATES = new Set<SelectLocationPredicate>([
  "intersects",
  "within",
  "contains",
  "disjoint",
]);

/** Result of {@link matchFeaturesByLocation}. */
export interface LocationMatches {
  /** One entry per input feature (aligned by index): did it match? */
  matches: boolean[];
  /**
   * Features excluded from a `disjoint` result only because a pair could not
   * be evaluated (e.g. a GeometryCollection Turf cannot test). Always 0 for
   * positive predicates.
   */
  unevaluableDropped: number;
}

/**
 * Tests every input feature against the filter features under a spatial
 * predicate, mirroring the sidecar's semantics: "disjoint" matches features
 * that intersect nothing, the others match features relating to any filter
 * feature. Features without geometry never match; filter features without
 * geometry are ignored. Shared by the Select by location processing tool and
 * the interactive Select by Location dialog (#1314).
 *
 * The pairwise test runs on the calling thread — callers should cap
 * `inputFeatures.length * filterFeatures.length` at {@link MAX_CLIENT_PAIRS}.
 */
export function matchFeaturesByLocation(
  inputFeatures: readonly Feature[],
  filterFeatures: readonly Feature[],
  predicate: SelectLocationPredicate,
): LocationMatches {
  const evaluableFilters = filterFeatures.filter((f) => f.geometry);
  // In the false branch TS narrows `predicate` to SpatialPredicate, so this is
  // checked — no cast — and would error if the "disjoint" guard were removed.
  const test: SpatialPredicate = predicate === "disjoint" ? "intersects" : predicate;
  let unevaluableDropped = 0;
  const matches = inputFeatures.map((f) => {
    if (!f.geometry) return false;
    let matchesAny = false;
    let unevaluable = false;
    for (const g of evaluableFilters) {
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
  return { matches, unevaluableDropped };
}

export const selectByLocationTool: ProcessingAlgorithm = {
  id: "select-by-location",
  name: "Select by location",
  description: "Extract features by their spatial relationship to a second layer into a new layer",
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
    if (!SELECT_LOCATION_PREDICATES.has(predicateInput as SelectLocationPredicate)) {
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
    const { matches, unevaluableDropped } = matchFeaturesByLocation(
      inputFeatures,
      filterFeatures,
      predicate,
    );
    const selected = inputFeatures.filter((_, index) => matches[index]);
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

export const reprojectTool: ProcessingAlgorithm = {
  id: "reproject",
  name: "Reproject",
  description:
    "Reinterpret a layer's coordinates as a source CRS and transform them to WGS84 so they display in the correct location. Requires the Sidecar or Python engine.",
  group: "Geometry",
  supportsSidecar: true,
  requiresSidecar: true,
  parameters: [
    { id: "layer", label: "Input layer", type: "layer", required: true },
    {
      id: "source_crs",
      label: "Source CRS",
      type: "string",
      required: true,
      default: "EPSG:3857",
      description:
        "The CRS the layer's coordinates are really in (e.g. EPSG:3857). The result is transformed to WGS84 (EPSG:4326).",
    },
  ],
  run: (ctx) => {
    // GeoLibre layers are WGS84 GeoJSON, and real CRS math needs pyproj, so the
    // client (Turf.js) engine cannot reproject. Point the user at the engines
    // that share the backend's _reproject (Sidecar/GeoPandas or Pyodide).
    ctx.log(
      'Reproject runs on the Python engine. Choose "Sidecar (GeoPandas)" or ' +
        '"Python (Pyodide)" in the Engine selector above, then run again.',
    );
  },
};

export const explodeTool: ProcessingAlgorithm = {
  id: "explode",
  name: "Explode",
  description:
    "Split multipart geometries into single-part features (one feature per part), keeping each parent's attributes",
  group: "Geometry",
  supportsSidecar: true,
  parameters: [{ id: "layer", label: "Input layer", type: "layer", required: true }],
  run: (ctx) => {
    const fc = requireFeatures(ctx);
    if (!fc) return;
    // Turf's flatten splits Multi* and GeometryCollection features into their
    // single-part components, copying properties — matching GeoPandas explode().
    const exploded = flatten(fc);
    ctx.log(
      `Exploded ${fc.features.length} feature(s) into ${exploded.features.length} single-part feature(s)`,
    );
    ctx.addResultLayer?.("Explode", exploded);
  },
};

export const aggregateTool: ProcessingAlgorithm = {
  id: "aggregate",
  name: "Aggregate by attribute",
  description:
    "Dissolve features that share an attribute value into one geometry per group, with a summary statistic",
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
      id: "group_field",
      label: "Group by field",
      type: "field",
      fieldSource: "layer",
      required: true,
    },
    {
      id: "statistic",
      label: "Statistic",
      type: "select",
      default: "count",
      options: [
        { value: "count", label: "Count" },
        { value: "sum", label: "Sum" },
        { value: "mean", label: "Mean" },
        { value: "min", label: "Min" },
        { value: "max", label: "Max" },
        { value: "median", label: "Median" },
      ],
    },
    {
      id: "stat_field",
      label: "Statistic field",
      type: "field",
      fieldSource: "layer",
      required: true,
      description: "Numeric field summarized by the statistic above.",
      // Count needs no field; every other statistic reduces this numeric field.
      visibleWhen: { param: "statistic", notIn: ["count"] },
    },
  ],
  run: (ctx) => {
    const fc = requireFeatures(ctx);
    if (!fc) return;
    const groupField = (ctx.parameters.group_field as string)?.trim();
    if (!groupField) {
      ctx.log("Error: a group field is required");
      return;
    }
    // Mirror the backend's `group_field not in gdf.columns` guard: if no feature
    // carries the field at all, fail rather than producing a single empty bucket.
    const hasGroupField = fc.features.some((f) =>
      Object.prototype.hasOwnProperty.call(f.properties ?? {}, groupField),
    );
    if (!hasGroupField) {
      ctx.log(`Error: group field '${groupField}' not found in layer attributes.`);
      return;
    }
    const statistic = (ctx.parameters.statistic as string) || "count";
    if (!AGGREGATE_STATS.has(statistic)) {
      ctx.log(`Error: unknown statistic '${statistic}'`);
      return;
    }
    const statField = (ctx.parameters.stat_field as string)?.trim();
    if (statistic !== "count" && !statField) {
      ctx.log(`Error: a statistic field is required for '${statistic}'`);
      return;
    }
    // Both engines restrict Aggregate to polygons (the layer picker filters to
    // polygon layers, and the sidecar drops non-polygons too), so count and the
    // numeric stats stay in sync. Group the polygon features, then union each
    // group's polygons for the output geometry.
    const groups = new Map<
      string,
      { value: unknown; features: Feature[]; nums: number[]; count: number }
    >();
    let skipped = 0;
    for (const feature of fc.features) {
      if (!isFamily(feature.geometry, "polygon")) {
        skipped += 1;
        continue;
      }
      const raw = feature.properties?.[groupField];
      // Skip features with no group value, matching pandas `groupby` (dropna=True),
      // so the client never invents a "null" bucket the sidecar wouldn't produce.
      if (raw === null || raw === undefined) continue;
      const key = stableStringify(raw);
      let group = groups.get(key);
      if (!group) {
        group = { value: raw, features: [], nums: [], count: 0 };
        groups.set(key, group);
      }
      group.features.push(feature);
      group.count += 1;
      if (statistic !== "count" && statField) {
        const num = toNumeric(feature.properties?.[statField]);
        if (num !== null) group.nums.push(num);
      }
    }
    const polygonCount = fc.features.length - skipped;
    if (polygonCount === 0) {
      ctx.log("Error: Aggregate by attribute requires polygon features");
      return;
    }
    if (!groups.size) {
      // Polygons exist but every one had a null/undefined group value; the
      // sidecar (pandas groupby dropna=True) yields an empty grouped result
      // here, so match it instead of erroring on "no polygons".
      ctx.log(`Aggregated ${polygonCount} feature(s) into 0 group(s) by '${groupField}'`);
      ctx.addResultLayer?.("Aggregate by attribute", featureCollection([]));
      return;
    }
    const outColumn = statistic === "count" ? "count" : `${statField}_${statistic}`;
    const results: Feature[] = [];
    for (const group of groups.values()) {
      // Each group holds only polygon features, so mergePolygons always returns a
      // geometry; the null check just satisfies its `| null` return type.
      const merged = mergePolygons(featureCollection(group.features));
      if (!merged) continue;
      const statValue = statistic === "count" ? group.count : computeStat(group.nums, statistic);
      results.push({
        type: "Feature",
        properties: { [groupField]: group.value, [outColumn]: statValue },
        geometry: merged.geometry,
      });
    }
    ctx.log(
      `Aggregated ${polygonCount} feature(s) into ${results.length} group(s) by '${groupField}'` +
        (skipped > 0 ? ` (${skipped} skipped, not polygons)` : ""),
    );
    ctx.addResultLayer?.("Aggregate by attribute", featureCollection(results));
  },
};

/** Largest iteration count Smooth accepts; kept in sync with the backend. */
const SMOOTH_MAX_ITERATIONS = 10;

/**
 * Interpolate the point a fraction `wa` of the way from `a` toward `b` (so
 * `wa = 0.75` lands closer to `a`). Z/elevation is carried through and
 * interpolated when both endpoints are 3D; otherwise the result is 2D.
 */
function chaikinPoint(a: Position, b: Position, wa: number): Position {
  const wb = 1 - wa;
  const x = a[0] * wa + b[0] * wb;
  const y = a[1] * wa + b[1] * wb;
  if (a.length > 2 && b.length > 2) return [x, y, a[2] * wa + b[2] * wb];
  return [x, y];
}

/**
 * One pass of Chaikin's corner-cutting algorithm over a list of positions.
 * Each segment A→B contributes two new points at 1/4 and 3/4 of the way along
 * it. For a closed ring the segments wrap (so every vertex is cut); for an open
 * line the first and last endpoints are preserved. Z is preserved/interpolated
 * (see {@link chaikinPoint}); extra coordinate dimensions are dropped.
 *
 * The exact same arithmetic (and ordering) runs in the Python backend's
 * ``_chaikin`` so the "Sidecar (GeoPandas)" / "Python (Pyodide)" engines return
 * bit-identical coordinates.
 */
function chaikinOnce(points: Position[], closed: boolean): Position[] {
  const n = points.length;
  if (n < (closed ? 3 : 2)) return points;
  const out: Position[] = [];
  if (closed) {
    for (let i = 0; i < n; i += 1) {
      const a = points[i];
      const b = points[(i + 1) % n];
      out.push(chaikinPoint(a, b, 0.75));
      out.push(chaikinPoint(a, b, 0.25));
    }
  } else {
    out.push(points[0].slice(0, 3));
    for (let i = 0; i < n - 1; i += 1) {
      const a = points[i];
      const b = points[i + 1];
      out.push(chaikinPoint(a, b, 0.75));
      out.push(chaikinPoint(a, b, 0.25));
    }
    out.push(points[n - 1].slice(0, 3));
  }
  return out;
}

/** Smooth an open line's coordinates with `iterations` Chaikin passes. */
function smoothLine(coords: Position[], iterations: number): Position[] {
  let pts: Position[] = coords.map((p) => p.slice(0, 3));
  for (let k = 0; k < iterations; k += 1) pts = chaikinOnce(pts, false);
  return pts;
}

/** Smooth a closed polygon ring, keeping it closed (first === last). */
function smoothRing(ring: Position[], iterations: number): Position[] {
  const closed =
    ring.length > 1 &&
    ring[0][0] === ring[ring.length - 1][0] &&
    ring[0][1] === ring[ring.length - 1][1];
  let pts: Position[] = (closed ? ring.slice(0, -1) : ring).map((p) => p.slice(0, 3));
  for (let k = 0; k < iterations; k += 1) pts = chaikinOnce(pts, true);
  // A ring needs >= 3 distinct vertices to form a valid polygon; an empty or
  // otherwise degenerate (1-2 vertex) ring collapses to an empty ring rather
  // than being re-closed into invalid GeoJSON.
  if (pts.length < 3) return [];
  pts.push(pts[0].slice());
  return pts;
}

/** Apply Chaikin smoothing to a single geometry; points pass through unchanged. */
function smoothGeometry(geometry: Geometry, iterations: number): Geometry {
  switch (geometry.type) {
    case "LineString":
      return {
        type: "LineString",
        coordinates: smoothLine(geometry.coordinates, iterations),
      };
    case "MultiLineString":
      return {
        type: "MultiLineString",
        coordinates: geometry.coordinates.map((l) => smoothLine(l, iterations)),
      };
    case "Polygon":
      return {
        type: "Polygon",
        coordinates: geometry.coordinates.map((r) => smoothRing(r, iterations)),
      };
    case "MultiPolygon":
      return {
        type: "MultiPolygon",
        coordinates: geometry.coordinates.map((poly) => poly.map((r) => smoothRing(r, iterations))),
      };
    case "GeometryCollection":
      // Recurse so line/polygon members are smoothed instead of silently
      // passing through; point members fall to the default below.
      return {
        type: "GeometryCollection",
        geometries: geometry.geometries.map((g) => smoothGeometry(g, iterations)),
      };
    default:
      return geometry;
  }
}

export const smoothTool: ProcessingAlgorithm = {
  id: "smooth",
  name: "Smooth",
  description:
    "Round the corners of line and polygon features with Chaikin's algorithm (adds vertices), distinct from Simplify's vertex reduction. Z/elevation is preserved; points pass through unchanged.",
  group: "Geometry",
  supportsSidecar: true,
  parameters: [
    {
      id: "layer",
      label: "Input layer",
      type: "layer",
      required: true,
      geometryFilter: ["line", "polygon"],
    },
    {
      id: "iterations",
      label: "Iterations",
      type: "number",
      default: 3,
      min: 1,
      max: SMOOTH_MAX_ITERATIONS,
      step: 1,
      description: "More iterations give a smoother result (1-10).",
    },
  ],
  run: (ctx) => {
    const fc = requireFeatures(ctx);
    if (!fc) return;
    const iterations = Math.round(numberParam(ctx, "iterations", 3));
    if (iterations < 1 || iterations > SMOOTH_MAX_ITERATIONS) {
      ctx.log(`Error: iterations must be between 1 and ${SMOOTH_MAX_ITERATIONS}`);
      return;
    }
    let smoothed = 0;
    const features: Feature[] = fc.features.map((feature) => {
      const geometry = feature.geometry;
      if (!geometry) return feature;
      const isSmoothable =
        isFamily(geometry, "line") ||
        isFamily(geometry, "polygon") ||
        // A GeometryCollection only counts if it actually has a line/polygon
        // member; a points-only collection passes through unchanged.
        (geometry.type === "GeometryCollection" &&
          geometry.geometries.some((g) => isFamily(g, "line") || isFamily(g, "polygon")));
      if (isSmoothable) smoothed += 1;
      return {
        type: "Feature",
        // Preserve the feature id (the GeoPandas handlers lose it through the
        // GeoDataFrame round-trip, but this raw-JSON path can keep it cheaply).
        ...(feature.id !== undefined ? { id: feature.id } : {}),
        properties: feature.properties ?? {},
        geometry: smoothGeometry(geometry, iterations),
      };
    });
    ctx.log(`Smoothed ${smoothed} feature(s) with ${iterations} iteration(s)`);
    ctx.addResultLayer?.("Smooth", featureCollection(features));
  },
};

/** Hard ceiling on grid cells so a tiny cell size cannot freeze the tab. */
const GRID_HARD_CAP = 1_000_000;

export const gridTool: ProcessingAlgorithm = {
  id: "grid",
  name: "Regular grid",
  description:
    "Generate a regular rectangular grid (fishnet) of cells over an extent. Source: the current map view, a layer's extent, or a manual bounding box.",
  group: "Geometry",
  parameters: [
    {
      id: "source",
      label: "Extent source",
      type: "select",
      default: "viewport",
      options: [
        { value: "viewport", label: "Map viewport" },
        { value: "layer", label: "Layer extent" },
        { value: "bbox", label: "Manual bounding box" },
      ],
    },
    {
      id: "layer",
      label: "Input layer",
      type: "layer",
      required: true,
      visibleWhen: { param: "source", in: ["layer"] },
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
      id: "cell_width",
      label: "Cell width (degrees)",
      type: "number",
      required: true,
      default: 1,
      min: 0.0001,
      step: 0.1,
    },
    {
      id: "cell_height",
      label: "Cell height (degrees)",
      type: "number",
      min: 0.0001,
      step: 0.1,
      description: "Leave blank to match the cell width.",
    },
    {
      id: "cell_type",
      label: "Cell type",
      type: "select",
      default: "polygon",
      options: [
        { value: "polygon", label: "Rectangles" },
        { value: "point", label: "Points (cell centers)" },
      ],
    },
  ],
  run: (ctx) => {
    const source = (ctx.parameters.source as string) || "viewport";
    let bounds: [number, number, number, number] | null = null;
    if (source === "viewport") {
      const view = ctx.viewportBounds?.();
      if (!view) {
        ctx.log("Error: map viewport is unavailable");
        return;
      }
      if (view[0] >= view[2] || view[1] >= view[3]) {
        ctx.log(
          "Error: the map view is empty or crosses the antimeridian; pan so it doesn't wrap +/-180, or use a manual bounding box",
        );
        return;
      }
      bounds = view;
    } else if (source === "bbox") {
      const west = numberParam(ctx, "west", NaN);
      const south = numberParam(ctx, "south", NaN);
      const east = numberParam(ctx, "east", NaN);
      const north = numberParam(ctx, "north", NaN);
      if ([west, south, east, north].some((n) => !Number.isFinite(n))) {
        ctx.log("Error: enter numeric west, south, east, and north values");
        return;
      }
      if (west >= east || south >= north) {
        ctx.log("Error: bounding box must have west < east and south < north");
        return;
      }
      bounds = [west, south, east, north];
    } else {
      const layer = getLayer(ctx, "layer");
      if (!layer?.geojson?.features?.length) {
        ctx.log('Error: parameter "layer" has no GeoJSON features');
        return;
      }
      bounds = bbox(layer.geojson) as [number, number, number, number];
      // Guard the layer path like the viewport/bbox paths: a zero-area extent
      // (e.g. a single-point layer, west === east) or an antimeridian-spanning
      // one (west > east) would otherwise make cols/rows zero or negative,
      // slipping past the cell cap into an empty, misleadingly-logged result.
      if (bounds[0] >= bounds[2] || bounds[1] >= bounds[3]) {
        ctx.log(
          "Error: the layer's extent is empty or spans the antimeridian; use a manual bounding box instead",
        );
        return;
      }
    }

    const cellWidth = numberParam(ctx, "cell_width", NaN);
    if (!Number.isFinite(cellWidth) || cellWidth <= 0) {
      ctx.log("Error: cell width must be greater than 0");
      return;
    }
    const rawHeight = ctx.parameters.cell_height;
    let cellHeight = numberParam(ctx, "cell_height", NaN);
    if (!Number.isFinite(cellHeight) || cellHeight <= 0) {
      // A blank field intentionally means "match the cell width"; only note it
      // when the user actually entered an invalid (non-positive/non-numeric) value.
      if (rawHeight != null && rawHeight !== "") {
        ctx.log(
          `Note: cell height '${rawHeight}' is not a positive number; using the cell width (${cellWidth}°)`,
        );
      }
      cellHeight = cellWidth;
    }

    const [w, s, e, n] = bounds;
    const cols = Math.ceil((e - w) / cellWidth);
    const rows = Math.ceil((n - s) / cellHeight);
    const total = cols * rows;
    if (total > GRID_HARD_CAP) {
      ctx.log(
        `Error: this extent and cell size would generate ${total.toLocaleString()} cells (cap ${GRID_HARD_CAP.toLocaleString()}); use a larger cell size.`,
      );
      return;
    }
    const asPoints = (ctx.parameters.cell_type as string) === "point";
    const features: Feature[] = [];
    for (let col = 0; col < cols; col += 1) {
      const x0 = w + col * cellWidth;
      const x1 = Math.min(x0 + cellWidth, e);
      for (let row = 0; row < rows; row += 1) {
        const y0 = s + row * cellHeight;
        const y1 = Math.min(y0 + cellHeight, n);
        const properties = { col, row };
        if (asPoints) {
          features.push({
            type: "Feature",
            properties,
            geometry: {
              type: "Point",
              coordinates: [(x0 + x1) / 2, (y0 + y1) / 2],
            },
          });
        } else {
          features.push({
            type: "Feature",
            properties,
            geometry: {
              type: "Polygon",
              coordinates: [
                [
                  [x0, y0],
                  [x1, y0],
                  [x1, y1],
                  [x0, y1],
                  [x0, y0],
                ],
              ],
            },
          });
        }
      }
    }
    ctx.log(`Created a ${cols}x${rows} grid (${features.length} cell(s))`);
    ctx.addResultLayer?.("Regular grid", featureCollection(features));
  },
};

/** Collect every Point (exploding MultiPoint) from a collection as Point features. */
function collectPoints(fc: FeatureCollection): Feature<Point>[] {
  const points: Feature<Point>[] = [];
  for (const feature of fc.features) {
    const geometry = feature.geometry;
    if (geometry?.type === "Point") {
      points.push(feature as Feature<Point>);
    } else if (geometry?.type === "MultiPoint") {
      for (const coordinates of geometry.coordinates) {
        points.push({
          type: "Feature",
          properties: feature.properties ?? {},
          geometry: { type: "Point", coordinates },
        });
      }
    }
  }
  return points;
}

export const voronoiTool: ProcessingAlgorithm = {
  id: "voronoi",
  name: "Voronoi / Delaunay",
  description:
    "Build a Voronoi diagram (one polygon per point, clipped to the points' extent) or a Delaunay triangulation from a point layer.",
  group: "Geometry",
  supportsSidecar: true,
  parameters: [
    {
      id: "layer",
      label: "Input point layer",
      type: "layer",
      required: true,
      geometryFilter: ["point"],
    },
    {
      id: "type",
      label: "Diagram",
      type: "select",
      default: "voronoi",
      options: [
        { value: "voronoi", label: "Voronoi polygons" },
        { value: "delaunay", label: "Delaunay triangles" },
      ],
    },
  ],
  run: (ctx) => {
    const fc = requireFeatures(ctx);
    if (!fc) return;
    const kind = (ctx.parameters.type as string) || "voronoi";
    if (kind !== "voronoi" && kind !== "delaunay") {
      ctx.log(`Error: unknown diagram type '${kind}'`);
      return;
    }
    const points = collectPoints(fc);
    if (points.length < 3) {
      ctx.log("Error: Voronoi / Delaunay needs at least 3 points");
      return;
    }
    const pointsFc = featureCollection(points);
    // Both diagrams are undefined for collinear/coincident points (a zero-area
    // bounding box). Turf's tin/voronoi would throw or return nothing; bail with
    // a clear message instead. Mirrors the backend guard.
    const [minX, minY, maxX, maxY] = bbox(pointsFc) as [number, number, number, number];
    if (minX === maxX || minY === maxY) {
      ctx.log(
        "Error: the points are collinear or coincident; Voronoi / Delaunay needs points that span an area",
      );
      return;
    }
    if (kind === "delaunay") {
      const result = tin(pointsFc);
      // The bbox guard above catches axis-aligned collinearity; diagonally
      // collinear points (non-zero-area bbox) still yield no triangle with area,
      // so report that rather than adding an empty layer.
      if (result.features.length === 0) {
        ctx.log("Error: could not triangulate — the points are collinear (no triangle has area)");
        return;
      }
      ctx.log(
        `Delaunay: produced ${result.features.length} triangle(s) from ${points.length} point(s)`,
      );
      ctx.addResultLayer?.("Delaunay", result);
      return;
    }
    // Clip the Voronoi cells to the points' bounding box expanded by a 10% margin,
    // matching the backend, so the outer (otherwise unbounded) cells get a finite
    // extent rather than spanning the whole world.
    const dx = maxX - minX;
    const dy = maxY - minY;
    const clip: BBox = [minX - dx * 0.1, minY - dy * 0.1, maxX + dx * 0.1, maxY + dy * 0.1];
    const result = voronoiDiagram(pointsFc, { bbox: clip });
    // Keep only polygonal cells, matching the backend: clipping a cell whose
    // edge coincides with the bbox can in principle yield a degenerate
    // non-polygon geometry.
    const cells = (result.features ?? []).filter(
      (f) => f?.geometry?.type === "Polygon" || f?.geometry?.type === "MultiPolygon",
    );
    if (cells.length === 0) {
      ctx.log("Error: could not build a Voronoi diagram — the points are collinear");
      return;
    }
    ctx.log(`Voronoi: produced ${cells.length} cell(s) from ${points.length} point(s)`);
    ctx.addResultLayer?.("Voronoi", featureCollection(cells));
  },
};

/** Linear/angular units shared by the sector and proximity tools. */
const LINEAR_UNITS = new Set(["kilometers", "meters", "miles"]);
type LinearUnit = "kilometers" | "meters" | "miles";

/**
 * Read a feature property as a finite number, or null when it is missing or
 * non-numeric. Reuses the aggregate engine's coercion (numbers pass through,
 * numeric strings parse, booleans map to 1/0).
 */
function numberField(props: GeoJsonProperties, field: string | undefined): number | null {
  if (!field) return null;
  return toNumeric(props?.[field]);
}

/**
 * Parse a timestamp property to epoch milliseconds. Accepts parseable date
 * strings (ISO-8601 etc.) and numeric times. Numbers are read by magnitude:
 * `>= 1e11` are taken as epoch milliseconds, and everything else as seconds.
 *
 * The 1e11 boundary sits in the wide gap between the two realistic numeric
 * forms: epoch/relative seconds stay well below ~1e10 (1e10 s is the year 2286;
 * a relative seconds counter is far smaller), while millisecond epochs are
 * >= 1e11 for any date from 1973 onward. This assumes numeric times are not
 * millisecond epochs from before 1973 nor relative-millisecond counters — both
 * unheard of in GPS tracks; use ISO-8601 strings if either is ever needed.
 * Returns null when unparseable.
 */
function parseTimestamp(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return Math.abs(value) >= 1e11 ? value : value * 1000;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    // A bare numeric string is an epoch, not a date, so route it through the
    // numeric branch ("1700000000" → Unix seconds, not "year 1700000000"). The
    // optional exponent also catches scientific notation like "1.7e9".
    if (/^[-+]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed))
      return parseTimestamp(Number(trimmed));
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** A point with a parsed timestamp, used by the movement tools. */
interface TimedPoint {
  coord: Position;
  time: number;
  props: GeoJsonProperties;
}

/**
 * Collect timed point features grouped by an optional id field (each distinct
 * value is one target/trajectory), sorted by time within each group. Points
 * lacking a parseable timestamp are counted in `skipped`; when an id field is
 * set, points with no id value are counted in `skippedNoId` rather than being
 * lumped under one anonymous trajectory (which would wrongly connect unrelated
 * targets). Both kinds are dropped.
 */
function collectTimedPoints(
  fc: FeatureCollection,
  timeField: string,
  idField: string | undefined,
): { groups: Map<string, TimedPoint[]>; skipped: number; skippedNoId: number } {
  const groups = new Map<string, TimedPoint[]>();
  let skipped = 0;
  let skippedNoId = 0;
  for (const point of collectPoints(fc)) {
    const time = parseTimestamp(point.properties?.[timeField]);
    if (time === null) {
      skipped += 1;
      continue;
    }
    // The "__all__" sentinel is only used when no id field is set; in that case
    // the `if (idField)` branch never runs, so a real trajectory whose id value
    // happens to be "__all__" cannot collide with it (the two paths are mutually
    // exclusive within a single call).
    let key = "__all__";
    if (idField) {
      const rawId = point.properties?.[idField];
      if (rawId == null) {
        skippedNoId += 1;
        continue;
      }
      key = String(rawId);
    }
    const entry: TimedPoint = {
      coord: point.geometry.coordinates,
      time,
      props: point.properties ?? {},
    };
    const bucket = groups.get(key);
    if (bucket) bucket.push(entry);
    else groups.set(key, [entry]);
  }
  for (const bucket of groups.values()) bucket.sort((a, b) => a.time - b.time);
  return { groups, skipped, skippedNoId };
}

export const cellSectorsTool: ProcessingAlgorithm = {
  id: "cell-sectors",
  name: "Cell-site coverage",
  description:
    "Build antenna sector/wedge polygons from point sites using azimuth, radius and beamwidth (read from attribute fields or fixed values). Beamwidth is clamped to 360° (a full circle); the recorded beamwidth reflects the clamped value. Useful for cell-tower coverage, like QGIS Shape Tools.",
  group: "Geometry",
  parameters: [
    {
      id: "layer",
      label: "Input point layer",
      type: "layer",
      required: true,
      geometryFilter: ["point"],
    },
    {
      id: "azimuthField",
      label: "Azimuth field (°)",
      type: "field",
      fieldSource: "layer",
      description:
        "Direction the sector faces, in degrees clockwise from north. Falls back to the fixed azimuth when blank or non-numeric.",
    },
    {
      id: "azimuth",
      label: "Azimuth (fixed, °)",
      type: "number",
      default: 0,
      step: 1,
    },
    {
      id: "radiusField",
      label: "Radius field",
      type: "field",
      fieldSource: "layer",
      description: "Coverage radius. Falls back to the fixed radius when blank or non-numeric.",
    },
    {
      id: "radius",
      label: "Radius (fixed)",
      type: "number",
      default: 1,
      min: 0,
      step: 0.1,
    },
    {
      id: "beamwidthField",
      label: "Beamwidth field (°)",
      type: "field",
      fieldSource: "layer",
      description:
        "Angular width of the sector, clamped to 360° (a full circle). Falls back to the fixed beamwidth when blank or non-numeric.",
    },
    {
      id: "beamwidth",
      label: "Beamwidth (fixed, °)",
      type: "number",
      default: 65,
      min: 0,
      max: 360,
      step: 1,
    },
    {
      id: "units",
      label: "Radius units",
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
    const azimuthField = (ctx.parameters.azimuthField as string)?.trim() || undefined;
    const radiusField = (ctx.parameters.radiusField as string)?.trim() || undefined;
    const beamwidthField = (ctx.parameters.beamwidthField as string)?.trim() || undefined;
    const azimuthDefault = numberParam(ctx, "azimuth", 0);
    const radiusDefault = numberParam(ctx, "radius", 1);
    const beamwidthDefault = numberParam(ctx, "beamwidth", 65);
    const units = (ctx.parameters.units as string) || "kilometers";
    if (!LINEAR_UNITS.has(units)) {
      ctx.log(`Error: unknown units '${units}'`);
      return;
    }
    const points = collectPoints(fc);
    if (!points.length) {
      ctx.log("Error: the input layer has no point features");
      return;
    }
    const sectors: Feature<Polygon | MultiPolygon>[] = [];
    let skipped = 0;
    for (const point of points) {
      const props = point.properties ?? {};
      const azimuth = numberField(props, azimuthField) ?? azimuthDefault;
      const radius = numberField(props, radiusField) ?? radiusDefault;
      let angle = numberField(props, beamwidthField) ?? beamwidthDefault;
      // A non-positive radius or beamwidth has no coverage to draw; skip it.
      if (!(radius > 0) || !(angle > 0)) {
        skipped += 1;
        continue;
      }
      // A full turn is undefined for turf's sector (its two bearings coincide
      // after normalization), so draw an omnidirectional site as a circle.
      if (angle > 360) angle = 360;
      const full = angle === 360; // only reachable once the clamp above fired
      const wedge = full
        ? circle(point.geometry.coordinates, radius, { units: units as LinearUnit })
        : sector(point.geometry.coordinates, radius, azimuth - angle / 2, azimuth + angle / 2, {
            units: units as LinearUnit,
          });
      if (!wedge?.geometry) {
        skipped += 1;
        continue;
      }
      wedge.properties = { ...props, azimuth, radius, beamwidth: angle };
      sectors.push(wedge as Feature<Polygon | MultiPolygon>);
    }
    if (skipped) {
      // Covers both skip reasons above: non-positive radius/beamwidth, and a
      // degenerate geometry returned by turf's sector.
      ctx.log(
        `Skipped ${skipped} site(s) with a non-positive radius/beamwidth or degenerate geometry`,
      );
    }
    ctx.log(`Cell-site coverage: built ${sectors.length} sector(s) from ${points.length} site(s)`);
    ctx.addResultLayer?.("Cell-site coverage", featureCollection(sectors));
  },
};

/**
 * Multipliers from metres-per-second to each supported speed unit. The keys are
 * the literal unit strings (e.g. "m/s", not "ms") so the `speed_units` value in
 * the output GeoJSON is unambiguous to downstream consumers.
 */
const SPEED_FACTORS: Record<string, number> = {
  "m/s": 1,
  "km/h": 3.6,
  mph: 2.2369362920544,
};

export const trajectorySpeedTool: ProcessingAlgorithm = {
  id: "trajectory-speed",
  name: "Trajectory speed",
  description:
    "Order points by time (per target) and connect consecutive fixes into segments carrying distance, duration and speed. Like QGIS TrajecTools.",
  group: "Movement & time",
  parameters: [
    {
      id: "layer",
      label: "Input point layer",
      type: "layer",
      required: true,
      geometryFilter: ["point"],
    },
    {
      id: "timeField",
      label: "Time field",
      type: "field",
      fieldSource: "layer",
      required: true,
      description:
        "Timestamp per fix: an ISO date/time string or an epoch (seconds or milliseconds).",
    },
    {
      id: "idField",
      label: "Target id field",
      type: "field",
      fieldSource: "layer",
      description:
        "Splits the points into separate trajectories. Leave blank to treat all points as one target.",
    },
    {
      id: "speedUnits",
      label: "Speed units",
      type: "select",
      default: "km/h",
      options: [
        { value: "km/h", label: "km/h" },
        { value: "m/s", label: "m/s" },
        { value: "mph", label: "mph" },
      ],
    },
  ],
  run: (ctx) => {
    const fc = requireFeatures(ctx);
    if (!fc) return;
    const timeField = (ctx.parameters.timeField as string)?.trim();
    if (!timeField) {
      ctx.log("Error: a time field is required");
      return;
    }
    const idField = (ctx.parameters.idField as string)?.trim() || undefined;
    const speedUnits = (ctx.parameters.speedUnits as string) || "km/h";
    const factor = SPEED_FACTORS[speedUnits];
    if (factor === undefined) {
      ctx.log(`Error: unknown speed units '${speedUnits}'`);
      return;
    }
    const { groups, skipped, skippedNoId } = collectTimedPoints(fc, timeField, idField);
    const segments: Feature<LineString>[] = [];
    for (const [key, pts] of groups) {
      for (let i = 1; i < pts.length; i += 1) {
        const a = pts[i - 1];
        const b = pts[i];
        const meters = distance(a.coord, b.coord, { units: "meters" });
        const seconds = (b.time - a.time) / 1000;
        // Equal timestamps (the only non-positive gap after sorting) give an
        // undefined speed; emit the segment with null rather than Infinity.
        const speed = seconds > 0 ? Math.round((meters / seconds) * factor * 1000) / 1000 : null;
        segments.push({
          type: "Feature",
          properties: {
            ...(idField ? { [idField]: key } : {}),
            from_time: a.props?.[timeField] ?? null,
            to_time: b.props?.[timeField] ?? null,
            duration_s: Math.round(seconds),
            distance_m: Math.round(meters * 100) / 100,
            speed,
            speed_units: speedUnits,
          },
          geometry: { type: "LineString", coordinates: [a.coord, b.coord] },
        });
      }
    }
    if (skipped) ctx.log(`Skipped ${skipped} point(s) with no parseable time`);
    if (skippedNoId) ctx.log(`Skipped ${skippedNoId} point(s) with no '${idField}' value`);
    if (!segments.length) {
      ctx.log("Error: need at least two timed fixes in a target to build a segment");
      return;
    }
    // Consecutive fixes with identical timestamps yield a null speed; warn so a
    // style-by-speed expression downstream isn't silently fed nulls.
    const nullSpeed = segments.filter((s) => s.properties?.speed === null).length;
    if (nullSpeed)
      ctx.log(`Warning: ${nullSpeed} segment(s) have identical timestamps and null speed`);
    ctx.log(
      `Trajectory speed: built ${segments.length} segment(s) across ${groups.size} target(s)`,
    );
    ctx.addResultLayer?.("Trajectory speed", featureCollection(segments));
  },
};

/**
 * Point cap for the stop scan. The scan re-anchors on every non-stop advance
 * (see the loop below), so its worst case is O(n²) Haversine calls on the UI
 * thread. 5,000 points bounds that to ~12.5M calls (~1-2 s) in the degenerate
 * case; the typical case is far cheaper because a formed stop jumps the anchor.
 * Larger inputs get a clear "split the layer" error rather than a frozen tab.
 */
const STOPS_MAX_POINTS = 5_000;

export const detectStopsTool: ProcessingAlgorithm = {
  id: "detect-stops",
  name: "Detect stops",
  description:
    "Find places where a target dwells: runs of consecutive fixes that stay within a distance (absorbing GPS scatter) for at least a minimum duration. Outputs one point per stop. Like QGIS TrajecTools.",
  group: "Movement & time",
  parameters: [
    {
      id: "layer",
      label: "Input point layer",
      type: "layer",
      required: true,
      geometryFilter: ["point"],
    },
    {
      id: "timeField",
      label: "Time field",
      type: "field",
      fieldSource: "layer",
      required: true,
      description:
        "Timestamp per fix: an ISO date/time string or an epoch (seconds or milliseconds).",
    },
    {
      id: "idField",
      label: "Target id field",
      type: "field",
      fieldSource: "layer",
      description: "Detects stops per target. Leave blank to treat all points as one target.",
    },
    {
      id: "maxDistance",
      label: "Max distance",
      type: "number",
      required: true,
      default: 50,
      min: 0,
      step: 1,
      description:
        "Every fix in a stop must be within this distance of the stop's first fix (so a stop can span up to twice this value). Set it to your GPS scatter radius.",
    },
    {
      id: "distanceUnits",
      label: "Distance units",
      type: "select",
      default: "meters",
      options: [
        { value: "meters", label: "Meters" },
        { value: "kilometers", label: "Kilometers" },
        { value: "miles", label: "Miles" },
      ],
    },
    {
      id: "minDuration",
      label: "Min duration (s)",
      type: "number",
      required: true,
      default: 60,
      min: 0,
      step: 1,
      description: "A dwell shorter than this is not reported as a stop.",
    },
  ],
  run: (ctx) => {
    const fc = requireFeatures(ctx);
    if (!fc) return;
    const timeField = (ctx.parameters.timeField as string)?.trim();
    if (!timeField) {
      ctx.log("Error: a time field is required");
      return;
    }
    const idField = (ctx.parameters.idField as string)?.trim() || undefined;
    const maxDistance = numberParam(ctx, "maxDistance", 50);
    const distanceUnits = (ctx.parameters.distanceUnits as string) || "meters";
    if (!LINEAR_UNITS.has(distanceUnits)) {
      ctx.log(`Error: unknown distance units '${distanceUnits}'`);
      return;
    }
    const minDurationMs = numberParam(ctx, "minDuration", 60) * 1000;
    const { groups, skipped, skippedNoId } = collectTimedPoints(fc, timeField, idField);
    let totalPoints = 0;
    for (const pts of groups.values()) totalPoints += pts.length;
    if (totalPoints === 0) {
      ctx.log("Error: no points with a parseable time; check the time field");
      return;
    }
    if (totalPoints > STOPS_MAX_POINTS) {
      ctx.log(
        `Error: ${totalPoints.toLocaleString()} timed points exceed the ${STOPS_MAX_POINTS.toLocaleString()} limit for stop detection; filter or split the layer first`,
      );
      return;
    }
    const stops: Feature<Point>[] = [];
    for (const [key, pts] of groups) {
      let i = 0;
      while (i < pts.length) {
        // `j` restarts from i+1 every iteration by design: the distance test is
        // relative to the current anchor pts[i], so when a run is rejected and i
        // advances by one (below), the next anchor must be re-scanned. This is
        // the source of the O(n²) worst case bounded by STOPS_MAX_POINTS; do not
        // "optimize" it into a monotonic pointer, which would change the result.
        let j = i + 1;
        // Extend the run while each later fix stays within maxDistance of the
        // anchor (the run's first fix), so brief GPS scatter around one spot is
        // absorbed into a single stop.
        while (
          j < pts.length &&
          distance(pts[i].coord, pts[j].coord, {
            units: distanceUnits as LinearUnit,
          }) <= maxDistance
        ) {
          j += 1;
        }
        const run = pts.slice(i, j);
        const durationMs = run[run.length - 1].time - run[0].time;
        if (run.length >= 2 && durationMs >= minDurationMs) {
          // Average longitudes relative to the anchor and unwrap each delta into
          // [-180, 180] so a stop straddling the antimeridian (e.g. 179.9 and
          // -179.9) centres near ±180, not 0. The run is within maxDistance of
          // the anchor, so the deltas are tiny and the unwrap is unambiguous.
          const anchorLon = run[0].coord[0];
          let sumLonDelta = 0;
          let sumLat = 0;
          for (const p of run) {
            let dLon = p.coord[0] - anchorLon;
            if (dLon > 180) dLon -= 360;
            else if (dLon < -180) dLon += 360;
            sumLonDelta += dLon;
            sumLat += p.coord[1];
          }
          const meanLon = ((anchorLon + sumLonDelta / run.length + 540) % 360) - 180;
          stops.push({
            type: "Feature",
            properties: {
              ...(idField ? { [idField]: key } : {}),
              arrival: run[0].props?.[timeField] ?? null,
              departure: run[run.length - 1].props?.[timeField] ?? null,
              duration_s: Math.round(durationMs / 1000),
              n_points: run.length,
            },
            geometry: {
              type: "Point",
              coordinates: [meanLon, sumLat / run.length],
            },
          });
          i = j; // a fix belongs to at most one stop
        } else {
          i += 1; // not a stop; advance and retry from the next fix
        }
      }
    }
    if (skipped) ctx.log(`Skipped ${skipped} point(s) with no parseable time`);
    if (skippedNoId) ctx.log(`Skipped ${skippedNoId} point(s) with no '${idField}' value`);
    ctx.log(`Detect stops: found ${stops.length} stop(s) across ${groups.size} target(s)`);
    ctx.addResultLayer?.("Stops", featureCollection(stops));
  },
};

/**
 * Worst-case pair cap for the space-time proximity scan. Each pair within the
 * time window costs one Haversine call on the UI thread, so this bounds the
 * absolute worst case (all points inside the window) to ~2M calls (~1s). Typical
 * runs are far cheaper because the time-sorted loop breaks out once the gap is
 * exceeded; the cap only rejects layers whose worst case would freeze the tab.
 */
const PROXIMITY_MAX_PAIRS = 2_000_000;
/** Multipliers from each supported time unit to milliseconds. */
const TIME_UNIT_MS: Record<string, number> = {
  seconds: 1000,
  minutes: 60_000,
  hours: 3_600_000,
};

export const spaceTimeProximityTool: ProcessingAlgorithm = {
  id: "space-time-proximity",
  name: "Space-time proximity",
  description:
    "Find pairs of points close in both space and time — e.g. two targets meeting. Outputs a line connecting each qualifying pair, carrying the distance and time gap.",
  group: "Movement & time",
  parameters: [
    {
      id: "layer",
      label: "Input point layer",
      type: "layer",
      required: true,
      geometryFilter: ["point"],
    },
    {
      id: "timeField",
      label: "Time field",
      type: "field",
      fieldSource: "layer",
      required: true,
      description:
        "Timestamp per point: an ISO date/time string or an epoch (seconds or milliseconds).",
    },
    {
      id: "idField",
      label: "Target id field",
      type: "field",
      fieldSource: "layer",
      description:
        "When set, only points with DIFFERENT id values are paired (encounters between distinct targets). Leave blank to consider every pair.",
    },
    {
      id: "maxDistance",
      label: "Max distance",
      type: "number",
      required: true,
      default: 100,
      min: 0,
      step: 1,
    },
    {
      id: "distanceUnits",
      label: "Distance units",
      type: "select",
      default: "meters",
      options: [
        { value: "meters", label: "Meters" },
        { value: "kilometers", label: "Kilometers" },
        { value: "miles", label: "Miles" },
      ],
    },
    {
      id: "maxTime",
      label: "Max time difference",
      type: "number",
      required: true,
      default: 5,
      min: 0,
      step: 1,
    },
    {
      id: "timeUnits",
      label: "Time units",
      type: "select",
      default: "minutes",
      options: [
        { value: "seconds", label: "Seconds" },
        { value: "minutes", label: "Minutes" },
        { value: "hours", label: "Hours" },
      ],
    },
  ],
  run: (ctx) => {
    const fc = requireFeatures(ctx);
    if (!fc) return;
    const timeField = (ctx.parameters.timeField as string)?.trim();
    if (!timeField) {
      ctx.log("Error: a time field is required");
      return;
    }
    const idField = (ctx.parameters.idField as string)?.trim() || undefined;
    const maxDistance = numberParam(ctx, "maxDistance", 100);
    const distanceUnits = (ctx.parameters.distanceUnits as string) || "meters";
    if (!LINEAR_UNITS.has(distanceUnits)) {
      ctx.log(`Error: unknown distance units '${distanceUnits}'`);
      return;
    }
    const maxTimeValue = numberParam(ctx, "maxTime", 5);
    const timeUnits = (ctx.parameters.timeUnits as string) || "minutes";
    const timeFactor = TIME_UNIT_MS[timeUnits];
    if (timeFactor === undefined) {
      ctx.log(`Error: unknown time units '${timeUnits}'`);
      return;
    }
    const maxTimeMs = maxTimeValue * timeFactor;
    const timed: { coord: Position; time: number; id: string | null; props: GeoJsonProperties }[] =
      [];
    let skipped = 0;
    let skippedNoId = 0;
    for (const point of collectPoints(fc)) {
      const time = parseTimestamp(point.properties?.[timeField]);
      if (time === null) {
        skipped += 1;
        continue;
      }
      let id: string | null = null;
      if (idField) {
        const rawId = point.properties?.[idField];
        // A missing id would coerce to "" and be treated as one shared target,
        // which would wrongly exclude unrelated id-less points from pairing.
        if (rawId == null) {
          skippedNoId += 1;
          continue;
        }
        id = String(rawId);
      }
      timed.push({
        coord: point.geometry.coordinates,
        time,
        id,
        props: point.properties ?? {},
      });
    }
    const n = timed.length;
    if (n === 0) {
      ctx.log("Error: no points with a parseable time; check the time field");
      return;
    }
    // Pre-work guard on the number of pairs the loop can actually evaluate. With
    // an id field only cross-target pairs are kept, so the real bound is
    // (n² − Σ nᵢ²) / 2 — this lets a layer that is mostly (or entirely) one
    // target through, instead of rejecting it on the all-pairs worst case.
    let maxPairs = (n * (n - 1)) / 2;
    if (idField) {
      const perId = new Map<string, number>();
      for (const t of timed) perId.set(t.id!, (perId.get(t.id!) ?? 0) + 1);
      let sumSquares = 0;
      for (const count of perId.values()) sumSquares += count * count;
      maxPairs = (n * n - sumSquares) / 2;
    }
    if (maxPairs > PROXIMITY_MAX_PAIRS) {
      ctx.log(
        `Error: these points could form up to ${maxPairs.toLocaleString()} pairs ` +
          `(> ${PROXIMITY_MAX_PAIRS.toLocaleString()}); filter or split the layer first` +
          (idField ? " or use more distinct target ids" : ""),
      );
      return;
    }
    // Sort by time so the inner loop can stop once the time gap is exceeded.
    timed.sort((a, b) => a.time - b.time);
    const pairs: Feature<LineString>[] = [];
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        const dt = timed[j].time - timed[i].time; // >= 0 (sorted)
        if (dt > maxTimeMs) break; // later j only widens the gap
        if (idField && timed[i].id === timed[j].id) continue;
        const dist = distance(timed[i].coord, timed[j].coord, {
          units: distanceUnits as LinearUnit,
        });
        if (dist > maxDistance) continue;
        pairs.push({
          type: "Feature",
          properties: {
            ...(idField ? { id_a: timed[i].id, id_b: timed[j].id } : {}),
            time_a: timed[i].props?.[timeField] ?? null,
            time_b: timed[j].props?.[timeField] ?? null,
            time_diff_s: Math.round(dt / 1000),
            distance: Math.round(dist * 1000) / 1000,
            distance_units: distanceUnits,
          },
          geometry: {
            type: "LineString",
            coordinates: [timed[i].coord, timed[j].coord],
          },
        });
      }
    }
    if (skipped) ctx.log(`Skipped ${skipped} point(s) with no parseable time`);
    if (skippedNoId) ctx.log(`Skipped ${skippedNoId} point(s) with no '${idField}' value`);
    ctx.log(
      `Space-time proximity: found ${pairs.length} pair(s) within ${maxDistance} ${distanceUnits} and ${maxTimeValue} ${timeUnits}`,
    );
    ctx.addResultLayer?.("Space-time proximity", featureCollection(pairs));
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
  attributeJoinTool,
  selectByValueTool,
  selectByLocationTool,
  reprojectTool,
  explodeTool,
  aggregateTool,
  smoothTool,
  gridTool,
  voronoiTool,
  cellSectorsTool,
  createH3GridTool,
  binPointsTool,
  // Movement & time tools come after H3 so the dialog's group order (derived
  // from this array) matches the Processing → Vector menu order.
  trajectorySpeedTool,
  detectStopsTool,
  spaceTimeProximityTool,
  // Data-quality tools (validity + topology rules) last, matching the menu.
  ...TOPOLOGY_TOOLS,
];

export function getVectorTool(id: string): ProcessingAlgorithm | undefined {
  return VECTOR_TOOLS.find((tool) => tool.id === id);
}
