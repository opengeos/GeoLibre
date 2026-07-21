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
 *    load. GeoLens caps `limit` (300 → 400), so this reads one page.
 *  - **STAC 1.0** — `/api/stac` catalog + `/api/stac/collections`, the natural
 *    path for raster/COG datasets.
 *
 * This module is deliberately DOM-free and framework-free so it can be unit
 * tested under `node --test`; everything that touches the map or the document
 * lives in `maplibre-geolens.ts`. The `fetchImpl` is injected (mirrors
 * `SourceCoopFetch` in `source-coop-api.ts`) so tests need no real server.
 */

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

/** Minimal response shape, so tests can stub the network without a DOM. */
export interface GeoLensHttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/** Minimal fetch shape. Mirrors `SourceCoopFetch` in `source-coop-api.ts`. */
export type GeoLensFetch = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
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
export function authHeaders(options: GeoLensClientOptions): Record<string, string> {
  const key = options.apiKey?.trim();
  return key ? { "X-Api-Key": key } : {};
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

/** OGC API Features items URL (one GeoJSON page) for a dataset. */
export function itemsUrl(options: GeoLensClientOptions, datasetId: string, limit: number): string {
  return `${options.baseUrl}/api/collections/${encodeURIComponent(datasetId)}/items?limit=${limit}`;
}

/** STAC 1.0 landing page URL. */
export function stacCatalogUrl(options: GeoLensClientOptions): string {
  return `${options.baseUrl}/api/stac`;
}

/** STAC collections URL. */
export function stacCollectionsUrl(options: GeoLensClientOptions): string {
  return `${options.baseUrl}/api/stac/collections`;
}
