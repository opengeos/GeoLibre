// web.geolibre.app (and viewer.geolibre.app, the original alias)
//
// Serves the GeoLibre web viewer at a clean subdomain by proxying to the build
// already published at https://geolibre.app/demo (GitHub Pages). We proxy rather
// than re-host the files because the viewer bundles a 32 MiB DuckDB WASM asset,
// which exceeds Cloudflare's 25 MiB per-asset limit for Workers/Pages. GitHub
// Pages has no such limit, so it stays the origin of record.
//
// Both hostnames route to this worker. The viewer build uses relative asset
// paths, so requests map 1:1 regardless of which host they arrive on:
//   {web,viewer}.geolibre.app/<path>?<query> -> geolibre.app/demo/<path>?<query>
//
// Origin redirects (e.g. trailing slash) are followed server-side so the public
// hostname is preserved and geolibre.app/demo is never exposed.

const ORIGIN = "https://geolibre.app/demo";

interface Env {}

export default {
  async fetch(request: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const target = `${ORIGIN}${url.pathname}${url.search}`;

    // Drop credential headers a public static-asset proxy never needs; keep the
    // rest (e.g. Range, Accept-Encoding) so large-asset requests work.
    const headers = new Headers(request.headers);
    headers.delete("cookie");
    headers.delete("authorization");

    // Follow origin redirects (e.g. trailing slash) server-side to preserve the
    // public URL. This assumes geolibre.app/demo never redirects back to a
    // viewer host, which would otherwise make the worker loop on itself.
    try {
      return await fetch(target, {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? null : request.body,
        redirect: "follow",
      });
    } catch {
      return new Response("Bad Gateway", { status: 502 });
    }
  },
};
