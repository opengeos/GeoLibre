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
 * Providers: geocoding is dispatched through a small {@link GeocodingProvider}
 * registry so alternatives to Nominatim (ArcGIS World Geocoder, CartoCiudad, Mapbox,
 * Pelias, Google) can be selected per project. Each provider builds its own request
 * URLs and normalizes its response into a {@link GeocodeMatch} (forward) or a
 * {@link ReverseGeocodeDisplay} (reverse), so the dialog and plugin stay
 * provider-agnostic. Nominatim is the default.
 *
 * The 1 request/second throttle and the row cap are part of Nominatim's public
 * usage policy and are therefore applied ONLY to the default public host; a
 * self-hosted endpoint relaxes both, and keyed providers (Mapbox/ArcGIS/Google)
 * are paced by their own quotas, not by us.
 *
 * Browser fetch cannot set `User-Agent`/`Referer`, so the app is identified to
 * Nominatim via the optional `email` query parameter plus the automatically
 * sent `Referer`. The desktop build overrides this with a native (Tauri) fetch
 * via {@link setGeocodingFetch} — see the note there. See
 * docs/user-guide/data-integrations.md#geocoding.
 */

export const DEFAULT_FORWARD_GEOCODE_ENDPOINT = "https://nominatim.openstreetmap.org/search";
export const DEFAULT_REVERSE_GEOCODE_ENDPOINT = "https://nominatim.openstreetmap.org/reverse";

/** Host whose public usage policy (1 req/sec, bulk limits) we must respect. */
export const NOMINATIM_PUBLIC_HOST = "nominatim.openstreetmap.org";

/** Minimum spacing between requests to the public Nominatim endpoint. */
export const NOMINATIM_MIN_INTERVAL_MS = 1100;

/** Host of the free, unkeyed public CartoCiudad geocoder (IGN/CNIG). */
export const CARTOCIUDAD_PUBLIC_HOST = "cartociudad.es";

/**
 * Courtesy spacing (~5 req/sec) between requests to the public CartoCiudad
 * endpoint. Unlike {@link NOMINATIM_MIN_INTERVAL_MS} this is not a published
 * policy — IGN documents no rate limit — it is our own conservative default so
 * a large batch does not burst at a free public government service. See
 * {@link geocoderMinIntervalMs}.
 */
export const CARTOCIUDAD_MIN_INTERVAL_MS = 200;

/** Max rows a single batch run will geocode against the public endpoint. */
export const PUBLIC_GEOCODE_ROW_CAP = 1000;

/** Property keys added to each geocoded feature. */
export const GEOCODE_LAT_KEY = "geocode_lat";
export const GEOCODE_LON_KEY = "geocode_lon";
export const GEOCODE_DISPLAY_NAME_KEY = "geocode_display_name";
export const GEOCODE_SCORE_KEY = "geocode_importance";
/** Provider id that produced (or failed to produce) a match, when stamped. */
export const GEOCODE_PROVIDER_KEY = "geocode_provider";
/** Whether a row matched, when stamped. See {@link GeocodeStatus}. */
export const GEOCODE_STATUS_KEY = "geocode_status";

/** Identifier of a selectable geocoding backend. */
export type GeocodingProviderId =
  | "nominatim"
  | "pelias"
  | "arcgis"
  | "mapbox"
  | "google"
  | "cartociudad";

/** The provider used when none is configured. */
export const DEFAULT_GEOCODING_PROVIDER_ID: GeocodingProviderId = "nominatim";

export interface GeocoderConfig {
  /** Which backend to dispatch through. */
  providerId: GeocodingProviderId;
  /** Forward (address -> point) endpoint. */
  forwardEndpoint: string;
  /** Reverse (point -> address) endpoint. */
  reverseEndpoint: string;
  /** Contact email sent as the `email` query param to identify the client. */
  email?: string;
  /** API key / access token for providers that require one. */
  apiKey?: string;
}

/** Per-request options passed to a provider's forward URL builder. */
export interface ForwardRequestOptions {
  email?: string;
  limit?: number;
}

/** Per-request options passed to a provider's reverse URL builder. */
export interface ReverseRequestOptions {
  email?: string;
  zoom?: number;
}

/**
 * A normalized forward-geocoding match. Each provider maps its own response
 * shape onto this so {@link geocodeMatchToFeature} can build a point feature
 * without knowing which backend produced it. `score` is the provider's match
 * confidence/importance on its own scale (Nominatim importance 0..1, ArcGIS
 * 0..100, ...), or null when the provider reports none.
 */
export interface GeocodeMatch {
  lat: number;
  lon: number;
  displayName: string;
  score: number | null;
}

/**
 * A geocoding backend. Builds provider-specific request URLs and normalizes the
 * raw response into the shared {@link GeocodeMatch} / {@link ReverseGeocodeDisplay}
 * shapes. Implementations are pure (no fetch) so they unit-test without a
 * network; {@link geocodeForward}/{@link geocodeReverse} own the actual fetch.
 */
export interface GeocodingProvider {
  id: GeocodingProviderId;
  /** Human-readable name shown in the provider picker. */
  label: string;
  /** Whether forward (address -> point) geocoding is supported. */
  forward: boolean;
  /** Whether reverse (point -> address) geocoding is supported. */
  reverse: boolean;
  /**
   * Whether the provider's default configuration cannot work without an API
   * key / access token. Drives the "missing key" warning and disables the run.
   */
  requiresApiKey: boolean;
  /**
   * Whether the provider can use an API key at all, so the Settings UI shows a
   * key field. True for every keyed provider plus Pelias (the hosted
   * geocode.earth endpoint needs a key, a self-hosted instance does not).
   */
  acceptsApiKey: boolean;
  /**
   * Whether the provider's API blocks browser cross-origin requests, so it
   * needs a same-origin proxy to work in the webview. The UI surfaces a hint
   * when true. Only set for Google's Geocoding API today.
   */
  browserCorsRestricted?: boolean;
  /** Default forward endpoint used when the project does not override it. */
  defaultForwardEndpoint: string;
  /** Default reverse endpoint used when the project does not override it. */
  defaultReverseEndpoint: string;
  buildForwardUrl(config: GeocoderConfig, query: string, options: ForwardRequestOptions): string;
  parseForward(data: unknown): GeocodeMatch[];
  buildReverseUrl(
    config: GeocoderConfig,
    lon: number,
    lat: number,
    options: ReverseRequestOptions,
  ): string;
  parseReverse(data: unknown): ReverseGeocodeDisplay | null;
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

/** Whether a row matched during batch geocoding, stamped as {@link GEOCODE_STATUS_KEY}. */
export type GeocodeStatus = "matched" | "unmatched";

function coerceScore(value: number | string | undefined | null): number | null {
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
 * Coerce an address-parts record to `Record<string, string>`. Provider address
 * objects can carry numbers (ArcGIS `Score`/`X`/`Y`, Pelias coordinates), so
 * values are stringified rather than unsafely cast; null/undefined are dropped.
 */
function stringifyParts(obj: Record<string, unknown>): Record<string, string> {
  const parts: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;
    parts[key] = typeof value === "string" ? value : String(value);
  }
  return parts;
}

/** Read a string property off an unknown object, or undefined. */
function readString(obj: unknown, key: string): string | undefined {
  if (obj && typeof obj === "object" && key in obj) {
    const value = (obj as Record<string, unknown>)[key];
    if (typeof value === "string") return value;
    if (typeof value === "number") return String(value);
  }
  return undefined;
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

/** Map one Nominatim forward result onto a normalized match, or null. */
function nominatimForwardResultToMatch(result: NominatimForwardResult): GeocodeMatch | null {
  const lat = Number(result.lat);
  const lon = Number(result.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    lat,
    lon,
    displayName: result.display_name ?? "",
    score: coerceScore(result.importance),
  };
}

/**
 * Convert a normalized {@link GeocodeMatch} into a point Feature whose
 * properties carry the original CSV row plus `geocode_lat`/`geocode_lon`/
 * `geocode_display_name`/`geocode_importance`. The added keys are de-duplicated
 * against the original columns so an existing `geocode_lat` is not clobbered.
 * Geometry coordinates are `[lon, lat]`. Returns null when the match has no
 * finite coordinates.
 *
 * `extra.providerId`, when passed, also stamps `geocode_provider` and
 * `geocode_status: "matched"` (dropped when omitted, so the existing
 * `GeocodeDialog` call site keeps its current output unchanged).
 */
export function geocodeMatchToFeature(
  match: GeocodeMatch,
  originalRow: Record<string, string> = {},
  extra?: { providerId?: GeocodingProviderId },
): Feature<Point> | null {
  if (!Number.isFinite(match.lat) || !Number.isFinite(match.lon)) return null;

  const properties: Record<string, unknown> = { ...originalRow };
  const added: Record<string, unknown> = {
    [GEOCODE_LAT_KEY]: match.lat,
    [GEOCODE_LON_KEY]: match.lon,
    [GEOCODE_DISPLAY_NAME_KEY]: match.displayName ?? "",
    [GEOCODE_SCORE_KEY]: match.score,
  };
  if (extra?.providerId) {
    added[GEOCODE_PROVIDER_KEY] = extra.providerId;
    added[GEOCODE_STATUS_KEY] = "matched" satisfies GeocodeStatus;
  }
  for (const [key, value] of Object.entries(added)) {
    properties[uniqueKey(key, properties)] = value;
  }

  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [match.lon, match.lat] },
    properties,
  };
}

/**
 * Build a null-geometry Feature for a CSV row that could not be geocoded, so
 * it is kept (not silently dropped) alongside the matched point features.
 * Mirrors the null-geometry shape {@link parseDelimitedTextLayer} already uses
 * for a non-spatial attribute table. Stamps `geocode_status: "unmatched"` and
 * `geocode_provider`, de-duplicated against the original columns the same way
 * {@link geocodeMatchToFeature} does.
 */
export function unmatchedGeocodeFeature(
  originalRow: Record<string, string>,
  providerId: GeocodingProviderId,
): Feature<null> {
  const properties: Record<string, unknown> = { ...originalRow };
  const added: Record<string, unknown> = {
    [GEOCODE_STATUS_KEY]: "unmatched" satisfies GeocodeStatus,
    [GEOCODE_PROVIDER_KEY]: providerId,
  };
  for (const [key, value] of Object.entries(added)) {
    properties[uniqueKey(key, properties)] = value;
  }

  return { type: "Feature", geometry: null, properties };
}

/**
 * Convert a Nominatim forward result into a point Feature. Retained as a thin
 * wrapper over {@link geocodeMatchToFeature} for callers and tests that work
 * directly with Nominatim results. Returns null when the result has no finite
 * coordinates.
 */
export function nominatimResultToFeature(
  result: NominatimForwardResult,
  originalRow: Record<string, string> = {},
): Feature<Point> | null {
  const match = nominatimForwardResultToMatch(result);
  return match ? geocodeMatchToFeature(match, originalRow) : null;
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

// --- Provider implementations ----------------------------------------------

const nominatimProvider: GeocodingProvider = {
  id: "nominatim",
  label: "Nominatim (OpenStreetMap)",
  forward: true,
  reverse: true,
  requiresApiKey: false,
  acceptsApiKey: false,
  defaultForwardEndpoint: DEFAULT_FORWARD_GEOCODE_ENDPOINT,
  defaultReverseEndpoint: DEFAULT_REVERSE_GEOCODE_ENDPOINT,
  buildForwardUrl: (config, query, options) =>
    buildForwardGeocodeUrl(config.forwardEndpoint, query, {
      email: options.email,
      limit: options.limit,
    }),
  parseForward: (data) =>
    Array.isArray(data)
      ? (data as NominatimForwardResult[])
          .map(nominatimForwardResultToMatch)
          .filter((m): m is GeocodeMatch => m !== null)
      : [],
  buildReverseUrl: (config, lon, lat, options) =>
    buildReverseGeocodeUrl(config.reverseEndpoint, lon, lat, {
      email: options.email,
      zoom: options.zoom,
    }),
  parseReverse: (data) =>
    nominatimReverseResultToDisplay(
      data && typeof data === "object" ? (data as NominatimReverseResult) : null,
    ),
};

/** Read a GeoJSON FeatureCollection's features array, or []. */
function geojsonFeatures(data: unknown): Record<string, unknown>[] {
  if (
    data &&
    typeof data === "object" &&
    Array.isArray((data as { features?: unknown }).features)
  ) {
    return (data as { features: unknown[] }).features.filter(
      (f): f is Record<string, unknown> => !!f && typeof f === "object",
    );
  }
  return [];
}

/** Pull `[lon, lat]` from a GeoJSON Point geometry, or null. */
function pointCoords(feature: Record<string, unknown>): [number, number] | null {
  const geometry = feature.geometry as { coordinates?: unknown } | undefined;
  const coords = geometry?.coordinates;
  if (Array.isArray(coords) && coords.length >= 2) {
    const lon = Number(coords[0]);
    const lat = Number(coords[1]);
    if (Number.isFinite(lon) && Number.isFinite(lat)) return [lon, lat];
  }
  return null;
}

const peliasProvider: GeocodingProvider = {
  id: "pelias",
  label: "Pelias",
  forward: true,
  reverse: true,
  // The default endpoint is hosted geocode.earth (key required), but a
  // self-hosted Pelias needs none, so the key is accepted yet not mandatory.
  requiresApiKey: false,
  acceptsApiKey: true,
  defaultForwardEndpoint: "https://api.geocode.earth/v1/search",
  defaultReverseEndpoint: "https://api.geocode.earth/v1/reverse",
  buildForwardUrl: (config, query, options) => {
    const url = new URL(config.forwardEndpoint);
    url.searchParams.set("text", query);
    if (options.limit) url.searchParams.set("size", String(options.limit));
    if (config.apiKey) url.searchParams.set("api_key", config.apiKey);
    return url.toString();
  },
  parseForward: (data) =>
    geojsonFeatures(data)
      .map((feature) => {
        const coords = pointCoords(feature);
        if (!coords) return null;
        const props = (feature.properties as Record<string, unknown>) ?? {};
        return {
          lon: coords[0],
          lat: coords[1],
          displayName: readString(props, "label") ?? "",
          score: coerceScore(props.confidence as number | undefined),
        } satisfies GeocodeMatch;
      })
      .filter((m): m is GeocodeMatch => m !== null),
  buildReverseUrl: (config, lon, lat) => {
    const url = new URL(config.reverseEndpoint);
    url.searchParams.set("point.lat", String(lat));
    url.searchParams.set("point.lon", String(lon));
    if (config.apiKey) url.searchParams.set("api_key", config.apiKey);
    return url.toString();
  },
  parseReverse: (data) => {
    const feature = geojsonFeatures(data)[0];
    if (!feature) return null;
    const props = (feature.properties as Record<string, unknown>) ?? {};
    const displayName = readString(props, "label")?.trim();
    return displayName ? { displayName, parts: stringifyParts(props) } : null;
  },
};

const arcgisProvider: GeocodingProvider = {
  id: "arcgis",
  label: "ArcGIS World Geocoder",
  forward: true,
  reverse: true,
  requiresApiKey: true,
  acceptsApiKey: true,
  defaultForwardEndpoint:
    "https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates",
  defaultReverseEndpoint:
    "https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/reverseGeocode",
  buildForwardUrl: (config, query, options) => {
    const url = new URL(config.forwardEndpoint);
    url.searchParams.set("SingleLine", query);
    url.searchParams.set("f", "json");
    url.searchParams.set("outFields", "Match_addr");
    if (options.limit) url.searchParams.set("maxLocations", String(options.limit));
    if (config.apiKey) url.searchParams.set("token", config.apiKey);
    return url.toString();
  },
  parseForward: (data) => {
    const candidates =
      data &&
      typeof data === "object" &&
      Array.isArray((data as { candidates?: unknown }).candidates)
        ? ((data as { candidates: unknown[] }).candidates as Record<string, unknown>[])
        : [];
    return candidates
      .map((candidate) => {
        const location = candidate.location as { x?: unknown; y?: unknown } | undefined;
        const lon = Number(location?.x);
        const lat = Number(location?.y);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
        return {
          lon,
          lat,
          displayName: readString(candidate, "address") ?? "",
          score: coerceScore(candidate.score as number | undefined),
        } satisfies GeocodeMatch;
      })
      .filter((m): m is GeocodeMatch => m !== null);
  },
  buildReverseUrl: (config, lon, lat) => {
    const url = new URL(config.reverseEndpoint);
    url.searchParams.set("location", `${lon},${lat}`);
    url.searchParams.set("f", "json");
    if (config.apiKey) url.searchParams.set("token", config.apiKey);
    return url.toString();
  },
  parseReverse: (data) => {
    const address =
      data && typeof data === "object" ? (data as { address?: unknown }).address : undefined;
    if (!address || typeof address !== "object") return null;
    const displayName = (
      readString(address, "LongLabel") ?? readString(address, "Match_addr")
    )?.trim();
    return displayName
      ? { displayName, parts: stringifyParts(address as Record<string, unknown>) }
      : null;
  },
};

const mapboxProvider: GeocodingProvider = {
  id: "mapbox",
  label: "Mapbox",
  forward: true,
  reverse: true,
  requiresApiKey: true,
  acceptsApiKey: true,
  defaultForwardEndpoint: "https://api.mapbox.com/geocoding/v5/mapbox.places",
  defaultReverseEndpoint: "https://api.mapbox.com/geocoding/v5/mapbox.places",
  buildForwardUrl: (config, query, options) => {
    const base = config.forwardEndpoint.replace(/\/+$/, "");
    const url = new URL(`${base}/${encodeURIComponent(query)}.json`);
    if (options.limit) url.searchParams.set("limit", String(options.limit));
    if (config.apiKey) url.searchParams.set("access_token", config.apiKey);
    return url.toString();
  },
  parseForward: (data) =>
    geojsonFeatures(data)
      .map((feature) => {
        const center = feature.center as unknown;
        let coords: [number, number] | null = null;
        if (Array.isArray(center) && center.length >= 2) {
          const lon = Number(center[0]);
          const lat = Number(center[1]);
          if (Number.isFinite(lon) && Number.isFinite(lat)) coords = [lon, lat];
        }
        coords ??= pointCoords(feature);
        if (!coords) return null;
        return {
          lon: coords[0],
          lat: coords[1],
          displayName: readString(feature, "place_name") ?? "",
          score: coerceScore(feature.relevance as number | undefined),
        } satisfies GeocodeMatch;
      })
      .filter((m): m is GeocodeMatch => m !== null),
  buildReverseUrl: (config, lon, lat) => {
    const base = config.reverseEndpoint.replace(/\/+$/, "");
    const url = new URL(`${base}/${lon},${lat}.json`);
    if (config.apiKey) url.searchParams.set("access_token", config.apiKey);
    return url.toString();
  },
  parseReverse: (data) => {
    const feature = geojsonFeatures(data)[0];
    if (!feature) return null;
    const displayName = readString(feature, "place_name")?.trim();
    return displayName
      ? {
          displayName,
          parts: stringifyParts((feature.properties as Record<string, unknown>) ?? {}),
        }
      : null;
  },
};

/**
 * Detect a Google Geocoding API error embedded in an HTTP 200 body. Google v3
 * returns REQUEST_DENIED / OVER_QUERY_LIMIT / INVALID_REQUEST and friends with
 * a 200 status and the failure only in the `status` field, so `response.ok`
 * alone would silently turn those into empty results. Returns null for OK and
 * ZERO_RESULTS (a successful empty match).
 */
function googleErrorMessage(data: unknown): string | null {
  const status = readString(data, "status");
  if (!status || status === "OK" || status === "ZERO_RESULTS") return null;
  const detail = readString(data, "error_message");
  return detail
    ? `Google geocoder error: ${status} - ${detail}`
    : `Google geocoder error: ${status}`;
}

const googleProvider: GeocodingProvider = {
  id: "google",
  label: "Google",
  forward: true,
  reverse: true,
  requiresApiKey: true,
  acceptsApiKey: true,
  browserCorsRestricted: true,
  defaultForwardEndpoint: "https://maps.googleapis.com/maps/api/geocode/json",
  defaultReverseEndpoint: "https://maps.googleapis.com/maps/api/geocode/json",
  // The Geocoding API has no result-count parameter, so the batch loop's
  // `limit` is intentionally not forwarded; only the top result is used.
  buildForwardUrl: (config, query) => {
    const url = new URL(config.forwardEndpoint);
    url.searchParams.set("address", query);
    if (config.apiKey) url.searchParams.set("key", config.apiKey);
    return url.toString();
  },
  parseForward: (data) => {
    const error = googleErrorMessage(data);
    if (error) throw new Error(error);
    return parseGoogleResults(data);
  },
  buildReverseUrl: (config, lon, lat) => {
    const url = new URL(config.reverseEndpoint);
    url.searchParams.set("latlng", `${lat},${lon}`);
    if (config.apiKey) url.searchParams.set("key", config.apiKey);
    return url.toString();
  },
  parseReverse: (data) => {
    const error = googleErrorMessage(data);
    if (error) throw new Error(error);
    const results =
      data && typeof data === "object" && Array.isArray((data as { results?: unknown }).results)
        ? ((data as { results: unknown[] }).results as Record<string, unknown>[])
        : [];
    const displayName = readString(results[0], "formatted_address")?.trim();
    return displayName ? { displayName, parts: {} } : null;
  },
};

/** Map a Google Geocoding API `results` array onto normalized matches. */
function parseGoogleResults(data: unknown): GeocodeMatch[] {
  const results =
    data && typeof data === "object" && Array.isArray((data as { results?: unknown }).results)
      ? ((data as { results: unknown[] }).results as Record<string, unknown>[])
      : [];
  return results
    .map((result): GeocodeMatch | null => {
      const geometry = result.geometry as { location?: unknown } | undefined;
      const location = geometry?.location as { lat?: unknown; lng?: unknown } | undefined;
      const lat = Number(location?.lat);
      const lon = Number(location?.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      return {
        lat,
        lon,
        displayName: readString(result, "formatted_address") ?? "",
        score: null,
      };
    })
    .filter((m): m is GeocodeMatch => m !== null);
}

// --- CartoCiudad (IGN/CNIG — Spanish national geocoder) -------------------

/**
 * A single CartoCiudad forward/reverse geocoding result. The API returns one
 * object (not an array) for both forward (`find`) and reverse (`reverseGeocode`)
 * lookups, even for an ambiguous query. `lat`/`lng` are top-level numbers.
 *
 * There is no in-body success flag or confidence signal to check. A query the
 * geocoder cannot match comes back as HTTP 204 with an empty body rather than
 * an object carrying a failure code, so {@link readGeocodeJson} turns it into
 * "no results" before a parser ever sees it. The `state`/`stateMsg` fields are
 * vestigial: IGN's own service docs record them as suppressed in the current
 * Elasticsearch-backed geocoder, which "cannot configure candidate output by
 * degree of match", so `state` is permanently 0 and `stateMsg` empty
 * (github.com/IDEESpain/Cartociudad). Neither is modeled here, and matches
 * carry `score: null` because the API exposes no ranking to map onto it.
 */
interface CartoCiudadResult {
  lat: number;
  lng: number;
  address?: string;
  type?: string;
  tip_via?: string;
  portalNumber?: number | string;
  postalCode?: string;
  poblacion?: string;
  muni?: string;
  province?: string;
  comunidadAutonoma?: string;
  refCatastral?: string;
  [key: string]: unknown;
}

/**
 * Read a CartoCiudad `lat`/`lng` field as a finite number, or null when the
 * field is absent, blank, or not numeric (`"NaN"` and `"invalid"` included).
 * Guarding the raw value matters because `Number(null)` is 0, which would turn
 * a coordinate-less response into a match in the Gulf of Guinea.
 */
function cartociudadCoordinate(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Validated WGS84 position for a result, or null when it carries none. */
function cartociudadCoords(r: CartoCiudadResult): { lat: number; lon: number } | null {
  const lat = cartociudadCoordinate(r.lat);
  const lon = cartociudadCoordinate(r.lng);
  if (lat === null || lon === null) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

/** Default endpoints for the public CartoCiudad REST API (no auth required). */
const CARTOCIUDAD_FORWARD_ENDPOINT = "https://www.cartociudad.es/geocoder/api/geocoder/find";
const CARTOCIUDAD_REVERSE_ENDPOINT =
  "https://www.cartociudad.es/geocoder/api/geocoder/reverseGeocode";

/**
 * Build a human-readable display name from CartoCiudad address fields.
 * Format: "Tip Via Address Num, CP Poblacion (Province)"
 */
function cartociudadDisplayName(r: CartoCiudadResult): string {
  const parts: string[] = [];
  const streetParts = [r.tip_via, r.address]
    .filter((s) => s && String(s).trim())
    .map((s) => String(s).trim());
  if (streetParts.length) {
    let street = streetParts.join(" ");
    const portalNumber =
      r.portalNumber === undefined || r.portalNumber === null ? "" : String(r.portalNumber).trim();
    if (portalNumber) street += ` ${portalNumber}`;
    parts.push(street);
  }
  // `poblacion` is null on some results that still carry `muni` — a road
  // kilometre point such as "A-6 km 120" answers with muni "Espinosa de los
  // Caballeros" and no poblacion — so fall back to the municipality rather than
  // drop it from the display name. When both are present, `poblacion` wins as
  // the more specific locality.
  const localityName = [r.poblacion, r.muni].find((s) => s && String(s).trim());
  const locality = [r.postalCode, localityName]
    .filter((s) => s && String(s).trim())
    .map((s) => String(s).trim())
    .join(" ");
  if (locality) parts.push(locality);
  const province = r.province ? String(r.province).trim() : "";
  if (province) parts.push(`(${province})`);
  return parts.join(", ") || r.address || r.poblacion || r.muni || "";
}

const cartociudadProvider: GeocodingProvider = {
  id: "cartociudad",
  label: "CartoCiudad (IGN España)",
  forward: true,
  reverse: true,
  requiresApiKey: false,
  acceptsApiKey: false,
  defaultForwardEndpoint: CARTOCIUDAD_FORWARD_ENDPOINT,
  defaultReverseEndpoint: CARTOCIUDAD_REVERSE_ENDPOINT,
  buildForwardUrl: (config, query) => {
    const url = new URL(config.forwardEndpoint);
    url.searchParams.set("q", query);
    // `find` answers with one best result and has no result-count parameter, so
    // the batch loop's `limit` is intentionally not forwarded.
    return url.toString();
  },
  parseForward: (data) => {
    // `find` returns a single object, never an array — verified against the live
    // endpoint with an ambiguous query ("calle mayor"), which still answers with
    // one object rather than a candidate list.
    if (!data || typeof data !== "object" || Array.isArray(data)) return [];
    const r = data as CartoCiudadResult;
    const coords = cartociudadCoords(r);
    if (!coords) return [];
    const displayName = cartociudadDisplayName(r).trim();
    if (!displayName) return [];
    return [
      {
        lat: coords.lat,
        lon: coords.lon,
        displayName,
        score: null,
      },
    ];
  },
  buildReverseUrl: (config, lon, lat) => {
    const url = new URL(config.reverseEndpoint);
    url.searchParams.set("lat", String(lat));
    url.searchParams.set("lon", String(lon));
    return url.toString();
  },
  parseReverse: (data) => {
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    const r = data as CartoCiudadResult;
    if (!cartociudadCoords(r)) return null;
    const displayName = cartociudadDisplayName(r).trim();
    if (!displayName) return null;
    // Build a structured address-parts record from the rich CartoCiudad fields.
    const parts: Record<string, string> = {};
    for (const [key, value] of Object.entries({
      type: r.type,
      tip_via: r.tip_via,
      address: r.address,
      portalNumber: r.portalNumber,
      postalCode: r.postalCode,
      poblacion: r.poblacion,
      muni: r.muni,
      province: r.province,
      comunidadAutonoma: r.comunidadAutonoma,
      refCatastral: r.refCatastral,
    })) {
      if (value !== undefined && value !== null && value !== "") parts[key] = String(value);
    }
    return { displayName, parts };
  },
};

/** All selectable geocoding providers, Nominatim first (the default). */
export const GEOCODING_PROVIDERS: readonly GeocodingProvider[] = [
  nominatimProvider,
  peliasProvider,
  arcgisProvider,
  mapboxProvider,
  googleProvider,
  cartociudadProvider,
];

const PROVIDERS_BY_ID = new Map<GeocodingProviderId, GeocodingProvider>(
  GEOCODING_PROVIDERS.map((provider) => [provider.id, provider]),
);

/** Coerce an arbitrary string to a known provider id, defaulting to Nominatim. */
export function normalizeGeocodingProviderId(
  value: string | undefined | null,
): GeocodingProviderId {
  const id = value?.trim() as GeocodingProviderId | undefined;
  return id && PROVIDERS_BY_ID.has(id) ? id : DEFAULT_GEOCODING_PROVIDER_ID;
}

/** Look up a provider by id, falling back to Nominatim for unknown ids. */
export function getGeocodingProvider(id: string | undefined | null): GeocodingProvider {
  return PROVIDERS_BY_ID.get(normalizeGeocodingProviderId(id)) ?? nominatimProvider;
}

/**
 * Resolve the geocoder configuration from runtime env, falling back to the
 * selected provider's default endpoints. `VITE_GEOCODER_PROVIDER` selects the
 * backend; `VITE_GEOCODER_ENDPOINT`/`VITE_GEOCODER_REVERSE_ENDPOINT` override
 * the endpoints; `VITE_GEOCODER_EMAIL` supplies the contact email; and
 * `VITE_GEOCODER_API_KEY` supplies the API key for keyed providers.
 */
export function getGeocoderConfig(): GeocoderConfig {
  const env = getRuntimeEnvironment();
  const provider = getGeocodingProvider(env.VITE_GEOCODER_PROVIDER);
  return {
    providerId: provider.id,
    forwardEndpoint: env.VITE_GEOCODER_ENDPOINT?.trim() || provider.defaultForwardEndpoint,
    reverseEndpoint: env.VITE_GEOCODER_REVERSE_ENDPOINT?.trim() || provider.defaultReverseEndpoint,
    email: env.VITE_GEOCODER_EMAIL?.trim() || undefined,
    apiKey: env.VITE_GEOCODER_API_KEY?.trim() || undefined,
  };
}

/** Inputs to {@link resolveGeocoderConfig}, mirroring the project preference. */
export interface GeocodingPreferenceInput {
  providerId?: string;
  /** Per-provider API keys keyed by provider id. */
  apiKeys?: Record<string, string>;
  /** Optional custom forward endpoint (else the provider default). */
  forwardEndpoint?: string;
  /** Optional custom reverse endpoint (else the provider default). */
  reverseEndpoint?: string;
  email?: string;
}

/**
 * Build a {@link GeocoderConfig} from structured project preferences. Used by
 * the geocode dialog so a per-run provider choice resolves the right endpoints
 * and API key without round-tripping through runtime env.
 */
export function resolveGeocoderConfig(input: GeocodingPreferenceInput): GeocoderConfig {
  const provider = getGeocodingProvider(input.providerId);
  return {
    providerId: provider.id,
    forwardEndpoint: input.forwardEndpoint?.trim() || provider.defaultForwardEndpoint,
    reverseEndpoint: input.reverseEndpoint?.trim() || provider.defaultReverseEndpoint,
    email: input.email?.trim() || undefined,
    apiKey: input.apiKeys?.[provider.id]?.trim() || undefined,
  };
}

/** Hostname of `endpoint`, or null when it does not parse as a URL. */
function geocoderHostname(endpoint: string): string | null {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return null;
  }
}

/** Whether `hostname` is the public CartoCiudad service or a subdomain of it. */
function isCartociudadHost(hostname: string | null): boolean {
  if (hostname === null) return false;
  return hostname === CARTOCIUDAD_PUBLIC_HOST || hostname.endsWith(`.${CARTOCIUDAD_PUBLIC_HOST}`);
}

/**
 * Whether requests to `endpoint` must be throttled AND row-capped. True for the
 * public Nominatim host (its usage policy applies) and, defensively, for any
 * endpoint that does not parse as a URL. Every other host (a self-hosted
 * Nominatim or a keyed provider) returns false.
 *
 * Note this is the *Nominatim policy* gate, not "is this host paced at all" —
 * see {@link geocoderMinIntervalMs}, which paces CartoCiudad more gently
 * without capping its row count.
 */
export function shouldThrottle(endpoint: string): boolean {
  const hostname = geocoderHostname(endpoint);
  return hostname === null || hostname === NOMINATIM_PUBLIC_HOST;
}

/**
 * The row cap to apply for `endpoint`: a finite cap for the public Nominatim
 * host, else Infinity. CartoCiudad is uncapped — IGN publishes no row limit and
 * its own bulk address geocoder processes up to 60,000 records per run, so a
 * cap here would be an invented constraint. It is still paced; see
 * {@link geocoderMinIntervalMs}.
 */
export function rowCap(endpoint: string): number {
  return shouldThrottle(endpoint) ? PUBLIC_GEOCODE_ROW_CAP : Number.POSITIVE_INFINITY;
}

/**
 * Minimum spacing (ms) between requests for `endpoint`. Gated on the hostname,
 * not the selected provider, so pointing any provider at the public Nominatim
 * host still honors its 1 req/sec policy.
 *
 * CartoCiudad gets a gentler pace of its own. IGN documents no rate limit for
 * the single-lookup `find`/`reverseGeocode` endpoints either way, so the honest
 * position is that unbounded bursting is unverified rather than sanctioned:
 * a large CSV run against a free public government service with zero spacing
 * risks getting the caller's IP throttled and degrading the service for
 * everyone. Nominatim's 1 req/sec is that provider's published policy and is
 * not borrowed here. Keyed providers and self-hosted endpoints are paced by
 * their own quotas, not by us.
 */
export function geocoderMinIntervalMs(endpoint: string): number {
  if (shouldThrottle(endpoint)) return NOMINATIM_MIN_INTERVAL_MS;
  return isCartociudadHost(geocoderHostname(endpoint)) ? CARTOCIUDAD_MIN_INTERVAL_MS : 0;
}

/** Hosted Pelias service that rejects keyless requests. */
const GEOCODE_EARTH_HOST_SUFFIX = "geocode.earth";

/**
 * Whether `config` cannot geocode without an API key. True for the keyed
 * providers (ArcGIS, Mapbox, Google) and for Pelias only when it targets the
 * hosted geocode.earth endpoint (a self-hosted Pelias needs no key). Drives the
 * batch dialog's "missing key" warning and disabled run.
 */
export function geocoderNeedsApiKey(config: GeocoderConfig): boolean {
  const provider = getGeocodingProvider(config.providerId);
  if (provider.requiresApiKey) return true;
  if (provider.id === "pelias") {
    try {
      const host = new URL(config.forwardEndpoint).hostname;
      return host === GEOCODE_EARTH_HOST_SUFFIX || host.endsWith(`.${GEOCODE_EARTH_HOST_SUFFIX}`);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Milliseconds to wait before starting the next request so consecutive
 * requests are spaced at least `intervalMs` apart, measured from the previous
 * request's start time (not its completion) so a slow network does not double
 * the wait. Returns 0 for the first request or when enough time has elapsed.
 */
export function nextDelayMs(lastStartedAt: number | null, now: number, intervalMs: number): number {
  if (lastStartedAt === null) return 0;
  return Math.max(0, intervalMs - (now - lastStartedAt));
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

/**
 * The fetch implementation used by {@link geocodeForward}/{@link geocodeReverse}.
 * Null means "use the global browser `fetch`" (the default for the web and
 * embedded builds).
 */
let geocodingFetch: typeof globalThis.fetch | null = null;

/**
 * Override the fetch used for geocoding requests, or pass null to restore the
 * global browser `fetch`.
 *
 * The desktop shell sets this to Tauri's native HTTP fetch so geocoding requests
 * are made from the Rust side, which:
 *   - bypasses the WebView's CORS enforcement. Public Nominatim's CDN
 *     intermittently omits the `Access-Control-Allow-Origin` header on cached
 *     responses, which the browser then rejects — surfacing to the user as
 *     "Search failed. Try again." (the symptom that failed Microsoft Store
 *     certification); and
 *   - can send a `User-Agent` identifying the app, as Nominatim's usage policy
 *     requires (browser fetch cannot set that header).
 *
 * Safe to call multiple times; only the most recent implementation is used.
 */
export function setGeocodingFetch(fetchImpl: typeof globalThis.fetch | null): void {
  geocodingFetch = fetchImpl;
}

/** The active geocoding fetch: the injected override, else the global fetch. */
function geocodeFetch(): typeof globalThis.fetch {
  return geocodingFetch ?? fetch;
}

/**
 * Read a geocoder response body as JSON, treating an empty one as "no results".
 *
 * CartoCiudad answers an unmatched query with HTTP 204 and an empty body rather
 * than a JSON null (verified against the live `find` and `reverseGeocode`
 * endpoints). `response.ok` is true for 204, so parsing unconditionally would
 * throw a JSON syntax error and surface a nonsense address as "Search failed"
 * instead of "no match". Returning undefined lets each provider's parser report
 * no results the way it already does for a null body.
 */
async function readGeocodeJson(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const text = await response.text();
  if (!text.trim()) return undefined;
  return JSON.parse(text) as unknown;
}

/**
 * Normalize a longitude into [-180, 180], or null when it is not finite.
 *
 * MapLibre reports `lngLat.lng` unwrapped once the map is zoomed out far enough
 * to show repeated world copies, so a click on a non-primary copy arrives as
 * e.g. 210 rather than -150. Rejecting those outright would silently drop a
 * legitimate reverse-geocode click for every provider, so wrap instead.
 *
 * An in-range longitude returns untouched: the modulo round-trip is not exact
 * in floating point (-3.7 comes back as -3.7000000000000455), and the common
 * case should not be perturbed to handle the rare one.
 */
function wrapLongitude(lon: number): number | null {
  if (!Number.isFinite(lon)) return null;
  if (lon >= -180 && lon <= 180) return lon;
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/**
 * Forward-geocode a single query through the configured provider, returning
 * normalized matches.
 */
export async function geocodeForward(
  query: string,
  options: { signal?: AbortSignal; config?: GeocoderConfig; limit?: number } = {},
): Promise<GeocodeMatch[]> {
  const config = options.config ?? getGeocoderConfig();
  const provider = getGeocodingProvider(config.providerId);
  const url = provider.buildForwardUrl(config, query, {
    email: config.email,
    limit: options.limit,
  });
  const response = await geocodeFetch()(url, {
    signal: options.signal,
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Geocoder returned HTTP ${response.status}`);
  }
  const data: unknown = await readGeocodeJson(response);
  return provider.parseForward(data);
}

/**
 * Reverse-geocode a single point ([lon, lat]) through the configured provider,
 * returning a normalized display result or null when no address was found.
 */
export async function geocodeReverse(
  lon: number,
  lat: number,
  options: { signal?: AbortSignal; config?: GeocoderConfig; zoom?: number } = {},
): Promise<ReverseGeocodeDisplay | null> {
  const wrappedLon = wrapLongitude(lon);
  if (wrappedLon === null || !Number.isFinite(lat) || lat < -90 || lat > 90) {
    return null;
  }
  const config = options.config ?? getGeocoderConfig();
  const provider = getGeocodingProvider(config.providerId);
  const url = provider.buildReverseUrl(config, wrappedLon, lat, {
    email: config.email,
    zoom: options.zoom,
  });
  const response = await geocodeFetch()(url, {
    signal: options.signal,
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Geocoder returned HTTP ${response.status}`);
  }
  const data: unknown = await readGeocodeJson(response);
  return provider.parseReverse(data);
}
