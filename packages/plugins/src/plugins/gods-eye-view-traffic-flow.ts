import { VectorTile } from "@mapbox/vector-tile";
import type { Feature, LineString, MultiLineString, Position } from "geojson";
import { PbfReader } from "pbf";
import type { ViewBounds } from "./gods-eye-view-viewport-feeds";

/**
 * TomTom traffic-flow coloring for the Street Traffic layer.
 *
 * TomTom publishes live congestion as Mapbox Vector Tiles. The `relative` style
 * carries `traffic_level`, the current speed as a fraction of free-flow speed
 * (1 = free flow), plus a `road_closure` flag. The tiles are CORS-open to the
 * browser, so the user's own key goes straight to TomTom with no relay.
 *
 * Zoom 12 matches upstream gods-eye-view: its tiles carry every road class down
 * to major local roads, and the Street Traffic viewport (at most 0.1°) needs
 * only a handful of them.
 */
export const TOMTOM_FLOW_TILE_URL =
  "https://api.tomtom.com/traffic/map/4/tile/flow/relative/{z}/{x}/{y}.pbf";
export const TOMTOM_FLOW_TILE_ZOOM = 12;
const TOMTOM_FLOW_LAYER = "Traffic flow";
const MAX_FLOW_TILES = 9;
/** A road and a flow segment farther apart than this are different roads. */
export const FLOW_MATCH_TOLERANCE_METERS = 30;
const MERCATOR_LATITUDE_LIMIT = 85.05112878;

export interface TrafficFlowSegment {
  coordinates: Position[];
  /** Current speed over free-flow speed, clamped to 0..1. */
  level: number;
  closure: boolean;
  roadType: string;
}

export interface FlowTile {
  z: number;
  x: number;
  y: number;
}

/** A rejected key, kept distinct so the panel can say so instead of "failed". */
export class TomTomKeyError extends Error {
  constructor(status: number) {
    super(`TomTom rejected the API key (HTTP ${status})`);
    this.name = "TomTomKeyError";
  }
}

function lonLatToTile(longitude: number, latitude: number, zoom: number): [number, number] {
  const n = 2 ** zoom;
  const clamped = Math.max(-MERCATOR_LATITUDE_LIMIT, Math.min(MERCATOR_LATITUDE_LIMIT, latitude));
  const radians = (clamped * Math.PI) / 180;
  const x = Math.floor(((longitude + 180) / 360) * n);
  const y = Math.floor(((1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2) * n);
  return [Math.max(0, Math.min(n - 1, x)), Math.max(0, Math.min(n - 1, y))];
}

/**
 * The slippy tiles covering `bounds`, row-major from the northwest corner.
 *
 * @returns An empty list for an unusable or oversized viewport, rather than a
 *   request storm against the user's key.
 */
export function flowTilesForBounds(
  bounds: ViewBounds | null,
  zoom = TOMTOM_FLOW_TILE_ZOOM,
): FlowTile[] {
  if (!bounds || !bounds.every(Number.isFinite)) return [];
  const [west, south, east, north] = bounds;
  if (!(east > west) || !(north > south)) return [];
  const [minX, minY] = lonLatToTile(west, north, zoom);
  const [maxX, maxY] = lonLatToTile(east, south, zoom);
  if ((maxX - minX + 1) * (maxY - minY + 1) > MAX_FLOW_TILES) return [];
  const tiles: FlowTile[] = [];
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) tiles.push({ z: zoom, x, y });
  }
  return tiles;
}

function lineParts(geometry: Feature["geometry"]): Position[][] {
  if (geometry?.type === "LineString") return [(geometry as LineString).coordinates];
  if (geometry?.type === "MultiLineString") return (geometry as MultiLineString).coordinates;
  return [];
}

/**
 * Decode one flow tile into plain lon/lat polylines.
 *
 * A feature with no usable `traffic_level` is skipped unless the road is
 * closed, which needs no level to be drawn. One malformed feature never drops
 * the rest of the tile.
 */
export function decodeFlowTile(
  data: ArrayBuffer | Uint8Array,
  tile: FlowTile,
): TrafficFlowSegment[] {
  let layer;
  try {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    layer = new VectorTile(new PbfReader(bytes)).layers[TOMTOM_FLOW_LAYER];
  } catch {
    return [];
  }
  if (!layer) return [];
  const segments: TrafficFlowSegment[] = [];
  for (let index = 0; index < layer.length; index += 1) {
    let feature: Feature;
    try {
      feature = layer.feature(index).toGeoJSON(tile.x, tile.y, tile.z) as Feature;
    } catch {
      continue;
    }
    const properties = feature.properties ?? {};
    const closure = properties.road_closure === true || properties.road_closure === "true";
    const rawLevel = properties.traffic_level;
    const hasLevel = typeof rawLevel === "number" && Number.isFinite(rawLevel);
    if (!hasLevel && !closure) continue;
    const level = hasLevel ? Math.min(1, Math.max(0, rawLevel)) : 0;
    const roadType = typeof properties.road_type === "string" ? properties.road_type : "";
    for (const coordinates of lineParts(feature.geometry)) {
      if (coordinates.length >= 2) segments.push({ coordinates, level, closure, roadType });
    }
  }
  return segments;
}

/**
 * Fetch and decode the flow tiles covering `bounds`.
 *
 * @throws {TomTomKeyError} When TomTom rejects the key, so the caller can tell
 *   a bad key from a transient failure.
 */
export async function fetchTrafficFlow(
  bounds: ViewBounds | null,
  key: string,
  options: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<TrafficFlowSegment[]> {
  const fetcher = options.fetch ?? fetch;
  const tiles = flowTilesForBounds(bounds);
  const decoded = await Promise.all(
    tiles.map(async (tile) => {
      const url = `${TOMTOM_FLOW_TILE_URL.replace("{z}", String(tile.z))
        .replace("{x}", String(tile.x))
        .replace("{y}", String(tile.y))}?key=${encodeURIComponent(key)}`;
      const response = await fetcher(url, { signal: options.signal });
      if (response.status === 401 || response.status === 403) {
        throw new TomTomKeyError(response.status);
      }
      if (!response.ok) throw new Error(`TomTom flow tile HTTP ${response.status}`);
      return decodeFlowTile(await response.arrayBuffer(), tile);
    }),
  );
  return decoded.flat();
}

/**
 * Congestion color on the usual green → red ramp, dark red for a closure.
 * The bands follow TomTom's own relative flow styling.
 */
export function trafficFlowColor(
  level: number,
  closure: boolean,
): [number, number, number, number] {
  if (closure) return [127, 29, 29, 235];
  if (level >= 0.8) return [34, 197, 94, 230];
  if (level >= 0.6) return [234, 179, 8, 235];
  if (level >= 0.35) return [249, 115, 22, 240];
  return [220, 38, 38, 245];
}

function metersBetween(a: Position, b: Position): number {
  const meanLatitude = ((a[1] + b[1]) / 2) * (Math.PI / 180);
  return Math.hypot((b[0] - a[0]) * Math.cos(meanLatitude), b[1] - a[1]) * 111_195;
}

/** Distance from `point` to the segment `a`→`b`, on a local equirectangular plane. */
function metersToSegment(point: Position, a: Position, b: Position): number {
  const scale = Math.cos((point[1] * Math.PI) / 180);
  const ax = (a[0] - point[0]) * scale;
  const ay = a[1] - point[1];
  const bx = (b[0] - point[0]) * scale;
  const by = b[1] - point[1];
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSquared)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy) * 111_195;
}

function pointAlong(line: Position[], fraction: number): Position {
  const lengths = [0];
  for (let index = 1; index < line.length; index += 1) {
    lengths.push(lengths[index - 1] + metersBetween(line[index - 1], line[index]));
  }
  const target = (lengths.at(-1) ?? 0) * fraction;
  for (let index = 1; index < line.length; index += 1) {
    if (lengths[index] >= target) {
      const span = lengths[index] - lengths[index - 1];
      const t = span > 0 ? (target - lengths[index - 1]) / span : 0;
      const a = line[index - 1];
      const b = line[index];
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
  }
  return line[0];
}

/**
 * The flow segment an OSM road lies on, judged at its midpoint.
 *
 * TomTom and OSM digitize the same street independently, so the match is by
 * proximity: the nearest flow segment within {@link FLOW_MATCH_TOLERANCE_METERS}
 * of the road's midpoint, or null when the road carries no flow (a minor street
 * TomTom does not cover at this zoom).
 */
export function matchTrafficFlow(
  line: Position[],
  segments: readonly TrafficFlowSegment[],
): TrafficFlowSegment | null {
  if (line.length < 2 || segments.length === 0) return null;
  const midpoint = pointAlong(line, 0.5);
  // Skip a segment whose bounding box is beyond the tolerance before walking it.
  const padLatitude = FLOW_MATCH_TOLERANCE_METERS / 111_195;
  const padLongitude = padLatitude / Math.max(0.01, Math.cos((midpoint[1] * Math.PI) / 180));
  let best: TrafficFlowSegment | null = null;
  let bestDistance = FLOW_MATCH_TOLERANCE_METERS;
  for (const segment of segments) {
    let west = Infinity;
    let south = Infinity;
    let east = -Infinity;
    let north = -Infinity;
    for (const [longitude, latitude] of segment.coordinates) {
      west = Math.min(west, longitude);
      east = Math.max(east, longitude);
      south = Math.min(south, latitude);
      north = Math.max(north, latitude);
    }
    if (
      midpoint[0] < west - padLongitude ||
      midpoint[0] > east + padLongitude ||
      midpoint[1] < south - padLatitude ||
      midpoint[1] > north + padLatitude
    ) {
      continue;
    }
    for (let index = 1; index < segment.coordinates.length; index += 1) {
      const distance = metersToSegment(
        midpoint,
        segment.coordinates[index - 1],
        segment.coordinates[index],
      );
      if (distance <= bestDistance) {
        bestDistance = distance;
        best = segment;
      }
    }
  }
  return best;
}

/** Whether any vertex of `segment` falls inside `bounds`. */
export function flowSegmentInBounds(segment: TrafficFlowSegment, bounds: ViewBounds): boolean {
  const [west, south, east, north] = bounds;
  return segment.coordinates.some(
    ([longitude, latitude]) =>
      longitude >= west && longitude <= east && latitude >= south && latitude <= north,
  );
}
