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

import * as UPNG from "upng-js";
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

// OpenAerialMap metadata search proxy. The OAM `/meta` API only sends CORS
// headers for the OAM web app origin, so a browser fetch from GeoLibre is
// blocked; this route fetches it server-side (no CORS applies server-to-server)
// and re-emits the JSON with `Access-Control-Allow-Origin: *` — the same thing
// leafmap.oam_search gets for free by calling the API from Python. The upstream
// path is fixed and only an allowlist of query params is forwarded, so this
// stays a named proxy, never an open one.
const OAM_META_PATH = "/oam/meta";
const OAM_META_UPSTREAM = "https://api.openaerialmap.org/meta";
const OAM_META_PARAMS = new Set([
  "bbox",
  "limit",
  "page",
  "order_by",
  "sort",
  "acquisition_from",
  "acquisition_to",
]);
// Searches change as imagery is added, so cache only briefly at the edge.
const OAM_CACHE_CONTROL = "public, max-age=120";
// Upper bound on the forwarded `limit` (OAM's own page-size ceiling).
const OAM_MAX_LIMIT = 100;

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

// Highest zoom the reprojection endpoint will serve. The mosaics top out at
// native zoom 7 (MapLibre never requests past a source's maxzoom), so this sits
// one level above that and rejects everything deeper. Without it the
// `x`/`y < 2**z` check is useless at high z (2**z dwarfs the regex's 7-digit
// ceiling), letting a client hammer USGS + the PNG codec with unlimited distinct
// cache keys — each miss here is CPU-bound, unlike the byte-forwarding /opm path.
const MAX_WMS_ZOOM = 8;

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  // Allow the Range request header (the /pmtiles route needs it) and expose the
  // response headers a range reader relies on. Harmless for the tile routes.
  "access-control-allow-headers": "range",
  "access-control-expose-headers":
    "content-range, content-length, etag, accept-ranges",
  "access-control-max-age": "86400",
};

/** `/pmtiles/<name>.pmtiles` range-proxies the Protomaps daily planet builds,
 * adding CORS so the in-browser PMTiles extractor can byte-range them from any
 * origin (build.protomaps.com only allowlists a few). Scoped to that one host
 * and `.pmtiles` paths so this is never an open proxy. */
const PMTILES_PATH = /^\/pmtiles\/([A-Za-z0-9._-]+\.pmtiles)$/;
const PMTILES_UPSTREAM = "https://build.protomaps.com";

// `/pmtiles/latest.pmtiles` resolves to the most recent daily build. Protomaps
// publishes `<YYYYMMDD>.pmtiles` with no "latest" alias and no index, so we
// probe backward from today until one exists, then cache the resolved date so
// every range request in one extraction hits the same file (mismatched dates
// would corrupt the assembled archive). The TTL is short enough to pick up the
// next day's build but long enough to stay stable through any extraction.
const LATEST_NAME = "latest.pmtiles";
const LATEST_TTL_MS = 60 * 60 * 1000;
const LATEST_MAX_LOOKBACK_DAYS = 7;
let latestCache: { date: string; at: number } | null = null;

function utcYmd(msSinceEpoch: number): string {
  return new Date(msSinceEpoch).toISOString().slice(0, 10).replace(/-/g, "");
}

/** Resolves `latest` to the newest available `<YYYYMMDD>` build, cached. */
async function resolveLatestBuildDate(): Promise<string> {
  const now = Date.now();
  if (latestCache && now - latestCache.at < LATEST_TTL_MS) {
    return latestCache.date;
  }
  for (let i = 0; i <= LATEST_MAX_LOOKBACK_DAYS; i++) {
    const ymd = utcYmd(now - i * 86_400_000);
    // A one-byte range is the cheapest existence check; edge-cache it so the
    // probe is nearly free across requests.
    const probe = await fetch(`${PMTILES_UPSTREAM}/${ymd}.pmtiles`, {
      headers: { range: "bytes=0-0" },
      cf: { cacheEverything: true, cacheTtl: 3600 },
    });
    if (probe.status === 206) {
      latestCache = { date: ymd, at: now };
      return ymd;
    }
  }
  throw new Error("no recent Protomaps build found");
}

// Cache tiles for a day at the edge and let browsers hold them for an hour. The
// mosaics are static, so a long TTL is safe and keeps the map responsive.
const CACHE_CONTROL = "public, max-age=3600, s-maxage=86400";

// Cache upstream misses (403/404 past a mosaic's native zoom) briefly, so a
// repeated bad tile is answered from the edge instead of re-hitting the OPM
// buckets every time.
const NEGATIVE_CACHE_CONTROL = "public, max-age=300";

/**
 * Whether an `Origin` header may use the OpenAerialMap search proxy. Allowed:
 *
 *   - the production web app on `*.geolibre.app` (any subdomain, plus the apex)
 *   - Cloudflare Pages deploy previews (project `geolibre-preview`) and
 *     `*.workers.dev` preview deployments
 *   - local dev on `localhost` / `127.0.0.1`
 *
 * Everything else gets a 403 so the route can't be driven as an open proxy from
 * an arbitrary third-party site. This route is only reached by the web, dev, and
 * embed builds; the desktop app fetches OAM through native (CORS-bypassing) HTTP
 * and never hits the Worker. The Jupyter embed runs on arbitrary origins, so its
 * OAM search is intentionally not proxied here (planetary tiles are unaffected —
 * only this `/oam/meta` route is origin-gated).
 *
 * `.geolibre.app` etc. are matched with a leading dot so a look-alike apex like
 * `evilgeolibre.app` cannot pass as a subdomain.
 */
function isAllowedOamOrigin(origin: string | null): boolean {
  if (!origin) return false;
  let hostname: string;
  let protocol: string;
  try {
    ({ hostname, protocol } = new URL(origin));
  } catch {
    return false;
  }
  if (protocol === "https:") {
    if (hostname === "geolibre.app" || hostname.endsWith(".geolibre.app")) {
      return true;
    }
    if (hostname.endsWith(".geolibre-preview.pages.dev")) return true;
    if (hostname.endsWith(".workers.dev")) return true;
  }
  if (
    (protocol === "http:" || protocol === "https:") &&
    (hostname === "localhost" || hostname === "127.0.0.1")
  ) {
    return true;
  }
  return false;
}

interface Env {}

/**
 * Range-proxies one Protomaps planet build. Forwards the client's `Range`
 * header to build.protomaps.com and re-emits the (usually 206) response with
 * CORS + range headers so an in-browser PMTiles reader can extract from it.
 * Only byte-range GETs are proxied — a full-file GET (no Range) is refused so
 * this can't be used to pull the whole 100+ GB archive through the Worker.
 */
async function handlePmtilesRange(
  request: Request,
  name: string,
): Promise<Response> {
  const range = request.headers.get("range");
  if (!range) {
    return new Response(
      "This endpoint only serves HTTP range requests (send a Range header).",
      { status: 400, headers: CORS_HEADERS },
    );
  }
  let target = name;
  if (name === LATEST_NAME) {
    try {
      target = `${await resolveLatestBuildDate()}.pmtiles`;
    } catch {
      return new Response("No recent Protomaps build available", {
        status: 502,
        headers: CORS_HEADERS,
      });
    }
  }
  let originResponse: Response;
  try {
    originResponse = await fetch(`${PMTILES_UPSTREAM}/${target}`, {
      headers: { range },
      // The upstream is range-cacheable at Cloudflare's edge; identical range
      // requests (directory reads) are served from the PoP.
      cf: { cacheEverything: true },
    });
  } catch {
    return new Response("Bad Gateway", { status: 502, headers: CORS_HEADERS });
  }
  const headers = new Headers(CORS_HEADERS);
  for (const key of [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "etag",
    "last-modified",
    "cache-control",
  ]) {
    const value = originResponse.headers.get(key);
    if (value) headers.set(key, value);
  }
  return new Response(originResponse.body, {
    status: originResponse.status,
    headers,
  });
}

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
        "GeoLibre tile + service proxy.\n" +
          "  Passthrough: /opm/<dataset>/<z>/<x>/<y>.png\n" +
          `    Datasets: ${Object.keys(DATASETS).join(", ")}\n` +
          "  Reprojected WMS: /wms/<dataset>/<z>/<x>/<y>.png\n" +
          `    Datasets: ${Object.keys(WMS_DATASETS).join(", ")}\n` +
          "  OpenAerialMap search: /oam/meta?bbox=...&limit=...\n" +
          "  PMTiles range proxy: /pmtiles/<name>.pmtiles (Range header required)\n",
        { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }

    const wmsMatch = WMS_PATH.exec(url.pathname);
    if (wmsMatch) {
      return handleWmsTile(request, wmsMatch, ctx);
    }

    // OpenAerialMap metadata search: forward the allowlisted query params to the
    // fixed upstream and re-emit the JSON with CORS (see OAM_META_PATH above).
    if (url.pathname === OAM_META_PATH) {
      // Abuse guard: this is a wildcard-CORS proxy to a fixed upstream, so
      // restrict it to GeoLibre's own origins (see isAllowedOamOrigin) — every
      // cross-origin `fetch()` from the app carries an Origin header. This stops
      // a third-party site from driving arbitrary OAM queries through the
      // Worker. It is not a rate limiter — per-client throttling belongs in a
      // Cloudflare rate-limiting rule in front of tiles.geolibre.app.
      if (!isAllowedOamOrigin(request.headers.get("origin"))) {
        return new Response("Forbidden", { status: 403, headers: CORS_HEADERS });
      }
      const upstream = new URL(OAM_META_UPSTREAM);
      for (const [key, value] of url.searchParams) {
        if (!OAM_META_PARAMS.has(key)) continue;
        if (key === "limit") {
          // Clamp so this named proxy can't be driven to request huge pages.
          const n = Number(value);
          const limit = Number.isFinite(n)
            ? Math.min(Math.max(Math.trunc(n), 1), OAM_MAX_LIMIT)
            : OAM_MAX_LIMIT;
          upstream.searchParams.set("limit", String(limit));
        } else {
          upstream.searchParams.append(key, value);
        }
      }
      let originResponse: Response;
      try {
        originResponse = await fetch(upstream.toString(), {
          headers: { accept: "application/json" },
          // cacheEverything is required for Cloudflare to edge-cache a URL with
          // no static file extension (cacheTtl alone does not).
          cf: { cacheEverything: true, cacheTtl: 120 },
        });
      } catch {
        return new Response("Bad Gateway", {
          status: 502,
          headers: CORS_HEADERS,
        });
      }
      const headers = new Headers(CORS_HEADERS);
      headers.set(
        "content-type",
        originResponse.headers.get("content-type") ?? "application/json",
      );
      // Only cache successful searches; a transient upstream error/throttle must
      // not be pinned in the browser for the OAM cache TTL.
      headers.set(
        "cache-control",
        originResponse.ok ? OAM_CACHE_CONTROL : "no-store",
      );
      return new Response(originResponse.body, {
        status: originResponse.status,
        headers,
      });
    }

    const pmtilesMatch = PMTILES_PATH.exec(url.pathname);
    if (pmtilesMatch) {
      return handlePmtilesRange(request, pmtilesMatch[1]);
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
    //
    // Unlike the /opm path (which forwards the real upstream status), a failure
    // here renders as a blank tile, so log it — otherwise a typo'd map/layer in
    // a WMS_DATASETS entry would fail silently as an all-blank basemap in prod.
    console.warn(
      `WMS reproject miss: dataset=${dataset} status=${origin.status} content-type=${contentType || "?"}`,
    );
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
  } catch (err) {
    // A 2xx response we can't decode/warp (e.g. a misconfigured dataset or an
    // unexpected upstream format/size) is a persistent failure, so degrade to a
    // negative-cached transparent tile — matching the upstream-status branch
    // above — instead of re-running this CPU-bound path on every request forever.
    console.warn(
      `WMS reproject decode failure: dataset=${dataset} error=${String(err)}`,
    );
    const resp = pngResponse(transparentTile(), NEGATIVE_CACHE_CONTROL);
    ctx.waitUntil(cache.put(request, resp.clone()));
    return resp;
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
