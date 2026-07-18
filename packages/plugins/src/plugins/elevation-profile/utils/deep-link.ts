/**
 * Deep-linking support for the GeoLibre integration: an elevation profile can be
 * shared by adding the line's coordinates to the GeoLibre URL, e.g.
 * `https://geolibre.app/?elevation-line=13.41,52.52;8.23,46.85`.
 *
 * GeoLibre auto-activates a plugin when a URL carries a parameter the plugin
 * declared in `urlParameterNames`, then dispatches the parsed query parameters
 * to the plugin's `handleUrlParameters(app, params)` hook. These helpers operate
 * purely on strings and `URLSearchParams`, with no DOM or MapLibre imports, so
 * the logic can be unit-tested in isolation.
 */

import type { LngLat } from "../elevation/geometry";

/** Query-parameter name this plugin owns. */
export const ELEVATION_LINE_PARAM = "elevation-line";

/**
 * Extract the raw elevation-line value from parsed query parameters. Returns the
 * trimmed value, or `null` when the parameter is absent or blank.
 */
export function getElevationLineValue(params: URLSearchParams): string | null {
  const trimmed = params.get(ELEVATION_LINE_PARAM)?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Encode a polyline as a compact `lng,lat;lng,lat;...` string for a share URL.
 *
 * This is the producer counterpart to {@link parseLine} and the canonical
 * definition of the `?elevation-line=` format. The built-in control only
 * *consumes* the parameter today (there is no in-app "copy share link" button
 * yet), so this encoder is currently exercised only by tests and external
 * callers (e.g. the Python API) that construct share links; it is kept as the
 * documented inverse and the basis for a future copy-link affordance.
 *
 * @param coords - Ordered polyline vertices as `[lng, lat]`
 * @returns The encoded string (coordinates rounded to 6 decimal places)
 */
export function encodeLine(coords: LngLat[]): string {
  return coords.map(([lng, lat]) => `${round(lng)},${round(lat)}`).join(";");
}

/**
 * Parse a `lng,lat;lng,lat;...` string back into polyline vertices.
 *
 * Malformed or out-of-range pairs are skipped. Returns `null` when fewer than two
 * valid vertices remain, since a profile needs at least a start and an end.
 *
 * @param value - The encoded line string
 * @returns The parsed coordinates, or `null` when there is no usable line
 */
export function parseLine(value: string): LngLat[] | null {
  const coords: LngLat[] = [];
  for (const pair of value.split(";")) {
    const [lngText, latText] = pair.split(",");
    const lng = Number(lngText);
    const lat = Number(latText);
    if (
      Number.isFinite(lng) &&
      Number.isFinite(lat) &&
      lng >= -180 &&
      lng <= 180 &&
      lat >= -90 &&
      lat <= 90
    ) {
      coords.push([lng, lat]);
    }
  }
  return coords.length >= 2 ? coords : null;
}

/** Minimal structural type for whatever consumes a parsed deep-link line. */
export interface DeepLinkConsumer {
  loadLine(coords: LngLat[]): Promise<void> | void;
}

/**
 * If the query parameters carry a valid {@link ELEVATION_LINE_PARAM}, parse it
 * and forward the coordinates to the consumer. No-op when the parameter is
 * absent, blank, or does not describe a usable line. Returns the consumer's
 * promise (if any) so callers can await completion.
 */
export async function maybeHandleDeepLink(
  consumer: DeepLinkConsumer,
  params: URLSearchParams,
): Promise<void> {
  const value = getElevationLineValue(params);
  if (!value) return;
  const coords = parseLine(value);
  if (coords) await consumer.loadLine(coords);
}

const round = (value: number): number => Math.round(value * 1e6) / 1e6;
