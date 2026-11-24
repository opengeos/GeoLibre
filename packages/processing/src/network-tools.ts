import { featureCollection } from "@turf/helpers";
import buffer from "@turf/buffer";
import { bodyLengthToEarth } from "@geolibre/core/worker-safe";
import type { Feature, Point, Position, Polygon, MultiPolygon } from "geojson";
import {
  type GeoLibreLayer,
  type RoutingMetric,
  type RoutingMode,
  type RoutingPoint,
  buildIsochroneRequest,
  buildMatrixRequest,
  RoutingRequestError,
  buildRouteRequest,
  compareSequenceValues,
  getRoutingConfig,
  isochroneResponseToFeatures,
  matrixResponseToFeatures,
  parseContours,
  requestIsochrone,
  requestMatrix,
  requestRoute,
  routeResponseToFeatures,
} from "@geolibre/core";
import {
  buildLocalNetwork,
  splitNetworkLine,
  type LocalNetwork,
  type NetworkCostMode,
} from "./local-network";
import {
  prepareAntimeridianInput,
  unwrapPolygonal,
  splitPolygonalAtAntimeridian,
} from "./antimeridian-buffer";
import type { AlgorithmParameter, ProcessingAlgorithm, ProcessingContext } from "./types";

/**
 * Network-analysis processing tools (isochrones / service areas, OD cost
 * matrices) backed by a Valhalla routing server. These run client-side: each
 * `run` calls the configured Valhalla endpoint directly and adds the result as
 * a GeoJSON layer, so they are NOT sidecar-capable.
 */

/** Cap on isochrone origins per run, to avoid overloading the public server. */
const MAX_ISOCHRONE_POINTS = 25;
/** Valhalla's hard limit on contour values per isochrone request. */
const MAX_ISOCHRONE_CONTOURS = 4;
/** Cap on OD matrix cells (origins × destinations) per run. */
const MAX_MATRIX_CELLS = 2500;
/** Cap on waypoints per sequential route. The public FOSSGIS server enforces
 *  `max_locations: 20` on `/route` (error_code 150), so requests above this are
 *  rejected outright; keep the cap at that limit and truncate with a log line. */
const MAX_ROUTE_POINTS = 20;

const MODE_OPTIONS = [
  { value: "auto", label: "Driving" },
  { value: "pedestrian", label: "Walking" },
  { value: "bicycle", label: "Cycling" },
];

function getLayer(ctx: ProcessingContext, paramId: string): GeoLibreLayer | undefined {
  const layerId = ctx.parameters[paramId] as string | undefined;
  return ctx.layers.find((layer) => layer.id === layerId);
}

/** Derives a stable point id from the feature id, an `id`/`name` property, or
 *  the feature index. */
function pointId(feature: Feature, index: number): string | number {
  const props = feature.properties ?? {};
  return (
    (feature.id as string | number | undefined) ??
    (props.id as string | number | undefined) ??
    (props.ID as string | number | undefined) ??
    (props.name as string | undefined) ??
    index
  );
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
    points.push({ id: pointId(feature, index), lon, lat });
  });
  return points;
}

/**
 * Extracts routing points in visiting order. With no `orderField`, points keep
 * the layer's feature order. With an `orderField`, points are sorted by that
 * attribute (numbers or timestamps sort chronologically; see
 * {@link compareSequenceValues}), keeping feature order as a stable tiebreaker.
 * Non-point geometries are skipped.
 */
export function layerToSequencedPoints(
  layer: GeoLibreLayer | undefined,
  orderField: string,
): RoutingPoint[] {
  const features = layer?.geojson?.features ?? [];
  const entries: { point: RoutingPoint; order: unknown; index: number }[] = [];
  features.forEach((feature, index) => {
    if (feature.geometry?.type !== "Point") return;
    const [lon, lat] = (feature.geometry as Point).coordinates;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
    const props = feature.properties ?? {};
    entries.push({
      point: { id: pointId(feature, index), lon, lat },
      order: orderField ? props[orderField] : index,
      index,
    });
  });
  if (orderField) {
    entries.sort((a, b) => {
      const cmp = compareSequenceValues(a.order, b.order);
      return cmp !== 0 ? cmp : a.index - b.index;
    });
  }
  return entries.map((entry) => entry.point);
}

function resolveEndpoint(ctx: ProcessingContext): string {
  const param = (ctx.parameters.endpoint as string | undefined)?.trim();
  return param || getRoutingConfig().endpoint;
}

export const isochroneTool: ProcessingAlgorithm = {
  id: "isochrone",
  name: "Isochrone / service area",
  description: "Travel-time or travel-distance reachability polygons from each point in a layer",
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
      // Left empty so the live routing config is resolved when the tool runs
      // (or seeded by the dialog), not baked in at module-import time. See
      // resolveEndpoint, which falls back to getRoutingConfig().endpoint.
      default: "",
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
    if (contours.length > MAX_ISOCHRONE_CONTOURS) {
      ctx.log(
        `Error: Valhalla supports at most ${MAX_ISOCHRONE_CONTOURS} contour values per request — reduce the list.`,
      );
      return;
    }
    const endpoint = resolveEndpoint(ctx);

    const used = points.slice(0, MAX_ISOCHRONE_POINTS);
    if (points.length > used.length) {
      ctx.log(`Using the first ${used.length} of ${points.length} points (server-load cap).`);
    }

    const features: Feature[] = [];
    for (const point of used) {
      if (ctx.signal?.aborted) return;
      try {
        const response = await requestIsochrone(
          endpoint,
          buildIsochroneRequest([point.lon, point.lat], {
            mode,
            metric,
            contours,
          }),
          ctx.signal,
        );
        features.push(
          ...isochroneResponseToFeatures(response, {
            sourceId: point.id,
            mode,
            metric,
          }),
        );
      } catch (error) {
        if (ctx.signal?.aborted) return;
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
    ctx.log(`Computed ${features.length} isochrone polygon(s) for ${used.length} point(s).`);
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
      // Left empty so the live routing config is resolved when the tool runs
      // (or seeded by the dialog), not baked in at module-import time. See
      // resolveEndpoint, which falls back to getRoutingConfig().endpoint.
      default: "",
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
        ctx.signal,
      );
      const features = matrixResponseToFeatures(response, origins, destinations, { mode });
      if (!features.length) {
        ctx.log("No reachable origin–destination pairs were returned.");
        return;
      }
      ctx.log(`Computed ${features.length} origin–destination pair(s) of ${cells} requested.`);
      ctx.addResultLayer?.("OD cost matrix", featureCollection(features));
    } catch (error) {
      if (ctx.signal?.aborted) return;
      ctx.log(`OD matrix failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
};

export const sequentialRouteTool: ProcessingAlgorithm = {
  id: "sequential-route",
  name: "Sequential route (directions)",
  description:
    "Connect points in sequence along the road network into a route. Each point is snapped to the nearest road, so off-road coordinates (cell sites, sensors) still route. Order follows the chosen field (e.g. a timestamp) or the layer's feature order.",
  group: "Network",
  parameters: [
    {
      id: "layer",
      label: "Input points",
      type: "layer",
      required: true,
      geometryFilter: ["point"],
    },
    {
      id: "order_field",
      label: "Order by field (optional)",
      type: "field",
      fieldSource: "layer",
      description:
        "Sort points by this field (numbers or timestamps) before routing. Leave empty to use the layer's feature order.",
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
      // Left empty so the live routing config is resolved when the tool runs
      // (or seeded by the dialog), not baked in at module-import time. See
      // resolveEndpoint, which falls back to getRoutingConfig().endpoint.
      default: "",
    },
  ],
  run: async (ctx) => {
    const orderField = (ctx.parameters.order_field as string | undefined)?.trim() || "";
    const points = layerToSequencedPoints(getLayer(ctx, "layer"), orderField);
    if (points.length < 2) {
      ctx.log("Error: at least two point features are required to build a route");
      return;
    }
    const used = points.slice(0, MAX_ROUTE_POINTS);
    if (points.length > used.length) {
      ctx.log(
        `Using the first ${used.length} of ${points.length} points (server limit: ${MAX_ROUTE_POINTS} locations per request).`,
      );
    }
    const mode = (ctx.parameters.mode as RoutingMode) || "auto";
    const endpoint = resolveEndpoint(ctx);

    try {
      const response = await requestRoute(endpoint, buildRouteRequest(used, mode), ctx.signal);
      const features = routeResponseToFeatures(response, used, { mode });
      if (!features.length) {
        ctx.log("No route was returned. The points may be unroutable for this travel mode.");
        return;
      }
      const totalKm = features.reduce((sum, feature) => sum + feature.properties.distance_km, 0);
      ctx.log(
        `Built a route through ${used.length} point(s): ${features.length} leg(s), ${totalKm.toFixed(2)} km total.`,
      );
      ctx.addResultLayer?.("Route", featureCollection(features));
    } catch (error) {
      if (ctx.signal?.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      // A 4xx means the server rejected the request (most often "Exceeded max
      // locations"); point the user at the actionable fix. The typed status
      // avoids depending on the wording of the error message.
      const isClientError =
        error instanceof RoutingRequestError && error.status >= 400 && error.status < 500;
      const hint = isClientError
        ? " The routing server rejected the request — reduce the number of points or use your own server (Settings → Environment variables, VITE_ROUTING_ENDPOINT)."
        : "";
      ctx.log(`Routing failed: ${message}.${hint}`);
    }
  },
};

// ---------------------------------------------------------------------------
// Local network tools: routing over a user line layer, no server involved.
// ---------------------------------------------------------------------------

/** Cap on stops for a local route, to keep one run interactive. */
const MAX_LOCAL_STOPS = 500;
/** Cap on incidents for closest facility. */
const MAX_LOCAL_INCIDENTS = 2000;
/** Cap on facilities for closest facility and service area. */
const MAX_LOCAL_FACILITIES = 2000;
/** Cap on service-area cost breaks. */
const MAX_SERVICE_BREAKS = 10;

/** Parameters shared by every local network tool: the graph definition. */
const LOCAL_NETWORK_PARAMS: AlgorithmParameter[] = [
  {
    id: "network",
    label: "Network lines",
    type: "layer",
    required: true,
    geometryFilter: ["line"],
  },
  {
    id: "costMode",
    label: "Edge cost",
    type: "select",
    default: "length",
    options: [
      { value: "length", label: "Length (metres)" },
      { value: "field", label: "Cost field (total per feature)" },
      { value: "speed", label: "Speed field (km/h, cost in minutes)" },
    ],
  },
  {
    id: "costField",
    label: "Cost or speed field",
    type: "field",
    fieldSource: "network",
    visibleWhen: { param: "costMode", in: ["field", "speed"] },
    description:
      "For a cost field, the cost of traversing the whole feature (spread over it by length). For a speed field, km/h. Features with a missing or invalid value are left out of the network.",
  },
  {
    id: "directionField",
    label: "One-way field (optional)",
    type: "field",
    fieldSource: "network",
    description:
      "yes, true, 1 or FT: travel only in the digitized direction. -1, reverse or TF: only against it. N or closed: no travel. Anything else: both ways.",
  },
  {
    id: "snapTolerance",
    label: "Snap tolerance (m)",
    type: "number",
    default: 1,
    min: 0,
    step: 0.5,
    description:
      "Line ends closer than this to another line are joined to it. Lines that share a vertex are always connected; lines that only cross are not.",
  },
];

const ROUTE_ALGORITHM_PARAM: AlgorithmParameter = {
  id: "algorithm",
  label: "Search algorithm",
  type: "select",
  default: "astar",
  options: [
    { value: "astar", label: "A* (haversine heuristic)" },
    { value: "dijkstra", label: "Dijkstra" },
  ],
};

/** Unit label for the log, by cost mode. */
function costUnit(mode: NetworkCostMode, field: string): string {
  if (mode === "speed") return "min";
  if (mode === "field") return field ? `(${field})` : "";
  return "m";
}

function round(value: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/**
 * Reads the shared network parameters and builds the graph, logging counters.
 * Returns null (after logging an error) when the network is unusable.
 */
function buildNetworkFromParams(
  ctx: ProcessingContext,
): { net: LocalNetwork; mode: NetworkCostMode; unit: string } | null {
  const layer = getLayer(ctx, "network");
  const features = layer?.geojson?.features ?? [];
  if (!features.length) {
    ctx.log("Error: the network layer has no line features");
    return null;
  }
  let vertices = 0;
  for (const feature of features) {
    if (feature.geometry?.type === "LineString") vertices += feature.geometry.coordinates.length;
    else if (feature.geometry?.type === "MultiLineString")
      for (const part of feature.geometry.coordinates) vertices += part.length;
  }
  if (vertices > 250_000) {
    ctx.log(
      "Error: local network construction supports at most 250,000 vertices; use a smaller extract",
    );
    return null;
  }
  const mode = ((ctx.parameters.costMode as string) || "length") as NetworkCostMode;
  const costField = ((ctx.parameters.costField as string | undefined) ?? "").trim();
  if (mode !== "length" && !costField) {
    ctx.log("Error: choose the cost or speed field");
    return null;
  }
  const directionField = ((ctx.parameters.directionField as string | undefined) ?? "").trim();
  const rawTolerance = Number(ctx.parameters.snapTolerance ?? 1);
  const net = buildLocalNetwork(features, {
    costMode: mode,
    costField,
    directionField: directionField || undefined,
    snapToleranceM: Number.isFinite(rawTolerance) ? Math.max(0, rawTolerance) : 1,
  });
  const { stats } = net;
  if (!net.edges.length) {
    ctx.log("Error: no usable line features were found in the network layer");
    return null;
  }
  ctx.log(
    `Network: ${net.nodeCount} node(s), ${net.edges.length} edge(s) from ${stats.features} feature(s).` +
      (stats.skippedFeatures
        ? ` ${stats.skippedFeatures} feature(s) skipped (no valid cost, or closed).`
        : "") +
      (stats.snappedEndpoints || stats.splitSegments
        ? ` Snapped ${stats.snappedEndpoints} endpoint(s) and split ${stats.splitSegments} segment(s).`
        : ""),
  );
  return { net, mode, unit: costUnit(mode, costField) };
}

interface PlacedPoint {
  id: string | number;
  node: number;
  snap: number;
}

/** Attaches every point to the network, in order. */
function placePoints(net: LocalNetwork, points: RoutingPoint[]): PlacedPoint[] {
  if (points.length * net.edges.length > 50_000_000)
    throw new RangeError(
      "Local network point placement is too large; reduce points or use a smaller extract",
    );
  const placed: PlacedPoint[] = [];
  for (const point of points) {
    const hit = net.insertPoint(point.lon, point.lat);
    if (hit) placed.push({ id: point.id, node: hit.node, snap: round(hit.snapDistance, 2) });
  }
  return placed;
}

function lineFeature(coordinates: Position[], properties: Record<string, unknown>): Feature {
  const source = coordinates.length >= 2 ? coordinates : [coordinates[0], coordinates[0]];
  const pieces = splitNetworkLine(source);
  return {
    type: "Feature",
    properties,
    geometry:
      pieces.length > 1
        ? { type: "MultiLineString", coordinates: pieces }
        : { type: "LineString", coordinates: pieces[0] ?? source },
  };
}

export const localShortestPathTool: ProcessingAlgorithm = {
  id: "local-shortest-path",
  name: "Shortest path (local network)",
  description:
    "Route through stops in order over your own line layer (roads, trails, pipes), with no routing server. Edges cost their length, a cost field, or travel time from a speed field, and one-way lines are respected.",
  group: "Local network",
  parameters: [
    ...LOCAL_NETWORK_PARAMS,
    {
      id: "stops",
      label: "Stops",
      type: "layer",
      required: true,
      geometryFilter: ["point"],
    },
    {
      id: "order_field",
      label: "Order by field (optional)",
      type: "field",
      fieldSource: "stops",
      description:
        "Visit stops sorted by this field (numbers or timestamps). Leave empty to use the layer's feature order.",
    },
    ROUTE_ALGORITHM_PARAM,
  ],
  run: async (ctx) => {
    const orderField = ((ctx.parameters.order_field as string | undefined) ?? "").trim();
    const stops = layerToSequencedPoints(getLayer(ctx, "stops"), orderField);
    if (stops.length < 2) {
      ctx.log("Error: at least two stop points are required");
      return;
    }
    if (stops.length > MAX_LOCAL_STOPS) {
      ctx.log(`Error: ${stops.length} stops exceeds the ${MAX_LOCAL_STOPS}-stop limit`);
      return;
    }
    const built = buildNetworkFromParams(ctx);
    if (!built) return;
    const { net, unit } = built;
    const astar = (ctx.parameters.algorithm as string) !== "dijkstra";
    const placed = placePoints(net, stops);
    if ((placed.length - 1) * net.nodeCount > 50_000_000) {
      ctx.log(
        "Error: routing selection is too large; reduce stops or use a smaller network extract",
      );
      return;
    }
    const features: Feature[] = [];
    let totalCost = 0;
    let totalLength = 0;
    let unreachable = 0;
    for (let i = 1; i < placed.length; i++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (ctx.signal?.aborted) return;
      const from = placed[i - 1];
      const to = placed[i];
      const path = net.shortestPath(from.node, to.node, astar);
      if (!path) {
        unreachable++;
        ctx.log(`No path from stop ${from.id} to stop ${to.id}: they are not connected.`);
        continue;
      }
      totalCost += path.cost;
      totalLength += path.length;
      features.push(
        lineFeature(path.coordinates, {
          leg: i,
          from: from.id,
          to: to.id,
          cost: round(path.cost),
          length_m: round(path.length, 2),
          from_snap_m: from.snap,
          to_snap_m: to.snap,
        }),
      );
    }
    if (!features.length) {
      ctx.log("Error: none of the stops could be connected through the network");
      return;
    }
    ctx.log(
      `Routed ${features.length} leg(s): total cost ${round(totalCost)} ${unit}, ${round(totalLength / 1000, 3)} km.` +
        (unreachable ? ` ${unreachable} leg(s) unreachable.` : ""),
    );
    ctx.addResultLayer?.("Shortest path", featureCollection(features));
  },
};

export const localClosestFacilityTool: ProcessingAlgorithm = {
  id: "local-closest-facility",
  name: "Closest facility (local network)",
  description:
    "For each incident, find the nearest facilities by network cost over your own line layer and draw the routes to them.",
  group: "Local network",
  parameters: [
    ...LOCAL_NETWORK_PARAMS,
    {
      id: "incidents",
      label: "Incidents",
      type: "layer",
      required: true,
      geometryFilter: ["point"],
    },
    {
      id: "facilities",
      label: "Facilities",
      type: "layer",
      required: true,
      geometryFilter: ["point"],
    },
    {
      id: "count",
      label: "Facilities to find per incident",
      type: "number",
      default: 1,
      min: 1,
      step: 1,
    },
    {
      id: "maxCost",
      label: "Maximum cost (0 = no limit)",
      type: "number",
      default: 0,
      min: 0,
    },
    {
      id: "travelDirection",
      label: "Travel direction",
      type: "select",
      default: "to",
      options: [
        { value: "to", label: "Incident to facility" },
        { value: "from", label: "Facility to incident" },
      ],
    },
  ],
  run: async (ctx) => {
    const incidents = layerToRoutingPoints(getLayer(ctx, "incidents"));
    const facilities = layerToRoutingPoints(getLayer(ctx, "facilities"));
    if (!incidents.length || !facilities.length) {
      ctx.log("Error: both the incident and facility layers must contain point features");
      return;
    }
    if (incidents.length > MAX_LOCAL_INCIDENTS || facilities.length > MAX_LOCAL_FACILITIES) {
      ctx.log(
        `Error: at most ${MAX_LOCAL_INCIDENTS} incidents and ${MAX_LOCAL_FACILITIES} facilities are supported per run`,
      );
      return;
    }
    const built = buildNetworkFromParams(ctx);
    if (!built) return;
    const { net, unit } = built;
    const count = Math.max(1, Math.floor(Number(ctx.parameters.count ?? 1)) || 1);
    if (!Number.isFinite(count) || incidents.length * Math.min(count, facilities.length) > 10_000) {
      ctx.log(
        "Error: at most 10,000 closest-facility routes are supported per run; reduce count or the incident selection",
      );
      return;
    }
    const rawMax = Number(ctx.parameters.maxCost ?? 0);
    const maxCost = Number.isFinite(rawMax) && rawMax > 0 ? rawMax : Infinity;
    const fromFacility = (ctx.parameters.travelDirection as string) === "from";
    const placedFacilities = placePoints(net, facilities);
    const placedIncidents = placePoints(net, incidents);
    if (placedIncidents.length * net.nodeCount > 50_000_000) {
      ctx.log(
        "Error: closest-facility selection is too large; reduce incidents or use a smaller network extract",
      );
      return;
    }
    const facilitiesAt = new Map<number, PlacedPoint[]>();
    for (const facility of placedFacilities) {
      const list = facilitiesAt.get(facility.node) ?? [];
      list.push(facility);
      facilitiesAt.set(facility.node, list);
    }
    const features: Feature[] = [];
    let short = 0;
    for (const incident of placedIncidents) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (ctx.signal?.aborted) return;
      const found: { facility: PlacedPoint; node: number }[] = [];
      // Searching against edge direction from the incident gives costs from
      // each facility to it, so one search serves either travel direction.
      const result = net.search([incident.node], {
        maxCost,
        reverse: fromFacility,
        onSettle: (node) => {
          for (const facility of facilitiesAt.get(node) ?? []) {
            if (found.length < count) found.push({ facility, node });
          }
          return found.length >= count;
        },
      });
      if (found.length < count) short++;
      found.forEach(({ facility, node }, rank) => {
        const path = net.pathTo(result, node);
        if (!path) return;
        const coordinates = fromFacility ? [...path.coordinates].reverse() : path.coordinates;
        features.push(
          lineFeature(coordinates, {
            incident: incident.id,
            facility: facility.id,
            rank: rank + 1,
            cost: round(path.cost),
            length_m: round(path.length, 2),
            incident_snap_m: incident.snap,
            facility_snap_m: facility.snap,
          }),
        );
      });
    }
    if (!features.length) {
      ctx.log("Error: no facility could be reached from any incident");
      return;
    }
    ctx.log(
      `Found ${features.length} route(s) for ${placedIncidents.length} incident(s) (cost in ${unit}).` +
        (short
          ? ` ${short} incident(s) reached fewer than ${count} facilit${count === 1 ? "y" : "ies"}.`
          : ""),
    );
    ctx.addResultLayer?.("Closest facility routes", featureCollection(features));
  },
};

/** Parses positive, ascending, de-duplicated cost breaks from "5, 10, 15". */
export function parseCostBreaks(text: string): number[] {
  const values = text
    .split(/[,;\s]+/)
    .map((part) => Number(part))
    .filter((value) => Number.isFinite(value) && value > 0);
  return [...new Set(values)].sort((a, b) => a - b);
}

export const localServiceAreaTool: ProcessingAlgorithm = {
  id: "local-service-area",
  name: "Service area (local network)",
  description:
    "Parts of your own line network reachable from facilities within cost breaks, as lines and (optionally) buffered polygons.",
  group: "Local network",
  parameters: [
    ...LOCAL_NETWORK_PARAMS,
    {
      id: "facilities",
      label: "Facilities",
      type: "layer",
      required: true,
      geometryFilter: ["point"],
    },
    {
      id: "breaks",
      label: "Cost breaks",
      type: "string",
      default: "500,1000,2000",
      description: "Comma-separated costs in the edge cost unit (metres, field units, or minutes).",
    },
    {
      id: "overlap",
      label: "Overlapping areas",
      type: "select",
      default: "merge",
      options: [
        { value: "merge", label: "Merge (one area per break)" },
        { value: "separate", label: "Separate area per facility" },
      ],
    },
    {
      id: "travelDirection",
      label: "Travel direction",
      type: "select",
      default: "from",
      options: [
        { value: "from", label: "Away from facility" },
        { value: "to", label: "Toward facility" },
      ],
    },
    {
      id: "polygonWidth",
      label: "Polygon trim width (m, 0 = lines only)",
      type: "number",
      default: 50,
      min: 0,
      description: "Also output polygons by buffering the reachable lines by this distance.",
    },
  ],
  run: async (ctx) => {
    const facilities = layerToRoutingPoints(getLayer(ctx, "facilities"));
    if (!facilities.length) {
      ctx.log("Error: the facility layer has no point features");
      return;
    }
    if (facilities.length > MAX_LOCAL_FACILITIES) {
      ctx.log(`Error: at most ${MAX_LOCAL_FACILITIES} facilities are supported per run`);
      return;
    }
    const breaks = parseCostBreaks(String(ctx.parameters.breaks ?? ""));
    if (!breaks.length) {
      ctx.log("Error: enter at least one positive cost break");
      return;
    }
    if (breaks.length > MAX_SERVICE_BREAKS) {
      ctx.log(`Error: at most ${MAX_SERVICE_BREAKS} cost breaks are supported`);
      return;
    }
    const built = buildNetworkFromParams(ctx);
    if (!built) return;
    const { net, unit } = built;
    const separate = (ctx.parameters.overlap as string) === "separate";
    const toward = (ctx.parameters.travelDirection as string) === "to";
    const width = Math.max(0, Number(ctx.parameters.polygonWidth ?? 0) || 0);
    const placed = placePoints(net, facilities);
    const passes = (separate ? facilities.length : 1) * breaks.length;
    if (passes * net.edges.length > 5_000_000 || (width > 0 && passes > 100)) {
      ctx.log(
        "Error: service area selection is too large; reduce facilities or breaks, merge areas, or disable polygons",
      );
      return;
    }
    const groups: { id: string | number | null; nodes: number[] }[] = separate
      ? placed.map((facility) => ({ id: facility.id, nodes: [facility.node] }))
      : [{ id: null, nodes: placed.map((facility) => facility.node) }];
    const maxBreak = breaks[breaks.length - 1];
    const lines: Feature[] = [];
    const polygons: Feature[] = [];
    for (const group of groups) {
      if (ctx.signal?.aborted) return;
      const result = net.search(group.nodes, { maxCost: maxBreak, reverse: toward });
      // Largest break first, so smaller areas draw on top in the result layer.
      for (const brk of [...breaks].reverse()) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (ctx.signal?.aborted) return;
        const pieces = net.reachableSegments(result, brk, toward);
        if (!pieces.length) continue;
        const properties: Record<string, unknown> = { break: brk };
        if (group.id !== null) properties.facility = group.id;
        const lineFeat: Feature = {
          type: "Feature",
          properties,
          geometry: { type: "MultiLineString", coordinates: pieces },
        };
        lines.push(lineFeat);
        if (width > 0) {
          const { feature: input, referenceLon } = prepareAntimeridianInput(lineFeat);
          const area = buffer(input, bodyLengthToEarth(width), { units: "meters" });
          if (area?.geometry)
            area.geometry = splitPolygonalAtAntimeridian(
              unwrapPolygonal(area.geometry as Polygon | MultiPolygon, referenceLon),
              referenceLon,
            );
          if (area?.geometry) {
            area.properties = { ...properties };
            polygons.push(area);
          }
        }
      }
    }
    if (!lines.length) {
      ctx.log("Error: nothing on the network is reachable within the breaks");
      return;
    }
    ctx.log(
      `Service areas for ${placed.length} facilit${placed.length === 1 ? "y" : "ies"} at ${breaks.join(", ")} ${unit}.`,
    );
    ctx.addResultLayer?.("Service area lines", featureCollection(lines), {
      graduatedField: "break",
    });
    if (polygons.length) {
      ctx.addResultLayer?.("Service area polygons", featureCollection(polygons), {
        graduatedField: "break",
      });
    }
  },
};

export const NETWORK_TOOLS: ProcessingAlgorithm[] = [
  isochroneTool,
  odMatrixTool,
  sequentialRouteTool,
  localShortestPathTool,
  localClosestFacilityTool,
  localServiceAreaTool,
];

export function getNetworkTool(id: string): ProcessingAlgorithm | undefined {
  return NETWORK_TOOLS.find((tool) => tool.id === id);
}
