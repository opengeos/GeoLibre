// Geometry vector tools: reproject, explode, aggregate, smooth, vertices, points along, grid and Voronoi.

import flatten from "@turf/flatten";
import voronoiDiagram from "@turf/voronoi";
import tin from "@turf/tin";
import distance from "@turf/distance";
import bearing from "@turf/bearing";
import destination from "@turf/destination";
import bbox from "@turf/bbox";
import { featureCollection } from "@turf/helpers";
import { reprojectFeatureCollectionToWgs84 } from "./crs-proj4";
import type { BBox, Feature, Geometry, Point, Position } from "geojson";
import { bodyLengthToEarth, earthLengthToBody, horizontalBbox } from "@geolibre/core/worker-safe";
import type { ProcessingAlgorithm } from "./types";
import {
  getLayer,
  requireFeatures,
  numberParam,
  isFamily,
  mergePolygons,
  AGGREGATE_STATS,
  toNumeric,
  computeStat,
  stableStringify,
  collectPoints,
  LINEAR_UNITS,
  type LinearUnit,
} from "./vector-tools-common";

export const reprojectTool: ProcessingAlgorithm = {
  id: "reproject",
  name: "Reproject",
  description:
    "Reinterpret a layer's coordinates as a source CRS and transform them to WGS84 so they display in the correct location.",
  group: "Geometry",
  supportsSidecar: true,
  parameters: [
    { id: "layer", label: "Input layer", type: "layer", required: true },
    {
      id: "source_crs",
      label: "Source CRS",
      type: "string",
      required: true,
      default: "EPSG:3857",
      description:
        "The CRS the layer's coordinates are really in (e.g. EPSG:3857, EPSG:32617). The result is transformed to WGS84 (EPSG:4326).",
    },
  ],
  run: async (ctx) => {
    const fc = requireFeatures(ctx);
    if (!fc) return;
    const sourceCrs = String(ctx.parameters.source_crs ?? "").trim();
    if (!sourceCrs) {
      ctx.log("Reproject requires a source CRS (e.g. EPSG:3857).");
      return;
    }
    try {
      const reprojected = await reprojectFeatureCollectionToWgs84(fc, sourceCrs);
      ctx.log(
        `Reprojected ${reprojected.features.length} feature(s) from ${sourceCrs} to EPSG:4326.`,
      );
      ctx.addResultLayer?.("Reproject", reprojected);
    } catch (error) {
      ctx.log(error instanceof Error ? error.message : String(error));
    }
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

/**
 * Split any geometry into its linear "parts": each ring of a polygon, each
 * line of a (multi)linestring, or the single coordinate of a point. Used by
 * Extract vertices and Points along geometry to walk coordinates uniformly.
 */
function geometryParts(geometry: Geometry): Position[][] {
  switch (geometry.type) {
    case "Point":
      return [[geometry.coordinates]];
    case "MultiPoint":
      return geometry.coordinates.map((pos) => [pos]);
    case "LineString":
      return [geometry.coordinates];
    case "MultiLineString":
      return geometry.coordinates;
    case "Polygon":
      return geometry.coordinates;
    case "MultiPolygon":
      return geometry.coordinates.flat();
    case "GeometryCollection":
      return geometry.geometries.flatMap(geometryParts);
    default:
      return [];
  }
}

/** Line/polygon coordinate rings of a geometry, unwrapping GeometryCollections. */
function linearParts(geometry: Geometry): Position[][] {
  if (geometry.type === "GeometryCollection") return geometry.geometries.flatMap(linearParts);
  return isFamily(geometry, "line") || isFamily(geometry, "polygon") ? geometryParts(geometry) : [];
}

export const extractVerticesTool: ProcessingAlgorithm = {
  id: "extract-vertices",
  name: "Extract vertices",
  description:
    "Convert every vertex of the input features into a point, keeping the original attributes plus vertex_index and part_index columns (same-named source attributes are overwritten)",
  group: "Geometry",
  parameters: [{ id: "layer", label: "Input layer", type: "layer", required: true }],
  run: (ctx) => {
    const fc = requireFeatures(ctx);
    if (!fc) return;
    const points: Feature<Point>[] = [];
    let skipped = 0;
    for (const feature of fc.features) {
      const geometry = feature.geometry;
      if (!geometry) {
        skipped += 1;
        continue;
      }
      const parts = geometryParts(geometry);
      if (!parts.length) {
        skipped += 1;
        continue;
      }
      for (const [partIndex, part] of parts.entries()) {
        for (const [vertexIndex, position] of part.entries()) {
          points.push({
            type: "Feature",
            properties: {
              ...(feature.properties ?? {}),
              vertex_index: vertexIndex,
              part_index: partIndex,
            },
            geometry: { type: "Point", coordinates: [...position] as Position },
          });
        }
      }
    }
    if (!points.length) {
      ctx.log("Error: no vertices found in the input layer");
      return;
    }
    if (skipped) ctx.log(`Skipped ${skipped} feature(s) with no usable geometry`);
    ctx.log(`Extracted ${points.length} vertex point(s)`);
    ctx.addResultLayer?.("Vertices", featureCollection(points));
  },
};

/**
 * Hard ceiling on generated points so a tiny interval on a long geometry
 * cannot freeze the tab (the same guard {@link GRID_HARD_CAP} gives the grid).
 */
const POINTS_ALONG_HARD_CAP = 1_000_000;

/**
 * Forward-only cursor that yields a point every {@link interval} (in Turf's
 * Earth-scaled units; see {@link bodyLengthToEarth}) along an open coordinate
 * ring, together with the interval multiple it sits on. Segment lengths are haversine and the position inside a
 * segment is found geodesically (bearing + destination), so the measured
 * `distance` attribute and the emitted coordinate agree even on long
 * high-latitude segments where linear lon/lat interpolation drifts. Each
 * segment is visited once, so a walk is O(points + vertices) rather than
 * re-scanning the ring from its first vertex for every point.
 */
function* walkAlong(
  positions: Position[],
  interval: number,
  units: LinearUnit,
  segmentLengths: number[],
): Generator<{ position: Position; step: number }> {
  let travelled = 0;
  let atDistance = 0;
  let step = 0;
  for (let i = 1; i < positions.length; i += 1) {
    const start = positions[i - 1];
    const end = positions[i];
    const segment = segmentLengths[i - 1];
    if (segment <= 0) continue;
    let heading: number | null = null;
    // A step landing within float noise of a vertex snaps to the vertex itself
    // (exact coordinates), so the caller's endpoint dedup never sees a point a
    // few ulps short of the end vertex. The noise in `atDistance - travelled`
    // scales with the *accumulated* distance, not with this segment, so the
    // tolerance follows the running totals: a segment-proportional epsilon is
    // far below the noise for a short segment late in a long ring, and far
    // above it (centimetres) for a single segment thousands of km long. The
    // 1e-12 factor is ~4500 ulp at any magnitude, enough slack to absorb the
    // per-vertex error of summing a dense ring.
    const epsilon = (travelled + segment) * 1e-12;
    while (atDistance <= travelled + segment + epsilon) {
      const offset = atDistance - travelled;
      let position: Position;
      // Exact vertices keep their full position; interior points are placed
      // geodesically in 2-D by Turf, so any Z is interpolated back in here to
      // keep a 3-D input from coming out with elevation only at its vertices.
      if (offset <= epsilon) position = [...start] as Position;
      else if (offset >= segment - epsilon) position = [...end] as Position;
      else {
        heading ??= bearing(start, end);
        position = destination(start, offset, heading, { units }).geometry.coordinates;
        if (typeof start[2] === "number" && typeof end[2] === "number") {
          position = [
            position[0],
            position[1],
            start[2] + (end[2] - start[2]) * (offset / segment),
          ];
        }
      }
      yield { position, step };
      step += 1;
      atDistance = step * interval;
    }
    travelled += segment;
  }
}

/** Haversine lengths of an open coordinate ring's segments. */
function ringSegmentLengths(positions: Position[], units: LinearUnit): number[] {
  const lengths: number[] = [];
  for (let i = 1; i < positions.length; i += 1) {
    lengths.push(distance(positions[i - 1], positions[i], { units }));
  }
  return lengths;
}

export const pointsAlongGeometryTool: ProcessingAlgorithm = {
  id: "points-along-geometry",
  name: "Points along geometry",
  description:
    "Generate points at a fixed distance interval along lines and polygon boundaries; the first and last vertices are always included. Each point gets a distance column (a same-named source attribute is overwritten)",
  group: "Geometry",
  parameters: [
    {
      id: "layer",
      label: "Input layer",
      type: "layer",
      required: true,
      geometryFilter: ["line", "polygon"],
    },
    {
      id: "interval",
      label: "Interval",
      type: "number",
      required: true,
      default: 1,
      min: 0.000001,
      step: 0.1,
      description: "Distance between generated points",
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
    const interval = numberParam(ctx, "interval", 1);
    if (!(interval > 0)) {
      ctx.log("Error: interval must be greater than 0");
      return;
    }
    const units = (ctx.parameters.units as string) || "kilometers";
    if (!LINEAR_UNITS.has(units)) {
      ctx.log(`Error: unknown units '${units}'`);
      return;
    }
    const alongUnits = units as LinearUnit;
    // Turf is Earth-locked: pre-scale the user's ground interval into Turf's
    // frame for the walk, and post-scale every length Turf measures back into
    // the active body's frame before it reaches the distance column.
    const turfInterval = bodyLengthToEarth(interval);
    const parts: {
      feature: Feature;
      part: Position[];
      length: number;
      segmentLengths: number[];
    }[] = [];
    let skipped = 0;
    let estimated = 0;
    for (const feature of fc.features) {
      const geometry = feature.geometry;
      const linear = geometry ? linearParts(geometry) : [];
      let usable = 0;
      for (const part of linear) {
        if (part.length < 2) continue;
        // Interval multiples plus the closing end vertex.
        const segmentLengths = ringSegmentLengths(part, alongUnits);
        const length = segmentLengths.reduce((total, segment) => total + segment, 0);
        estimated += Math.floor(length / turfInterval) + 2;
        parts.push({ feature, part, length, segmentLengths });
        usable += 1;
      }
      // A feature with no line or polygon geometry at all and one whose every
      // part is a lone coordinate both contribute nothing, so both are counted
      // here: the summary would otherwise under-report the second kind.
      if (!usable) skipped += 1;
    }
    // Bail before allocating anything, the way gridTool does for its cells.
    if (estimated > POINTS_ALONG_HARD_CAP) {
      ctx.log(
        `Error: this interval would generate about ${estimated.toLocaleString()} points (cap ${POINTS_ALONG_HARD_CAP.toLocaleString()}); use a larger interval.`,
      );
      return;
    }
    // One rounding rule for the whole distance column, so `3 * 0.1` and the
    // measured endpoint length both read cleanly.
    const roundDistance = (value: number) => Number(value.toFixed(6));
    const points: Feature<Point>[] = [];
    for (const { feature, part, length, segmentLengths } of parts) {
      // Walk every interval multiple, then always close with the part's
      // final vertex so endpoints survive rounding of the total length.
      let lastPushed: Feature<Point> | undefined;
      for (const { position, step } of walkAlong(part, turfInterval, alongUnits, segmentLengths)) {
        lastPushed = {
          type: "Feature",
          properties: { ...(feature.properties ?? {}), distance: roundDistance(step * interval) },
          geometry: { type: "Point", coordinates: position },
        };
        points.push(lastPushed);
      }
      const last = part[part.length - 1];
      const endDistance = roundDistance(earthLengthToBody(length));
      const previous = lastPushed?.geometry.coordinates;
      // When the length is an (near) exact multiple of the interval, the last
      // stepped point already sits on the end vertex; keep one point but snap
      // it to the exact end vertex so endpoints are never off by float noise.
      // `lastPushed` is scoped to this part, so a degenerate part (all
      // segments zero-length) can never snap a point from another part.
      const duplicatesEnd =
        previous &&
        Math.abs(previous[0] - last[0]) < 1e-9 &&
        Math.abs(previous[1] - last[1]) < 1e-9;
      if (duplicatesEnd && lastPushed) {
        lastPushed.geometry.coordinates = [...last] as Position;
        lastPushed.properties!.distance = endDistance;
      } else if (!duplicatesEnd) {
        points.push({
          type: "Feature",
          properties: { ...(feature.properties ?? {}), distance: endDistance },
          geometry: { type: "Point", coordinates: [...last] as Position },
        });
      }
    }
    if (!points.length) {
      ctx.log("Error: no line or polygon features found in the input layer");
      return;
    }
    if (skipped) ctx.log(`Skipped ${skipped} feature(s) with no usable line or polygon geometry`);
    ctx.log(`Generated ${points.length} point(s) every ${interval} ${units}`);
    ctx.addResultLayer?.("Points along geometry", featureCollection(points));
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
      const layerBounds = horizontalBbox(bbox(layer.geojson));
      if (!layerBounds) {
        ctx.log('Error: parameter "layer" has no usable extent');
        return;
      }
      bounds = layerBounds;
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
    const pointsBox = horizontalBbox(bbox(pointsFc));
    if (!pointsBox || pointsBox[0] === pointsBox[2] || pointsBox[1] === pointsBox[3]) {
      ctx.log(
        "Error: the points are collinear or coincident; Voronoi / Delaunay needs points that span an area",
      );
      return;
    }
    const [minX, minY, maxX, maxY] = pointsBox;
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
