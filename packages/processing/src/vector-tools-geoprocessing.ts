// Geoprocessing vector tools: buffer, centroids, hulls, dissolve, simplify and overlays.

import buffer from "@turf/buffer";
import centroid from "@turf/centroid";
import convex from "@turf/convex";
import dissolve from "@turf/dissolve";
import envelope from "@turf/envelope";
import simplify from "@turf/simplify";
import intersect from "@turf/intersect";
import difference from "@turf/difference";
import union from "@turf/union";
import distance from "@turf/distance";
import bbox from "@turf/bbox";
import { featureCollection } from "@turf/helpers";
import type { Feature, FeatureCollection, GeoJsonProperties, Polygon, MultiPolygon } from "geojson";
import { bodyLengthToEarth, horizontalBbox } from "@geolibre/core/worker-safe";
import type { ProcessingAlgorithm } from "./types";
import {
  prepareAntimeridianInput,
  splitPolygonalAtAntimeridian,
  unwrapPolygonal,
} from "./antimeridian-buffer";
import {
  MAX_CLIENT_PAIRS,
  requireFeatures,
  numberParam,
  polygonFeatures,
  mergePolygons,
  booleanParam,
  hasPositions,
  overlay,
  overlayFieldOutputNames,
  propertyKeys,
  bboxesOverlap,
} from "./vector-tools-common";

/** Split Polygon/MultiPolygon features into single-part Polygon features. */
export function explodeToPolygons(features: Feature[]): Feature<Polygon>[] {
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

/** Reassemble Turf dissolve parts into one Polygon/MultiPolygon per group. */
export function collectDissolveParts(
  dissolved: FeatureCollection<Polygon>,
  field?: string,
  originalProperties?: ReadonlyMap<string, GeoJsonProperties>,
): FeatureCollection<Polygon | MultiPolygon> {
  const groups = new Map<string, Feature<Polygon>[]>();
  for (const feature of dissolved.features) {
    const key = field ? String(feature.properties?.[field]) : "";
    const group = groups.get(key);
    if (group) group.push(feature);
    else groups.set(key, [feature]);
  }

  const features: Feature<Polygon | MultiPolygon>[] = [...groups.entries()].map(([key, parts]) => {
    // Mirror GeoPandas' `dissolve` (aggfunc="first"): every merged feature keeps
    // the first source feature's whole attribute set, so the dissolve field keeps
    // its original type and the other attributes survive the merge — whether or
    // not the group happened to stay connected.
    const source = originalProperties?.get(key) ?? parts[0].properties;
    const properties: GeoJsonProperties = source ? { ...source } : {};
    if (parts.length === 1) {
      return { ...parts[0], properties };
    }
    return {
      type: "Feature" as const,
      properties,
      geometry: {
        type: "MultiPolygon" as const,
        coordinates: parts.map((part) => part.geometry.coordinates),
      },
    };
  });
  return featureCollection(features);
}

/** Which side of a feature's boundary {@link bufferTool} keeps. */
export type BufferSide = "outside" | "inside" | "both";

export const BUFFER_SIDES = new Set<BufferSide>(["outside", "inside", "both"]);

/** Distance units {@link bufferTool} accepts, in turf's own vocabulary. */
export type BufferUnits = "kilometers" | "meters" | "miles";

export const BUFFER_UNITS = new Set<BufferUnits>(["kilometers", "meters", "miles"]);

/**
 * Python's decimal-float grammar, which `Number()` does not share.
 *
 * `Number()` reads JavaScript's `0x`/`0b`/`0o` bases (`Number("0x10")` is 16)
 * and whitespace-only input (`Number("  ")` is 0), where Python's `float()`
 * raises on all of them — so a string distance that the sidecar rejects would
 * otherwise buffer happily on the client. This is deliberately the narrower of
 * the two grammars: it also rejects Python's digit separators (`float("1_000")`
 * is 1000, `Number("1_000")` is `NaN`), which both engines then refuse.
 */
export const DECIMAL_NUMBER = /^\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?\s*$/;

/**
 * A buffered feature, or `null` when the operation left nothing behind.
 *
 * An inward buffer erodes a polygon and can consume it entirely; on a point or
 * line, which has no interior, it always does. jsts answers with an empty
 * geometry rather than nothing at all, so an emptied feature reaches us as a
 * polygon with zero rings — a shape no renderer can draw and every downstream
 * tool has to special-case. Drop those here instead.
 */
export function nonEmptyBuffer(result: Feature | undefined | null): Feature | null {
  const geometry = result?.geometry as Polygon | MultiPolygon | undefined;
  if (!geometry || !hasPositions(geometry.coordinates)) return null;
  return result as Feature;
}

/**
 * Buffer one feature on the requested side of its boundary.
 *
 * `outside` grows the feature (the historical behavior), `inside` shrinks it by
 * buffering with a negative radius, and `both` keeps only the band within
 * `radius` of the boundary — the grown shape with the eroded one cut back out.
 *
 * For `both` on a feature with no interior left to erode (a point, a line, or a
 * polygon thinner than twice the radius) the grown shape *is* the band, so it is
 * returned whole rather than treated as a failure.
 */
export function bufferOneFeature(
  feature: Feature,
  radius: number,
  side: BufferSide,
  units: BufferUnits,
): Feature | null {
  const options = { units };
  // A feature split at the antimeridian is buffered as one continuous shape,
  // and every result is made continuous again (unwrapped past ±180) before it
  // is combined, then cut at ±180 on the way out (GeoLibre#3469).
  const { feature: input, referenceLon } = prepareAntimeridianInput(feature);
  const grow = (distance: number): Feature | null => {
    const result = nonEmptyBuffer(buffer(input, distance, options));
    if (!result) return null;
    const geometry = unwrapPolygonal(result.geometry as Polygon | MultiPolygon, referenceLon);
    return geometry === result.geometry ? result : { ...result, geometry };
  };
  const finish = (result: Feature | null): Feature | null => {
    if (!result) return null;
    const geometry = splitPolygonalAtAntimeridian(
      result.geometry as Polygon | MultiPolygon,
      referenceLon,
    );
    // turf carries its input's properties through, but for a shifted feature
    // that input is our own copy — restore the source feature's attributes.
    // Cutting can leave nothing (every piece degenerate); drop that too.
    return nonEmptyBuffer({ ...result, geometry, properties: feature.properties ?? {} });
  };
  if (side === "inside") return finish(grow(-radius));
  const outer = grow(radius);
  if (side === "outside" || !outer) return finish(outer);
  const inner = grow(-radius);
  if (!inner) return finish(outer);
  const band = difference(
    featureCollection([
      outer as Feature<Polygon | MultiPolygon>,
      inner as Feature<Polygon | MultiPolygon>,
    ]),
  );
  return finish(nonEmptyBuffer(band as Feature | null));
}

/**
 * Merge every buffered feature into one, dissolving the overlaps between them.
 *
 * The merged ring belongs to no single input feature, so the result carries no
 * attributes — the same shape the GeoPandas engine's `union_all` produces. Only
 * `null` when the union collapses to nothing; a throw from polyclip is left to
 * the caller, which reports it the way the Python engine's raise does.
 *
 * @param features - The buffered polygons, at least one.
 * @returns The single merged feature, or `null` when nothing is left.
 */
export function dissolveBuffers(features: Feature[]): Feature | null {
  const polys = features as Feature<Polygon | MultiPolygon>[];
  // turf's union throws on a single geometry ("Must have at least 2
  // geometries"), and one buffer is already its own dissolve.
  const merged = polys.length === 1 ? polys[0] : union(featureCollection(polys));
  const kept = nonEmptyBuffer(merged as Feature | null);
  // The single `properties: {}` — the lone-buffer branch carries the source
  // feature's attributes in, so clearing them has to happen here either way.
  return kept ? { ...kept, properties: {} } : null;
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
    {
      id: "side",
      label: "Buffer side",
      type: "select",
      default: "outside",
      description:
        "Outside grows each feature, Inside shrinks it, and Both keeps the zone within the distance on either side of its boundary. Inside needs polygon input — a point or line has no interior to buffer into.",
      options: [
        { value: "outside", label: "Outside (grow)" },
        { value: "inside", label: "Inside (shrink)" },
        { value: "both", label: "Both sides" },
      ],
    },
    {
      id: "dissolve",
      label: "Dissolve result",
      type: "boolean",
      default: false,
      description:
        "Merge the buffers into one feature and dissolve the overlaps between them. The merged shape belongs to no input feature, so attributes are dropped; to dissolve by an attribute, run the Dissolve tool on the result.",
    },
  ],
  run: (ctx) => {
    const fc = requireFeatures(ctx);
    if (!fc) return;
    // Validate in the Python engine's order (`_buffer`: units, then side, then
    // distance finiteness, then distance sign) so a call with several bad
    // parameters at once gets the same first error from both engines, not just
    // the same accept/reject verdict.
    const rawUnits = ctx.parameters.units;
    const units = (rawUnits == null ? "kilometers" : String(rawUnits)) as BufferUnits;
    if (!BUFFER_UNITS.has(units)) {
      // turf throws on a unit it does not know, and the per-feature `try`/`catch`
      // below would swallow that into the `Skipped` count — reporting a
      // successful run that buffered nothing where the Python engine raises
      // "Unknown unit". Reject up front so the two engines agree.
      ctx.log(`Error: unknown unit '${units}'; expected ${[...BUFFER_UNITS].join(", ")}`);
      return;
    }
    // Only a missing `side` defaults; an explicitly empty one falls through to
    // the check below, matching the Python engine (and the way an empty `units`
    // reaches its own lookup there). Direction is a deliberate choice, so a
    // caller that sends a blank one gets an error rather than a silent grow.
    const rawSide = ctx.parameters.side;
    const side = (rawSide == null ? "outside" : String(rawSide)) as BufferSide;
    if (!BUFFER_SIDES.has(side)) {
      // Reject rather than fall back, so the client and Python engines answer a
      // bad `side` the same way (see tests/fixtures/vector/SPEC.md).
      ctx.log(`Error: unknown buffer side '${side}'; expected ${[...BUFFER_SIDES].join(", ")}`);
      return;
    }
    // Checked before the distance, so a call with a bad dissolve flag and a bad
    // distance reports the same first error from both engines.
    const dissolveResult = booleanParam(ctx.parameters.dissolve);
    if (dissolveResult === null) {
      ctx.log("Error: buffer dissolve must be true or false");
      return;
    }
    const rawDistance = ctx.parameters.distance;
    // `numberParam` folds a non-finite or unparseable value into its fallback,
    // which would hand a programmatic caller a silent 1-unit buffer where the
    // Python engine raises. Check the raw parameter so both engines reject it.
    // A string is held to Python's grammar rather than `Number()`'s (see
    // DECIMAL_NUMBER), so `"0x10"` and `"  "` are rejected here the way
    // `float()` rejects them there. An *empty* string is the one case both
    // engines already agree on — `"" or 0` is 0 in Python — so it falls
    // through to `numberParam`.
    // A distance must be a number or a numeric string. Anything else is caller
    // error, and the two languages coerce it differently enough that letting it
    // through diverges: `Number(false)` is 0 and `Number([5])` is 5 (both of
    // which `numberParam` then discards for the fallback 1), while Python's
    // `raw or 0` reads `false`/`[]`/`{}` as 0 and raises on `[5]`. Rejecting the
    // type outright is the only reading both engines share.
    const distanceType = typeof rawDistance;
    const badDistanceType = distanceType !== "number" && distanceType !== "string";
    const badDistanceString =
      typeof rawDistance === "string" && rawDistance !== "" && !DECIMAL_NUMBER.test(rawDistance);
    if (
      rawDistance != null &&
      (badDistanceType || badDistanceString || !Number.isFinite(Number(rawDistance)))
    ) {
      ctx.log("Error: buffer distance must be a finite number");
      return;
    }
    const distance = numberParam(ctx, "distance", 1);
    if (distance < 0) {
      // The dialog's `min: 0` binds the form, not a programmatic caller (Model
      // Builder, the assistant, a replayed history entry). Reject rather than
      // erode: direction belongs to `side`, and the Python engine already
      // answers a negative distance this way.
      ctx.log("Error: buffer distance must be >= 0; use the buffer side to buffer inward");
      return;
    }
    // turf bakes in Earth's radius, so the requested distance would lay out as
    // Earth ground on a Moon/Mars project. Convert to the Earth-equivalent that
    // spans the same distance on this body (GeoLibre#1128) — a no-op on Earth.
    const radius = bodyLengthToEarth(distance);
    const features: Feature[] = [];
    let dropped = 0;
    let failed = 0;
    for (const feature of fc.features) {
      // A null-geometry feature counts as dropped, not skipped in silence: the
      // Python engine loads it into the GeoDataFrame and its `isna()` filter
      // reports it, so counting it here keeps the two engines' totals equal.
      if (!feature?.geometry) {
        dropped += 1;
        continue;
      }
      let buffered: Feature | null = null;
      try {
        buffered = bufferOneFeature(feature, radius, side, units);
      } catch {
        // jsts can throw on a degenerate or self-intersecting geometry — the
        // erosion step in `inside`/`both` is a new way to produce one. Report
        // it separately from an empty result (the geometry was not buffered
        // away, it could not be buffered at all) rather than let it abort the
        // whole batch and discard every feature already buffered.
        failed += 1;
        continue;
      }
      if (buffered) features.push(buffered);
      else dropped += 1;
    }
    // Dissolve before logging anything: the Python engine returns its messages
    // only on success, so a failed dissolve must not leave a "Buffered N" line
    // behind on the client either.
    let output = featureCollection(features);
    const didDissolve = dissolveResult && features.length > 0;
    if (didDissolve) {
      let merged: Feature | null = null;
      try {
        merged = dissolveBuffers(features);
      } catch {
        // polyclip can throw on a self-intersecting union, the way the
        // GeoPandas engine's `union_all` can — fail the run rather than hand
        // back the undissolved buffers the caller did not ask for.
        merged = null;
      }
      if (!merged) {
        ctx.log("Error: unable to dissolve the buffered features");
        return;
      }
      output = featureCollection([merged]);
    }
    ctx.log(`Buffered ${features.length} feature(s) by ${distance} ${units} (${side})`);
    if (dropped > 0) {
      // Deliberately not "the inward buffer": an outward buffer also drops a
      // feature whose geometry is missing or degenerate enough to come back empty.
      ctx.log(`Dropped ${dropped} feature(s) the buffer left empty`);
    }
    if (failed > 0) {
      ctx.log(`Skipped ${failed} feature(s) the buffer could not process`);
    }
    if (didDissolve) {
      ctx.log(`Dissolved ${features.length} buffer(s) into 1 feature`);
    }
    ctx.addResultLayer?.("Buffer", output);
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
    // Remember the first source feature of each group so the merged output can
    // carry its attributes through, the way the sidecar's GeoPandas dissolve does.
    const originalProperties = new Map<string, GeoJsonProperties>();
    for (const polygon of polys) {
      const key = field ? String(polygon.properties?.[field]) : "";
      if (!originalProperties.has(key)) originalProperties.set(key, polygon.properties);
    }
    const dissolvedParts = dissolve(featureCollection(polys), {
      propertyName: field || undefined,
    });
    const dissolved = collectDissolveParts(dissolvedParts, field || undefined, originalProperties);
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
    // the sidecar's gpd.overlay(how="intersection"). Pre-filter pairs by bbox
    // and rename case-insensitively colliding overlay columns so input fields
    // are not clobbered or duplicated.
    const inputBoxes = inputPolys.map((f) => horizontalBbox(bbox(f, { recompute: true })));
    const overlayBoxes = overlayPolys.map((f) => horizontalBbox(bbox(f, { recompute: true })));
    const overlayOutputNames = overlayFieldOutputNames(
      propertyKeys(inputPolys),
      propertyKeys(overlayPolys),
    );
    const results: Feature[] = [];
    for (let i = 0; i < inputPolys.length; i += 1) {
      const a = inputPolys[i];
      const boxA = inputBoxes[i];
      for (let j = 0; j < overlayPolys.length; j += 1) {
        if (!bboxesOverlap(boxA, overlayBoxes[j])) continue;
        const b = overlayPolys[j];
        let piece: Feature<Polygon | MultiPolygon> | null = null;
        try {
          piece = intersect(featureCollection([a, b])) as Feature<Polygon | MultiPolygon> | null;
        } catch {
          continue;
        }
        if (piece?.geometry) {
          const mergedProps: Record<string, unknown> = Object.create(null);
          if (a.properties) {
            for (const [key, value] of Object.entries(a.properties)) {
              mergedProps[key] = value;
            }
          }
          if (b.properties) {
            for (const [key, value] of Object.entries(b.properties)) {
              mergedProps[overlayOutputNames.get(key) ?? key] = value;
            }
          }
          piece.properties = { ...mergedProps };
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
