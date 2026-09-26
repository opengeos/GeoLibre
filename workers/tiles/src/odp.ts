import { ODP_FEATURES_UPSTREAM, ODP_TILE_UPSTREAM } from "./allowlisted-fetch";

// HUB Ocean's Ocean Data Platform. Its vector tile and OGC API Features
// endpoints answer anonymous reads of public datasets, but send CORS headers
// only for `app.hubocean.earth`, so neither the web build nor the desktop
// webview can read them directly. Two named reads are exposed, both keyed on a
// dataset UUID so the route can never reach another ODP path:
//   /odp/tiles/<uuid>/<z>/<x>/<y>.pbf  → /api/table/v2/tile/<uuid>?z=&x=&y=
//   /odp/features/<id>/items?bbox=&limit=
//                                      → /api/features/collections/<id>/items
// A features id may carry a `::<GeometryType>` suffix: ODP splits a dataset
// with mixed geometry into one collection per type.
const ODP_TILE_PATH =
  /^\/odp\/tiles\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(\d{1,2})\/(\d{1,8})\/(\d{1,8})(?:\.pbf)?$/;
const ODP_FEATURES_PATH =
  /^\/odp\/features\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:::[A-Za-z]{1,32})?)\/items$/;
const ODP_MAX_ZOOM = 22;
/** Largest OGC API Features page the route forwards. */
const ODP_FEATURES_MAX_LIMIT = 10_000;
// Published datasets change rarely and a cold tile can take upstream 10-20 s,
// so tiles are held at the edge for six hours; a feature page for one hour.
const ODP_TILE_CACHE_SECONDS = 21_600;
const ODP_FEATURES_CACHE_SECONDS = 3_600;

/**
 * Resolves an `/odp/...` request to its fixed upstream URL, or null when the
 * path or its parameters fall outside the two allowlisted reads (see
 * ODP_TILE_PATH above). Only a validated `bbox` and `limit` are forwarded.
 */
export function odpUpstream(url: URL): { upstream: string; cacheSeconds: number } | null {
  const tile = ODP_TILE_PATH.exec(url.pathname);
  if (tile) {
    const [, uuid, zText, xText, yText] = tile;
    const z = Number(zText);
    const x = Number(xText);
    const y = Number(yText);
    const size = 2 ** z;
    if (z > ODP_MAX_ZOOM || x >= size || y >= size) return null;
    return {
      upstream: `${ODP_TILE_UPSTREAM}${uuid}?z=${z}&x=${x}&y=${y}`,
      cacheSeconds: ODP_TILE_CACHE_SECONDS,
    };
  }
  const features = ODP_FEATURES_PATH.exec(url.pathname);
  if (!features) return null;
  const params = new URLSearchParams({ f: "json" });
  const limitText = url.searchParams.get("limit");
  if (limitText !== null) {
    const limit = Number(limitText);
    if (!Number.isInteger(limit) || limit < 1 || limit > ODP_FEATURES_MAX_LIMIT) return null;
    params.set("limit", String(limit));
  }
  const bboxText = url.searchParams.get("bbox");
  if (bboxText !== null) {
    const bbox = bboxText.split(",").map(Number);
    const [west, south, east, north] = bbox;
    if (
      bbox.length !== 4 ||
      !bbox.every(Number.isFinite) ||
      west < -180 ||
      east > 180 ||
      south < -90 ||
      north > 90 ||
      south > north
    ) {
      return null;
    }
    params.set("bbox", bbox.join(","));
  }
  return {
    upstream: `${ODP_FEATURES_UPSTREAM}${features[1]}/items?${params}`,
    cacheSeconds: ODP_FEATURES_CACHE_SECONDS,
  };
}
