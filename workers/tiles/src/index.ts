// tiles.geolibre.app
//
// A CORS-adding, edge-caching tile service for GeoLibre's planetary basemaps.
// It does two jobs, both keyed to a tight allowlist so it is never an open proxy:
//
//   1. `/opm/<dataset>/<z>/<x>/<y>.png` — a plain reverse proxy for the
//      OpenPlanetaryMap raster mosaics (Mars, Moon).
//   2. `/wms/<dataset>/<z>/<x>/<y>.png` — reprojects a USGS Astrogeology WMS
//      layer (Mercury, Venus, the Galilean moons, Titan, Pluto, Charon) from
//      equirectangular to Web Mercator on the fly (see reproject.ts).
//
// Why (1) exists: MapLibre GL fetches raster tiles with `fetch()`, which
// enforces CORS. OpenPlanetaryMap's single-layer mosaics are served straight
// from S3 buckets that send no `Access-Control-Allow-Origin` header, so the
// browser blocks them and the map renders black. (The openplanetarymap.org site
// gets away with it because Leaflet loads tiles as plain <img> elements, which
// are not CORS-checked.) A same-origin dev proxy exists, but the web build
// (nginx), desktop build (Tauri) and Jupyter embed have no shared proxy — a
// public Worker is the one URL that works uniformly across all of them.
//
// Why (2) exists: the USGS `planetarymaps.usgs.gov` WMS only offers EPSG:4326
// (equirectangular) for these bodies — no EPSG:3857 — so MapLibre can't consume
// it directly. The Worker requests one WMS window per tile, warps it to Web
// Mercator, and re-emits it with CORS. This is CPU-bound (PNG decode + encode);
// each tile is computed once and then served from the edge cache, so raise
// `limits.cpu_ms` in wrangler.toml if cold tiles ever time out on your plan.
//
// The Worker fetches each tile server-side (no CORS applies server-to-server),
// re-emits it with `Access-Control-Allow-Origin: *`, and caches it at the edge
// so repeat requests are served from Cloudflare's PoP rather than round-tripping
// upstream — faster and gentler on the origins than hitting them directly.
//
// The OPM tiles are TMS (flipped Y); MapLibre applies the flip before the
// request reaches the Worker, so the Worker treats <z>/<x>/<y> as opaque and
// forwards them unchanged. The reprojected WMS tiles are standard XYZ.

import UPNG from "upng-js";
import {
  remapRowsToMercator,
  tileGeoBounds,
  wmsBboxFor,
} from "./reproject";

/** Allowlisted OpenPlanetaryMap tile datasets → their upstream base URL. */
const DATASETS: Record<string, string> = {
  "mars-mola-color-noshade":
    "https://s3-eu-west-1.amazonaws.com/whereonmars.cartodb.net/mola_color-noshade_global",
  "mars-viking-mdim21":
    "https://s3-eu-west-1.amazonaws.com/whereonmars.cartodb.net/viking_mdim21_global",
  "mars-hillshade":
    "https://s3.us-east-2.amazonaws.com/opmmarstiles/hillshade-tiles",
  "mars-mola-color":
    "https://s3-eu-west-1.amazonaws.com/whereonmars.cartodb.net/mola-color",
  "mars-mola-gray":
    "https://s3-eu-west-1.amazonaws.com/whereonmars.cartodb.net/mola-gray",
  "moon-hillshaded-albedo":
    "https://s3.amazonaws.com/opmbuilder/301_moon/tiles/w/hillshaded-albedo",
};

// `/opm/<dataset>/<z>/<x>/<y>.png`. z/x/y are constrained to integers so the
// Worker can never be coerced into fetching an arbitrary upstream path.
const TILE_PATH = /^\/opm\/([a-z0-9-]+)\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})\.png$/;

// A USGS Astrogeology WMS layer to reproject. `map` and `layer` are the only
// caller-influenced parts of the upstream request, and both come from this
// allowlist — the Worker never forwards a client-supplied WMS parameter.
interface WmsDataset {
  /** MapServer `map=` file, e.g. `/maps/mercury/mercury_simp_cyl.map`. */
  map: string;
  /** WMS `LAYERS=` value. */
  layer: string;
}

// The single USGS Astrogeology MapServer endpoint every WMS dataset is served
// from. Requests are same-origin server-to-server, so CORS never applies.
const WMS_BASE = "https://planetarymaps.usgs.gov/cgi-bin/mapserv";

/** Allowlisted WMS layers → their `map`/`layer` on the USGS MapServer. */
const WMS_DATASETS: Record<string, WmsDataset> = {
  "mercury-messenger-color": {
    map: "/maps/mercury/mercury_simp_cyl.map",
    layer: "MESSENGER_Color",
  },
  "mercury-messenger": {
    map: "/maps/mercury/mercury_simp_cyl.map",
    layer: "MESSENGER",
  },
  "venus-magellan": {
    map: "/maps/venus/venus_simp_cyl.map",
    layer: "MAGELLAN",
  },
  "venus-magellan-color": {
    map: "/maps/venus/venus_simp_cyl.map",
    layer: "MAGELLAN_color",
  },
  "io-galileo-color": {
    map: "/maps/jupiter/io_simp_cyl.map",
    layer: "SSI_color",
  },
  "europa-galileo-voyager": {
    map: "/maps/jupiter/europa_simp_cyl.map",
    layer: "GALILEO_VOYAGER",
  },
  "ganymede-galileo-voyager": {
    map: "/maps/jupiter/ganymede_simp_cyl.map",
    layer: "GALILEO_VOYAGER",
  },
  "callisto-galileo-voyager": {
    map: "/maps/jupiter/callisto_simp_cyl.map",
    layer: "GALILEO_VOYAGER",
  },
  "titan-cassini": {
    map: "/maps/saturn/titan_simp_cyl.map",
    layer: "Titan_ISS_Controlled_Mosaic",
  },
  "titan-hisar": {
    map: "/maps/saturn/titan_simp_cyl.map",
    layer: "Titan_HiSAR_Mosaic",
  },
  "pluto-mosaic": {
    map: "/maps/pluto/pluto_simp_cyl.map",
    layer: "NEWHORIZONS_PLUTO_MOSAIC",
  },
  "pluto-color": {
    map: "/maps/pluto/pluto_simp_cyl.map",
    layer: "NEWHORIZONS_PLUTO_ClrSHADE",
  },
  "charon-mosaic": {
    map: "/maps/pluto/charon_simp_cyl.map",
    layer: "NEWHORIZONS_CHARON_MOSAIC",
  },
};

// `/wms/<dataset>/<z>/<x>/<y>.png`. Same integer constraints as TILE_PATH.
const WMS_PATH = /^\/wms\/([a-z0-9-]+)\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})\.png$/;

// Edge length of a reprojected tile. Matches MapLibre's default `tileSize`.
const WMS_TILE_SIZE = 256;

// Highest zoom the reprojection endpoint will serve. The mosaics top out around
// native zoom 7, so this leaves a little overzoom headroom while capping abuse:
// beyond it the `x`/`y < 2**z` check is useless (2**z dwarfs the regex's 7-digit
// ceiling), so a client could hammer USGS + the PNG codec with unlimited
// distinct high-z cache keys.
const MAX_WMS_ZOOM = 10;

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-max-age": "86400",
};

// Cache tiles for a day at the edge and let browsers hold them for an hour. The
// mosaics are static, so a long TTL is safe and keeps the map responsive.
const CACHE_CONTROL = "public, max-age=3600, s-maxage=86400";

// Cache upstream misses (403/404 past a mosaic's native zoom) briefly, so a
// repeated bad tile is answered from the edge instead of re-hitting the OPM
// buckets every time.
const NEGATIVE_CACHE_CONTROL = "public, max-age=300";

interface Env {}

export default {
  async fetch(
    request: Request,
    _env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    // Only GET is proxied. MapLibre issues GET for every tile; supporting HEAD
    // would just complicate the Cache API keying (which requires GET) for no
    // real consumer.
    if (request.method !== "GET") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { ...CORS_HEADERS, allow: "GET, OPTIONS" },
      });
    }

    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "") {
      return new Response(
        "GeoLibre planetary tile service.\n" +
          "  Passthrough: /opm/<dataset>/<z>/<x>/<y>.png\n" +
          `    Datasets: ${Object.keys(DATASETS).join(", ")}\n` +
          "  Reprojected WMS: /wms/<dataset>/<z>/<x>/<y>.png\n" +
          `    Datasets: ${Object.keys(WMS_DATASETS).join(", ")}\n`,
        { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }

    const wmsMatch = WMS_PATH.exec(url.pathname);
    if (wmsMatch) {
      return handleWmsTile(request, wmsMatch, ctx);
    }

    const match = TILE_PATH.exec(url.pathname);
    if (!match) {
      return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
    }
    const [, dataset, z, x, y] = match;
    // Look up own properties only — a bare object literal inherits keys like
    // "constructor" from Object.prototype (and `[a-z0-9-]+` matches it), which
    // would otherwise resolve to a truthy function and slip past the 404 below.
    const base = Object.hasOwn(DATASETS, dataset)
      ? DATASETS[dataset]
      : undefined;
    if (!base) {
      return new Response(`Unknown dataset: ${dataset}`, {
        status: 404,
        headers: CORS_HEADERS,
      });
    }

    // Reject coordinates outside the tile pyramid for this zoom (x, y < 2**z)
    // before touching upstream, so out-of-range /z/x/y can't be looped over to
    // hammer the third-party OPM S3 buckets through this Worker.
    const dim = 2 ** Number(z);
    if (Number(x) >= dim || Number(y) >= dim) {
      return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
    }

    // Serve from the edge cache when we can; the cache key is the incoming
    // request URL (method + path), which uniquely identifies the tile.
    const cache = caches.default;
    const cached = await cache.match(request);
    if (cached) return cached;

    const upstream = `${base}/${z}/${x}/${y}.png`;
    let originResponse: Response;
    try {
      originResponse = await fetch(upstream, {
        cf: { cacheEverything: true, cacheTtl: 86400 },
      });
    } catch {
      return new Response("Bad Gateway", { status: 502, headers: CORS_HEADERS });
    }

    // Pass upstream errors (e.g. 403/404 for tiles past a mosaic's native zoom)
    // straight through, with CORS, so MapLibre just leaves that tile blank.
    const headers = new Headers(CORS_HEADERS);
    headers.set(
      "content-type",
      originResponse.headers.get("content-type") ?? "image/png",
    );
    headers.set(
      "cache-control",
      originResponse.ok ? CACHE_CONTROL : NEGATIVE_CACHE_CONTROL,
    );

    const response = new Response(originResponse.body, {
      status: originResponse.status,
      headers,
    });
    // Cache successes long and upstream misses briefly (see NEGATIVE_CACHE_
    // CONTROL). Skip 5xx and 429 so a transient upstream failure or throttle
    // isn't pinned as a blank tile for the negative TTL — only genuine 403/404
    // past-native-zoom misses are worth caching. Only GET reaches here, so the
    // request is always a valid Cache API key.
    if (originResponse.status < 500 && originResponse.status !== 429) {
      ctx.waitUntil(cache.put(request, response.clone()));
    }
    return response;
  },
};

/**
 * Serve one reprojected `/wms/<dataset>/<z>/<x>/<y>.png` tile: request the
 * matching USGS WMS window in EPSG:4326, warp it to Web Mercator, and re-emit it
 * as a PNG with CORS. Results are edge-cached, so the decode/warp/encode cost is
 * paid once per tile.
 */
async function handleWmsTile(
  request: Request,
  match: RegExpExecArray,
  ctx: ExecutionContext,
): Promise<Response> {
  const [, dataset, zs, xs, ys] = match;
  // Own-property lookup only, for the same Object.prototype reason as the OPM
  // path above (a slug like "constructor" must 404, not resolve to a function).
  const ds = Object.hasOwn(WMS_DATASETS, dataset)
    ? WMS_DATASETS[dataset]
    : undefined;
  if (!ds) {
    return new Response(`Unknown dataset: ${dataset}`, {
      status: 404,
      headers: CORS_HEADERS,
    });
  }

  const z = Number(zs);
  const x = Number(xs);
  const y = Number(ys);
  // Reject over-deep zooms and coordinates outside the pyramid before touching
  // the USGS server (see MAX_WMS_ZOOM — the x/y bound alone doesn't limit z).
  const dim = 2 ** z;
  if (z > MAX_WMS_ZOOM || x >= dim || y >= dim) {
    return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
  }

  const cache = caches.default;
  const cached = await cache.match(request);
  if (cached) return cached;

  const bounds = tileGeoBounds({ z, x, y });
  // Every WMS parameter is Worker-controlled except `map`/`layer`, which come
  // from the WMS_DATASETS allowlist — never from the request.
  const wmsUrl =
    `${WMS_BASE}?map=${encodeURIComponent(ds.map)}` +
    "&SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&STYLES=" +
    `&LAYERS=${encodeURIComponent(ds.layer)}` +
    "&SRS=EPSG:4326&FORMAT=image/png&TRANSPARENT=TRUE" +
    `&WIDTH=${WMS_TILE_SIZE}&HEIGHT=${WMS_TILE_SIZE}` +
    `&BBOX=${wmsBboxFor(bounds)}`;

  let origin: Response;
  try {
    origin = await fetch(wmsUrl, { cf: { cacheEverything: true, cacheTtl: 86400 } });
  } catch {
    return new Response("Bad Gateway", { status: 502, headers: CORS_HEADERS });
  }

  const contentType = origin.headers.get("content-type") ?? "";
  if (!origin.ok || !contentType.startsWith("image/")) {
    // A WMS ServiceException is XML, not an image — don't feed it to the PNG
    // decoder. Answer with a transparent tile so the black-space backdrop shows
    // through. Draining the body frees the connection.
    await origin.arrayBuffer().catch(() => undefined);
    const resp = pngResponse(transparentTile(), NEGATIVE_CACHE_CONTROL);
    // Negative-cache genuine misses, but skip 5xx/429 so a transient USGS
    // outage or throttle isn't pinned as a blank tile for the negative TTL
    // (mirrors the OPM passthrough path above).
    if (origin.status < 500 && origin.status !== 429) {
      ctx.waitUntil(cache.put(request, resp.clone()));
    }
    return resp;
  }

  let out: ArrayBuffer;
  try {
    const decoded = UPNG.decode(await origin.arrayBuffer());
    // The window is requested at exactly WMS_TILE_SIZE², so the returned image
    // matches; guard anyway so a surprise size can't drive an out-of-bounds read.
    if (decoded.width !== WMS_TILE_SIZE || decoded.height !== WMS_TILE_SIZE) {
      throw new Error(`unexpected WMS size ${decoded.width}x${decoded.height}`);
    }
    const rgba = new Uint8Array(UPNG.toRGBA8(decoded)[0]);
    const warped = remapRowsToMercator(rgba, WMS_TILE_SIZE, { z, x, y }, bounds);
    out = UPNG.encode(
      [warped.buffer as ArrayBuffer],
      WMS_TILE_SIZE,
      WMS_TILE_SIZE,
      0,
    );
  } catch {
    return new Response("Bad Gateway", { status: 502, headers: CORS_HEADERS });
  }

  const resp = pngResponse(out, CACHE_CONTROL);
  ctx.waitUntil(cache.put(request, resp.clone()));
  return resp;
}

/** A 200 PNG response with CORS and the given cache policy. */
function pngResponse(body: ArrayBuffer, cacheControl: string): Response {
  const headers = new Headers(CORS_HEADERS);
  headers.set("content-type", "image/png");
  headers.set("cache-control", cacheControl);
  return new Response(body, { status: 200, headers });
}

// A fully-transparent tile, encoded once and reused for WMS misses. Sliced per
// use so each Response owns its bytes (never a detached shared buffer).
let transparentTilePng: ArrayBuffer | undefined;
function transparentTile(): ArrayBuffer {
  if (!transparentTilePng) {
    const rgba = new Uint8Array(WMS_TILE_SIZE * WMS_TILE_SIZE * 4);
    transparentTilePng = UPNG.encode(
      [rgba.buffer as ArrayBuffer],
      WMS_TILE_SIZE,
      WMS_TILE_SIZE,
      0,
    );
  }
  return transparentTilePng.slice(0);
}
