import type { Feature, Point } from "geojson";
import { getRuntimeEnvironment } from "./runtime-env";
import type { GeocodingLocator } from "./types";

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
 * Pelias, Google, organization-hosted ArcGIS GeocodeServer locators) can be
 * selected per project. Each provider builds its own request
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
/** Prefix of a matched candidate's own attributes, when they are kept. */
export const GEOCODE_ATTRIBUTE_PREFIX = "geocode_attr_";

/** Identifier of a selectable geocoding backend. */
export type GeocodingProviderId =
  | "nominatim"
  | "pelias"
  | "arcgis"
  | "arcgis-locator"
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
  /** The selected locator, for the `arcgis-locator` provider. */
  locator?: GeocodingLocator;
}

/**
 * An error the geocoding service reported about the request itself, as opposed
 * to a network failure or a search with no matches. ArcGIS answers failures with
 * HTTP 200 and an `error` envelope, so `response.ok` alone would turn them into
 * an empty result. `code` is the service's own code (498/499 for a missing or
 * invalid token, 403 for insufficient permission).
 */
export class GeocoderServiceError extends Error {
  readonly code: number | undefined;

  constructor(message: string, code?: number) {
    super(message);
    this.name = "GeocoderServiceError";
    this.code = code;
  }

  /** Whether the service asked for a token or rejected the one it got. */
  get isAuthError(): boolean {
    return this.code === 401 || this.code === 403 || this.code === 498 || this.code === 499;
  }
}

/** The configured geocoder does not support the requested operation. */
export class GeocoderUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeocoderUnsupportedError";
  }
}

/** Per-request options passed to a provider's forward URL builder. */
export interface ForwardRequestOptions {
  email?: string;
  limit?: number;
  /** A suggestion's key, so the locator resolves exactly that suggestion. */
  magicKey?: string;
  /** Ask for each candidate's own attributes (see {@link GeocodeMatch.attributes}). */
  attributes?: boolean;
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
  /**
   * The candidate's own attributes, when the service returns them (an
   * organization locator's parcel or asset identifiers, address type, ...).
   * Empty values are left out.
   */
  attributes?: Record<string, string | number | boolean>;
}

/** A partial-text suggestion from a locator's `suggest` operation. */
export interface GeocodeSuggestion {
  /** The suggested place, as the locator words it. */
  text: string;
  /** Opaque key that `findAddressCandidates` resolves to this suggestion. */
  magicKey: string;
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
 * `extra.attributes` also adds the candidate's own attributes, each under
 * {@link GEOCODE_ATTRIBUTE_PREFIX} plus its name.
 */
export function geocodeMatchToFeature(
  match: GeocodeMatch,
  originalRow: Record<string, string> = {},
  extra?: { providerId?: GeocodingProviderId; attributes?: boolean },
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
  // The locator's own fields, prefixed so they never collide with the row's.
  if (extra?.attributes)
    for (const [key, value] of Object.entries(match.attributes ?? {}))
      added[`${GEOCODE_ATTRIBUTE_PREFIX}${key}`] = value;
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
  parseForward: parseArcGISCandidates,
  buildReverseUrl: (config, lon, lat) => {
    const url = new URL(config.reverseEndpoint);
    url.searchParams.set("location", `${lon},${lat}`);
    url.searchParams.set("f", "json");
    if (config.apiKey) url.searchParams.set("token", config.apiKey);
    return url.toString();
  },
  parseReverse: parseArcGISReverse,
};

// --- Organization-hosted ArcGIS GeocodeServer locators ----------------------

/** Spatial references ArcGIS reports for Web Mercator. */
const WEB_MERCATOR_WKIDS = new Set([102100, 102113, 3857, 900913]);
/** Earth radius of the Web Mercator sphere, in meters. */
const WEB_MERCATOR_RADIUS = 6378137;
/** The operations a pasted GeocodeServer URL may already end in. */
const LOCATOR_OPERATION = /\/(findAddressCandidates|reverseGeocode|suggest|geocodeAddresses)$/i;

/** The ArcGIS `error` envelope in a response body, as a {@link GeocoderServiceError}. */
function arcgisServiceError(data: unknown): GeocoderServiceError | null {
  const error = data && typeof data === "object" ? (data as { error?: unknown }).error : undefined;
  if (!error || typeof error !== "object") return null;
  const code = Number((error as { code?: unknown }).code);
  const message = readString(error, "message") ?? "ArcGIS geocoding service error";
  return new GeocoderServiceError(message, Number.isFinite(code) ? code : undefined);
}

/** The well-known ID of an ArcGIS `spatialReference`, preferring `latestWkid`. */
function spatialReferenceWkid(spatialReference: unknown): number | null {
  if (!spatialReference || typeof spatialReference !== "object") return null;
  const sr = spatialReference as { wkid?: unknown; latestWkid?: unknown };
  const wkid = Number(sr.latestWkid ?? sr.wkid);
  return Number.isFinite(wkid) ? wkid : null;
}

/**
 * A candidate's position as longitude/latitude. Organization-hosted locators
 * often work in a projected system, and ArcGIS ignores an `outSR` it cannot
 * honor, so the reported spatial reference decides: geographic WGS 84 (or none,
 * the World Geocoder's default) is read as is, Web Mercator is unprojected, and
 * anything else is refused rather than plotted in the wrong place.
 *
 * @param x - The candidate's x coordinate.
 * @param y - The candidate's y coordinate.
 * @param wkid - The response's spatial reference, or null when it reports none.
 * @returns The position, or null when the coordinates are not finite or not on Earth.
 * @throws GeocoderServiceError When the coordinates are in an unsupported spatial reference.
 */
function arcgisCandidatePosition(
  x: number,
  y: number,
  wkid: number | null,
): { lon: number; lat: number } | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  let lon = x;
  let lat = y;
  if (wkid !== null && WEB_MERCATOR_WKIDS.has(wkid)) {
    lon = (x / WEB_MERCATOR_RADIUS) * (180 / Math.PI);
    lat = (2 * Math.atan(Math.exp(y / WEB_MERCATOR_RADIUS)) - Math.PI / 2) * (180 / Math.PI);
  } else if (wkid !== null && wkid !== 4326) {
    throw new GeocoderServiceError(
      `The geocoder returned coordinates in spatial reference ${wkid}, which GeoLibre cannot place on the map.`,
    );
  }
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return null;
  return { lon, lat };
}

/**
 * A candidate's attributes worth keeping: plain values that are not empty.
 * The shape and the location fields the match already carries are dropped.
 */
function candidateAttributes(
  value: unknown,
): Record<string, string | number | boolean> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const kept: Record<string, string | number | boolean> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (/^(shape|x|y|displayx|displayy|xmin|xmax|ymin|ymax)$/i.test(key)) continue;
    if (
      typeof entry === "string"
        ? entry.trim() === ""
        : typeof entry !== "number" && typeof entry !== "boolean"
    )
      continue;
    if (typeof entry === "number" && !Number.isFinite(entry)) continue;
    kept[key] = entry as string | number | boolean;
  }
  return Object.keys(kept).length ? kept : undefined;
}

/**
 * Normalize an ArcGIS `findAddressCandidates` response. Throws the service's
 * error envelope instead of reporting it as "no matches".
 *
 * @param data - The parsed response body.
 * @returns The candidates as normalized matches.
 */
function parseArcGISCandidates(data: unknown): GeocodeMatch[] {
  const error = arcgisServiceError(data);
  if (error) throw error;
  if (!data || typeof data !== "object") return [];
  const body = data as { candidates?: unknown; spatialReference?: unknown };
  if (!Array.isArray(body.candidates)) return [];
  const wkid = spatialReferenceWkid(body.spatialReference);
  return (body.candidates as Record<string, unknown>[])
    .map((candidate) => {
      const location = candidate.location as { x?: unknown; y?: unknown } | undefined;
      const position = arcgisCandidatePosition(Number(location?.x), Number(location?.y), wkid);
      if (!position) return null;
      const attributes = candidateAttributes(candidate.attributes);
      return {
        ...position,
        displayName: readString(candidate, "address") ?? "",
        score: coerceScore(candidate.score as number | undefined),
        ...(attributes ? { attributes } : {}),
      } satisfies GeocodeMatch;
    })
    .filter((m): m is GeocodeMatch => m !== null);
}

/**
 * Whether an ArcGIS error envelope is the "Unable to find address" answer:
 * code 400 with that text in its message or (Enterprise) its details. Other
 * 400s, such as malformed parameters, are real failures.
 */
function isNoAddressError(data: unknown, error: GeocoderServiceError): boolean {
  if (error.code !== 400) return false;
  const envelope = (data as { error?: { details?: unknown } }).error;
  const details = Array.isArray(envelope?.details) ? envelope.details.join(" ") : "";
  return /unable to find address/i.test(`${error.message} ${details}`);
}

/**
 * Normalize an ArcGIS `reverseGeocode` response. "Unable to find address" comes
 * back as an `error` envelope with code 400, which is a valid empty answer
 * rather than a failure.
 *
 * @param data - The parsed response body.
 * @returns The address, or null when there is none.
 */
function parseArcGISReverse(data: unknown): ReverseGeocodeDisplay | null {
  const error = arcgisServiceError(data);
  if (error && !isNoAddressError(data, error)) throw error;
  const address =
    data && typeof data === "object" ? (data as { address?: unknown }).address : undefined;
  if (!address || typeof address !== "object") return null;
  const displayName = (
    readString(address, "LongLabel") ??
    readString(address, "Match_addr") ??
    readString(address, "Address")
  )?.trim();
  return displayName
    ? { displayName, parts: stringifyParts(address as Record<string, unknown>) }
    : null;
}

/**
 * The GeocodeServer base URL of a pasted locator URL: an operation suffix
 * (`/findAddressCandidates`, ...), the query string and any credentials are
 * dropped, so a token in a pasted URL is never stored.
 *
 * @param input - The URL as typed.
 * @returns The base URL ending in `/GeocodeServer`, or null when it is not one.
 */
export function normalizeArcGISLocatorUrl(input: string | undefined | null): string | null {
  let url: URL;
  try {
    url = new URL((input ?? "").trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const path = url.pathname.replace(/\/+$/, "").replace(LOCATOR_OPERATION, "");
  if (!/\/GeocodeServer$/i.test(path)) return null;
  url.pathname = path;
  url.search = "";
  url.hash = "";
  url.username = "";
  url.password = "";
  return url.toString();
}

/**
 * Coerce a stored locator to a {@link GeocodingLocator}, or null when it has no
 * usable id or GeocodeServer URL. Used for project files and runtime env, so
 * anything unexpected is dropped rather than trusted.
 *
 * @param value - The stored value.
 * @returns The locator, or null.
 */
export function normalizeGeocodingLocator(value: unknown): GeocodingLocator | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
  const url = normalizeArcGISLocatorUrl(
    typeof candidate.url === "string" ? candidate.url : undefined,
  );
  if (!id || !url) return null;
  const text = (key: string) =>
    typeof candidate[key] === "string" && (candidate[key] as string).trim()
      ? (candidate[key] as string).trim()
      : undefined;
  const flag = (key: string) =>
    typeof candidate[key] === "boolean" ? (candidate[key] as boolean) : undefined;
  const addressFields = Array.isArray(candidate.addressFields)
    ? candidate.addressFields.filter(
        (field): field is string => typeof field === "string" && field.trim() !== "",
      )
    : undefined;
  const locator: GeocodingLocator = { id, name: text("name") ?? id, url };
  const portalUrl = text("portalUrl");
  if (portalUrl) locator.portalUrl = portalUrl;
  const singleLineField = text("singleLineField");
  if (singleLineField) locator.singleLineField = singleLineField;
  if (addressFields?.length) locator.addressFields = addressFields;
  const reverse = flag("reverse");
  if (reverse !== undefined) locator.reverse = reverse;
  const suggest = flag("suggest");
  if (suggest !== undefined) locator.suggest = suggest;
  const searchField = text("searchField");
  if (searchField) locator.searchField = searchField;
  return locator;
}

/** What a GeocodeServer's `?f=json` metadata says it supports. */
export type ArcGISLocatorCapabilities = Required<Pick<GeocodingLocator, "reverse" | "suggest">> &
  Pick<GeocodingLocator, "singleLineField" | "addressFields">;

/**
 * Read a GeocodeServer's capabilities from its `?f=json` metadata. A service
 * that lists no `capabilities` (older ArcGIS Server) is taken to support
 * geocoding and reverse geocoding but not suggestions.
 *
 * @param data - The parsed metadata.
 * @returns The capabilities.
 * @throws GeocoderServiceError For an error envelope, or metadata that is not a
 *   GeocodeServer's.
 * @throws GeocoderUnsupportedError When the service does not geocode.
 */
export function parseArcGISLocatorInfo(data: unknown): ArcGISLocatorCapabilities {
  const error = arcgisServiceError(data);
  if (error) throw error;
  if (!data || typeof data !== "object") {
    throw new GeocoderServiceError("The service did not return GeocodeServer metadata.");
  }
  const info = data as Record<string, unknown>;
  const fieldName = (field: unknown) =>
    field && typeof field === "object" ? readString(field, "name")?.trim() || undefined : undefined;
  const addressFields = Array.isArray(info.addressFields)
    ? info.addressFields.map(fieldName).filter((name): name is string => !!name)
    : [];
  const singleLineField = fieldName(info.singleLineAddressField);
  if (!singleLineField && !addressFields.length) {
    throw new GeocoderServiceError("The service did not return GeocodeServer metadata.");
  }
  const listed =
    typeof info.capabilities === "string"
      ? new Set(info.capabilities.split(",").map((entry) => entry.trim().toLowerCase()))
      : null;
  if (listed && !listed.has("geocode")) {
    throw new GeocoderUnsupportedError("This locator does not support geocoding.");
  }
  return {
    singleLineField,
    addressFields: addressFields.length ? addressFields : undefined,
    reverse: listed ? listed.has("reversegeocode") : true,
    suggest: listed ? listed.has("suggest") : false,
  };
}

/**
 * The input field a single search string is sent in: the published field the
 * user chose for it, else the locator's single-line field, else its only
 * structured field (an asset ID locator often publishes just one), else
 * ArcGIS's conventional `SingleLine`.
 *
 * @param locator - The locator.
 * @returns The input field name.
 */
export function arcgisLocatorInputField(locator: GeocodingLocator): string {
  // The user's choice, while the service still publishes that field.
  const published = [locator.singleLineField, ...(locator.addressFields ?? [])];
  if (locator.searchField && published.includes(locator.searchField)) return locator.searchField;
  if (locator.singleLineField) return locator.singleLineField;
  if (locator.addressFields?.length === 1) return locator.addressFields[0];
  return "SingleLine";
}

/** The config's locator, or an error naming what is missing. */
function requireLocator(config: GeocoderConfig): GeocodingLocator {
  if (!config.locator) {
    throw new GeocoderUnsupportedError("No ArcGIS GeocodeServer locator is selected.");
  }
  return config.locator;
}

const arcgisLocatorProvider: GeocodingProvider = {
  id: "arcgis-locator",
  label: "ArcGIS GeocodeServer (organization)",
  forward: true,
  // Per locator: see geocoderSupportsReverse.
  reverse: true,
  // A public locator needs no key; a secured one borrows a portal sign-in.
  requiresApiKey: false,
  acceptsApiKey: false,
  // Derived from the selected locator's URL by resolveGeocoderConfig.
  defaultForwardEndpoint: "",
  defaultReverseEndpoint: "",
  buildForwardUrl: (config, query, options) => {
    const locator = requireLocator(config);
    const url = new URL(config.forwardEndpoint || `${locator.url}/findAddressCandidates`);
    url.searchParams.set(arcgisLocatorInputField(locator), query);
    url.searchParams.set("f", "json");
    // Locators often work in a projected system; ask for WGS 84 and check the
    // spatial reference the response reports (see arcgisCandidatePosition).
    url.searchParams.set("outSR", "4326");
    // The candidate's own fields (parcel or asset IDs, address type, ...),
    // only when wanted: a locator can return dozens of them.
    if (options.attributes) url.searchParams.set("outFields", "*");
    if (options.magicKey) url.searchParams.set("magicKey", options.magicKey);
    if (options.limit) url.searchParams.set("maxLocations", String(options.limit));
    return url.toString();
  },
  parseForward: parseArcGISCandidates,
  buildReverseUrl: (config, lon, lat) => {
    const locator = requireLocator(config);
    const url = new URL(config.reverseEndpoint || `${locator.url}/reverseGeocode`);
    url.searchParams.set(
      "location",
      JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } }),
    );
    url.searchParams.set("outSR", "4326");
    url.searchParams.set("f", "json");
    return url.toString();
  },
  parseReverse: parseArcGISReverse,
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
  arcgisLocatorProvider,
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
 * the endpoints (except for `arcgis-locator`, whose endpoints always come from
 * `VITE_GEOCODER_LOCATOR`); `VITE_GEOCODER_EMAIL` supplies the contact email; and
 * `VITE_GEOCODER_API_KEY` supplies the API key for keyed providers.
 */
export function getGeocoderConfig(): GeocoderConfig {
  const env = getRuntimeEnvironment();
  const provider = getGeocodingProvider(env.VITE_GEOCODER_PROVIDER);
  // The `arcgis-locator` provider's selected locator travels as JSON in
  // `VITE_GEOCODER_LOCATOR`, so the reverse-geocode plugin (which reads runtime
  // env, not the store) can build its requests.
  let locator: GeocodingLocator | undefined;
  if (provider.id === "arcgis-locator" && env.VITE_GEOCODER_LOCATOR) {
    try {
      locator = normalizeGeocodingLocator(JSON.parse(env.VITE_GEOCODER_LOCATOR)) ?? undefined;
    } catch {
      locator = undefined;
    }
  }
  const endpoints = locator ? locatorEndpoints(locator) : provider;
  // A locator's endpoints always come from its own URL: an override would send
  // its requests, and the portal token they may carry, somewhere else.
  const overrides = provider.id === "arcgis-locator" ? {} : env;
  return {
    providerId: provider.id,
    forwardEndpoint: overrides.VITE_GEOCODER_ENDPOINT?.trim() || endpoints.defaultForwardEndpoint,
    reverseEndpoint:
      overrides.VITE_GEOCODER_REVERSE_ENDPOINT?.trim() || endpoints.defaultReverseEndpoint,
    email: env.VITE_GEOCODER_EMAIL?.trim() || undefined,
    apiKey: env.VITE_GEOCODER_API_KEY?.trim() || undefined,
    ...(locator ? { locator } : {}),
  };
}

/** A locator's operation URLs, derived from its base GeocodeServer URL. */
function locatorEndpoints(locator: GeocodingLocator): {
  defaultForwardEndpoint: string;
  defaultReverseEndpoint: string;
} {
  return {
    defaultForwardEndpoint: `${locator.url}/findAddressCandidates`,
    defaultReverseEndpoint: `${locator.url}/reverseGeocode`,
  };
}

/**
 * The locator the `arcgis-locator` provider uses: the one `locatorId` names,
 * else the first configured.
 *
 * @param input - The geocoding preference.
 * @returns The locator, or undefined when none is configured.
 */
export function selectedGeocodingLocator(
  input: Pick<GeocodingPreferenceInput, "locators" | "locatorId">,
): GeocodingLocator | undefined {
  const locators = input.locators ?? [];
  return locators.find((locator) => locator.id === input.locatorId) ?? locators[0];
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
  /** Configured ArcGIS GeocodeServer locators. */
  locators?: GeocodingLocator[];
  /** The locator the `arcgis-locator` provider uses. */
  locatorId?: string;
}

/**
 * Build a {@link GeocoderConfig} from structured project preferences. Used by
 * the geocode dialog so a per-run provider choice resolves the right endpoints
 * and API key without round-tripping through runtime env.
 */
export function resolveGeocoderConfig(input: GeocodingPreferenceInput): GeocoderConfig {
  const provider = getGeocodingProvider(input.providerId);
  if (provider.id === "arcgis-locator") {
    // A locator's endpoints come from its own URL; the project-wide overrides
    // belong to the built-in providers.
    const locator = selectedGeocodingLocator(input);
    const endpoints = locator ? locatorEndpoints(locator) : provider;
    return {
      providerId: provider.id,
      forwardEndpoint: endpoints.defaultForwardEndpoint,
      reverseEndpoint: endpoints.defaultReverseEndpoint,
      email: input.email?.trim() || undefined,
      ...(locator ? { locator } : {}),
    };
  }
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

/**
 * Resolves the access token for a secured locator, or undefined to send the
 * request without one. See {@link setGeocodingTokenProvider}.
 */
export type GeocodingTokenProvider = (locator: GeocodingLocator) => Promise<string | undefined>;

let geocodingTokenProvider: GeocodingTokenProvider | null = null;

/**
 * Register how a secured locator gets its token, or pass null to remove it.
 *
 * Core has no sign-in of its own: the app installs a provider that reuses its
 * ArcGIS portal sessions. It is only consulted for a locator that names a
 * `portalUrl`, and the provider decides whether that portal's token may be sent
 * to the locator's host, so a token is never forwarded to an unrelated server.
 *
 * @param provider - The token provider, or null.
 */
export function setGeocodingTokenProvider(provider: GeocodingTokenProvider | null): void {
  geocodingTokenProvider = provider;
}

/** The token to send with a request for `config`, when its locator is secured. */
async function locatorToken(config: GeocoderConfig): Promise<string | undefined> {
  const locator = config.providerId === "arcgis-locator" ? config.locator : undefined;
  if (!locator?.portalUrl || !geocodingTokenProvider) return undefined;
  return geocodingTokenProvider(locator);
}

/**
 * `url` with the locator's token added, when there is one. The token is only
 * attached to a request under the locator's own GeocodeServer URL, whatever
 * endpoint the config carries.
 *
 * @returns The URL, and whether a token was attached (such a request must not
 *   follow redirects, which could replay the token to another host).
 */
async function withLocatorToken(
  url: string,
  config: GeocoderConfig,
): Promise<{ url: string; token: boolean }> {
  const token = await locatorToken(config);
  if (!token) return { url, token: false };
  const withToken = new URL(url);
  const base = `${config.locator?.url}/`;
  if (!`${withToken.origin}${withToken.pathname}`.startsWith(base)) {
    throw new GeocoderServiceError(
      "The geocoding request does not go to the locator's own server, so its sign-in is not sent.",
    );
  }
  withToken.searchParams.set("token", token);
  return { url: withToken.toString(), token: true };
}

/**
 * Whether `config` can reverse-geocode: a locator only when its metadata
 * advertises `reverseGeocode` (unchecked locators are assumed to).
 *
 * @param config - The geocoder configuration.
 * @returns Whether reverse geocoding is available.
 */
export function geocoderSupportsReverse(config: GeocoderConfig): boolean {
  const provider = getGeocodingProvider(config.providerId);
  if (!provider.reverse) return false;
  return provider.id !== "arcgis-locator" || config.locator?.reverse !== false;
}

/**
 * Whether `config` offers suggestions while typing: a locator whose metadata
 * advertises `suggest`, searched through its single-line field (a suggestion
 * is a whole address, so it does not fit a structured field the user chose).
 *
 * @param config - The geocoder configuration.
 * @returns Whether {@link geocodeSuggest} can be used.
 */
export function geocoderSupportsSuggest(config: GeocoderConfig): boolean {
  const locator = config.providerId === "arcgis-locator" ? config.locator : undefined;
  if (!locator?.suggest || !locator.singleLineField) return false;
  return arcgisLocatorInputField(locator) === locator.singleLineField;
}

/**
 * Normalize an ArcGIS `suggest` response. Collection suggestions (a category
 * such as "Coffee shop") are dropped: they name many places, not one.
 *
 * @param data - The parsed response body.
 * @returns The suggestions.
 */
export function parseArcGISSuggestions(data: unknown): GeocodeSuggestion[] {
  const error = arcgisServiceError(data);
  if (error) throw error;
  const suggestions =
    data && typeof data === "object" ? (data as { suggestions?: unknown }).suggestions : undefined;
  if (!Array.isArray(suggestions)) return [];
  return suggestions.flatMap((entry) => {
    const text = readString(entry, "text")?.trim();
    const magicKey = readString(entry, "magicKey");
    const collection = (entry as { isCollection?: unknown } | null)?.isCollection === true;
    return text && magicKey && !collection ? [{ text, magicKey }] : [];
  });
}

/**
 * Ask the selected locator for suggestions that complete `text`. Resolve one
 * with {@link geocodeForward} and its `magicKey`.
 *
 * @param text - What the user has typed so far.
 * @param options - Abort signal, configuration and the most suggestions wanted.
 * @returns The suggestions.
 * @throws GeocoderUnsupportedError When the geocoder does not suggest.
 * @throws GeocoderServiceError For an HTTP or service error.
 */
export async function geocodeSuggest(
  text: string,
  options: { signal?: AbortSignal; config?: GeocoderConfig; limit?: number } = {},
): Promise<GeocodeSuggestion[]> {
  const config = options.config ?? getGeocoderConfig();
  if (!geocoderSupportsSuggest(config)) {
    throw new GeocoderUnsupportedError("The selected geocoder does not offer suggestions.");
  }
  const url = new URL(`${requireLocator(config).url}/suggest`);
  url.searchParams.set("text", text);
  url.searchParams.set("f", "json");
  if (options.limit) url.searchParams.set("maxSuggestions", String(options.limit));
  const request = await withLocatorToken(url.toString(), config);
  const response = await geocodeFetch()(request.url, {
    signal: options.signal,
    headers: { Accept: "application/json" },
    ...(request.token ? { redirect: "error" as const } : {}),
  });
  if (!response.ok) {
    throw new GeocoderServiceError(`Geocoder returned HTTP ${response.status}`, response.status);
  }
  return parseArcGISSuggestions(await readGeocodeJson(response));
}

/**
 * Fetch and read a GeocodeServer's capabilities. A secured service is asked
 * with `token`.
 *
 * @param url - The locator's GeocodeServer URL (normalized first).
 * @param options - An abort signal and an optional token.
 * @returns The capabilities.
 * @throws GeocoderServiceError For an HTTP or service error.
 */
export async function fetchArcGISLocatorInfo(
  url: string,
  options: { signal?: AbortSignal; token?: string } = {},
): Promise<ArcGISLocatorCapabilities> {
  const base = normalizeArcGISLocatorUrl(url);
  if (!base) throw new GeocoderServiceError("Not an ArcGIS GeocodeServer URL.");
  const request = new URL(base);
  request.searchParams.set("f", "json");
  if (options.token) request.searchParams.set("token", options.token);
  const response = await geocodeFetch()(request.toString(), {
    signal: options.signal,
    headers: { Accept: "application/json" },
    // A redirect would replay the token to wherever it points.
    ...(options.token ? { redirect: "error" as const } : {}),
  });
  if (!response.ok) {
    throw new GeocoderServiceError(`Geocoder returned HTTP ${response.status}`, response.status);
  }
  return parseArcGISLocatorInfo(await readGeocodeJson(response));
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
  options: {
    signal?: AbortSignal;
    config?: GeocoderConfig;
    limit?: number;
    /** A {@link GeocodeSuggestion}'s key, to resolve that suggestion. */
    magicKey?: string;
    /** Ask for each candidate's own attributes, where the provider supports it. */
    attributes?: boolean;
  } = {},
): Promise<GeocodeMatch[]> {
  const config = options.config ?? getGeocoderConfig();
  const provider = getGeocodingProvider(config.providerId);
  const request = await withLocatorToken(
    provider.buildForwardUrl(config, query, {
      email: config.email,
      limit: options.limit,
      magicKey: options.magicKey,
      attributes: options.attributes,
    }),
    config,
  );
  const response = await geocodeFetch()(request.url, {
    signal: options.signal,
    headers: { Accept: "application/json" },
    ...(request.token ? { redirect: "error" as const } : {}),
  });
  if (!response.ok) {
    throw new GeocoderServiceError(`Geocoder returned HTTP ${response.status}`, response.status);
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
  if (!geocoderSupportsReverse(config)) {
    throw new GeocoderUnsupportedError("The selected geocoder does not support reverse geocoding.");
  }
  const request = await withLocatorToken(
    provider.buildReverseUrl(config, wrappedLon, lat, {
      email: config.email,
      zoom: options.zoom,
    }),
    config,
  );
  const response = await geocodeFetch()(request.url, {
    signal: options.signal,
    headers: { Accept: "application/json" },
    ...(request.token ? { redirect: "error" as const } : {}),
  });
  if (!response.ok) {
    throw new GeocoderServiceError(`Geocoder returned HTTP ${response.status}`, response.status);
  }
  const data: unknown = await readGeocodeJson(response);
  return provider.parseReverse(data);
}
