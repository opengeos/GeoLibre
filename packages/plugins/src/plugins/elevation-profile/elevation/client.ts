/**
 * Client for the Open-Meteo elevation API (https://open-meteo.com/en/docs/elevation-api).
 *
 * Open-Meteo is free and key-less. A single request accepts up to
 * {@link MAX_POINTS_PER_REQUEST} coordinates and returns one elevation per
 * coordinate. Network access is isolated here behind an injectable `fetch` so
 * the rest of the plugin stays easy to test.
 */

import type { LngLat } from "./geometry";

/** Open-Meteo accepts at most 100 coordinates per elevation request. */
export const MAX_POINTS_PER_REQUEST = 100;

const ENDPOINT = "https://api.open-meteo.com/v1/elevation";

/** Error thrown when an elevation request cannot be completed or parsed. */
export class ElevationFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ElevationFetchError";
  }
}

/** A `fetch`-compatible function, so tests can inject a stub. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Abort an elevation request that has not responded within this window. */
export const ELEVATION_REQUEST_TIMEOUT_MS = 15000;

interface ElevationResponse {
  elevation?: number[];
}

/**
 * Fetch elevations (in meters) for an ordered list of coordinates.
 *
 * @param points - Coordinates as `[lng, lat]`, at most {@link MAX_POINTS_PER_REQUEST}
 * @param fetchImpl - Optional `fetch` implementation; defaults to the global `fetch`
 * @returns The elevation in meters for each input coordinate, in the same order
 * @throws {ElevationFetchError} On too many points, a network error, a non-2xx
 *   response, a malformed body, or a length mismatch
 */
export async function fetchElevations(points: LngLat[], fetchImpl?: FetchLike): Promise<number[]> {
  if (points.length === 0) return [];
  if (points.length > MAX_POINTS_PER_REQUEST) {
    throw new ElevationFetchError(
      `Too many points: ${points.length} (max ${MAX_POINTS_PER_REQUEST}).`,
    );
  }

  const doFetch: FetchLike = fetchImpl ?? ((url, init) => fetch(url, init));
  const latitudes = points.map((p) => p[1].toFixed(6)).join(",");
  const longitudes = points.map((p) => p[0].toFixed(6)).join(",");
  const url = `${ENDPOINT}?latitude=${latitudes}&longitude=${longitudes}`;

  // A default fetch never times out, so a hung request would leave the control's
  // busy state stuck with no recovery. Abort after ELEVATION_REQUEST_TIMEOUT_MS
  // and surface it as a normal fetch error the caller already handles.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ELEVATION_REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await doFetch(url, { signal: controller.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ElevationFetchError("Elevation request timed out.");
    }
    const detail = error instanceof Error ? error.message : "unknown error";
    throw new ElevationFetchError(`Could not reach the elevation service: ${detail}`);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    throw new ElevationFetchError(`Elevation request failed (HTTP ${response.status}).`);
  }

  let data: ElevationResponse;
  try {
    data = (await response.json()) as ElevationResponse;
  } catch {
    throw new ElevationFetchError("Could not parse the elevation response.");
  }

  if (!data || !Array.isArray(data.elevation)) {
    throw new ElevationFetchError("Malformed elevation response.");
  }
  if (data.elevation.length !== points.length) {
    throw new ElevationFetchError(
      `Expected ${points.length} elevations but received ${data.elevation.length}.`,
    );
  }

  return data.elevation;
}
