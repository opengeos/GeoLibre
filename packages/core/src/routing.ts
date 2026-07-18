import type { Feature, FeatureCollection, LineString, MultiPolygon, Polygon } from "geojson";
import { getRuntimeEnvironment } from "./runtime-env";

/**
 * Routing / network-analysis client and pure helpers backing the Processing →
 * Network tools (isochrones / service areas, OD cost matrices).
 *
 * Provider: Valhalla. OSRM (the Directions backend) has no isochrone endpoint,
 * so isochrones require Valhalla, which also serves the OD matrix
 * (`/sources_to_targets`) — one consistent API. The default is the shared
 * public FOSSGIS server, overridable via runtime env (`VITE_ROUTING_ENDPOINT`)
 * so a self-hosted Valhalla can be used instead. The pure request builders and
 * response parsers carry no React/MapLibre dependency so they can be
 * unit-tested without a browser or network.
 */

/** Default public Valhalla server (FOSSGIS). CORS-enabled; usage limits apply. */
export const DEFAULT_ROUTING_ENDPOINT = "https://valhalla1.openstreetmap.de";

/** Valhalla costing models exposed in the UI. */
export type RoutingMode = "auto" | "pedestrian" | "bicycle";

/** Isochrone contour metric: travel time (minutes) or distance (km). */
export type RoutingMetric = "time" | "distance";

export interface RoutingConfig {
  /** Base URL of the Valhalla server (no trailing slash). */
  endpoint: string;
}

/** A point with a stable id, used as an isochrone origin or matrix source/target. */
export interface RoutingPoint {
  id: string | number;
  lon: number;
  lat: number;
}

/**
 * Resolves the routing configuration from runtime env, defaulting to the public
 * Valhalla server. `VITE_ROUTING_ENDPOINT` overrides the endpoint.
 *
 * @returns The resolved routing configuration.
 */
export function getRoutingConfig(): RoutingConfig {
  const env = getRuntimeEnvironment();
  return {
    endpoint: stripTrailingSlash(env.VITE_ROUTING_ENDPOINT?.trim()) || DEFAULT_ROUTING_ENDPOINT,
  };
}

function stripTrailingSlash(value: string | undefined): string | undefined {
  return value ? value.replace(/\/+$/, "") : value;
}

/**
 * Parses a comma/space-separated contour string ("5, 10, 15") into a sorted,
 * de-duplicated list of positive numbers.
 *
 * @param value - The raw contour string.
 * @returns Ascending unique positive contour values.
 */
export function parseContours(value: string): number[] {
  const seen = new Set<number>();
  for (const token of value.split(/[\s,]+/)) {
    if (!token) continue;
    const n = Number(token);
    if (Number.isFinite(n) && n > 0) seen.add(n);
  }
  return [...seen].sort((a, b) => a - b);
}

export interface IsochroneRequestBody {
  locations: { lon: number; lat: number }[];
  costing: RoutingMode;
  contours: ({ time: number } | { distance: number })[];
  polygons: true;
}

/**
 * Builds a Valhalla `/isochrone` request body for a single origin.
 *
 * @param point - The origin `[lon, lat]`.
 * @param opts - Travel mode, metric, and contour values (minutes for time, km for distance).
 * @returns The request body.
 */
export function buildIsochroneRequest(
  point: [number, number],
  opts: { mode: RoutingMode; metric: RoutingMetric; contours: number[] },
): IsochroneRequestBody {
  const [lon, lat] = point;
  return {
    locations: [{ lon, lat }],
    costing: opts.mode,
    contours: opts.contours.map((value) =>
      opts.metric === "time" ? { time: value } : { distance: value },
    ),
    polygons: true,
  };
}

type IsochroneFeatureProps = {
  source_id: string | number;
  mode: RoutingMode;
  metric: RoutingMetric;
  contour: number | null;
};

/**
 * Converts a Valhalla isochrone GeoJSON response into polygon features tagged
 * with their origin, mode, metric, and contour value. Non-polygon features
 * (Valhalla can also emit contour LineStrings) are dropped.
 *
 * @param response - The Valhalla `/isochrone` GeoJSON FeatureCollection.
 * @param ctx - Origin id, travel mode, and metric to tag onto each polygon.
 * @returns The tagged polygon features.
 */
export function isochroneResponseToFeatures(
  response: unknown,
  ctx: { sourceId: string | number; mode: RoutingMode; metric: RoutingMetric },
): Feature<Polygon | MultiPolygon, IsochroneFeatureProps>[] {
  const features = (response as FeatureCollection | null)?.features;
  if (!Array.isArray(features)) return [];
  const out: Feature<Polygon | MultiPolygon, IsochroneFeatureProps>[] = [];
  for (const feature of features) {
    const type = feature?.geometry?.type;
    if (type !== "Polygon" && type !== "MultiPolygon") continue;
    const contour = (feature.properties as { contour?: unknown } | null)?.contour;
    out.push({
      type: "Feature",
      geometry: feature.geometry as Polygon | MultiPolygon,
      properties: {
        source_id: ctx.sourceId,
        mode: ctx.mode,
        metric: ctx.metric,
        contour: typeof contour === "number" ? contour : null,
      },
    });
  }
  return out;
}

export interface MatrixRequestBody {
  sources: { lon: number; lat: number }[];
  targets: { lon: number; lat: number }[];
  costing: RoutingMode;
}

/**
 * Builds a Valhalla `/sources_to_targets` request body.
 *
 * @param origins - The source points.
 * @param targets - The target points.
 * @param mode - The travel mode.
 * @returns The request body.
 */
export function buildMatrixRequest(
  origins: RoutingPoint[],
  targets: RoutingPoint[],
  mode: RoutingMode,
): MatrixRequestBody {
  return {
    sources: origins.map((p) => ({ lon: p.lon, lat: p.lat })),
    targets: targets.map((p) => ({ lon: p.lon, lat: p.lat })),
    costing: mode,
  };
}

type MatrixCell = {
  from_index: number;
  to_index: number;
  /** Travel time in seconds, or null when unreachable. */
  time: number | null;
  /** Travel distance in km, or null when unreachable. */
  distance: number | null;
};

type MatrixFeatureProps = {
  origin_id: string | number;
  dest_id: string | number;
  time_s: number;
  distance_km: number;
  mode: RoutingMode;
};

/**
 * Converts a Valhalla `/sources_to_targets` response into one LineString per
 * reachable origin→destination pair, carrying the travel time and distance.
 * Unreachable pairs (null time) are dropped.
 *
 * @param response - The Valhalla matrix response.
 * @param origins - The origin points (indexed by `from_index`).
 * @param targets - The target points (indexed by `to_index`).
 * @param ctx - The travel mode to tag onto each pair.
 * @returns The OD-pair LineString features.
 */
export function matrixResponseToFeatures(
  response: unknown,
  origins: RoutingPoint[],
  targets: RoutingPoint[],
  ctx: { mode: RoutingMode },
): Feature<LineString, MatrixFeatureProps>[] {
  const rows = (response as { sources_to_targets?: MatrixCell[][] } | null)?.sources_to_targets;
  if (!Array.isArray(rows)) return [];
  const out: Feature<LineString, MatrixFeatureProps>[] = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    for (const cell of row) {
      if (cell?.time == null || cell.distance == null) continue;
      const origin = origins[cell.from_index];
      const target = targets[cell.to_index];
      if (!origin || !target) continue;
      out.push({
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            [origin.lon, origin.lat],
            [target.lon, target.lat],
          ],
        },
        properties: {
          origin_id: origin.id,
          dest_id: target.id,
          time_s: cell.time,
          distance_km: cell.distance,
          mode: ctx.mode,
        },
      });
    }
  }
  return out;
}

export interface RouteRequestBody {
  locations: { lon: number; lat: number }[];
  costing: RoutingMode;
  directions_options: { units: "kilometers" };
}

/**
 * Builds a Valhalla `/route` request body that visits the points in the given
 * order. Valhalla snaps each location to the nearest routable edge, so points
 * that are off the road network (cell sites, sensors) still route cleanly.
 *
 * @param points - The waypoints in visiting order (at least two).
 * @param mode - The travel mode (costing model).
 * @returns The request body.
 */
export function buildRouteRequest(points: RoutingPoint[], mode: RoutingMode): RouteRequestBody {
  return {
    locations: points.map((p) => ({ lon: p.lon, lat: p.lat })),
    costing: mode,
    directions_options: { units: "kilometers" },
  };
}

/**
 * Decodes an encoded-polyline string into `[lon, lat]` coordinate pairs.
 * Valhalla encodes route geometry with 6 digits of precision (factor 1e6),
 * unlike Google's 5-digit polylines, so `precision` defaults to 6.
 *
 * @param encoded - The encoded polyline string.
 * @param precision - Number of decimal digits the encoder used (6 for Valhalla).
 * @returns The decoded `[lon, lat]` coordinates in order.
 */
export function decodePolyline(encoded: string, precision = 6): [number, number][] {
  const factor = 10 ** precision;
  const len = encoded.length;
  const coordinates: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  while (index < len) {
    let shift = 0;
    let result = 0;
    let byte: number;
    do {
      // Truncated input: stop cleanly rather than reading NaN past the end and
      // pushing a garbage coordinate.
      if (index >= len) return coordinates;
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    // Unsigned shift (>>>) so the zigzag decode is correct even if the
    // accumulator's bit 31 is set, rather than sign-extending.
    lat += result & 1 ? ~(result >>> 1) : result >>> 1;

    shift = 0;
    result = 0;
    do {
      if (index >= len) return coordinates;
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lon += result & 1 ? ~(result >>> 1) : result >>> 1;

    coordinates.push([lon / factor, lat / factor]);
  }
  return coordinates;
}

type RouteLeg = {
  shape?: string;
  summary?: { time?: number; length?: number };
};

type RouteFeatureProps = {
  leg_index: number;
  from_id: string | number;
  to_id: string | number;
  time_s: number;
  distance_km: number;
  mode: RoutingMode;
};

/**
 * Converts a Valhalla `/route` response into one LineString per leg (the road
 * path between two consecutive waypoints), carrying the leg's travel time and
 * distance. Legs without a decodable shape are dropped.
 *
 * @param response - The Valhalla `/route` response.
 * @param points - The waypoints passed to the request, indexing the legs.
 * @param ctx - The travel mode to tag onto each leg.
 * @returns One LineString feature per routed leg.
 */
export function routeResponseToFeatures(
  response: unknown,
  points: RoutingPoint[],
  ctx: { mode: RoutingMode },
): Feature<LineString, RouteFeatureProps>[] {
  const legs = (response as { trip?: { legs?: RouteLeg[] } } | null)?.trip?.legs;
  if (!Array.isArray(legs)) return [];
  const out: Feature<LineString, RouteFeatureProps>[] = [];
  legs.forEach((leg, index) => {
    if (typeof leg?.shape !== "string") return;
    const coordinates = decodePolyline(leg.shape);
    if (coordinates.length < 2) return;
    const from = points[index];
    const to = points[index + 1];
    out.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates },
      properties: {
        leg_index: index,
        from_id: from?.id ?? index,
        to_id: to?.id ?? index + 1,
        time_s: typeof leg.summary?.time === "number" ? leg.summary.time : 0,
        distance_km: typeof leg.summary?.length === "number" ? leg.summary.length : 0,
        mode: ctx.mode,
      },
    });
  });
  return out;
}

/**
 * Comparator for ordering route waypoints by a chosen attribute value. Numeric
 * strings and timestamps (anything `Date.parse` understands, e.g. ISO 8601)
 * sort chronologically/numerically; values that parse this way sort before
 * free-form text, which falls back to a locale string comparison. Empty/missing
 * values sort last so unlabeled points trail the ordered ones.
 *
 * Numeric parsing is tried before date parsing, so a single column is expected
 * to use one convention: a column mixing plain integers with ISO timestamps
 * would compare them on the same numeric axis (epoch millis dwarf small
 * integers), which is not a meaningful ordering. Real sequence/time columns use
 * one convention, so this is acceptable in practice.
 *
 * @param a - The first value.
 * @param b - The second value.
 * @returns A negative, zero, or positive number for ascending order.
 */
export function compareSequenceValues(a: unknown, b: unknown): number {
  const aMissing = isMissingValue(a);
  const bMissing = isMissingValue(b);
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;
  const an = toComparableNumber(a);
  const bn = toComparableNumber(b);
  if (an !== null && bn !== null) return an - bn;
  if (an !== null) return -1;
  if (bn !== null) return 1;
  return String(a).localeCompare(String(b));
}

function isMissingValue(value: unknown): boolean {
  return value == null || (typeof value === "string" && value.trim() === "");
}

function toComparableNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    // Only treat plain decimal/scientific notation as numeric, so hex ("0x1A")
    // and other Number()-coercible forms sort as text rather than by their
    // surprising numeric value.
    if (/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(trimmed)) {
      return Number(trimmed);
    }
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * Error thrown when a Valhalla request returns a non-2xx response. Carries the
 * HTTP status so callers can branch on it (e.g. a 4xx rejection) without
 * pattern-matching the message string.
 */
export class RoutingRequestError extends Error {
  readonly status: number;

  constructor(status: number, statusText: string) {
    super(`Routing request failed (${status} ${statusText})`);
    this.name = "RoutingRequestError";
    this.status = status;
  }
}

async function postJson(url: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    throw new RoutingRequestError(response.status, response.statusText);
  }
  return response.json();
}

/**
 * Requests an isochrone from the Valhalla server.
 *
 * @param endpoint - The Valhalla base URL.
 * @param body - The request body from {@link buildIsochroneRequest}.
 * @param signal - Optional abort signal.
 * @returns The Valhalla GeoJSON response.
 */
export function requestIsochrone(
  endpoint: string,
  body: IsochroneRequestBody,
  signal?: AbortSignal,
): Promise<unknown> {
  return postJson(`${stripTrailingSlash(endpoint)}/isochrone`, body, signal);
}

/**
 * Requests an OD cost matrix from the Valhalla server.
 *
 * @param endpoint - The Valhalla base URL.
 * @param body - The request body from {@link buildMatrixRequest}.
 * @param signal - Optional abort signal.
 * @returns The Valhalla matrix response.
 */
export function requestMatrix(
  endpoint: string,
  body: MatrixRequestBody,
  signal?: AbortSignal,
): Promise<unknown> {
  return postJson(`${stripTrailingSlash(endpoint)}/sources_to_targets`, body, signal);
}

/**
 * Requests a route through ordered waypoints from the Valhalla server.
 *
 * @param endpoint - The Valhalla base URL.
 * @param body - The request body from {@link buildRouteRequest}.
 * @param signal - Optional abort signal.
 * @returns The Valhalla `/route` response.
 */
export function requestRoute(
  endpoint: string,
  body: RouteRequestBody,
  signal?: AbortSignal,
): Promise<unknown> {
  return postJson(`${stripTrailingSlash(endpoint)}/route`, body, signal);
}
