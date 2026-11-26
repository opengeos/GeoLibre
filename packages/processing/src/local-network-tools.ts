import { featureCollection } from "@turf/helpers";
import buffer from "@turf/buffer";
import {
  bodyLengthToEarth,
  compareSequenceValues,
  type GeoLibreLayer,
} from "@geolibre/core/worker-safe";
import type { RoutingPoint } from "@geolibre/core";
import type { Feature, Point, Position, Polygon, MultiPolygon } from "geojson";
import {
  buildLocalNetwork,
  createNetworkSearchBudget,
  splitNetworkLine,
  type LocalNetwork,
  type NetworkCostMode,
  type NetworkSearchBudget,
  type NetworkSearchYield,
  type TurnRules,
  type TurnTableEntry,
  type UTurnPolicy,
} from "./local-network";
import { installWasmNetworkEngine } from "./local-network-wasm";
import {
  prepareAntimeridianInput,
  unwrapPolygonal,
  splitPolygonalAtAntimeridian,
} from "./antimeridian-buffer";
import type { AlgorithmParameter, ProcessingAlgorithm, ProcessingContext } from "./types";

/**
 * Local network tools: shortest path, closest facility and service area over a
 * user line layer, with no routing server involved. They import only
 * store-free modules so they can run on the processing worker
 * (vector-tool-worker-tools.ts); `network-tools.ts` adds them to the Network
 * registry next to the Valhalla tools, which share the point helpers here.
 */

export function getLayer(ctx: ProcessingContext, paramId: string): GeoLibreLayer | undefined {
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
export function layerToRoutingPoints(layer: GeoLibreLayer | undefined): RoutingPoint[] {
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

/**
 * A finite number, or a plain decimal or scientific-notation string. Other
 * `Number()` forms (`0x1A`, `0b1`) are rejected, so a turn cost cell reading
 * them prohibits the turn like any other non-numeric value.
 */
function numericValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) return Number(trimmed);
  }
  return null;
}

/**
 * Lets an inline run paint and notice Cancel between searches. On the worker
 * there is no signal and nothing to yield to, so it does not wait: a nested
 * `setTimeout(0)` is clamped to 4 ms, which adds seconds over thousands of
 * incidents.
 */
function yieldToHost(ctx: ProcessingContext): Promise<void> {
  if (!ctx.signal) return Promise.resolve();
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** Lets a chunked network search yield to the host and stop on cancel. */
function searchHooks(ctx: ProcessingContext): NetworkSearchYield {
  return {
    yieldToHost: () => yieldToHost(ctx),
    aborted: () => ctx.signal?.aborted === true,
  };
}

/** Cap on stops for a local route, to keep one run interactive. */
const MAX_LOCAL_STOPS = 500;
/** Cap on incidents for closest facility. */
const MAX_LOCAL_INCIDENTS = 2000;
/** Cap on facilities for closest facility and service area. */
const MAX_LOCAL_FACILITIES = 2000;
/** Cap on service-area cost breaks. */
const MAX_SERVICE_BREAKS = 10;

/** Shows the turn parameters only once turn rules are switched on. */
const TURN_RULES_ON = { param: "turns", in: ["rules"] };

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
  {
    id: "turns",
    label: "Turn rules",
    type: "select",
    default: "none",
    options: [
      { value: "none", label: "None (turns are free)" },
      { value: "rules", label: "Turn restrictions and costs" },
    ],
    description:
      "Prohibit or charge turns with a turn table, a cost per left or right turn, or a U-turn limit. Costs are in the edge cost unit.",
  },
  {
    id: "turnTable",
    label: "Turn table (optional)",
    type: "layer",
    visibleWhen: TURN_RULES_ON,
    description:
      "One row per turn from one network line onto another, matched by the line id field. The row applies wherever the two lines meet.",
  },
  {
    id: "networkIdField",
    label: "Network line id field",
    type: "field",
    fieldSource: "network",
    visibleWhen: TURN_RULES_ON,
    description: "The network attribute that the turn table's from and to fields refer to.",
  },
  {
    id: "turnFromField",
    label: "Turn from-line field",
    type: "field",
    fieldSource: "turnTable",
    visibleWhen: TURN_RULES_ON,
  },
  {
    id: "turnToField",
    label: "Turn to-line field",
    type: "field",
    fieldSource: "turnTable",
    visibleWhen: TURN_RULES_ON,
  },
  {
    id: "turnCostField",
    label: "Turn cost field (optional)",
    type: "field",
    fieldSource: "turnTable",
    visibleWhen: TURN_RULES_ON,
    description:
      "Cost added for the turn. Without this field every row prohibits its turn; with it, a blank, negative or non-numeric value prohibits the turn.",
  },
  {
    id: "leftTurnCost",
    label: "Left turn cost",
    type: "number",
    default: 0,
    min: 0,
    visibleWhen: TURN_RULES_ON,
    description:
      "Added at junctions of three or more lines when the route bends left by more than 30 degrees.",
  },
  {
    id: "rightTurnCost",
    label: "Right turn cost",
    type: "number",
    default: 0,
    min: 0,
    visibleWhen: TURN_RULES_ON,
    description:
      "Added at junctions of three or more lines when the route bends right by more than 30 degrees.",
  },
  {
    id: "uturns",
    label: "U-turns",
    type: "select",
    default: "allow",
    visibleWhen: TURN_RULES_ON,
    options: [
      { value: "allow", label: "Allowed anywhere" },
      { value: "junctions", label: "At junctions and dead ends" },
      { value: "dead-ends", label: "At dead ends only" },
      { value: "never", label: "Never" },
    ],
  },
  {
    id: "uturnCost",
    label: "U-turn cost",
    type: "number",
    default: 0,
    min: 0,
    visibleWhen: TURN_RULES_ON,
    description: "Added for each U-turn where one is allowed.",
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
 * Reads the shared network parameters and builds the graph, logging counters,
 * and loads the WebAssembly search engine when it is available.
 * Returns null (after logging an error) when the network is unusable.
 */
async function buildNetworkFromParams(ctx: ProcessingContext): Promise<{
  net: LocalNetwork;
  mode: NetworkCostMode;
  unit: string;
  budget: NetworkSearchBudget;
} | null> {
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
  const turnRules = readTurnRules(ctx, features);
  if (turnRules === null) return null;
  if (turnRules) {
    net.setTurnRules(turnRules);
    if (!net.hasTurnRules) ctx.log("Turn rules are on but set no restriction or cost.");
  }
  const engine = await installWasmNetworkEngine();
  ctx.log(`Network searches run in ${engine ? engine.name : "JavaScript"}.`);
  return { net, mode, unit: costUnit(mode, costField), budget: createNetworkSearchBudget() };
}

/** Most turn pairs one turn table may expand to (rows times duplicate ids). */
const MAX_TURN_PAIRS = 1_000_000;

/** Reads a parameter as a non-negative number, or null when it is invalid. */
function turnCostParam(ctx: ProcessingContext, id: string): number | null {
  const raw = ctx.parameters[id];
  if (raw === undefined || raw === null || raw === "") return 0;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Reads the turn-rule parameters. Returns `false` when turn rules are off,
 * the rules when they are on, or null (after logging an error) when they are
 * invalid. Turn table rows name network lines by `networkIdField`; a value
 * shared by several network features applies the row to each of them.
 */
export function readTurnRules(
  ctx: ProcessingContext,
  features: Feature[],
): TurnRules | false | null {
  if ((ctx.parameters.turns as string | undefined) !== "rules") return false;
  const leftCost = turnCostParam(ctx, "leftTurnCost");
  const rightCost = turnCostParam(ctx, "rightTurnCost");
  const uturnCost = turnCostParam(ctx, "uturnCost");
  if (leftCost === null || rightCost === null || uturnCost === null) {
    ctx.log("Error: turn costs must be zero or a positive number");
    return null;
  }
  const rawPolicy = ctx.parameters.uturns as string | undefined;
  const uturns: UTurnPolicy =
    rawPolicy === "junctions" || rawPolicy === "dead-ends" || rawPolicy === "never"
      ? rawPolicy
      : "allow";
  const rules: TurnRules = { leftCost, rightCost, uturnCost, uturns };
  const tableLayer = getLayer(ctx, "turnTable");
  if (ctx.parameters.turnTable && !tableLayer) {
    ctx.log("Error: the selected turn table layer is no longer available; select it again");
    return null;
  }
  if (tableLayer) {
    const text = (id: string) => ((ctx.parameters[id] as string | undefined) ?? "").trim();
    const idField = text("networkIdField");
    const fromField = text("turnFromField");
    const toField = text("turnToField");
    const costField = text("turnCostField");
    if (!idField || !fromField || !toField) {
      ctx.log(
        "Error: a turn table needs the network line id field and the turn from-line and to-line fields",
      );
      return null;
    }
    const key = (value: unknown): string =>
      value === null || value === undefined ? "" : String(value).trim();
    const byId = new Map<string, number[]>();
    features.forEach((feature, index) => {
      const id = key(feature.properties?.[idField]);
      if (!id) return;
      const list = byId.get(id);
      if (list) list.push(index);
      else byId.set(id, [index]);
    });
    const table: TurnTableEntry[] = [];
    let matched = 0;
    let unmatched = 0;
    let prohibited = 0;
    for (const row of tableLayer.geojson?.features ?? []) {
      const props = row.properties ?? {};
      const from = byId.get(key(props[fromField]));
      const to = byId.get(key(props[toField]));
      if (!from || !to) {
        unmatched++;
        continue;
      }
      let cost = Infinity;
      if (costField) {
        const value = numericValue(props[costField]);
        if (value !== null && value >= 0) cost = value;
      }
      if (!Number.isFinite(cost)) prohibited++;
      matched++;
      if (table.length + from.length * to.length > MAX_TURN_PAIRS) {
        ctx.log(
          `Error: the turn table expands to more than ${MAX_TURN_PAIRS.toLocaleString("en-US")} line pairs; use unique network line ids`,
        );
        return null;
      }
      for (const a of from) for (const b of to) table.push({ from: a, to: b, cost });
    }
    rules.table = table;
    ctx.log(
      `Turn table: ${matched} row(s) matched (${prohibited} prohibited, ${matched - prohibited} with a cost)` +
        (unmatched ? `, ${unmatched} row(s) name no network line and were skipped.` : "."),
    );
  }
  return rules;
}

interface PlacedPoint {
  id: string | number;
  node: number;
  snap: number;
}

/** Attaches every point to the network, in order. */
function placePoints(
  net: LocalNetwork,
  points: RoutingPoint[],
  ctx: ProcessingContext,
): PlacedPoint[] {
  if (points.length * net.edges.length > 50_000_000)
    throw new RangeError(
      "Local network point placement is too large; reduce points or use a smaller extract",
    );
  const placed: PlacedPoint[] = [];
  const rawTolerance = Number(ctx.parameters.snapTolerance ?? 1);
  const warningDistance = Math.max(1000, 10 * (Number.isFinite(rawTolerance) ? rawTolerance : 1));
  let far = 0;
  let maxDistance = 0;
  for (const point of points) {
    const hit = net.insertPoint(point.lon, point.lat);
    if (hit) {
      placed.push({ id: point.id, node: hit.node, snap: round(hit.snapDistance, 2) });
      if (hit.snapDistance > warningDistance) {
        far++;
        maxDistance = Math.max(maxDistance, hit.snapDistance);
      }
    }
  }
  if (far)
    ctx.log(
      `Warning: ${far} input point(s) attached more than ${round(warningDistance, 0)} m from the network (maximum ${round(maxDistance, 0)} m). Inspect the result snap-distance fields.`,
    );
  return placed;
}

function lineFeature(coordinates: Position[], properties: Record<string, unknown>): Feature {
  if (
    coordinates.length === 1 ||
    coordinates.every((point) => point[0] === coordinates[0][0] && point[1] === coordinates[0][1])
  )
    return {
      type: "Feature",
      properties,
      geometry: { type: "Point", coordinates: coordinates[0] },
    };
  const pieces = splitNetworkLine(coordinates);
  return {
    type: "Feature",
    properties,
    geometry:
      pieces.length > 1
        ? { type: "MultiLineString", coordinates: pieces }
        : pieces.length
          ? { type: "LineString", coordinates: pieces[0] }
          : { type: "Point", coordinates: coordinates[0] },
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
    const built = await buildNetworkFromParams(ctx);
    if (!built) return;
    const { net, unit, budget } = built;
    const astar = (ctx.parameters.algorithm as string) !== "dijkstra";
    const placed = placePoints(net, stops, ctx);
    if ((placed.length - 1) * net.searchStateCount > 50_000_000) {
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
      await yieldToHost(ctx);
      if (ctx.signal?.aborted) return;
      const from = placed[i - 1];
      const to = placed[i];
      const result = await net.searchChunked(
        [from.node],
        { target: to.node, astar, budget },
        searchHooks(ctx),
      );
      if (!result) return;
      const path = net.pathTo(result, to.node);
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
    const built = await buildNetworkFromParams(ctx);
    if (!built) return;
    const { net, unit, budget } = built;
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
    const placedFacilities = placePoints(net, facilities, ctx);
    const placedIncidents = placePoints(net, incidents, ctx);
    if (placedIncidents.length * net.searchStateCount > 50_000_000) {
      ctx.log(
        "Error: closest-facility selection is too large; reduce incidents or use a smaller network extract",
      );
      return;
    }
    const facilitiesAt = new Map<number, PlacedPoint[]>();
    const facilityWeights = new Uint32Array(net.nodeCount);
    for (const facility of placedFacilities) {
      const list = facilitiesAt.get(facility.node) ?? [];
      list.push(facility);
      facilitiesAt.set(facility.node, list);
      facilityWeights[facility.node]++;
    }
    const features: Feature[] = [];
    let short = 0;
    for (const incident of placedIncidents) {
      await yieldToHost(ctx);
      if (ctx.signal?.aborted) return;
      // Searching against edge direction from the incident gives costs from
      // each facility to it, so one search serves either travel direction.
      // It stops once `count` facilities are settled, nearest first.
      const result = await net.searchChunked(
        [incident.node],
        {
          budget,
          maxCost,
          reverse: fromFacility,
          stopAt: { weights: facilityWeights, count },
        },
        searchHooks(ctx),
      );
      if (!result) return;
      const found: { facility: PlacedPoint; node: number }[] = [];
      for (const node of result.settledTargets ?? []) {
        for (const facility of facilitiesAt.get(node) ?? []) {
          if (found.length < count) found.push({ facility, node });
        }
      }
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
    const built = await buildNetworkFromParams(ctx);
    if (!built) return;
    const { net, unit, budget } = built;
    const separate = (ctx.parameters.overlap as string) === "separate";
    const toward = (ctx.parameters.travelDirection as string) === "to";
    const width = Math.max(0, Number(ctx.parameters.polygonWidth ?? 0) || 0);
    const placed = placePoints(net, facilities, ctx);
    const passes = (separate ? facilities.length : 1) * breaks.length;
    if (
      passes * Math.max(net.edges.length, net.searchStateCount) > 5_000_000 ||
      (width > 0 && passes > 100)
    ) {
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
    let bufferedPieces = 0;
    for (const group of groups) {
      if (ctx.signal?.aborted) return;
      const result = await net.searchChunked(
        group.nodes,
        { maxCost: maxBreak, reverse: toward, budget },
        searchHooks(ctx),
      );
      if (!result) return;
      // Largest break first, so smaller areas draw on top in the result layer.
      for (const brk of [...breaks].reverse()) {
        await yieldToHost(ctx);
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
          bufferedPieces += pieces.length;
          if (pieces.length > 1000 || bufferedPieces > 5000) {
            ctx.log(
              "Error: service-area polygon buffering exceeds 1,000 line pieces per area or 5,000 per run. Disable polygons, reduce the breaks, or use a smaller network.",
            );
            return;
          }
          const { feature: input, referenceLon } = prepareAntimeridianInput(lineFeat);
          await yieldToHost(ctx);
          if (ctx.signal?.aborted) return;
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
