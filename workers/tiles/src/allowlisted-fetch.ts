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
// Prefer the reachable `z` backend instead of the round-robin hostname:
// requests from Cloudflare's edge currently receive a synthetic 521 from the
// latter. A second explicitly allowlisted public instance handles transient
// overloads without turning the route into an open proxy.
export const OVERPASS_API_UPSTREAM = "https://z.overpass-api.de/api/interpreter";
export const OVERPASS_API_FALLBACK_UPSTREAM = "https://overpass.private.coffee/api/interpreter";
export const OPEN_SKY_STATES_UPSTREAM = "https://opensky-network.org/api/states/all";
export const ADSB_LOL_MILITARY_UPSTREAM = "https://api.adsb.lol/v2/mil";
export const ADSBDB_AIRCRAFT_UPSTREAM = "https://api.adsbdb.com/v0/aircraft/";
export const AUSTIN_CCTV_FRAME_UPSTREAM = "https://cctv.austinmobility.io/image/";
export const CALGARY_CCTV_FRAME_UPSTREAM = "https://trafficcam.calgary.ca/";
export const ONTARIO_CCTV_CATALOG_UPSTREAM = "https://511on.ca/api/v2/get/cameras";
export const ONTARIO_CCTV_FRAME_UPSTREAM = "https://511on.ca/map/Cctv/";
export const DRIVEBC_CCTV_CATALOG_UPSTREAM = "https://www.drivebc.ca/api/webcams/";
export const NSW_CCTV_CATALOG_UPSTREAM = "https://data.livetraffic.com/cameras/traffic-cam.json";
export const NSW_CCTV_FRAME_UPSTREAM =
  "https://webcams.transport.nsw.gov.au/livetraffic-webcams/cameras/";
export const CALTRANS_CCTV_UPSTREAM = "https://cwwp2.dot.ca.gov/data/";
export const TRANSIT_UPSTREAMS = {
  mbta: "https://cdn.mbta.com/realtime/VehiclePositions.pb",
  "capmetro-austin": "https://data.texas.gov/download/eiei-9rpf/application%2Foctet-stream",
  "metrotransit-msp": "https://svc.metrotransit.org/mtgtfs/vehiclepositions.pb",
  "hsl-helsinki": "https://realtime.hsl.fi/realtime/vehicle-positions/v2/hsl",
  "ovapi-nl": "https://gtfs.ovapi.nl/nl/vehiclePositions.pb",
  "translink-seq": "https://gtfsrt.api.translink.com.au/api/realtime/seq/VehiclePositions",
} as const;

/**
 * NASA FIRMS' keyless global 24-hour VIIRS active-fire files. The keyed area
 * API is not needed for a whole-world snapshot, but these files send no CORS
 * header, so the browser build reads them through `/firms/viirs/<satellite>`.
 */
export const FIRMS_UPSTREAMS = {
  "noaa-20":
    "https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_Global_24h.csv",
  "noaa-21":
    "https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-21-viirs-c2/csv/J2_VIIRS_C2_Global_24h.csv",
  "suomi-npp":
    "https://firms.modaps.eosdis.nasa.gov/data/active_fire/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_Global_24h.csv",
} as const;

export const TILES_ALLOWED_URL_PREFIXES = [
  "https://s3-eu-west-1.amazonaws.com/whereonmars.cartodb.net/",
  "https://s3.us-east-2.amazonaws.com/opmmarstiles/",
  "https://s3.amazonaws.com/opmbuilder/",
  "https://api.openaerialmap.org/",
  HDX_CKAN_SEARCH_UPSTREAM,
  OVERPASS_API_UPSTREAM,
  OVERPASS_API_FALLBACK_UPSTREAM,
  OPEN_SKY_STATES_UPSTREAM,
  ADSB_LOL_MILITARY_UPSTREAM,
  ADSBDB_AIRCRAFT_UPSTREAM,
  AUSTIN_CCTV_FRAME_UPSTREAM,
  CALGARY_CCTV_FRAME_UPSTREAM,
  ONTARIO_CCTV_CATALOG_UPSTREAM,
  ONTARIO_CCTV_FRAME_UPSTREAM,
  DRIVEBC_CCTV_CATALOG_UPSTREAM,
  NSW_CCTV_CATALOG_UPSTREAM,
  NSW_CCTV_FRAME_UPSTREAM,
  CALTRANS_CCTV_UPSTREAM,
  ...Object.values(TRANSIT_UPSTREAMS),
  ...Object.values(FIRMS_UPSTREAMS),
  // CapMetro's fixed Socrata download endpoint redirects to a versioned file
  // path on the same public-data host.
  "https://data.texas.gov/api/views/",
  "https://source.coop/",
  "https://build.protomaps.com/",
  "https://planetarymaps.usgs.gov/",
  "https://celestrak.org/NORAD/elements/gp.php",
  "https://celestrak.org/NORAD/elements/supplemental/sup-gp.php",
  "https://ll.thespacedevs.com/2.3.0/launches/",
  "https://raw.githubusercontent.com/",
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
