import type {
  Feature,
  FeatureCollection,
  LineString,
  MultiPolygon,
  Polygon,
} from "geojson";
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
    endpoint:
      stripTrailingSlash(env.VITE_ROUTING_ENDPOINT?.trim()) ||
      DEFAULT_ROUTING_ENDPOINT,
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
    const contour = (feature.properties as { contour?: unknown } | null)
      ?.contour;
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
  const rows = (response as { sources_to_targets?: MatrixCell[][] } | null)
    ?.sources_to_targets;
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

async function postJson(
  url: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    throw new Error(
      `Routing request failed (${response.status} ${response.statusText})`,
    );
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
  return postJson(
    `${stripTrailingSlash(endpoint)}/sources_to_targets`,
    body,
    signal,
  );
}
