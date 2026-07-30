/**
 * Allowlisted upstream hosts the tiles worker may fetch. Named proxies
 * (OPM mosaics, USGS WMS, OAM meta, Source Cooperative, Protomaps) are never
 * an open proxy — but a 302 from an allowlisted URL to an arbitrary Location
 * would reintroduce that risk if `fetch` followed redirects automatically.
 */
export const TILES_ALLOWED_UPSTREAM_HOSTS = new Set([
  "s3-eu-west-1.amazonaws.com",
  "s3.us-east-2.amazonaws.com",
  "s3.amazonaws.com",
  "api.openaerialmap.org",
  "source.coop",
  "build.protomaps.com",
  "planetarymaps.usgs.gov",
]);

export const TILES_MAX_REDIRECT_HOPS = 5;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Whether a resolved upstream URL is HTTPS and on an allowlisted host.
 */
export function isAllowedTilesUpstreamUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && TILES_ALLOWED_UPSTREAM_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Fetch an allowlisted upstream URL, following redirects only while they stay
 * on HTTPS allowlisted hosts. Cross-host Locations are refused so a compromised
 * or misconfigured origin cannot turn the worker into an open proxy.
 */
export async function fetchAllowlistedUpstream(
  url: string,
  init: RequestInit = {},
  fetchImpl: FetchLike = fetch,
): Promise<Response> {
  if (!isAllowedTilesUpstreamUrl(url)) {
    throw new Error(`Refused fetch to non-allowlisted upstream: ${url}`);
  }

  let target = url;
  for (let hop = 0; hop <= TILES_MAX_REDIRECT_HOPS; hop++) {
    const response = await fetchImpl(target, { ...init, redirect: "manual" });
    if (response.status < 300 || response.status >= 400) {
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
