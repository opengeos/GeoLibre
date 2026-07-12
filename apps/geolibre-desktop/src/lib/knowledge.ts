/**
 * Wikipedia "knowledge card" client (Google Earth-style place info).
 *
 * Given a clicked or searched coordinate we ask Wikipedia's public API two
 * things: which geotagged articles sit near that point (the geosearch list),
 * and a plain-language summary + thumbnail for a chosen article (the REST
 * summary endpoint). Both are anonymous cross-origin GETs — Wikimedia serves
 * `Access-Control-Allow-Origin: *` for `origin=*` API calls and for the REST
 * summary route — so no proxy, key, or custom header (which would force a CORS
 * preflight) is needed, and the calls work in both the desktop and web builds
 * under their existing `connect-src https:` CSP.
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

/**
 * Normalise a UI locale to a Wikipedia language edition subdomain. Wikipedia
 * editions are keyed by the base language code (`pt`, not `pt-BR`), lowercase
 * ASCII letters only; anything else falls back to English so we never build a
 * request against a non-existent subdomain.
 */
export function wikipediaLang(locale: string | undefined | null): string {
  const base = (locale ?? "").split(/[-_]/)[0]?.toLowerCase() ?? "";
  return /^[a-z]{2,3}$/.test(base) ? base : "en";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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

/** Build the geosearch API URL for articles near a point. */
export function buildGeosearchUrl(
  lat: number,
  lon: number,
  {
    lang,
    radiusM = DEFAULT_NEARBY_RADIUS_M,
    limit = DEFAULT_NEARBY_LIMIT,
  }: NearbyOptions = {},
): string {
  const host = `${wikipediaLang(lang)}.wikipedia.org`;
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    list: "geosearch",
    gscoord: `${lat}|${lon}`,
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
    if (
      typeof r.title !== "string" ||
      !Number.isFinite(pageId) ||
      !isValidLatLon(lat, lon)
    ) {
      continue;
    }
    places.push({
      pageId,
      title: r.title,
      lat,
      lon,
      distanceM: Number.isFinite(Number(r.dist)) ? Number(r.dist) : 0,
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
  // Disambiguation and "not found" documents carry no useful card content.
  if (r.type === "disambiguation" || r.type === "https://mediawiki.org/wiki/HyperSwitch/errors/not_found") {
    return null;
  }
  const extract = typeof r.extract === "string" ? r.extract : "";
  const thumbnail = r.thumbnail as { source?: unknown } | undefined;
  const contentUrls = r.content_urls as
    | { desktop?: { page?: unknown } }
    | undefined;
  const coordinates = r.coordinates as { lat?: unknown; lon?: unknown } | undefined;
  const lat = Number(coordinates?.lat);
  const lon = Number(coordinates?.lon);
  const geotagged = isValidLatLon(lat, lon);
  return {
    title: r.title,
    extract,
    description:
      typeof r.description === "string" ? r.description : undefined,
    thumbnailUrl:
      typeof thumbnail?.source === "string" ? thumbnail.source : undefined,
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

async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { signal, headers: { Accept: "application/json" } });
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
  if (!isValidLatLon(lat, lon)) return [];
  const json = await getJson(buildGeosearchUrl(lat, lon, options), options.signal);
  return parseGeosearch(json);
}

/** Fetch the summary + thumbnail for a single article title, or null. */
export async function fetchArticleSummary(
  title: string,
  options: { lang?: string; signal?: AbortSignal } = {},
): Promise<WikiSummary | null> {
  const lang = wikipediaLang(options.lang);
  const json = await getJson(buildSummaryUrl(title, lang), options.signal);
  return parseSummary(json, lang);
}
