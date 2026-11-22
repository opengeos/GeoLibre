// tiles.geolibre.app
//
// A CORS-adding, edge-caching tile and service proxy for GeoLibre, keyed to a
// tight allowlist so it is never an open proxy. Route handlers are organized by
// upstream domain under `./routes/`.

import { fetchAllowlistedUpstream } from "./allowlisted-fetch";
import {
  EARTHDATA_CORS_HEADERS,
  EARTHDATA_DOWNLOAD_PATH,
  handleEarthdataDownload,
} from "./earthdata";
import { handleCatalogRoute } from "./routes/catalogs";
import { handleCctvRoute } from "./routes/cctv";
import { handleLiveFeedRoute } from "./routes/live-feeds";
import { handleOverpass, OVERPASS_PATH } from "./routes/overpass";
import { handlePmtilesRange, PMTILES_PATH } from "./routes/pmtiles";
import { CORS_HEADERS, isAllowedProxyOrigin, OVERPASS_CORS_HEADERS } from "./routes/shared";

/** Allowlisted OpenPlanetaryMap tile datasets -> their upstream base URL. */
const DATASETS: Record<string, string> = {
  "mars-mola-color-noshade":
    "https://s3-eu-west-1.amazonaws.com/whereonmars.cartodb.net/mola_color-noshade_global",
  "mars-viking-mdim21":
    "https://s3-eu-west-1.amazonaws.com/whereonmars.cartodb.net/viking_mdim21_global",
  "mars-hillshade": "https://s3.us-east-2.amazonaws.com/opmmarstiles/hillshade-tiles",
  "mars-mola-color": "https://s3-eu-west-1.amazonaws.com/whereonmars.cartodb.net/mola-color",
  "mars-mola-gray": "https://s3-eu-west-1.amazonaws.com/whereonmars.cartodb.net/mola-gray",
  "moon-hillshaded-albedo":
    "https://s3.amazonaws.com/opmbuilder/301_moon/tiles/w/hillshaded-albedo",
};

const TILE_PATH = /^\/opm\/([a-z0-9-]+)\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})\.png$/;
const CACHE_CONTROL = "public, max-age=3600, s-maxage=86400";
const NEGATIVE_CACHE_CONTROL = "public, max-age=300";

interface Env {
  TILES_RATE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
}

async function handleOpmTile(
  request: Request,
  ctx: ExecutionContext,
  match: RegExpExecArray,
): Promise<Response> {
  const [, dataset, z, x, y] = match;
  const base = Object.hasOwn(DATASETS, dataset) ? DATASETS[dataset] : undefined;
  if (!base) {
    return new Response(`Unknown dataset: ${dataset}`, {
      status: 404,
      headers: CORS_HEADERS,
    });
  }
  const zoom = Number(z);
  if (!Number.isInteger(zoom) || zoom < 0 || zoom > 24) {
    return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
  }
  const dim = 2 ** zoom;
  if (Number(x) >= dim || Number(y) >= dim) {
    return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
  }

  const cache = typeof caches === "undefined" ? null : caches.default;
  if (cache) {
    const cached = await cache.match(request);
    if (cached) return cached;
  }

  const upstream = `${base}/${z}/${x}/${y}.png`;
  let originResponse: Response;
  try {
    originResponse = await fetchAllowlistedUpstream(upstream, {
      cf: { cacheEverything: true, cacheTtl: 86400 },
    });
  } catch {
    return new Response("Bad Gateway", { status: 502, headers: CORS_HEADERS });
  }

  const headers = new Headers(CORS_HEADERS);
  headers.set("content-type", originResponse.headers.get("content-type") ?? "image/png");
  headers.set("cache-control", originResponse.ok ? CACHE_CONTROL : NEGATIVE_CACHE_CONTROL);

  const response = new Response(originResponse.body, {
    status: originResponse.status,
    headers,
  });
  if (cache && originResponse.status < 500 && originResponse.status !== 429) {
    ctx.waitUntil(cache.put(request, response.clone()));
  }
  return response;
}

export const tilesWorker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      const headers =
        url.pathname === OVERPASS_PATH
          ? OVERPASS_CORS_HEADERS
          : url.pathname === EARTHDATA_DOWNLOAD_PATH
            ? EARTHDATA_CORS_HEADERS
            : CORS_HEADERS;
      return new Response(null, { status: 204, headers });
    }

    if (env?.TILES_RATE_LIMITER) {
      const key = request.headers.get("CF-Connecting-IP") ?? "anonymous";
      const outcome = await env.TILES_RATE_LIMITER.limit({ key });
      if (!outcome.success) {
        return new Response("Too Many Requests", {
          status: 429,
          headers: { ...CORS_HEADERS, "retry-after": "60" },
        });
      }
    }

    if (url.pathname === OVERPASS_PATH && request.method === "POST") {
      return handleOverpass(request);
    }
    if (request.method !== "GET") {
      const overpass = url.pathname === OVERPASS_PATH;
      const allow = overpass ? "POST, OPTIONS" : "GET, OPTIONS";
      return new Response("Method Not Allowed", {
        status: 405,
        headers: {
          ...(overpass ? OVERPASS_CORS_HEADERS : CORS_HEADERS),
          allow,
        },
      });
    }

    if (url.pathname === "/" || url.pathname === "") {
      return new Response(
        "GeoLibre tile + service proxy.\n" +
          "  Passthrough: /opm/<dataset>/<z>/<x>/<y>.png\n" +
          `    Datasets: ${Object.keys(DATASETS).join(", ")}\n` +
          "  OpenAerialMap search: /oam/meta?bbox=...&limit=...\n" +
          "  NASA Earthdata granule download: /earthdata/download?url=... (Authorization: Bearer)\n" +
          "  CKAN search: /ckan/search?q=...&rows=...&start=...\n" +
          "  CelesTrak TLE groups: /celestrak/<group>\n" +
          "  Launch Library 2 recent missions: /launch-library/recent\n" +
          "  OpenSky live flights: /opensky/states\n" +
          "  adsb.lol military flights: /adsb-lol/military\n" +
          "  ADSBDB aircraft details: /adsbdb/aircraft/<icao>\n" +
          "  GTFS-Realtime transit: /transit/vehicles/<provider>\n" +
          "  NASA FIRMS active fires (24 h): /firms/viirs/<satellite>\n" +
          "  OpenStreetMap download: POST /overpass\n" +
          "  Source Cooperative metadata: /source-coop/products/... , /source-coop/feed\n" +
          "  GitHub repository file: /github-raw?url=https://github.com/.../raw/...\n" +
          "  Ocean Data Platform: /odp/tiles/<uuid>/<z>/<x>/<y>.pbf , /odp/features/<uuid>/items\n" +
          "  PMTiles range proxy: /pmtiles/<name>.pmtiles (Range header required)\n",
        {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        },
      );
    }

    if (url.pathname === EARTHDATA_DOWNLOAD_PATH) {
      if (!isAllowedProxyOrigin(request.headers.get("origin"))) {
        return new Response("Forbidden", { status: 403, headers: EARTHDATA_CORS_HEADERS });
      }
      return handleEarthdataDownload(request);
    }

    const catalogResponse = handleCatalogRoute(request, url);
    if (catalogResponse) return catalogResponse;

    const liveFeedResponse = handleLiveFeedRoute(request, url, ctx);
    if (liveFeedResponse) return liveFeedResponse;

    const cctvResponse = handleCctvRoute(request, url, ctx);
    if (cctvResponse) return cctvResponse;

    const pmtilesMatch = PMTILES_PATH.exec(url.pathname);
    if (pmtilesMatch) {
      return handlePmtilesRange(request, pmtilesMatch[1]);
    }

    const tileMatch = TILE_PATH.exec(url.pathname);
    if (!tileMatch) {
      return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
    }
    return handleOpmTile(request, ctx, tileMatch);
  },
};

export default tilesWorker;
