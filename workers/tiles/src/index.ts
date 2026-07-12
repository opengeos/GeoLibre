// tiles.geolibre.app
//
// A CORS-adding, edge-caching reverse proxy for the OpenPlanetaryMap raster
// mosaics used by GeoLibre's planetary basemaps.
//
// Why this exists: MapLibre GL fetches raster tiles with `fetch()`, which
// enforces CORS. OpenPlanetaryMap's single-layer mosaics are served straight
// from S3 buckets that send no `Access-Control-Allow-Origin` header, so the
// browser blocks them and the map renders black. (The openplanetarymap.org site
// gets away with it because Leaflet loads tiles as plain <img> elements, which
// are not CORS-checked.) A same-origin dev proxy exists, but the web build
// (nginx), desktop build (Tauri) and Jupyter embed have no shared proxy — a
// public Worker is the one URL that works uniformly across all of them.
//
// The Worker fetches each tile server-side (no CORS applies server-to-server),
// re-emits it with `Access-Control-Allow-Origin: *`, and caches it at the edge
// so repeat requests are served from Cloudflare's PoP rather than round-tripping
// to S3 — faster and gentler on the upstream than hitting S3 directly.
//
// URL scheme (keeps this a named-dataset proxy, never an open proxy):
//   tiles.geolibre.app/opm/<dataset>/<z>/<x>/<y>.png
// where <dataset> is a key in DATASETS below. The tiles are TMS (flipped Y);
// MapLibre applies the flip before the request reaches the Worker, so the Worker
// treats <z>/<x>/<y> as opaque and forwards them unchanged.

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
          "  Planetary tiles: /opm/<dataset>/<z>/<x>/<y>.png\n" +
          "  OpenAerialMap search: /oam/meta?bbox=...&limit=...\n" +
          `Datasets: ${Object.keys(DATASETS).join(", ")}\n`,
        { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } },
      );
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

    const match = TILE_PATH.exec(url.pathname);
    if (!match) {
      return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
    }
    const [, dataset, z, x, y] = match;
    // Look up own properties only — a bare object literal inherits keys like
    // "constructor" from Object.prototype (and `[a-z0-9-]+` matches it), which
    // would otherwise resolve to a truthy function and slip past the 404 below.
    const base = Object.prototype.hasOwnProperty.call(DATASETS, dataset)
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
