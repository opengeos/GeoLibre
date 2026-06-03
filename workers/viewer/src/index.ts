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

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const target = `${ORIGIN}${url.pathname}${url.search}`;
    return fetch(target, request);
  },
};
