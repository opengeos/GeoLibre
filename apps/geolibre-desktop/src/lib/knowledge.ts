/**
 * Wikipedia "knowledge card" client (Google Earth-style place info).
 *
 * Given a clicked or searched coordinate we ask Wikipedia's public API two
 * things: which geotagged articles sit near that point (the geosearch list),
 * and a plain-language summary + thumbnail for a chosen article (the REST
 * summary endpoint). Both are anonymous cross-origin GETs — Wikimedia serves
 * `Access-Control-Allow-Origin: *` for `origin=*` API calls and for the REST
 * summary route — so no proxy or API key is needed. We send only
 * `Accept: application/json`, a CORS-safelisted header that triggers no
 * preflight; adding any non-safelisted header would, so keep requests to
 * safelisted headers. The calls work in both the desktop and web builds under
 * their existing `connect-src https:` CSP.
 *
 * All network functions send the queried coordinate/title to Wikimedia, so the
 * caller gates the first use behind a one-time consent notice (see
 * {@link ./knowledge-consent}), mirroring the reverse-geocode tool.
 *
 * The URL builders and response parsers are pure and exported for unit testing.
 */

/** A geotagged Wikipedia article near a point, from the geosearch API. */
export interface WikiNearbyPlace {
  pageId: number;
  title: string;
  lat: number;
  lon: number;
  /** Great-circle distance from the query point in metres (from the API). */
  distanceM: number;
}

/** A plain-language article summary from the REST summary endpoint. */
export interface WikiSummary {
  title: string;
  /** Plain-text summary extract. */
  extract: string;
  /** Short one-line description (e.g. "Capital of France"), when present. */
  description?: string;
  /** Thumbnail image URL, when the article has a lead image. */
  thumbnailUrl?: string;
  /** Canonical desktop article URL for the "Read more" link. */
  contentUrl: string;
  /** Article coordinates, when the article is geotagged. */
  lat?: number;
  lon?: number;
  /** Wikipedia language edition the summary came from. */
  lang: string;
}

/** Default search radius in metres (the API caps `gsradius` at 10 000). */
export const DEFAULT_NEARBY_RADIUS_M = 10_000;
/** Default number of nearby articles to request. */
export const DEFAULT_NEARBY_LIMIT = 12;
/** Wikimedia's hard cap on `gsradius` (metres) and `gslimit`. */
const MAX_RADIUS_M = 10_000;
const MIN_RADIUS_M = 10;
const MAX_LIMIT = 50;

interface NearbyOptions {
  lang?: string;
  radiusM?: number;
  limit?: number;
  signal?: AbortSignal;
}

/** Split a locale on its region separator, e.g. `pt-BR` / `zh_Hans`. */
const LOCALE_SEPARATOR_RE = /[-_]/;
/** A bare 2-3 letter language code, the shape of a Wikipedia edition subdomain. */
const LANGUAGE_CODE_RE = /^[a-z]{2,3}$/;

/**
 * Normalise a UI locale to a Wikipedia language edition subdomain. Wikipedia
 * editions are keyed by the base language code (`pt`, not `pt-BR`), lowercase
 * ASCII letters only; anything else falls back to English so we never build a
 * request against a non-existent subdomain.
 */
export function wikipediaLang(locale: string | undefined | null): string {
  const base = (locale ?? "").split(LOCALE_SEPARATOR_RE)[0]?.toLowerCase() ?? "";
  return LANGUAGE_CODE_RE.test(base) ? base : "en";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Wrap a longitude into [-180, 180]. MapLibre reports unwrapped longitudes once
 * the map has been panned across the antimeridian (e.g. `190` or `-370`), which
 * the Wikipedia API would reject; normalising keeps those real clicks valid.
 */
export function normalizeLon(lon: number): number {
  if (!Number.isFinite(lon)) return lon;
  // Leave in-range values exactly as given; only wrap when out of range, so
  // ordinary longitudes are never perturbed by the modulo's floating-point drift.
  if (lon >= -180 && lon <= 180) return lon;
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/** Whether a coordinate pair is finite and within valid lat/lon bounds. */
export function isValidLatLon(lat: number, lon: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}

/** Decimals used when formatting a coordinate for the `gscoord` parameter. */
const COORD_DECIMALS = 6;

/**
 * Format a coordinate for `gscoord` with fixed decimals. A raw template
 * interpolation would emit exponential notation for a near-zero value (e.g.
 * `5e-8` near the equator/prime meridian), which the API does not parse.
 */
function formatCoord(value: number): string {
  return Number.isFinite(value) ? value.toFixed(COORD_DECIMALS) : String(value);
}

/** Build the geosearch API URL for articles near a point. */
export function buildGeosearchUrl(
  lat: number,
  lon: number,
  { lang, radiusM = DEFAULT_NEARBY_RADIUS_M, limit = DEFAULT_NEARBY_LIMIT }: NearbyOptions = {},
): string {
  const host = `${wikipediaLang(lang)}.wikipedia.org`;
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    list: "geosearch",
    gscoord: `${formatCoord(lat)}|${formatCoord(normalizeLon(lon))}`,
    gsradius: String(Math.round(clamp(radiusM, MIN_RADIUS_M, MAX_RADIUS_M))),
    gslimit: String(Math.round(clamp(limit, 1, MAX_LIMIT))),
    // Anonymous cross-origin access; returns permissive CORS headers.
    origin: "*",
  });
  return `https://${host}/w/api.php?${params.toString()}`;
}

/** Build the REST summary URL for a single article title. */
export function buildSummaryUrl(title: string, lang?: string): string {
  const host = `${wikipediaLang(lang)}.wikipedia.org`;
  // The REST route wants the title with spaces as underscores, then
  // percent-encoded so slashes and other reserved characters survive.
  const slug = encodeURIComponent(title.replace(/ /g, "_"));
  return `https://${host}/api/rest_v1/page/summary/${slug}`;
}

/** Parse a geosearch JSON response into typed, sorted nearby places. */
export function parseGeosearch(json: unknown): WikiNearbyPlace[] {
  const rows = (json as { query?: { geosearch?: unknown } })?.query?.geosearch;
  if (!Array.isArray(rows)) return [];
  const places: WikiNearbyPlace[] = [];
  for (const row of rows) {
    const r = row as Record<string, unknown>;
    const pageId = Number(r.pageid);
    const lat = Number(r.lat);
    const lon = Number(r.lon);
    if (typeof r.title !== "string" || !Number.isFinite(pageId) || !isValidLatLon(lat, lon)) {
      continue;
    }
    places.push({
      pageId,
      title: r.title,
      lat,
      lon,
      // Unknown distance sorts last (Infinity), never as the nearest article.
      distanceM: Number.isFinite(Number(r.dist)) ? Number(r.dist) : Number.POSITIVE_INFINITY,
    });
  }
  // The API returns nearest-first, but sort defensively so the card can always
  // treat the first entry as the closest article.
  return places.sort((a, b) => a.distanceM - b.distanceM);
}

/** Parse a REST summary JSON response into a typed summary, or null. */
export function parseSummary(json: unknown, lang: string): WikiSummary | null {
  const r = json as Record<string, unknown> | null | undefined;
  if (!r || typeof r.title !== "string") return null;
  // Disambiguation pages return HTTP 200 but carry no single-place content, so
  // they reach this parser; a missing article ("not found") is a 404 handled by
  // fetchArticleSummary before the body is ever parsed here.
  if (r.type === "disambiguation") return null;
  const extract = typeof r.extract === "string" ? r.extract : "";
  const thumbnail = r.thumbnail as { source?: unknown } | undefined;
  const contentUrls = r.content_urls as { desktop?: { page?: unknown } } | undefined;
  const coordinates = r.coordinates as { lat?: unknown; lon?: unknown } | undefined;
  const lat = Number(coordinates?.lat);
  const lon = Number(coordinates?.lon);
  const geotagged = isValidLatLon(lat, lon);
  return {
    title: r.title,
    extract,
    description: typeof r.description === "string" ? r.description : undefined,
    thumbnailUrl: typeof thumbnail?.source === "string" ? thumbnail.source : undefined,
    contentUrl:
      typeof contentUrls?.desktop?.page === "string"
        ? contentUrls.desktop.page
        : `https://${wikipediaLang(lang)}.wikipedia.org/wiki/${encodeURIComponent(
            r.title.replace(/ /g, "_"),
          )}`,
    lat: geotagged ? lat : undefined,
    lon: geotagged ? lon : undefined,
    lang,
  };
}

/** Abort a Wikipedia request after this long if nothing else cancels it (ms). */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * `fetch` with a default timeout combined with the caller's abort signal, so a
 * stalled network can never hang a request — and the card stuck in "loading" —
 * indefinitely. Either the caller aborting or the timeout firing cancels it.
 */
async function fetchWithTimeout(url: string, signal?: AbortSignal): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  // `abort` only fires on a future transition, so honour a signal that is
  // already aborted by cancelling up front rather than starting the fetch.
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", () => controller.abort(), { once: true });
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetchWithTimeout(url, signal);
  if (!response.ok) {
    throw new Error(`Wikipedia request failed: ${response.status}`);
  }
  return response.json();
}

/** Fetch geotagged Wikipedia articles near a point (nearest first). */
export async function fetchNearbyPlaces(
  lat: number,
  lon: number,
  options: NearbyOptions = {},
): Promise<WikiNearbyPlace[]> {
  // Wrap the longitude first: a click past the antimeridian arrives unwrapped
  // (e.g. 190) and would otherwise fail the bounds check and return nothing.
  const wrappedLon = normalizeLon(lon);
  if (!isValidLatLon(lat, wrappedLon)) return [];
  const json = await getJson(buildGeosearchUrl(lat, wrappedLon, options), options.signal);
  return parseGeosearch(json);
}

/**
 * Fetch the summary + thumbnail for a single article title, or null when there
 * is no usable article. A 404 (a missing or renamed title) resolves to null so
 * the card shows the friendly empty state instead of a generic error; other
 * non-OK responses still throw and surface as an error.
 */
export async function fetchArticleSummary(
  title: string,
  options: { lang?: string; signal?: AbortSignal } = {},
): Promise<WikiSummary | null> {
  const lang = wikipediaLang(options.lang);
  const response = await fetchWithTimeout(buildSummaryUrl(title, lang), options.signal);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Wikipedia request failed: ${response.status}`);
  }
  return parseSummary(await response.json(), lang);
}
