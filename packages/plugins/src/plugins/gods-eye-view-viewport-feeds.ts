import type { CzmlPacket } from "@geolibre/core";
import type {
  Feature,
  FeatureCollection,
  LineString,
  MultiLineString,
  Point,
  Position,
} from "geojson";
import type { CzmlTimeWindow } from "./gods-eye-view-feeds";
import type { GodsEyeViewFeedPayload } from "./gods-eye-view-catalog-feeds";
import { downloadOsmGeoJson } from "./osm-downloader-api";
import {
  fetchTrafficFlow,
  flowSegmentInBounds,
  matchTrafficFlow,
  TomTomKeyError,
  trafficFlowColor,
  type TrafficFlowSegment,
} from "./gods-eye-view-traffic-flow";

export type ViewBounds = [west: number, south: number, east: number, north: number];

export const ALPR_MAX_VIEW_SPAN_DEGREES = 1.5;
export const ALPR_QUERY_SNAP_DEGREES = 0.05;
export const TRAFFIC_MAX_VIEW_SPAN_DEGREES = 0.1;
export const TRAFFIC_QUERY_SNAP_DEGREES = 0.01;

const TRAFFIC_CLASSES = new Set([
  "motorway",
  "trunk",
  "primary",
  "secondary",
  "tertiary",
  "residential",
  "unclassified",
]);
const TRAFFIC_SPEED_MPS: Record<string, number> = {
  motorway: 25,
  trunk: 20,
  primary: 14,
  secondary: 11,
  tertiary: 8,
  residential: 5,
  unclassified: 5,
};
const MAX_TRAFFIC_ENTITIES = 180;
const MAX_TRAFFIC_VERTICES = 16;
const MAX_TRAFFIC_CYCLES = 24;
const MAX_FLOW_POLYLINES = 1_500;
/** A jammed road still creeps; a zero speed would park every vehicle on it. */
const MIN_FLOW_SPEED_FACTOR = 0.15;

function documentPacket(name: string): CzmlPacket {
  return { id: "document", name, version: "1.0" };
}

function finitePosition(value: unknown): value is Position {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1]) &&
    value[0] >= -180 &&
    value[0] <= 180 &&
    value[1] >= -90 &&
    value[1] <= 90
  );
}

/**
 * Snap a small renderer-neutral viewport outward so nearby camera moves reuse
 * the exact same Overpass request (and its worker-side in-flight/cache key).
 */
export function viewportQueryBounds(
  bounds: ViewBounds | null,
  maxSpan: number,
  snap: number,
): ViewBounds | null {
  if (!bounds || !bounds.every(Number.isFinite) || !(maxSpan > 0) || !(snap > 0)) return null;
  const [west, south, east, north] = bounds;
  const width = east - west;
  const height = north - south;
  if (
    west < -180 ||
    west > 180 ||
    east > west + 360 ||
    south < -90 ||
    north > 90 ||
    width <= 0 ||
    height <= 0 ||
    width > maxSpan ||
    height > maxSpan
  ) {
    return null;
  }
  const stable = (value: number) => Number(value.toFixed(10));
  const down = (value: number) => stable(Math.floor(value / snap) * snap);
  const up = (value: number) => stable(Math.ceil(value / snap) * snap);
  return [down(west), Math.max(-90, down(south)), up(east), Math.min(90, up(north))];
}

export function viewportBoundsKey(
  bounds: ViewBounds | null,
  maxSpan: number,
  snap: number,
): string {
  const queryBounds = viewportQueryBounds(bounds, maxSpan, snap);
  return queryBounds ? queryBounds.map((value) => value.toFixed(4)).join(",") : "out-of-range";
}

function isAlprValue(value: unknown): boolean {
  return String(value ?? "")
    .split(";")
    .some((part) => part.trim().toUpperCase() === "ALPR");
}

export function mappedAlprToCzml(data: FeatureCollection): GodsEyeViewFeedPayload {
  const packets: CzmlPacket[] = [documentPacket("Mapped ALPR Cameras")];
  const features: Feature<Point>[] = [];
  for (const feature of data.features) {
    if (
      feature.geometry?.type !== "Point" ||
      !finitePosition(feature.geometry.coordinates) ||
      !isAlprValue(feature.properties?.["surveillance:type"])
    ) {
      continue;
    }
    const id = `alpr-${String(feature.id ?? features.length)}`;
    const properties = {
      operator: String(feature.properties?.operator ?? "Unknown"),
      cameraType: String(feature.properties?.["camera:type"] ?? "ALPR"),
      direction: String(
        feature.properties?.["camera:direction"] ?? feature.properties?.direction ?? "",
      ),
      source: "OpenStreetMap community mapping",
    };
    packets.push({
      id,
      name: properties.operator === "Unknown" ? "Mapped ALPR camera" : properties.operator,
      position: { cartographicDegrees: [...feature.geometry.coordinates.slice(0, 2), 3] },
      properties,
      point: {
        pixelSize: 10,
        color: { rgba: [82, 212, 255, 240] },
        outlineColor: { rgba: [8, 15, 24, 230] },
        outlineWidth: 2,
      },
    });
    features.push({
      type: "Feature",
      id,
      geometry: { type: "Point", coordinates: feature.geometry.coordinates.slice(0, 2) },
      properties,
    });
  }
  return { packets, attributes: { type: "FeatureCollection", features } };
}

export async function fetchMappedAlprCzml(
  bounds: ViewBounds | null,
  options: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<GodsEyeViewFeedPayload> {
  const queryBounds = viewportQueryBounds(
    bounds,
    ALPR_MAX_VIEW_SPAN_DEGREES,
    ALPR_QUERY_SNAP_DEGREES,
  );
  if (!queryBounds) return mappedAlprToCzml({ type: "FeatureCollection", features: [] });
  // Query only the canonical public OSM tag. This feed exposes mapped camera
  // locations and metadata; it never requests imagery or license-plate records.
  const data = await downloadOsmGeoJson(
    queryBounds,
    { preset: "custom", key: "surveillance:type", value: "ALPR" },
    { fetchImpl: options.fetch as never, signal: options.signal },
  );
  return mappedAlprToCzml(data);
}

function lineGeometries(feature: Feature): Position[][] {
  const geometry = feature.geometry;
  if (geometry?.type === "LineString") return [(geometry as LineString).coordinates];
  if (geometry?.type === "MultiLineString") return (geometry as MultiLineString).coordinates;
  return [];
}

function thinLine(line: Position[], limit = MAX_TRAFFIC_VERTICES): Position[] {
  const valid = line.filter(finitePosition);
  if (valid.length <= limit) return valid;
  const result: Position[] = [];
  for (let index = 0; index < limit; index += 1) {
    result.push(valid[Math.round((index * (valid.length - 1)) / (limit - 1))]);
  }
  return result;
}

function segmentLengthMeters(a: Position, b: Position): number {
  const meanLatitude = ((a[1] + b[1]) / 2) * (Math.PI / 180);
  const x = (b[0] - a[0]) * Math.cos(meanLatitude);
  const y = b[1] - a[1];
  return Math.hypot(x, y) * 111_195;
}

function cumulativeDistances(line: Position[]): number[] {
  const distances = [0];
  for (let index = 1; index < line.length; index += 1) {
    distances.push(distances[index - 1] + segmentLengthMeters(line[index - 1], line[index]));
  }
  return distances;
}

/** Live congestion to draw under, and pace, the simulated vehicles. */
export interface StreetTrafficFlow {
  segments: readonly TrafficFlowSegment[];
  /** Only segments reaching into this box are drawn; flow tiles overhang the view. */
  bounds: ViewBounds;
}

/**
 * Simulate vehicles on OSM road geometry, optionally paced by TomTom flow.
 *
 * With `flow`, each road takes the congestion of the flow segment it matches:
 * vehicles slow to that fraction of the road's free speed and take its color,
 * closed roads carry none, and the flow segments themselves are drawn as
 * colored lines. Roads TomTom does not cover keep the keyless simulation.
 */
export function streetTrafficToCzml(
  data: FeatureCollection,
  window: CzmlTimeWindow,
  flow?: StreetTrafficFlow,
): GodsEyeViewFeedPayload {
  const packets: CzmlPacket[] = [documentPacket("Simulated Street Traffic")];
  const features: Feature<Point>[] = [];
  const windowSeconds = Math.max(1, (window.stop.getTime() - window.start.getTime()) / 1000);
  const candidates = data.features.flatMap((feature) => {
    const roadClass = String(feature.properties?.highway ?? "");
    if (!TRAFFIC_CLASSES.has(roadClass)) return [];
    return lineGeometries(feature).map((line, lineIndex) => ({
      feature,
      line: thinLine(line),
      lineIndex,
      roadClass,
    }));
  });

  for (const candidate of candidates) {
    if (features.length >= MAX_TRAFFIC_ENTITIES) break;
    if (candidate.line.length < 2) continue;
    const distances = cumulativeDistances(candidate.line);
    const totalDistance = distances.at(-1) ?? 0;
    if (!(totalDistance > 0)) continue;
    const match = flow ? matchTrafficFlow(candidate.line, flow.segments) : null;
    if (match?.closure) continue;
    const speedFactor = match ? Math.max(MIN_FLOW_SPEED_FACTOR, match.level) : 1;
    const naturalCycleSeconds =
      totalDistance / ((TRAFFIC_SPEED_MPS[candidate.roadClass] ?? 5) * speedFactor);
    const cycleSeconds = Math.max(naturalCycleSeconds, windowSeconds / MAX_TRAFFIC_CYCLES);
    const samples: number[] = [];
    let lastElapsed = -1;
    cycles: for (let cycle = 0; cycle * cycleSeconds < windowSeconds; cycle += 1) {
      const route = cycle % 2 === 0 ? candidate.line : [...candidate.line].reverse();
      const routeDistances = cycle % 2 === 0 ? distances : cumulativeDistances(route);
      // Adjacent cycles share their boundary point; omit the duplicate timestamp
      // so Cesium receives one authoritative sample for that instant.
      for (let index = cycle === 0 ? 0 : 1; index < route.length; index += 1) {
        const elapsed = Math.min(
          windowSeconds,
          cycle * cycleSeconds + (routeDistances[index] / totalDistance) * cycleSeconds,
        );
        if (elapsed <= lastElapsed) continue;
        samples.push(elapsed, route[index][0], route[index][1], 3);
        lastElapsed = elapsed;
        if (elapsed === windowSeconds) break cycles;
      }
    }
    const id = `street-traffic-${String(candidate.feature.id ?? features.length)}-${candidate.lineIndex}`;
    const properties = {
      road: String(candidate.feature.properties?.name ?? "Unnamed road"),
      roadClass: candidate.roadClass,
      mode: match
        ? "Simulated positions on OpenStreetMap road geometry, paced by TomTom live flow"
        : "Simulated positions on OpenStreetMap road geometry",
      ...(match ? { freeFlowPercent: Math.round(match.level * 100) } : {}),
    };
    packets.push({
      id,
      name: "Simulated traffic",
      availability: `${window.start.toISOString()}/${window.stop.toISOString()}`,
      position: {
        epoch: window.start.toISOString(),
        referenceFrame: "FIXED",
        interpolationAlgorithm: "LINEAR",
        interpolationDegree: 1,
        cartographicDegrees: samples,
      },
      properties,
      point: {
        pixelSize: ["motorway", "trunk"].includes(candidate.roadClass) ? 6 : 4,
        color: { rgba: match ? trafficFlowColor(match.level, false) : [245, 248, 255, 235] },
        outlineColor: { rgba: [30, 41, 59, 190] },
        outlineWidth: 1,
      },
    });
    features.push({
      type: "Feature",
      id,
      geometry: { type: "Point", coordinates: candidate.line[0].slice(0, 2) },
      properties,
    });
  }
  if (flow) packets.push(...trafficFlowPackets(flow));
  return { packets, attributes: { type: "FeatureCollection", features } };
}

/** The congestion itself: one ground-clamped polyline per flow segment in view. */
function trafficFlowPackets(flow: StreetTrafficFlow): CzmlPacket[] {
  const packets: CzmlPacket[] = [];
  for (const segment of flow.segments) {
    if (packets.length >= MAX_FLOW_POLYLINES) break;
    if (!flowSegmentInBounds(segment, flow.bounds)) continue;
    const positions = segment.coordinates.filter(finitePosition).flatMap(([x, y]) => [x, y, 0]);
    if (positions.length < 6) continue;
    packets.push({
      id: `traffic-flow-${packets.length}`,
      name: segment.closure ? "Road closed" : "Traffic flow",
      properties: {
        roadType: segment.roadType,
        freeFlowPercent: Math.round(segment.level * 100),
        closure: segment.closure,
        source: "TomTom Traffic Flow",
      },
      polyline: {
        positions: { cartographicDegrees: positions },
        width: segment.closure ? 5 : 3,
        clampToGround: true,
        material: {
          solidColor: { color: { rgba: trafficFlowColor(segment.level, segment.closure) } },
        },
      },
    });
  }
  return packets;
}

/** Why the flow coloring is missing although a key was supplied. */
export type StreetTrafficFlowStatus = "active" | "keyRejected" | "unavailable";

let roadCache: { key: string; data: FeatureCollection } | null = null;

/**
 * Street Traffic for the current view.
 *
 * The OSM roads for a snapped viewport are cached, so a flow-only refresh does
 * not re-query Overpass for geometry that has not changed. A TomTom failure
 * never takes the vehicles down with it: the layer falls back to the keyless
 * simulation and reports why through `flowStatus`.
 */
export async function fetchStreetTrafficCzml(
  bounds: ViewBounds | null,
  window: CzmlTimeWindow,
  options: {
    fetch?: typeof fetch;
    signal?: AbortSignal;
    tomtomKey?: string;
    onFlowStatus?: (status: StreetTrafficFlowStatus) => void;
  } = {},
): Promise<GodsEyeViewFeedPayload> {
  const queryBounds = viewportQueryBounds(
    bounds,
    TRAFFIC_MAX_VIEW_SPAN_DEGREES,
    TRAFFIC_QUERY_SNAP_DEGREES,
  );
  if (!queryBounds) {
    return streetTrafficToCzml({ type: "FeatureCollection", features: [] }, window);
  }
  const key = queryBounds.join(",");
  const roads =
    roadCache?.key === key
      ? Promise.resolve(roadCache.data)
      : downloadOsmGeoJson(
          queryBounds,
          { preset: "roads" },
          { fetchImpl: options.fetch as never, signal: options.signal },
        ).then((data) => {
          roadCache = { key, data };
          return data;
        });
  const flow = options.tomtomKey
    ? fetchTrafficFlow(queryBounds, options.tomtomKey, {
        fetch: options.fetch,
        signal: options.signal,
      }).then(
        (segments) => {
          options.onFlowStatus?.("active");
          return segments;
        },
        (error: unknown) => {
          if (options.signal?.aborted) throw error;
          options.onFlowStatus?.(error instanceof TomTomKeyError ? "keyRejected" : "unavailable");
          console.warn("[God's Eye View] TomTom traffic flow unavailable", error);
          return null;
        },
      )
    : Promise.resolve(null);
  const [data, segments] = await Promise.all([roads, flow]);
  return streetTrafficToCzml(
    data,
    window,
    segments ? { segments, bounds: queryBounds } : undefined,
  );
}

/** Forget cached road geometry (tests, and a plugin deactivation). */
export function clearStreetTrafficRoadCache(): void {
  roadCache = null;
}
