// viewer.geolibre.app
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
// Origin redirects (e.g. trailing slash) are followed server-side so the public
// viewer.geolibre.app URL is preserved and geolibre.app/demo is never exposed.

const ORIGIN = "https://geolibre.app/demo";

interface Env {}

export default {
  async fetch(
    request: Request,
    _env: Env,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const target = `${ORIGIN}${url.pathname}${url.search}`;

    // Drop credential headers a public static-asset proxy never needs; keep the
    // rest (e.g. Range, Accept-Encoding) so large-asset requests work. Follow
    // origin redirects server-side to preserve the public URL.
    const headers = new Headers(request.headers);
    headers.delete("cookie");
    headers.delete("authorization");

    return fetch(target, {
      method: request.method,
      headers,
      body: request.body,
      redirect: "follow",
    });
  },
};
