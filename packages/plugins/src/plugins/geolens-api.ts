/**
 * GeoLens (https://getgeolens.com) API client.
 *
 * GeoLens is a self-hosted spatial catalog + map builder (FastAPI + PostGIS)
 * that serves its datasets over open standards GeoLibre already speaks:
 *
 *  - **Search** — `GET /api/search/datasets/?q=…` returns an OGC-Records-shaped
 *    `FeatureCollection`, one feature per dataset, with `record_type`,
 *    `geometry_type`, `band_count`, and a bbox polygon. This is GeoLens's
 *    differentiator over plain OGC/STAC (fuzzy + optional semantic ranking).
 *  - **Vector tiles** — signed XYZ MVT at
 *    `/api/tiles/{table_path}/{z}/{x}/{y}.pbf?sig&exp&scope`. The `{table_path}`
 *    is `data.{scope}` and doubles as the MVT source-layer name. Tiles need a
 *    short-lived HMAC token from `/api/tiles/token/{dataset_id}/` — so a static
 *    URL is not enough; the caller must re-mint before `expires_in` elapses.
 *  - **OGC API Features** — `GET /api/collections/{id}/items` is a plain
 *    (paginated) GeoJSON `FeatureCollection`, the fallback for a full-feature
 *    load.
 *  - **STAC 1.0** — `/api/stac` catalog + `/api/stac/collections`, the natural
 *    path for raster/COG datasets.
 *  - **Feature editing** — `POST /api/datasets/{id}/features/` and
 *    `PUT`/`PATCH`/`DELETE /api/datasets/{id}/features/{gid}` write single
 *    features back to PostGIS. There is no bulk/transaction endpoint, so an
 *    edited layer is saved as one request per changed feature (see
 *    {@link applyFeatureEdits}). Writes always need credentials, and the
 *    deployment must have `enable_dataset_editing` on (see
 *    {@link fetchCapabilities}).
 *
 * This module is deliberately DOM-free and framework-free so it can be unit
 * tested under `node --test`; everything that touches the map or the document
 * lives in `maplibre-geolens.ts`. The `fetchImpl` is injected (mirrors
 * `SourceCoopFetch` in `source-coop-api.ts`) so tests need no real server.
 */

import { GEOMETRY_EDIT_FID_PROPERTY } from "./geo-editor-geometry";

/** How a dataset connects to the API, resolved from the base URL + optional key. */
export interface GeoLensClientOptions {
  /** Server root, e.g. `https://demo.getgeolens.com` (no trailing slash). */
  baseUrl: string;
  /** Optional API key, sent as `X-Api-Key` for private datasets. */
  apiKey?: string;
}

/** One dataset in a GeoLens catalog, normalized from a search feature. */
export interface GeoLensDataset {
  id: string;
  title: string;
  description: string;
  keywords: string[];
  /** Raw GeoLens type, e.g. `vector_dataset` / `raster_dataset`. */
  recordType: string | null;
  geometryType: string | null;
  bandCount: number | null;
  featureCount: number | null;
  license: string | null;
  /** `[minLon, minLat, maxLon, maxLat]`, or null when unknown. */
  bbox: [number, number, number, number] | null;
  /** Vector data → add as vector tiles / OGC Features. */
  isVector: boolean;
  /** Raster data → add via STAC / COG. */
  isRaster: boolean;
}

/** A short-lived, HMAC-signed, per-dataset vector-tile token. */
export interface GeoLensTileToken {
  /** `vector` or `raster`. */
  kind: string;
  sig: string;
  /** Absolute expiry, unix seconds. */
  exp: number;
  /** Table name without the `data.` prefix; also the tile scope param. */
  scope: string;
  /** Seconds until `exp` at mint time — schedule the refresh off this. */
  expiresIn: number;
}

/** A signed vector-tile template plus its MVT source-layer name. */
export interface GeoLensVectorTiles {
  /** `{z}/{x}/{y}` MVT template with the signature query appended. */
  tiles: string;
  /** MapLibre `source-layer`, i.e. `data.{scope}`. */
  sourceLayer: string;
}

/**
 * A server-rendered raster-tile source (Titiler PNG). Unlike a vector token,
 * the raster token carries no signature or expiry: GeoLens authorizes each
 * `/raster-tiles/…png` request itself, so the URL needs no refresh. A public
 * dataset renders anonymously; a private one renders when the browser carries a
 * GeoLens session cookie or embed token for the same origin.
 *
 * Known limitation: an API-key-only private raster cannot render, because
 * MapLibre issues the tile image requests and does not attach the `X-Api-Key`
 * header, and GeoLens does not (yet) return a URL-signed raster template the
 * way it does for vector tiles. Rendering those would need a signed raster URL
 * from GeoLens or an authenticated tile proxy — a server-side change beyond
 * this client. Public and session/embed-authorized rasters are unaffected.
 */
export interface GeoLensRasterTiles {
  /** Absolute `{z}/{x}/{y}.png` XYZ template. */
  tiles: string;
  /** `[minLon, minLat, maxLon, maxLat]`, or null when unknown. */
  bounds: [number, number, number, number] | null;
  minzoom: number;
  maxzoom: number;
  tileSize: number;
}

/** Minimal response shape, so tests can stub the network without a DOM. */
export interface GeoLensHttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/** Minimal fetch shape. Mirrors `SourceCoopFetch` in `source-coop-api.ts`. */
export type GeoLensFetch = (
  url: string,
  init?: {
    /** Defaults to GET; the feature-editing calls set POST/PUT/PATCH/DELETE. */
    method?: string;
    headers?: Record<string, string>;
    /** JSON request body, already serialized. */
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<GeoLensHttpResponse>;

/** The default transport: the platform `fetch`. */
export const defaultGeoLensFetch: GeoLensFetch = (url, init) =>
  fetch(url, init) as unknown as Promise<GeoLensHttpResponse>;

/** Only http(s) URLs may ever reach the map or a token mint. */
const HTTP_URL_RE = /^https?:\/\//i;

/**
 * Normalize a user-entered server URL: trim, default the scheme to https, and
 * drop a trailing slash so path joins never double up. Returns "" for blank.
 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return "";
  const withScheme = HTTP_URL_RE.test(trimmed) ? trimmed : `https://${trimmed}`;
  return withScheme.replace(/\/+$/, "");
}

/** Auth headers for a request — an API key becomes `X-Api-Key`. */
/** GeoLens accepts the API key in this header (it also honors `Authorization`). */
export const GEOLENS_API_KEY_HEADER = "X-Api-Key";

export function authHeaders(options: GeoLensClientOptions): Record<string, string> {
  const key = options.apiKey?.trim();
  return key ? { [GEOLENS_API_KEY_HEADER]: key } : {};
}

/**
 * The prefix of a tile URL template: everything before the first `{z}`/`{x}`/`{y}`
 * placeholder.
 *
 * Used as the match key when attaching credentials to MapLibre-issued raster
 * tile requests, so a key is scoped to the exact endpoint that produced it
 * rather than to a whole origin.
 */
export function tileUrlPrefix(template: string): string {
  const brace = template.indexOf("{");
  return brace === -1 ? template : template.slice(0, brace);
}

/** The store-layer fields needed to re-key restored GeoLens raster layers. */
export interface GeoLensRasterLayerLike {
  metadata?: Record<string, unknown> | null;
  source?: { tiles?: unknown } | null;
}

/**
 * Tile templates of GeoLens raster layers already on the map that belong to
 * `baseUrl`.
 *
 * API keys are held in memory only, so a restored project (or a
 * deactivate/reactivate cycle) leaves private raster layers in the store with
 * no registered credential, and the Add button is disabled for them because
 * they are already present. Re-registering these templates at connect time is
 * what lets the key the user just entered reach those layers' tile requests.
 */
export function rasterTemplatesForServer(
  layers: readonly GeoLensRasterLayerLike[],
  baseUrl: string,
): string[] {
  const out: string[] = [];
  for (const layer of layers) {
    const md = layer.metadata;
    if (!md || md.sourceKind !== "geolens-raster-tiles" || md.geolensBaseUrl !== baseUrl) {
      continue;
    }
    const tiles = layer.source?.tiles;
    const first = Array.isArray(tiles) ? tiles[0] : undefined;
    if (typeof first === "string" && first) out.push(first);
  }
  return out;
}

/**
 * Auth headers for a raster tile URL, or `null` to leave the request untouched.
 *
 * `keysByPrefix` maps a {@link tileUrlPrefix} to the API key that endpoint needs.
 * A request only ever gets a key when its URL starts with that exact prefix, so
 * basemaps, other plugins' tiles, and a second GeoLens server on the same origin
 * are all unaffected.
 */
export function rasterTileAuthHeaders(
  url: string,
  keysByPrefix: ReadonlyMap<string, string>,
): Record<string, string> | null {
  for (const [prefix, apiKey] of keysByPrefix) {
    if (url.startsWith(prefix)) return { [GEOLENS_API_KEY_HEADER]: apiKey };
  }
  return null;
}

/**
 * Compute `[minLon, minLat, maxLon, maxLat]` from a GeoJSON geometry (GeoLens
 * search features carry a bbox polygon). Returns null when there are no finite
 * coordinates — a degenerate extent is worse than none, since `fitBounds`
 * would jump the camera somewhere meaningless.
 */
export function bboxFromGeometry(geometry: unknown): [number, number, number, number] | null {
  if (!geometry || typeof geometry !== "object") return null;
  const coords = (geometry as { coordinates?: unknown }).coordinates;
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      if (node.length >= 2 && typeof node[0] === "number" && typeof node[1] === "number") {
        const [lon, lat] = node as [number, number];
        if (Number.isFinite(lon) && Number.isFinite(lat)) {
          if (lon < minLon) minLon = lon;
          if (lat < minLat) minLat = lat;
          if (lon > maxLon) maxLon = lon;
          if (lat > maxLat) maxLat = lat;
        }
      } else {
        for (const child of node) walk(child);
      }
    }
  };
  walk(coords);
  if (!Number.isFinite(minLon) || !Number.isFinite(minLat)) return null;
  return [minLon, minLat, maxLon, maxLat];
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Normalize one GeoLens search feature into a {@link GeoLensDataset}. A dataset
 * is treated as raster when GeoLens says so or when it reports bands; vector
 * otherwise (the common case, and the one the vector-tile path serves).
 */
export function parseDataset(feature: unknown): GeoLensDataset | null {
  if (!feature || typeof feature !== "object") return null;
  const f = feature as { id?: unknown; geometry?: unknown; properties?: unknown };
  const id = asString(f.id);
  if (!id) return null;
  const props = (f.properties ?? {}) as Record<string, unknown>;
  const recordType = asString(props.record_type);
  const geometryType = asString(props.geometry_type);
  const bandCount = asNumber(props.band_count);
  const keywords = Array.isArray(props.keywords)
    ? props.keywords.filter((k): k is string => typeof k === "string")
    : [];
  const isRaster = (recordType?.includes("raster") ?? false) || (bandCount ?? 0) > 0;
  const isVector = !isRaster;
  return {
    id,
    title: asString(props.title) ?? id,
    description: asString(props.description) ?? "",
    keywords,
    recordType,
    geometryType,
    bandCount,
    featureCount: asNumber(props.feature_count),
    license: asString(props.license),
    bbox: bboxFromGeometry(f.geometry),
    isVector,
    isRaster,
  };
}

async function getJson(
  url: string,
  options: GeoLensClientOptions,
  fetchImpl: GeoLensFetch,
  signal?: AbortSignal,
): Promise<unknown> {
  if (!HTTP_URL_RE.test(url)) throw new Error("GeoLens URL must be http(s)");
  const res = await fetchImpl(url, { headers: authHeaders(options), signal });
  if (!res.ok) throw new Error(`GeoLens request failed (HTTP ${res.status})`);
  return res.json();
}

/**
 * Search a GeoLens catalog. A blank query lists the catalog. Returns normalized
 * datasets; the raw `FeatureCollection` shape is validated rather than trusted.
 */
export async function searchDatasets(
  options: GeoLensClientOptions,
  query: string,
  limit: number,
  fetchImpl: GeoLensFetch = defaultGeoLensFetch,
  signal?: AbortSignal,
): Promise<GeoLensDataset[]> {
  const params = new URLSearchParams();
  const q = query.trim();
  if (q) params.set("q", q);
  params.set("limit", String(limit));
  const url = `${options.baseUrl}/api/search/datasets/?${params.toString()}`;
  const body = await getJson(url, options, fetchImpl, signal);
  const features = (body as { features?: unknown }).features;
  if (!Array.isArray(features)) throw new Error("GeoLens search returned no features");
  return features.map(parseDataset).filter((d): d is GeoLensDataset => d !== null);
}

/**
 * Mint a signed vector-tile token for one dataset. Anonymous for public
 * datasets; an API key unlocks private ones. The returned {@link GeoLensTileToken}
 * carries `expiresIn` — the caller schedules a re-mint before it lapses.
 */
export async function mintTileToken(
  options: GeoLensClientOptions,
  datasetId: string,
  fetchImpl: GeoLensFetch = defaultGeoLensFetch,
  signal?: AbortSignal,
): Promise<GeoLensTileToken> {
  const url = `${options.baseUrl}/api/tiles/token/${encodeURIComponent(datasetId)}/`;
  const body = (await getJson(url, options, fetchImpl, signal)) as Record<string, unknown>;
  const sig = asString(body.sig);
  const scope = asString(body.scope);
  const exp = asNumber(body.exp);
  if (!sig || !scope || exp === null) {
    throw new Error("GeoLens tile token response was malformed");
  }
  return {
    kind: asString(body.kind) ?? "vector",
    sig,
    exp,
    scope,
    expiresIn: asNumber(body.expires_in) ?? 0,
  };
}

/**
 * Build the signed `{z}/{x}/{y}` MVT template and its source-layer from a token.
 * The `{z}/{x}/{y}` braces are MapLibre placeholders and stay literal; only the
 * query values are encoded.
 */
export function vectorTileTemplate(
  options: GeoLensClientOptions,
  token: GeoLensTileToken,
): GeoLensVectorTiles {
  const table = `data.${token.scope}`;
  const query = new URLSearchParams({
    sig: token.sig,
    exp: String(token.exp),
    scope: token.scope,
  }).toString();
  return {
    tiles: `${options.baseUrl}/api/tiles/${table}/{z}/{x}/{y}.pbf?${query}`,
    sourceLayer: table,
  };
}

function asBounds(value: unknown): [number, number, number, number] | null {
  if (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((n) => typeof n === "number" && Number.isFinite(n))
  ) {
    return value as [number, number, number, number];
  }
  return null;
}

/**
 * Resolve a raster dataset's server-rendered tile source. Hits the same token
 * endpoint as {@link mintTileToken}, but reads the raster shape: the response
 * carries a relative `tile_url` (the Titiler PNG path) plus bounds and a zoom
 * range. The `tile_url` is joined onto the base URL to give MapLibre an
 * absolute XYZ template. Throws when the dataset is not a raster tile source.
 */
export async function resolveRasterTiles(
  options: GeoLensClientOptions,
  datasetId: string,
  fetchImpl: GeoLensFetch = defaultGeoLensFetch,
  signal?: AbortSignal,
): Promise<GeoLensRasterTiles> {
  const url = `${options.baseUrl}/api/tiles/token/${encodeURIComponent(datasetId)}/`;
  const body = (await getJson(url, options, fetchImpl, signal)) as Record<string, unknown>;
  const tileUrl = asString(body.tile_url);
  if (asString(body.kind) !== "raster" || !tileUrl) {
    throw new Error("GeoLens dataset is not a raster tile source");
  }
  // `tile_url` is relative and keeps its literal {z}/{x}/{y} placeholders; a
  // plain join preserves them (they must not be URL-encoded).
  return {
    tiles: `${options.baseUrl}${tileUrl}`,
    bounds: asBounds(body.bounds),
    minzoom: asNumber(body.minzoom) ?? 0,
    maxzoom: asNumber(body.maxzoom) ?? 22,
    tileSize: asNumber(body.tile_size) ?? 256,
  };
}

/** OGC API Features items URL (one GeoJSON page) for a dataset. */
/**
 * A `[minLon, minLat, maxLon, maxLat]` extent to restrict a feature load to,
 * e.g. the current map view.
 */
export type GeoLensBbox = readonly [number, number, number, number];

/** Serialize a bbox for the OGC `bbox` query parameter, clamped to valid ranges. */
export function bboxParam(bbox: GeoLensBbox): string {
  const lon = (v: number): number => Math.min(180, Math.max(-180, v));
  const lat = (v: number): number => Math.min(90, Math.max(-90, v));
  return [lon(bbox[0]), lat(bbox[1]), lon(bbox[2]), lat(bbox[3])].join(",");
}

/**
 * OGC API Features items URL (one GeoJSON page) for a dataset, optionally
 * restricted to a bounding box.
 */
export function itemsUrl(
  options: GeoLensClientOptions,
  datasetId: string,
  limit: number,
  bbox?: GeoLensBbox,
): string {
  const query = `limit=${limit}${bbox ? `&bbox=${encodeURIComponent(bboxParam(bbox))}` : ""}`;
  return `${options.baseUrl}/api/collections/${encodeURIComponent(datasetId)}/items?${query}`;
}

/**
 * The known-safe items page size, used as the last rung of
 * {@link GEOLENS_PAGE_SIZE_LADDER}. GeoLens caps the `limit` query param and
 * **rejects** anything above the cap with HTTP 400 rather than clamping, and
 * the cap is not advertised anywhere a client can read, so the loader probes
 * downward instead of assuming.
 */
export const GEOLENS_PAGE_LIMIT = 100;

/**
 * Page sizes retried, in order, after a server rejects the full requested
 * limit with HTTP 400: GeoLens's OGC items cap (10,000), then the
 * conservative floor every deployment accepts.
 */
const GEOLENS_PAGE_SIZE_LADDER = [10_000, GEOLENS_PAGE_LIMIT];

/**
 * Load up to `limit` features, following OGC API Features `rel=next` links.
 *
 * With a `bbox` the server filters to that extent, so `limit` then caps how many
 * features *in view* are loaded rather than which arbitrary slice of the whole
 * dataset arrives first.
 *
 * The first request asks for all `limit` features at once, so a server whose
 * page cap allows it answers in a single round trip. A server that caps the
 * page size responds one of two ways: clamping servers return a shorter first
 * page plus a `next` link, which the pagination loop follows as usual; GeoLens
 * instead rejects the request with HTTP 400, in which case the loader retries
 * down {@link GEOLENS_PAGE_SIZE_LADDER} until a page size is accepted.
 */
export async function fetchDatasetFeatures(
  options: GeoLensClientOptions,
  datasetId: string,
  limit: number,
  fetchImpl: GeoLensFetch = defaultGeoLensFetch,
  signal?: AbortSignal,
  bbox?: GeoLensBbox,
): Promise<import("geojson").FeatureCollection> {
  if (!HTTP_URL_RE.test(options.baseUrl)) throw new Error("GeoLens URL must be http(s)");
  const base = new URL(options.baseUrl);
  const requested = Math.max(1, Math.floor(limit));
  const pageSizes = [requested, ...GEOLENS_PAGE_SIZE_LADDER.filter((n) => n < requested)];

  for (let attempt = 0; attempt < pageSizes.length; attempt++) {
    const features: import("geojson").Feature[] = [];
    const visited = new Set<string>();
    let nextUrl: string | null = itemsUrl(options, datasetId, pageSizes[attempt], bbox);
    let firstPage: Record<string, unknown> | null = null;
    let pageSizeRejected = false;

    while (nextUrl && features.length < requested && !visited.has(nextUrl)) {
      visited.add(nextUrl);
      const res = await fetchImpl(nextUrl, { headers: authHeaders(options), signal });
      if (!res.ok) {
        // Only a 400 on the *first* request means the page size was refused;
        // one mid-pagination is a real error and must surface, not silently
        // restart the whole download.
        if (res.status === 400 && firstPage === null && attempt < pageSizes.length - 1) {
          pageSizeRejected = true;
          break;
        }
        throw new Error(`GeoLens items request failed (HTTP ${res.status})`);
      }
      const body = (await res.json()) as Record<string, unknown>;
      if (!firstPage) firstPage = body;
      if (!Array.isArray(body.features)) {
        throw new Error("GeoLens items response contained no features");
      }
      // Appended one at a time, not spread: a page can hold more features than
      // the engine accepts as call arguments, and `push(...page)` would throw.
      for (const feature of body.features as import("geojson").Feature[]) {
        if (features.length >= requested) break;
        features.push(feature);
      }

      const links = Array.isArray(body.links) ? body.links : [];
      const next = links.find(
        (link): link is { rel: string; href: string } =>
          !!link &&
          typeof link === "object" &&
          (link as { rel?: unknown }).rel === "next" &&
          typeof (link as { href?: unknown }).href === "string",
      );
      if (next) {
        // A deployment behind a reverse proxy may advertise its *internal*
        // origin in link hrefs (datasets.geolibre.app returns
        // `http://localhost:8080/...` next links), so the href's path + query
        // are rebased onto the configured base URL rather than trusted
        // verbatim. This also keeps every paginated request (and its auth
        // header) on the origin the user connected to.
        const resolvedUrl: URL = new URL(next.href, nextUrl);
        nextUrl = `${base.origin}${resolvedUrl.pathname}${resolvedUrl.search}`;
      } else {
        nextUrl = null;
      }
    }

    if (pageSizeRejected) continue;
    return {
      ...(firstPage ?? {}),
      type: "FeatureCollection",
      features,
    } as import("geojson").FeatureCollection;
  }

  // Unreachable: the final ladder rung either returns or throws above.
  throw new Error("GeoLens items request failed");
}

/**
 * The dataset's attribute (field) names, read from a single OGC API Features
 * item. GeoLens exposes no queryables endpoint, but a `limit=1` items request
 * carries a representative feature whose `properties` keys are the fields. Used
 * to populate a vector-tile layer's `metadata.fields` so the host Style panel's
 * attribute dropdowns (3D extrusion height, graduated/categorical color) work —
 * a vector-tile layer has no `geojson` features for the host to read them from.
 */
export async function fetchDatasetFields(
  options: GeoLensClientOptions,
  datasetId: string,
  fetchImpl: GeoLensFetch = defaultGeoLensFetch,
  signal?: AbortSignal,
): Promise<string[]> {
  const res = await fetchImpl(itemsUrl(options, datasetId, 1), {
    headers: authHeaders(options),
    signal,
  });
  if (!res.ok) throw new Error(`GeoLens items request failed (HTTP ${res.status})`);
  const body = (await res.json()) as {
    features?: Array<{ properties?: Record<string, unknown> | null }>;
  };
  const properties = body.features?.[0]?.properties;
  return properties ? Object.keys(properties) : [];
}

/** The dataset's human-readable detail page on the GeoLens web UI. */
export function datasetPageUrl(options: GeoLensClientOptions, datasetId: string): string {
  return `${options.baseUrl}/datasets/${encodeURIComponent(datasetId)}`;
}

/**
 * Map a GeoLens `geometry_type` (e.g. `MULTIPOLYGON`, `LINESTRING`) to the
 * host's canonical `point | line | polygon` geometry kind, or null when it
 * can't be classified (mixed/unknown). Used to set a vector-tile layer's
 * `metadata.geometryType` so the host knows the geometry without local features.
 */
export function geometryKind(geometryType: string | null): "point" | "line" | "polygon" | null {
  const g = (geometryType ?? "").toUpperCase();
  if (g.includes("POINT")) return "point";
  if (g.includes("LINE")) return "line"; // LINESTRING / MULTILINESTRING
  if (g.includes("POLYGON")) return "polygon";
  return null;
}

// ---------------------------------------------------------------------------
// Feature editing (write-back).
// ---------------------------------------------------------------------------

/**
 * What a GeoLens deployment allows, read from its public settings.
 *
 * `datasetEditing` mirrors the server's `enable_dataset_editing` flag. It is
 * **off by default** (it is off on `datasets.geolibre.app` today), and when it
 * is off every write returns an error — so the UI reads this at connect time
 * and offers saving only when the server would accept it.
 */
export interface GeoLensCapabilities {
  datasetEditing: boolean;
}

/**
 * Read the server's public feature flags. The endpoint needs no credentials.
 *
 * A server that does not expose it (an older deployment, or a proxy that hides
 * `/api/settings`) is reported as "no editing" rather than optimistically
 * enabled: a disabled Save button is a far better failure than one that offers
 * to write and then fails per feature after the user has committed edits.
 */
export async function fetchCapabilities(
  options: GeoLensClientOptions,
  fetchImpl: GeoLensFetch = defaultGeoLensFetch,
  signal?: AbortSignal,
): Promise<GeoLensCapabilities> {
  try {
    const body = (await getJson(
      `${options.baseUrl}/api/settings/feature-flags/`,
      options,
      fetchImpl,
      signal,
    )) as Record<string, unknown>;
    return { datasetEditing: body.enable_dataset_editing === true };
  } catch {
    return { datasetEditing: false };
  }
}

/** The GeoLens row id of a feature (its `gid`), used in the per-feature paths. */
export type GeoLensGid = number;

/** A feature's server-side state at load time, keyed by `String(gid)`. */
export interface GeoLensBaselineEntry {
  geometry: import("geojson").Geometry | null;
  properties: Record<string, unknown>;
}

/** Snapshot of a dataset's features as loaded, for diffing on save. */
export type GeoLensFeatureBaseline = Map<string, GeoLensBaselineEntry>;

/** One feature to write back, and how. */
export interface GeoLensFeatureUpdate {
  gid: GeoLensGid;
  /**
   * `replace` sends PUT with the whole feature, `patch` sends PATCH with only
   * the geometry. Attribute changes always go through PUT because GeoLens does
   * not document whether PATCH merges or replaces the `properties` map — and a
   * merge would silently keep an attribute the user cleared.
   */
  mode: "replace" | "patch";
  geometry: import("geojson").Geometry | null;
  properties: Record<string, unknown>;
}

/** A feature that exists only locally, plus where it sits in the collection. */
export interface GeoLensFeatureCreate {
  /** Index in the edited collection, so the assigned gid can be written back. */
  index: number;
  geometry: import("geojson").Geometry;
  properties: Record<string, unknown>;
}

/** The complete set of writes that would bring the server in line with a layer. */
export interface GeoLensEditPlan {
  creates: GeoLensFeatureCreate[];
  updates: GeoLensFeatureUpdate[];
  deletes: GeoLensGid[];
}

/** Total number of requests a plan implies (drives the progress readout). */
export function editPlanSize(plan: GeoLensEditPlan): number {
  return plan.creates.length + plan.updates.length + plan.deletes.length;
}

/** True when a plan would write nothing. */
export function isEditPlanEmpty(plan: GeoLensEditPlan): boolean {
  return editPlanSize(plan) === 0;
}

/**
 * Editor-internal property keys that must never be written to the server:
 * Geoman's own `__gm_*` shape hints and the GeoEditor's transient feature-key
 * tag. Both can survive into a layer's `geojson` after an edit session.
 */
function isInternalProperty(key: string): boolean {
  return key.startsWith("__gm_") || key === GEOMETRY_EDIT_FID_PROPERTY;
}

/** A feature's attributes with editor-internal keys removed. */
function cleanProperties(
  properties: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties ?? {})) {
    if (!isInternalProperty(key)) out[key] = value;
  }
  return out;
}

/**
 * The GeoLens `gid` a feature carries, or null when it has none (a feature the
 * user drew locally). GeoLens returns the row id as the GeoJSON `id` member, so
 * it survives `addGeoJsonLayer`, the attribute table, and the GeoEditor's
 * round-trip (which restores `feature.id` from its own tag on save).
 */
export function featureGid(feature: { id?: string | number | undefined }): GeoLensGid | null {
  const raw = feature.id;
  if (typeof raw === "number") return Number.isInteger(raw) ? raw : null;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed : null;
}

/**
 * Snapshot the features of a freshly loaded dataset so a later save can tell
 * what the user actually changed. Only features carrying a `gid` are captured —
 * anything else does not exist on the server and is a create, not an update.
 *
 * Deep-cloned so that later in-place edits of the layer's geojson cannot drift
 * the baseline (which would make the diff miss those edits).
 */
export function captureFeatureBaseline(
  collection: import("geojson").FeatureCollection,
): GeoLensFeatureBaseline {
  const baseline: GeoLensFeatureBaseline = new Map();
  for (const feature of collection.features) {
    const gid = featureGid(feature);
    if (gid === null) continue;
    baseline.set(String(gid), {
      geometry: feature.geometry ? structuredClone(feature.geometry) : null,
      properties: cleanProperties(feature.properties),
    });
  }
  return baseline;
}

function canonicalGeometry(geometry: import("geojson").Geometry | null | undefined): string {
  if (!geometry) return "null";
  try {
    return JSON.stringify(geometry);
  } catch {
    return "null";
  }
}

/**
 * Canonical form of a feature's attributes for change detection, with keys
 * holding `null` treated as absent.
 *
 * A GeoLens row exposes every column, so a feature with nothing filled in comes
 * back as `{"id": null, "height": null}` — but a GeoEditor session returns it as
 * `{}`, because the editor drops null-valued keys on the round trip. Comparing
 * those literally makes **every** feature in such a dataset look edited the
 * moment the user opens the editor, and a 540-feature layer then issues 540
 * writes that set null columns to null (verified against the Las Vegas
 * Buildings demo dataset: geometry byte-identical, `{"id":null,…}` vs `{}`).
 *
 * Absent and null mean the same thing to the server here — both leave the
 * column NULL — so folding them together drops writes that could not change
 * anything. A key whose real value disappears still registers as a change,
 * which is the case that must not be masked.
 */
function canonicalProperties(properties: Record<string, unknown>): string {
  const keys = Object.keys(properties)
    .filter((key) => properties[key] !== null && properties[key] !== undefined)
    .sort();
  try {
    return JSON.stringify(keys.map((key) => [key, properties[key]]));
  } catch {
    return "";
  }
}

/**
 * Diff a layer's current features against the baseline captured when it was
 * loaded, producing the writes that would reconcile the server with it.
 *
 * Identity comes from the `gid` in each feature's GeoJSON `id`:
 *
 *  - a feature whose gid is in the baseline is an **update** (skipped entirely
 *    when neither its geometry nor its attributes moved);
 *  - a feature with no gid — or with one the baseline never held, which is what
 *    a locally drawn feature ends up with — is a **create**;
 *  - a baseline gid that no current feature claims is a **delete**.
 *
 * A gid claimed twice (Geoman's copy/split duplicates `properties`, and the
 * GeoEditor hands the duplicate a fresh id, but a hand-built collection could
 * still repeat one) updates the server row once, from the first occurrence; the
 * rest are treated as creates, which is what a copied feature should be.
 */
export function diffFeatures(
  collection: import("geojson").FeatureCollection,
  baseline: GeoLensFeatureBaseline,
): GeoLensEditPlan {
  const plan: GeoLensEditPlan = { creates: [], updates: [], deletes: [] };
  const seen = new Set<string>();

  collection.features.forEach((feature, index) => {
    const properties = cleanProperties(feature.properties);
    const gid = featureGid(feature);
    const key = gid === null ? null : String(gid);
    const original = key !== null && !seen.has(key) ? baseline.get(key) : undefined;

    if (key !== null && original) {
      seen.add(key);
      const geometryChanged =
        canonicalGeometry(feature.geometry) !== canonicalGeometry(original.geometry);
      const propertiesChanged =
        canonicalProperties(properties) !== canonicalProperties(original.properties);
      if (!geometryChanged && !propertiesChanged) return;
      plan.updates.push({
        gid: gid as GeoLensGid,
        // Attributes replace wholesale; a geometry-only move can PATCH. A
        // feature with no geometry cannot be PUT (GeoLens requires one), so it
        // falls back to a properties PATCH.
        mode: propertiesChanged && feature.geometry ? "replace" : "patch",
        geometry: feature.geometry ?? null,
        properties,
      });
      return;
    }

    // A create needs geometry: GeoLens rejects a feature without one, and there
    // is nothing meaningful to insert.
    if (!feature.geometry) return;
    plan.creates.push({ index, geometry: feature.geometry, properties });
  });

  for (const key of baseline.keys()) {
    if (!seen.has(key)) plan.deletes.push(Number(key));
  }

  return plan;
}

/** Path of one dataset's feature collection endpoint. */
function featuresUrl(options: GeoLensClientOptions, datasetId: string): string {
  return `${options.baseUrl}/api/datasets/${encodeURIComponent(datasetId)}/features/`;
}

/**
 * Turn a failed write into a message worth showing. GeoLens answers with an
 * RFC 7807 problem document, whose `detail` names the actual cause (a bad
 * geometry type, a column that does not exist, editing disabled); the status
 * code alone would hide all of that.
 */
async function writeError(res: GeoLensHttpResponse, fallback: string): Promise<Error> {
  let detail = "";
  try {
    const body = (await res.json()) as Record<string, unknown>;
    const candidate = body?.detail ?? body?.title;
    if (typeof candidate === "string") detail = candidate;
  } catch {
    // A non-JSON error body (a proxy's HTML 502) leaves just the status.
  }
  return new Error(detail ? `${fallback}: ${detail}` : `${fallback} (HTTP ${res.status})`);
}

async function writeRequest(
  url: string,
  method: string,
  options: GeoLensClientOptions,
  body: unknown | undefined,
  fetchImpl: GeoLensFetch,
  signal: AbortSignal | undefined,
  fallback: string,
): Promise<GeoLensHttpResponse> {
  if (!HTTP_URL_RE.test(url)) throw new Error("GeoLens URL must be http(s)");
  const res = await fetchImpl(url, {
    method,
    headers: {
      ...authHeaders(options),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal,
  });
  if (!res.ok) throw await writeError(res, fallback);
  return res;
}

/**
 * Insert one feature. Returns the `gid` GeoLens assigned it, or null when the
 * response carries no usable id — the write still succeeded, but the caller
 * cannot link the local feature to its new row and must reload to edit it again.
 */
export async function createFeature(
  options: GeoLensClientOptions,
  datasetId: string,
  feature: { geometry: import("geojson").Geometry; properties: Record<string, unknown> },
  fetchImpl: GeoLensFetch = defaultGeoLensFetch,
  signal?: AbortSignal,
): Promise<GeoLensGid | null> {
  const res = await writeRequest(
    featuresUrl(options, datasetId),
    "POST",
    options,
    { geometry: feature.geometry, properties: feature.properties },
    fetchImpl,
    signal,
    "Could not create feature",
  );
  try {
    const body = (await res.json()) as { id?: unknown; gid?: unknown };
    const raw = body?.id ?? body?.gid;
    return typeof raw === "number" && Number.isInteger(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** Write one changed feature back, replacing it or patching its geometry. */
export async function updateFeature(
  options: GeoLensClientOptions,
  datasetId: string,
  update: GeoLensFeatureUpdate,
  fetchImpl: GeoLensFetch = defaultGeoLensFetch,
  signal?: AbortSignal,
): Promise<void> {
  const url = `${featuresUrl(options, datasetId)}${update.gid}`;
  const body =
    update.mode === "replace"
      ? { geometry: update.geometry, properties: update.properties }
      : update.geometry
        ? { geometry: update.geometry }
        : { properties: update.properties };
  await writeRequest(
    url,
    update.mode === "replace" ? "PUT" : "PATCH",
    options,
    body,
    fetchImpl,
    signal,
    `Could not update feature ${update.gid}`,
  );
}

/** Delete one feature by its `gid`. */
export async function deleteFeature(
  options: GeoLensClientOptions,
  datasetId: string,
  gid: GeoLensGid,
  fetchImpl: GeoLensFetch = defaultGeoLensFetch,
  signal?: AbortSignal,
): Promise<void> {
  await writeRequest(
    `${featuresUrl(options, datasetId)}${gid}`,
    "DELETE",
    options,
    undefined,
    fetchImpl,
    signal,
    `Could not delete feature ${gid}`,
  );
}

/** What actually happened when a plan was applied. */
export interface GeoLensEditResult {
  /** Newly inserted features: collection index → the gid GeoLens assigned. */
  created: Array<{ index: number; gid: GeoLensGid | null }>;
  updated: GeoLensGid[];
  deleted: GeoLensGid[];
  /** One message per failed write; the rest of the plan still ran. */
  errors: string[];
}

/**
 * Apply an edit plan, one request per changed feature.
 *
 * Requests are issued **sequentially**: GeoLens has no bulk or transactional
 * endpoint, so this is a stream of independent writes, and serializing them
 * keeps them off each other's row locks, makes `onProgress` meaningful, and
 * stops a large save from flooding a small self-hosted deployment.
 *
 * A failed write is recorded and the plan continues, so one rejected geometry
 * cannot strand the remaining edits — meaning a save can be **partially
 * applied**. That is why the caller re-baselines from what succeeded rather
 * than assuming the whole plan landed.
 *
 * Updates run before creates and deletes so that a feature that was both moved
 * and (elsewhere) deleted is written in the order the user would expect.
 */
export async function applyFeatureEdits(
  options: GeoLensClientOptions,
  datasetId: string,
  plan: GeoLensEditPlan,
  fetchImpl: GeoLensFetch = defaultGeoLensFetch,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<GeoLensEditResult> {
  const result: GeoLensEditResult = { created: [], updated: [], deleted: [], errors: [] };
  const total = editPlanSize(plan);
  let done = 0;
  const step = (): void => {
    done += 1;
    onProgress?.(done, total);
  };

  for (const update of plan.updates) {
    if (signal?.aborted) return result;
    try {
      await updateFeature(options, datasetId, update, fetchImpl, signal);
      result.updated.push(update.gid);
    } catch (error) {
      result.errors.push(error instanceof Error ? error.message : String(error));
    }
    step();
  }

  for (const create of plan.creates) {
    if (signal?.aborted) return result;
    try {
      const gid = await createFeature(options, datasetId, create, fetchImpl, signal);
      result.created.push({ index: create.index, gid });
    } catch (error) {
      result.errors.push(error instanceof Error ? error.message : String(error));
    }
    step();
  }

  for (const gid of plan.deletes) {
    if (signal?.aborted) return result;
    try {
      await deleteFeature(options, datasetId, gid, fetchImpl, signal);
      result.deleted.push(gid);
    } catch (error) {
      result.errors.push(error instanceof Error ? error.message : String(error));
    }
    step();
  }

  return result;
}

/** STAC 1.0 landing page URL. */
export function stacCatalogUrl(options: GeoLensClientOptions): string {
  return `${options.baseUrl}/api/stac`;
}

/** STAC collections URL. */
export function stacCollectionsUrl(options: GeoLensClientOptions): string {
  return `${options.baseUrl}/api/stac/collections`;
}
