// viewer.geolibre.app (legacy alias)
//
// Serves the GeoLibre web viewer at a clean subdomain by proxying to the build
// already published at https://geolibre.app/demo (GitHub Pages). We proxy rather
// than re-host the files because the viewer bundles a 32 MiB DuckDB WASM asset,
// which exceeds Cloudflare's 25 MiB per-asset limit for Workers/Pages. GitHub
// Pages has no such limit, so it stays the origin of record.
//
// The viewer build uses relative asset paths, so requests map 1:1:
//   viewer.geolibre.app/<path>?<query> -> geolibre.app/demo/<path>?<query>
//
// Origin redirects (e.g. trailing slash) are followed server-side only when the
// Location stays on https://geolibre.app/demo/… — a cross-origin or off-prefix
// redirect is refused so this worker cannot become an open proxy.

import { proxyViewerRequest } from "./proxy";

interface Env {
  VIEWER_RATE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
}

/** Static bundle assets bypass the IP rate limiter so shared NATs never break mid-load. */
const STATIC_ASSET_RE =
  /^\/assets\/|\.(?:js|mjs|css|wasm|png|jpe?g|webp|svg|ico|woff2?|map|json)$/i;

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (env?.VIEWER_RATE_LIMITER && !STATIC_ASSET_RE.test(pathname)) {
      const key = request.headers.get("CF-Connecting-IP") ?? "anonymous";
      try {
        const outcome = await env.VIEWER_RATE_LIMITER.limit({ key });
        if (!outcome.success) {
          return new Response("Too many requests", {
            status: 429,
            headers: { "Retry-After": "60" },
          });
        }
      } catch (err) {
        console.warn("VIEWER_RATE_LIMITER error:", err);
      }
    }
    return proxyViewerRequest(request);
  },
};
