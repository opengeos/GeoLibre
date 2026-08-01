/**
 * Allowlisted upstream URL prefixes the tiles worker may fetch. Named proxies
 * (OPM mosaics, USGS WMS, OAM meta, Source Cooperative, Protomaps) are never
 * an open proxy — but a 302 from an allowlisted URL to an arbitrary Location
 * would reintroduce that risk if `fetch` followed redirects automatically.
 *
 * S3 entries are scoped to the known OPM dataset path prefixes (not the whole
 * shared `s3*.amazonaws.com` host) so a redirect cannot jump to another bucket.
 */
export const HDX_CKAN_SEARCH_UPSTREAM = "https://data.humdata.org/api/3/action/package_search";

export const TILES_ALLOWED_URL_PREFIXES = [
  "https://s3-eu-west-1.amazonaws.com/whereonmars.cartodb.net/",
  "https://s3.us-east-2.amazonaws.com/opmmarstiles/",
  "https://s3.amazonaws.com/opmbuilder/",
  "https://api.openaerialmap.org/",
  HDX_CKAN_SEARCH_UPSTREAM,
  "https://source.coop/",
  "https://build.protomaps.com/",
  "https://planetarymaps.usgs.gov/",
] as const;

/** @deprecated Prefer {@link TILES_ALLOWED_URL_PREFIXES}; kept for tests/docs. */
export const TILES_ALLOWED_UPSTREAM_HOSTS = new Set(
  TILES_ALLOWED_URL_PREFIXES.map((prefix) => new URL(prefix).hostname),
);

export const TILES_MAX_REDIRECT_HOPS = 5;

/** HTTP statuses that carry a Location and should be followed manually. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Cloudflare outgoing fetch options (`cf` cache hints, etc.). */
export type TilesFetchInit = RequestInit & {
  cf?: RequestInitCfProperties;
};

type FetchLike = (input: RequestInfo | URL, init?: TilesFetchInit) => Promise<Response>;

/**
 * Whether a resolved upstream URL is HTTPS and under an allowlisted
 * host+path prefix (not merely an allowlisted hostname).
 */
export function isAllowedTilesUpstreamUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    const candidate = `${parsed.origin}${parsed.pathname}`;
    return TILES_ALLOWED_URL_PREFIXES.some((prefix) =>
      prefix.endsWith("/") ? candidate.startsWith(prefix) : candidate === prefix,
    );
  } catch {
    return false;
  }
}

/**
 * Fetch an allowlisted upstream URL, following redirects only while they stay
 * under an allowlisted HTTPS prefix. Cross-prefix Locations are refused so a
 * compromised or misconfigured origin cannot turn the worker into an open proxy.
 */
export async function fetchAllowlistedUpstream(
  url: string,
  init: TilesFetchInit = {},
  fetchImpl: FetchLike = fetch,
): Promise<Response> {
  if (!isAllowedTilesUpstreamUrl(url)) {
    throw new Error(`Refused fetch to non-allowlisted upstream: ${url}`);
  }

  let target = url;
  for (let hop = 0; hop <= TILES_MAX_REDIRECT_HOPS; hop++) {
    const response = await fetchImpl(target, { ...init, redirect: "manual" });
    // Pass through non-redirect responses, including 304 Not Modified.
    if (!REDIRECT_STATUSES.has(response.status)) {
      return response;
    }
    const location = response.headers.get("location");
    if (!location) {
      return response;
    }
    const next = new URL(location, target).toString();
    if (!isAllowedTilesUpstreamUrl(next)) {
      throw new Error(`Refused redirect to non-allowlisted upstream: ${next}`);
    }
    target = next;
  }
  throw new Error("Too many upstream redirects");
}
