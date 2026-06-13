import type { Feature, Point } from "geojson";
import { getRuntimeEnvironment } from "./runtime-env";

/**
 * Geocoding client and pure helpers shared by the batch-geocode dialog and the
 * reverse-geocode plugin.
 *
 * This module lives in `@geolibre/core` rather than `@geolibre/processing`
 * because `@geolibre/plugins` depends on core but not on processing, and the
 * reverse-geocode plugin needs the same client. The pure helpers (URL builders,
 * result mappers, pacing) carry no React or MapLibre dependency so they can be
 * unit-tested without a browser or network.
 *
 * Provider: the public Nominatim endpoint by default, overridable via runtime
 * env so a self-hosted Nominatim or a Pelias instance can be used instead. The
 * 1 request/second throttle and the row cap are part of Nominatim's public
 * usage policy and are therefore applied ONLY to the default public host; a
 * self-hosted endpoint relaxes both.
 *
 * Browser fetch cannot set `User-Agent`/`Referer`, so the app is identified to
 * Nominatim via the optional `email` query parameter plus the automatically
 * sent `Referer`. See docs/user-guide/data-integrations.md#geocoding.
 */

export const DEFAULT_FORWARD_GEOCODE_ENDPOINT =
  "https://nominatim.openstreetmap.org/search";
export const DEFAULT_REVERSE_GEOCODE_ENDPOINT =
  "https://nominatim.openstreetmap.org/reverse";

/** Host whose public usage policy (1 req/sec, bulk limits) we must respect. */
export const NOMINATIM_PUBLIC_HOST = "nominatim.openstreetmap.org";

/** Minimum spacing between requests to the public Nominatim endpoint. */
export const NOMINATIM_MIN_INTERVAL_MS = 1100;

/** Max rows a single batch run will geocode against the public endpoint. */
export const PUBLIC_GEOCODE_ROW_CAP = 1000;

/** Property keys added to each geocoded feature. */
export const GEOCODE_LAT_KEY = "geocode_lat";
export const GEOCODE_LON_KEY = "geocode_lon";
export const GEOCODE_DISPLAY_NAME_KEY = "geocode_display_name";
export const GEOCODE_SCORE_KEY = "geocode_importance";

export interface GeocoderConfig {
  /** Forward (address -> point) endpoint. */
  forwardEndpoint: string;
  /** Reverse (point -> address) endpoint. */
  reverseEndpoint: string;
  /** Contact email sent as the `email` query param to identify the client. */
  email?: string;
}

/** A single Nominatim forward-geocoding result (jsonv2). */
export interface NominatimForwardResult {
  lat: string;
  lon: string;
  display_name?: string;
  importance?: number | string;
  [key: string]: unknown;
}

/** A Nominatim reverse-geocoding result (jsonv2). */
export interface NominatimReverseResult {
  lat?: string;
  lon?: string;
  display_name?: string;
  address?: Record<string, string>;
  /** Present (e.g. "Unable to geocode") when no match was found. */
  error?: string;
  [key: string]: unknown;
}

/** A row queued for geocoding, paired with its source CSV row. */
export interface GeocodeRequest {
  /** Zero-based index among the parsed data rows. */
  index: number;
  /** The composed address string sent to the geocoder. */
  address: string;
  /** The original CSV row, copied onto the output feature's properties. */
  row: Record<string, string>;
}

/** A reverse-geocode result resolved to a display string plus address parts. */
export interface ReverseGeocodeDisplay {
  displayName: string;
  parts: Record<string, string>;
}


/**
 * Resolve the geocoder configuration from runtime env, falling back to the
 * public Nominatim endpoints. `VITE_GEOCODER_ENDPOINT` overrides forward
 * geocoding, `VITE_GEOCODER_REVERSE_ENDPOINT` overrides reverse geocoding, and
 * `VITE_GEOCODER_EMAIL` supplies the contact email.
 */
export function getGeocoderConfig(): GeocoderConfig {
  const env = getRuntimeEnvironment();
  return {
    forwardEndpoint:
      env.VITE_GEOCODER_ENDPOINT?.trim() || DEFAULT_FORWARD_GEOCODE_ENDPOINT,
    reverseEndpoint:
      env.VITE_GEOCODER_REVERSE_ENDPOINT?.trim() ||
      DEFAULT_REVERSE_GEOCODE_ENDPOINT,
    email: env.VITE_GEOCODER_EMAIL?.trim() || undefined,
  };
}

/**
 * Whether requests to `endpoint` must be throttled/capped. True for the public
 * Nominatim host (its usage policy applies) and, defensively, for any endpoint
 * that does not parse as a URL. A self-hosted endpoint returns false.
 */
export function shouldThrottle(endpoint: string): boolean {
  try {
    return new URL(endpoint).hostname === NOMINATIM_PUBLIC_HOST;
  } catch {
    return true;
  }
}

/** The row cap to apply for `endpoint`: a finite cap for the public host, else Infinity. */
export function rowCap(endpoint: string): number {
  return shouldThrottle(endpoint)
    ? PUBLIC_GEOCODE_ROW_CAP
    : Number.POSITIVE_INFINITY;
}

/**
 * Milliseconds to wait before starting the next request so consecutive
 * requests are spaced at least `intervalMs` apart, measured from the previous
 * request's start time (not its completion) so a slow network does not double
 * the wait. Returns 0 for the first request or when enough time has elapsed.
 */
export function nextDelayMs(
  lastStartedAt: number | null,
  now: number,
  intervalMs: number,
): number {
  if (lastStartedAt === null) return 0;
  return Math.max(0, intervalMs - (now - lastStartedAt));
}

/** Build a Nominatim forward-geocoding URL (jsonv2, address details on). */
export function buildForwardGeocodeUrl(
  endpoint: string,
  query: string,
  options: { email?: string; limit?: number } = {},
): string {
  const url = new URL(endpoint);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("limit", String(options.limit ?? 1));
  if (options.email) url.searchParams.set("email", options.email);
  return url.toString();
}

/** Build a Nominatim reverse-geocoding URL (jsonv2, address details on). */
export function buildReverseGeocodeUrl(
  endpoint: string,
  lon: number,
  lat: number,
  options: { email?: string; zoom?: number } = {},
): string {
  const url = new URL(endpoint);
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lon));
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  if (options.zoom !== undefined) url.searchParams.set("zoom", String(options.zoom));
  if (options.email) url.searchParams.set("email", options.email);
  return url.toString();
}

function coerceScore(value: number | string | undefined): number | null {
  if (value === undefined || value === null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/** Append `base` to `existing`, suffixing `_2`, `_3`, ... if the key collides. */
function uniqueKey(base: string, existing: Record<string, unknown>): string {
  if (!(base in existing)) return base;
  let suffix = 2;
  while (`${base}_${suffix}` in existing) suffix += 1;
  return `${base}_${suffix}`;
}

/**
 * Convert a Nominatim forward result into a point Feature whose properties
 * carry the original CSV row plus `geocode_lat`/`geocode_lon`/
 * `geocode_display_name`/`geocode_importance`. The added keys are de-duplicated
 * against the original columns so an existing `geocode_lat` is not clobbered.
 * Geometry coordinates are `[lon, lat]`. Returns null when the result has no
 * finite coordinates.
 */
export function nominatimResultToFeature(
  result: NominatimForwardResult,
  originalRow: Record<string, string> = {},
): Feature<Point> | null {
  const lat = Number(result.lat);
  const lon = Number(result.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const properties: Record<string, unknown> = { ...originalRow };
  const added: Record<string, unknown> = {
    [GEOCODE_LAT_KEY]: lat,
    [GEOCODE_LON_KEY]: lon,
    [GEOCODE_DISPLAY_NAME_KEY]: result.display_name ?? "",
    [GEOCODE_SCORE_KEY]: coerceScore(result.importance),
  };
  for (const [key, value] of Object.entries(added)) {
    properties[uniqueKey(key, properties)] = value;
  }

  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [lon, lat] },
    properties,
  };
}

/**
 * Resolve a Nominatim reverse result to a display string and address parts, or
 * null when the point could not be reverse-geocoded.
 */
export function nominatimReverseResultToDisplay(
  result: NominatimReverseResult | null,
): ReverseGeocodeDisplay | null {
  if (!result || result.error) return null;
  const displayName = result.display_name?.trim();
  if (!displayName) return null;
  return { displayName, parts: result.address ?? {} };
}

/**
 * Build geocoding requests from parsed CSV rows. The address for each row is
 * the selected columns trimmed and joined with ", " (so multi-part addresses
 * like street/city/country can be combined). Rows whose composed address is
 * empty are skipped.
 */
export function csvRowsToGeocodeRequests(
  rows: Record<string, string>[],
  addressColumns: string[],
): GeocodeRequest[] {
  const requests: GeocodeRequest[] = [];
  rows.forEach((row, index) => {
    const address = addressColumns
      .map((column) => (row[column] ?? "").trim())
      .filter(Boolean)
      .join(", ")
      .trim();
    if (!address) return;
    requests.push({ index, address, row });
  });
  return requests;
}

/** Forward-geocode a single query, returning the raw Nominatim results. */
export async function geocodeForward(
  query: string,
  options: { signal?: AbortSignal; config?: GeocoderConfig; limit?: number } = {},
): Promise<NominatimForwardResult[]> {
  const config = options.config ?? getGeocoderConfig();
  const url = buildForwardGeocodeUrl(config.forwardEndpoint, query, {
    email: config.email,
    limit: options.limit,
  });
  const response = await fetch(url, {
    signal: options.signal,
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Geocoder returned HTTP ${response.status}`);
  }
  const data: unknown = await response.json();
  return Array.isArray(data) ? (data as NominatimForwardResult[]) : [];
}

/** Reverse-geocode a single point ([lon, lat]) to a Nominatim result. */
export async function geocodeReverse(
  lon: number,
  lat: number,
  options: { signal?: AbortSignal; config?: GeocoderConfig; zoom?: number } = {},
): Promise<NominatimReverseResult | null> {
  const config = options.config ?? getGeocoderConfig();
  const url = buildReverseGeocodeUrl(config.reverseEndpoint, lon, lat, {
    email: config.email,
    zoom: options.zoom,
  });
  const response = await fetch(url, {
    signal: options.signal,
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Geocoder returned HTTP ${response.status}`);
  }
  const data: unknown = await response.json();
  return data && typeof data === "object"
    ? (data as NominatimReverseResult)
    : null;
}
