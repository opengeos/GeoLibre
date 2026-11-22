import {
  ADSB_LOL_MILITARY_UPSTREAM,
  ADSBDB_AIRCRAFT_UPSTREAM,
  fetchAllowlistedUpstream,
  FIRMS_UPSTREAMS,
  OPEN_SKY_STATES_UPSTREAM,
  TRANSIT_UPSTREAMS,
} from "../allowlisted-fetch";
import { CORS_HEADERS, isAllowedProxyOrigin, readResponseBytesWithLimit } from "./shared";

const CELESTRAK_PATH = /^\/celestrak\/(stations|visual|gps-ops|glo-ops|galileo|geo|starlink)$/;
const CELESTRAK_UPSTREAM = "https://celestrak.org/NORAD/elements/gp.php";
const CELESTRAK_STARLINK_UPSTREAM = "https://celestrak.org/NORAD/elements/supplemental/sup-gp.php";
const CELESTRAK_CACHE_CONTROL = "public, max-age=21600";

const LAUNCH_LIBRARY_PATH = "/launch-library/recent";
const LAUNCH_LIBRARY_UPSTREAM = "https://ll.thespacedevs.com/2.3.0/launches/";
const LAUNCH_LIBRARY_CACHE_CONTROL = "public, max-age=900";

const OPEN_SKY_PATH = "/opensky/states";
const ADSB_LOL_MILITARY_PATH = "/adsb-lol/military";
const ADSBDB_AIRCRAFT_PATH = /^\/adsbdb\/aircraft\/([0-9a-fA-F]{6})$/;
const OPEN_SKY_CACHE_SECONDS = 30;
const ADSB_LOL_CACHE_SECONDS = 15;
const AIRCRAFT_FEED_MAX_BODY_BYTES = 25 * 1024 * 1024;

const TRANSIT_PATH = /^\/transit\/vehicles\/([a-z0-9][a-z0-9-]{1,63})$/;
const TRANSIT_MAX_BODY_BYTES = 8 * 1024 * 1024;
const TRANSIT_CACHE_SECONDS = 15;
const OVAPI_TRANSIT_CACHE_SECONDS = 60;

const FIRMS_PATH = /^\/firms\/viirs\/([a-z0-9][a-z0-9-]{1,31})$/;
const FIRMS_MAX_BODY_BYTES = 32 * 1024 * 1024;
const FIRMS_CACHE_SECONDS = 30 * 60;

function isFirmsCsv(body: Uint8Array): boolean {
  const head = new TextDecoder().decode(body.subarray(0, 256)).trimStart().toLowerCase();
  return head.startsWith("latitude,longitude,");
}

async function handleCelestrak(request: Request, group: string): Promise<Response> {
  if (!isAllowedProxyOrigin(request.headers.get("origin"))) {
    return new Response("Forbidden", { status: 403, headers: CORS_HEADERS });
  }
  const starlink = group === "starlink";
  const upstream = new URL(starlink ? CELESTRAK_STARLINK_UPSTREAM : CELESTRAK_UPSTREAM);
  upstream.searchParams.set(starlink ? "FILE" : "GROUP", group);
  upstream.searchParams.set("FORMAT", "tle");
  let originResponse: Response;
  try {
    originResponse = await fetchAllowlistedUpstream(upstream.toString(), {
      headers: {
        accept: "text/plain",
        "user-agent": "GeoLibre-CelesTrak-Proxy/1.0 (+https://geolibre.org)",
      },
      cf: { cacheEverything: true, cacheTtl: 21_600 },
    });
  } catch {
    return new Response("Bad Gateway", { status: 502, headers: CORS_HEADERS });
  }
  const headers = new Headers(CORS_HEADERS);
  headers.set("content-type", "text/plain; charset=utf-8");
  headers.set("cache-control", originResponse.ok ? CELESTRAK_CACHE_CONTROL : "no-store");
  return new Response(originResponse.body, {
    status: originResponse.status,
    headers,
  });
}

async function handleLaunchLibrary(request: Request): Promise<Response> {
  if (!isAllowedProxyOrigin(request.headers.get("origin"))) {
    return new Response("Forbidden", { status: 403, headers: CORS_HEADERS });
  }
  const now = new Date(Math.floor(Date.now() / 900_000) * 900_000);
  const upstream = new URL(LAUNCH_LIBRARY_UPSTREAM);
  upstream.searchParams.set("net__gte", new Date(now.getTime() - 30 * 86_400_000).toISOString());
  upstream.searchParams.set("net__lte", now.toISOString());
  upstream.searchParams.set("limit", "100");
  upstream.searchParams.set("mode", "detailed");
  let originResponse: Response;
  try {
    originResponse = await fetchAllowlistedUpstream(upstream.toString(), {
      headers: {
        accept: "application/json",
        "user-agent": "GeoLibre-Launch-Library-Proxy/1.0 (+https://geolibre.org)",
      },
      cf: {
        cacheEverything: true,
        cacheTtlByStatus: { "200-299": 900, "300-599": -1 },
      },
    });
  } catch {
    return new Response("Bad Gateway", { status: 502, headers: CORS_HEADERS });
  }
  const headers = new Headers(CORS_HEADERS);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", originResponse.ok ? LAUNCH_LIBRARY_CACHE_CONTROL : "no-store");
  return new Response(originResponse.body, {
    status: originResponse.status,
    headers,
  });
}

async function handleAircraftFeed(
  request: Request,
  ctx: ExecutionContext,
  upstream: string,
  cacheSeconds: number,
  arrayKey: "states" | "ac",
): Promise<Response> {
  if (!isAllowedProxyOrigin(request.headers.get("origin"))) {
    return new Response("Forbidden", { status: 403, headers: CORS_HEADERS });
  }
  const cache = typeof caches === "undefined" ? null : caches.default;
  const cached = await cache?.match(request);
  if (cached) return cached;
  let originResponse: Response;
  try {
    originResponse = await fetchAllowlistedUpstream(upstream, {
      headers: {
        accept: "application/json",
        "user-agent": "GeoLibre-Aircraft-Proxy/1.0 (+https://geolibre.org)",
      },
    });
  } catch {
    return new Response("Bad Gateway", { status: 502, headers: CORS_HEADERS });
  }
  const body = await readResponseBytesWithLimit(originResponse, AIRCRAFT_FEED_MAX_BODY_BYTES);
  if (!body) return new Response("Bad Gateway", { status: 502, headers: CORS_HEADERS });
  if (originResponse.ok) {
    try {
      const payload = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
      if (!payload || typeof payload !== "object" || !Array.isArray(payload[arrayKey])) {
        throw new Error("Malformed aircraft feed");
      }
    } catch {
      return new Response("Bad Gateway", { status: 502, headers: CORS_HEADERS });
    }
  }
  const headers = new Headers(CORS_HEADERS);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", originResponse.ok ? `public, max-age=${cacheSeconds}` : "no-store");
  const response = new Response(body, {
    status: originResponse.status,
    headers,
  });
  if (originResponse.ok && cache) ctx.waitUntil(cache.put(request, response.clone()));
  return response;
}

async function handleAdsbdbAircraft(
  request: Request,
  ctx: ExecutionContext,
  icao: string,
): Promise<Response> {
  if (!isAllowedProxyOrigin(request.headers.get("origin"))) {
    return new Response("Forbidden", { status: 403, headers: CORS_HEADERS });
  }
  const cache = typeof caches === "undefined" ? null : caches.default;
  const cached = await cache?.match(request);
  if (cached) return cached;
  let originResponse: Response;
  try {
    originResponse = await fetchAllowlistedUpstream(
      `${ADSBDB_AIRCRAFT_UPSTREAM}${icao.toLowerCase()}`,
      {
        headers: { accept: "application/json" },
      },
    );
  } catch {
    return new Response("Bad Gateway", { status: 502, headers: CORS_HEADERS });
  }
  const headers = new Headers(CORS_HEADERS);
  headers.set("content-type", "application/json; charset=utf-8");
  if (originResponse.status === 404) {
    await originResponse.body?.cancel().catch(() => undefined);
    headers.set("cache-control", "public, max-age=3600");
    const response = new Response('{"response":{"aircraft":null}}', {
      status: 200,
      headers,
    });
    if (cache) ctx.waitUntil(cache.put(request, response.clone()));
    return response;
  }
  const body = await readResponseBytesWithLimit(originResponse, 1024 * 1024);
  if (!body) return new Response("Bad Gateway", { status: 502, headers: CORS_HEADERS });
  if (originResponse.ok) {
    try {
      const payload = JSON.parse(new TextDecoder().decode(body)) as {
        response?: { aircraft?: unknown };
      };
      const aircraft = payload.response?.aircraft;
      if (!aircraft || typeof aircraft !== "object" || Array.isArray(aircraft)) {
        throw new Error("Malformed ADSBDB response");
      }
    } catch {
      return new Response("Bad Gateway", { status: 502, headers: CORS_HEADERS });
    }
  }
  headers.set("cache-control", originResponse.ok ? "public, max-age=86400" : "no-store");
  const response = new Response(body, {
    status: originResponse.status,
    headers,
  });
  if (originResponse.ok && cache) ctx.waitUntil(cache.put(request, response.clone()));
  return response;
}

async function handleTransitFeed(
  request: Request,
  ctx: ExecutionContext,
  feedId: string,
): Promise<Response> {
  if (!isAllowedProxyOrigin(request.headers.get("origin"))) {
    return new Response("Forbidden", { status: 403, headers: CORS_HEADERS });
  }
  if (!Object.hasOwn(TRANSIT_UPSTREAMS, feedId)) {
    return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
  }
  const cache = typeof caches === "undefined" ? null : caches.default;
  const cached = await cache?.match(request);
  if (cached) return cached;
  const upstream = TRANSIT_UPSTREAMS[feedId as keyof typeof TRANSIT_UPSTREAMS];
  let originResponse: Response;
  try {
    originResponse = await fetchAllowlistedUpstream(upstream, {
      headers: {
        accept: "application/x-protobuf,application/octet-stream",
        "user-agent": "GeoLibre-Transit-Proxy/1.0 (+https://geolibre.org)",
      },
    });
  } catch {
    return new Response("Bad Gateway", { status: 502, headers: CORS_HEADERS });
  }
  const body = await readResponseBytesWithLimit(originResponse, TRANSIT_MAX_BODY_BYTES);
  if (!originResponse.ok || !body || body.byteLength === 0) {
    return new Response("Bad Gateway", { status: 502, headers: CORS_HEADERS });
  }
  const headers = new Headers(CORS_HEADERS);
  headers.set("content-type", "application/x-protobuf");
  const cacheSeconds = feedId === "ovapi-nl" ? OVAPI_TRANSIT_CACHE_SECONDS : TRANSIT_CACHE_SECONDS;
  headers.set("cache-control", `public, max-age=${cacheSeconds}`);
  const response = new Response(body, { status: 200, headers });
  if (cache) ctx.waitUntil(cache.put(request, response.clone()));
  return response;
}

async function handleFirmsFeed(
  request: Request,
  ctx: ExecutionContext,
  satellite: string,
): Promise<Response> {
  if (!isAllowedProxyOrigin(request.headers.get("origin"))) {
    return new Response("Forbidden", { status: 403, headers: CORS_HEADERS });
  }
  if (!Object.hasOwn(FIRMS_UPSTREAMS, satellite)) {
    return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
  }
  const cache = typeof caches === "undefined" ? null : caches.default;
  const cached = await cache?.match(request);
  if (cached) return cached;
  const upstream = FIRMS_UPSTREAMS[satellite as keyof typeof FIRMS_UPSTREAMS];
  let originResponse: Response;
  try {
    originResponse = await fetchAllowlistedUpstream(upstream, {
      headers: {
        accept: "text/csv",
        "user-agent": "GeoLibre-FIRMS-Proxy/1.0 (+https://geolibre.org)",
      },
    });
  } catch {
    return new Response("Bad Gateway", { status: 502, headers: CORS_HEADERS });
  }
  const body = await readResponseBytesWithLimit(originResponse, FIRMS_MAX_BODY_BYTES);
  if (!originResponse.ok || !body || !isFirmsCsv(body)) {
    return new Response("Bad Gateway", { status: 502, headers: CORS_HEADERS });
  }
  const headers = new Headers(CORS_HEADERS);
  headers.set("content-type", "text/csv; charset=utf-8");
  headers.set("cache-control", `public, max-age=${FIRMS_CACHE_SECONDS}`);
  const response = new Response(body, { status: 200, headers });
  if (cache) ctx.waitUntil(cache.put(request, response.clone()));
  return response;
}

/** Route live-feed proxy requests (CelesTrak, Launch Library, OpenSky, ADS-B, Transit, FIRMS). */
export function handleLiveFeedRoute(
  request: Request,
  url: URL,
  ctx: ExecutionContext,
): Promise<Response> | null {
  const celestrakMatch = CELESTRAK_PATH.exec(url.pathname);
  if (celestrakMatch) return handleCelestrak(request, celestrakMatch[1]);
  if (url.pathname === LAUNCH_LIBRARY_PATH) return handleLaunchLibrary(request);
  if (url.pathname === OPEN_SKY_PATH) {
    return handleAircraftFeed(
      request,
      ctx,
      OPEN_SKY_STATES_UPSTREAM,
      OPEN_SKY_CACHE_SECONDS,
      "states",
    );
  }
  if (url.pathname === ADSB_LOL_MILITARY_PATH) {
    return handleAircraftFeed(
      request,
      ctx,
      ADSB_LOL_MILITARY_UPSTREAM,
      ADSB_LOL_CACHE_SECONDS,
      "ac",
    );
  }
  const adsbdbMatch = ADSBDB_AIRCRAFT_PATH.exec(url.pathname);
  if (adsbdbMatch) return handleAdsbdbAircraft(request, ctx, adsbdbMatch[1]);
  const transitMatch = TRANSIT_PATH.exec(url.pathname);
  if (transitMatch) return handleTransitFeed(request, ctx, transitMatch[1]);
  const firmsMatch = FIRMS_PATH.exec(url.pathname);
  if (firmsMatch) return handleFirmsFeed(request, ctx, firmsMatch[1]);
  return null;
}
