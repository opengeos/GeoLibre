import { featureCollection } from "@turf/helpers";
import type { Feature, Point } from "geojson";
import {
  type GeoLibreLayer,
  type RoutingMetric,
  type RoutingMode,
  type RoutingPoint,
  buildIsochroneRequest,
  buildMatrixRequest,
  getRoutingConfig,
  isochroneResponseToFeatures,
  matrixResponseToFeatures,
  parseContours,
  requestIsochrone,
  requestMatrix,
} from "@geolibre/core";
import type { ProcessingAlgorithm, ProcessingContext } from "./types";

/**
 * Network-analysis processing tools (isochrones / service areas, OD cost
 * matrices) backed by a Valhalla routing server. These run client-side: each
 * `run` calls the configured Valhalla endpoint directly and adds the result as
 * a GeoJSON layer, so they are NOT sidecar-capable.
 */

/** Cap on isochrone origins per run, to avoid overloading the public server. */
const MAX_ISOCHRONE_POINTS = 25;
/** Cap on OD matrix cells (origins × destinations) per run. */
const MAX_MATRIX_CELLS = 2500;

const MODE_OPTIONS = [
  { value: "auto", label: "Driving" },
  { value: "pedestrian", label: "Walking" },
  { value: "bicycle", label: "Cycling" },
];

function getLayer(
  ctx: ProcessingContext,
  paramId: string,
): GeoLibreLayer | undefined {
  const layerId = ctx.parameters[paramId] as string | undefined;
  return ctx.layers.find((layer) => layer.id === layerId);
}

/**
 * Extracts routing points from a layer's Point features, deriving a stable id
 * from the feature id, an `id`/`name` property, or the feature index. Non-point
 * geometries are skipped.
 */
function layerToRoutingPoints(layer: GeoLibreLayer | undefined): RoutingPoint[] {
  const features = layer?.geojson?.features ?? [];
  const points: RoutingPoint[] = [];
  features.forEach((feature, index) => {
    if (feature.geometry?.type !== "Point") return;
    const [lon, lat] = (feature.geometry as Point).coordinates;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
    const props = feature.properties ?? {};
    const id =
      (feature.id as string | number | undefined) ??
      (props.id as string | number | undefined) ??
      (props.ID as string | number | undefined) ??
      (props.name as string | undefined) ??
      index;
    points.push({ id, lon, lat });
  });
  return points;
}

function resolveEndpoint(ctx: ProcessingContext): string {
  const param = (ctx.parameters.endpoint as string | undefined)?.trim();
  return param || getRoutingConfig().endpoint;
}

export const isochroneTool: ProcessingAlgorithm = {
  id: "isochrone",
  name: "Isochrone / service area",
  description:
    "Travel-time or travel-distance reachability polygons from each point in a layer",
  group: "Network",
  parameters: [
    {
      id: "layer",
      label: "Origin points",
      type: "layer",
      required: true,
      geometryFilter: ["point"],
    },
    {
      id: "mode",
      label: "Travel mode",
      type: "select",
      default: "auto",
      options: MODE_OPTIONS,
    },
    {
      id: "metric",
      label: "Metric",
      type: "select",
      default: "time",
      options: [
        { value: "time", label: "Travel time (minutes)" },
        { value: "distance", label: "Distance (km)" },
      ],
    },
    {
      id: "contours",
      label: "Contours",
      type: "string",
      default: "5,10,15",
      description: "Comma-separated values (minutes for time, km for distance)",
    },
    {
      id: "endpoint",
      label: "Routing server (Valhalla)",
      type: "string",
      default: getRoutingConfig().endpoint,
    },
  ],
  run: async (ctx) => {
    const points = layerToRoutingPoints(getLayer(ctx, "layer"));
    if (!points.length) {
      ctx.log("Error: the origin layer has no point features");
      return;
    }
    const mode = (ctx.parameters.mode as RoutingMode) || "auto";
    const metric = (ctx.parameters.metric as RoutingMetric) || "time";
    const contours = parseContours((ctx.parameters.contours as string) || "");
    if (!contours.length) {
      ctx.log("Error: enter at least one positive contour value");
      return;
    }
    const endpoint = resolveEndpoint(ctx);

    const used = points.slice(0, MAX_ISOCHRONE_POINTS);
    if (points.length > used.length) {
      ctx.log(
        `Using the first ${used.length} of ${points.length} points (server-load cap).`,
      );
    }

    const features: Feature[] = [];
    for (const point of used) {
      try {
        const response = await requestIsochrone(
          endpoint,
          buildIsochroneRequest([point.lon, point.lat], {
            mode,
            metric,
            contours,
          }),
        );
        features.push(
          ...isochroneResponseToFeatures(response, {
            sourceId: point.id,
            mode,
            metric,
          }),
        );
      } catch (error) {
        ctx.log(
          `Isochrone failed for point ${point.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (!features.length) {
      ctx.log("No isochrone polygons were returned.");
      return;
    }
    ctx.log(
      `Computed ${features.length} isochrone polygon(s) for ${used.length} point(s).`,
    );
    ctx.addResultLayer?.("Isochrones", featureCollection(features));
  },
};

export const odMatrixTool: ProcessingAlgorithm = {
  id: "od-matrix",
  name: "OD cost matrix",
  description:
    "Travel time and distance between every origin and destination point, as connecting lines",
  group: "Network",
  parameters: [
    {
      id: "origins",
      label: "Origin points",
      type: "layer",
      required: true,
      geometryFilter: ["point"],
    },
    {
      id: "destinations",
      label: "Destination points",
      type: "layer",
      required: true,
      geometryFilter: ["point"],
    },
    {
      id: "mode",
      label: "Travel mode",
      type: "select",
      default: "auto",
      options: MODE_OPTIONS,
    },
    {
      id: "endpoint",
      label: "Routing server (Valhalla)",
      type: "string",
      default: getRoutingConfig().endpoint,
    },
  ],
  run: async (ctx) => {
    const origins = layerToRoutingPoints(getLayer(ctx, "origins"));
    const destinations = layerToRoutingPoints(getLayer(ctx, "destinations"));
    if (!origins.length || !destinations.length) {
      ctx.log("Error: both layers must contain point features");
      return;
    }
    const cells = origins.length * destinations.length;
    if (cells > MAX_MATRIX_CELLS) {
      ctx.log(
        `Error: ${origins.length} × ${destinations.length} = ${cells} pairs exceeds the ${MAX_MATRIX_CELLS}-cell limit. Reduce the input sizes.`,
      );
      return;
    }
    const mode = (ctx.parameters.mode as RoutingMode) || "auto";
    const endpoint = resolveEndpoint(ctx);

    try {
      const response = await requestMatrix(
        endpoint,
        buildMatrixRequest(origins, destinations, mode),
      );
      const features = matrixResponseToFeatures(
        response,
        origins,
        destinations,
        { mode },
      );
      if (!features.length) {
        ctx.log("No reachable origin–destination pairs were returned.");
        return;
      }
      ctx.log(
        `Computed ${features.length} origin–destination pair(s) of ${cells} requested.`,
      );
      ctx.addResultLayer?.("OD cost matrix", featureCollection(features));
    } catch (error) {
      ctx.log(
        `OD matrix failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  },
};

export const NETWORK_TOOLS: ProcessingAlgorithm[] = [isochroneTool, odMatrixTool];

export function getNetworkTool(id: string): ProcessingAlgorithm | undefined {
  return NETWORK_TOOLS.find((tool) => tool.id === id);
}
