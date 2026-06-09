import buffer from "@turf/buffer";
import centroid from "@turf/centroid";
import convex from "@turf/convex";
import dissolve from "@turf/dissolve";
import envelope from "@turf/envelope";
import simplify from "@turf/simplify";
import intersect from "@turf/intersect";
import difference from "@turf/difference";
import union from "@turf/union";
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

/** Merge all polygons of a collection into a single (multi)polygon feature. */
function mergePolygons(
  fc: FeatureCollection,
): Feature<Polygon | MultiPolygon> | null {
  const polys = polygonFeatures(fc);
  if (!polys.length) return null;
  let merged: Feature<Polygon | MultiPolygon> = polys[0];
  for (let i = 1; i < polys.length; i += 1) {
    const next = union(featureCollection([merged, polys[i]]));
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
    // Turf's dissolve only accepts single Polygon features (not MultiPolygon).
    const polys = fc.features.filter(
      (f) => f.geometry?.type === "Polygon",
    ) as Feature<Polygon>[];
    if (!polys.length) {
      ctx.log("Error: Dissolve requires (single-part) Polygon features");
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
  run: (ctx) =>
    overlay(
      ctx,
      (a, b) =>
        intersect(featureCollection([a, b])) as Feature<
          Polygon | MultiPolygon
        > | null,
      "Intersection",
      true,
    ),
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
];

export function getVectorTool(id: string): ProcessingAlgorithm | undefined {
  return VECTOR_TOOLS.find((tool) => tool.id === id);
}
