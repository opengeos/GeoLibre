/**
 * Catalog, search and URL helpers for HUB Ocean's Ocean Data Platform (ODP).
 *
 * ODP publishes three public, keyless read APIs for its datasets:
 *
 * - a STAC API (`/api/stac`) listing every public dataset as an item grouped
 *   into collections. It is CORS-open, so the panel reads it directly. The whole
 *   public catalog is a few hundred items, so it is loaded once and searched
 *   client-side (the STAC API ignores free-text `q`).
 * - Mapbox Vector Tiles per dataset (`/api/table/v2/tile/<uuid>?z=&x=&y=`, one
 *   source layer named `main`).
 * - OGC API Features per dataset (`/api/features/collections/<uuid>/items`).
 *
 * The tile and features endpoints send CORS headers only for
 * `app.hubocean.earth`, so every GeoLibre host reads them through the tiles
 * Worker's `/odp/` route (see workers/tiles). The desktop app reads features
 * over native HTTP instead, but its webview fetches map tiles itself, so tiles
 * always take the Worker.
 *
 * A STAC item id is the dataset UUID the tile and features endpoints take.
 */

/** ODP's API origin. */
export const ODP_API_BASE = "https://api.hubocean.earth";

/** The public STAC API root. */
export const ODP_STAC_URL = `${ODP_API_BASE}/api/stac`;

/** The ODP web app. */
export const ODP_APP_URL = "https://app.hubocean.earth";

/** The ODP web catalog. */
export const ODP_CATALOG_URL = `${ODP_APP_URL}/catalog`;

/** ODP's developer documentation. */
export const ODP_DOCS_URL = "https://docs.hubocean.earth";

/** The ODP terms of use. */
export const ODP_TERMS_URL = "https://www.hubocean.earth/odp-terms";

/** The tiles Worker route that re-emits ODP tiles and features with CORS. */
export const ODP_PROXY_ENDPOINT = "https://tiles.geolibre.app/odp";

/** The single source layer in every ODP vector tile. */
export const ODP_SOURCE_LAYER = "main";

/**
 * Highest zoom requested from ODP. It renders tiles at every zoom, but deeper
 * tiles only add requests (a cold tile takes seconds upstream), so MapLibre
 * overzooms from here.
 */
export const ODP_TILE_MAX_ZOOM = 14;

/** Largest OGC API Features page the Worker forwards (and the panel requests). */
export const ODP_FEATURES_MAX_LIMIT = 10_000;

/** Most STAC items requested per catalog page. */
const STAC_PAGE_LIMIT = 1000;

/** Most catalog pages followed, a guard against a `next` link loop. */
const STAC_MAX_PAGES = 20;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `[west, south, east, north]` in WGS84 degrees. */
export type OdpBbox = [number, number, number, number];

/** One ODP data collection (a STAC collection). */
export interface OdpCollection {
  id: string;
  title: string;
  description: string;
  keywords: string[];
}

/** One public ODP dataset (a STAC item). */
export interface OdpDataset {
  /** Dataset UUID, the key the tile and features endpoints take. */
  id: string;
  title: string;
  description: string;
  /** SPDX-like license id, or null when the dataset declares none. */
  license: string | null;
  /** Owning collection id, or null when the item names none. */
  collectionId: string | null;
  /** Owning collection title, or "" when unknown. */
  collectionTitle: string;
  /** The owning collection's keywords, which items do not carry themselves. */
  keywords: string[];
  /**
   * Extent, or null when the catalog gives none. A dataset without an extent
   * may still have geometry; only the catalog record lacks it.
   */
  bbox: OdpBbox | null;
  /** ISO start of the dataset's time range, or null. */
  start: string | null;
  /** ISO end of the dataset's time range, or null. */
  end: string | null;
  /** The dataset's page in the ODP web catalog. */
  catalogUrl: string;
}

/** A catalog search. */
export interface OdpSearch {
  /** Free text; every whitespace-separated term must match somewhere. */
  query: string;
  /** Keep only datasets whose extent intersects this box, when set. */
  bbox: OdpBbox | null;
  /** Keep only this collection's datasets, when set. */
  collectionId: string | null;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/** Strips ODP's "Published — " status prefix some titles carry. */
function cleanTitle(title: string): string {
  return title.replace(/^Published\s+[—-]\s+/u, "").trim();
}

/** Whether a value is a dataset UUID the ODP endpoints accept. */
export function isOdpDatasetId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/**
 * Reads a `[w, s, e, n]` box, or null when the value is not four finite
 * numbers in range. Degenerate boxes (a single point) are kept.
 */
export function parseOdpBbox(value: unknown): OdpBbox | null {
  if (!Array.isArray(value) || value.length < 4) return null;
  // A 3D STAC bbox is [w, s, zmin, e, n, zmax].
  const numbers = value.length === 6 ? [value[0], value[1], value[3], value[4]] : value.slice(0, 4);
  if (!numbers.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  const [west, south, east, north] = numbers as number[];
  if (south > north || south < -90 || north > 90 || west < -180 || east > 180) return null;
  return [west, south, east, north];
}

/**
 * Parses a STAC `/collections` document.
 *
 * @param json - The parsed response body.
 * @returns The collections, skipping malformed entries.
 */
export function parseOdpCollections(json: unknown): OdpCollection[] {
  const list = isRecord(json) && Array.isArray(json.collections) ? json.collections : [];
  const collections: OdpCollection[] = [];
  for (const entry of list) {
    if (!isRecord(entry) || typeof entry.id !== "string") continue;
    collections.push({
      id: entry.id,
      title: cleanTitle(stringOr(entry.title, entry.id)),
      description: stringOr(entry.description, ""),
      keywords: Array.isArray(entry.keywords)
        ? entry.keywords.filter((k): k is string => typeof k === "string")
        : [],
    });
  }
  return collections;
}

/**
 * Parses the features of a STAC item search into datasets.
 *
 * @param json - The parsed search response.
 * @param collections - Collections by id, to fill in titles and keywords.
 * @returns The datasets, skipping items whose id is not a dataset UUID.
 */
export function parseOdpItems(
  json: unknown,
  collections: ReadonlyMap<string, OdpCollection>,
): OdpDataset[] {
  const features = isRecord(json) && Array.isArray(json.features) ? json.features : [];
  const datasets: OdpDataset[] = [];
  for (const feature of features) {
    if (!isRecord(feature) || typeof feature.id !== "string") continue;
    if (!isOdpDatasetId(feature.id)) continue;
    const properties = isRecord(feature.properties) ? feature.properties : {};
    const collectionId = stringOrNull(feature.collection);
    const collection = collectionId ? collections.get(collectionId) : undefined;
    datasets.push({
      id: feature.id,
      title: cleanTitle(stringOr(properties.title, feature.id)),
      description: stringOr(properties.description, ""),
      license: stringOrNull(properties.license),
      collectionId,
      collectionTitle: collection?.title ?? "",
      keywords: collection?.keywords ?? [],
      bbox: parseOdpBbox(feature.bbox),
      start: stringOrNull(properties.start_datetime) ?? stringOrNull(properties.datetime),
      end: stringOrNull(properties.end_datetime),
      catalogUrl: `${ODP_CATALOG_URL}/dataset/${feature.id}`,
    });
  }
  return datasets;
}

/** The `next` page link of a STAC response, or null. */
function nextLink(json: unknown): string | null {
  if (!isRecord(json) || !Array.isArray(json.links)) return null;
  for (const link of json.links) {
    if (isRecord(link) && link.rel === "next" && typeof link.href === "string") return link.href;
  }
  return null;
}

async function fetchJson(fetchImpl: FetchLike, url: string, signal?: AbortSignal) {
  const response = await fetchImpl(url, { signal, headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`HTTP ${response.status} loading ${url}`);
  return (await response.json()) as unknown;
}

/**
 * Loads the whole public ODP catalog from its STAC API.
 *
 * @param fetchImpl - The fetch to use (the global one by default).
 * @param signal - Aborts the load.
 * @returns The collections, and the datasets sorted by title.
 */
export async function fetchOdpCatalog(
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
  signal?: AbortSignal,
): Promise<{ collections: OdpCollection[]; datasets: OdpDataset[] }> {
  const collections = parseOdpCollections(
    await fetchJson(fetchImpl, `${ODP_STAC_URL}/collections`, signal),
  );
  const byId = new Map(collections.map((collection) => [collection.id, collection]));
  const datasets: OdpDataset[] = [];
  const seen = new Set<string>();
  let url: string | null = `${ODP_STAC_URL}/search?limit=${STAC_PAGE_LIMIT}`;
  for (let page = 0; url && page < STAC_MAX_PAGES; page++) {
    const json = await fetchJson(fetchImpl, url, signal);
    const items = parseOdpItems(json, byId);
    for (const item of items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      datasets.push(item);
    }
    // An empty page ends the walk even if the server still links a next one.
    url = items.length > 0 ? nextLink(json) : null;
    // Only follow pages on ODP's own STAC API.
    if (url && !url.startsWith(`${ODP_STAC_URL}/`)) url = null;
  }
  collections.sort((a, b) => a.title.localeCompare(b.title));
  datasets.sort((a, b) => a.title.localeCompare(b.title));
  return { collections, datasets };
}

/** Whether two boxes overlap. A box crossing the antimeridian has west > east. */
export function odpBboxesIntersect(a: OdpBbox, b: OdpBbox): boolean {
  if (a[1] > b[3] || a[3] < b[1]) return false;
  const spans = (box: OdpBbox): Array<[number, number]> =>
    box[0] <= box[2]
      ? [[box[0], box[2]]]
      : [
          [box[0], 180],
          [-180, box[2]],
        ];
  return spans(a).some(([aw, ae]) => spans(b).some(([bw, be]) => aw <= be && ae >= bw));
}

/**
 * Filters and ranks the catalog for a search. Title matches rank above matches
 * found only in the description, collection or keywords; ties keep the
 * catalog's title order.
 *
 * @param datasets - The loaded catalog.
 * @param search - The search to apply.
 * @returns The matching datasets.
 */
export function searchOdpDatasets(
  datasets: readonly OdpDataset[],
  search: OdpSearch,
): OdpDataset[] {
  const terms = search.query.toLowerCase().split(/\s+/).filter(Boolean);
  const ranked: Array<{ dataset: OdpDataset; rank: number }> = [];
  for (const dataset of datasets) {
    if (search.collectionId && dataset.collectionId !== search.collectionId) continue;
    if (search.bbox && !(dataset.bbox && odpBboxesIntersect(dataset.bbox, search.bbox))) continue;
    if (terms.length === 0) {
      ranked.push({ dataset, rank: 0 });
      continue;
    }
    const title = dataset.title.toLowerCase();
    const haystack = [
      title,
      dataset.description,
      dataset.collectionTitle,
      dataset.license ?? "",
      dataset.id,
      ...dataset.keywords,
    ]
      .join("\n")
      .toLowerCase();
    if (!terms.every((term) => haystack.includes(term))) continue;
    ranked.push({ dataset, rank: terms.every((term) => title.includes(term)) ? 0 : 1 });
  }
  // Array.prototype.sort is stable, so equal ranks keep the input order.
  return ranked.sort((a, b) => a.rank - b.rank).map((entry) => entry.dataset);
}

/**
 * The vector tile URL template for a dataset, routed through the Worker.
 *
 * @param datasetId - The dataset UUID.
 * @param endpoint - The Worker route (overridable for local testing).
 */
export function odpTileUrlTemplate(datasetId: string, endpoint = ODP_PROXY_ENDPOINT): string {
  return `${endpoint.replace(/\/+$/, "")}/tiles/${datasetId}/{z}/{x}/{y}.pbf`;
}

/**
 * Clamps a box to what the features route accepts. A box crossing the
 * antimeridian (west > east) becomes the full longitude range, since one OGC
 * `bbox` cannot express it.
 */
function featuresBbox(bbox: OdpBbox): OdpBbox {
  const clamp = (value: number, limit: number) => Math.max(-limit, Math.min(limit, value));
  const round = (value: number) => Math.round(value * 1e6) / 1e6;
  const south = round(clamp(bbox[1], 90));
  const north = round(clamp(bbox[3], 90));
  if (bbox[0] > bbox[2]) return [-180, south, 180, north];
  return [round(clamp(bbox[0], 180)), south, round(clamp(bbox[2], 180)), north];
}

/**
 * An OGC API Features items URL for a dataset.
 *
 * @param datasetId - The dataset UUID.
 * @param options.bbox - Keep only features intersecting this box.
 * @param options.limit - Most features returned (capped at
 *   {@link ODP_FEATURES_MAX_LIMIT}).
 * @param options.via - `"proxy"` (the Worker, for browsers) or `"direct"` (ODP
 *   itself, for native HTTP clients).
 * @param options.endpoint - The Worker route (overridable for local testing).
 */
export function odpFeaturesUrl(
  datasetId: string,
  options: {
    bbox?: OdpBbox | null;
    limit: number;
    via: "proxy" | "direct";
    endpoint?: string;
  },
): string {
  const params = new URLSearchParams();
  if (options.via === "direct") params.set("f", "json");
  const limit = Math.max(1, Math.min(ODP_FEATURES_MAX_LIMIT, Math.floor(options.limit)));
  params.set("limit", String(limit));
  if (options.bbox) params.set("bbox", featuresBbox(options.bbox).join(","));
  const base =
    options.via === "direct"
      ? `${ODP_API_BASE}/api/features/collections/${datasetId}`
      : `${(options.endpoint ?? ODP_PROXY_ENDPOINT).replace(/\/+$/, "")}/features/${datasetId}`;
  return `${base}/items?${params}`;
}

/** The host's geometry signal for a GeoJSON geometry type. */
export function odpGeometryKind(geometryType: unknown): "point" | "line" | "polygon" | null {
  const type = typeof geometryType === "string" ? geometryType.toUpperCase() : "";
  if (type.includes("POINT")) return "point";
  if (type.includes("LINE")) return "line";
  if (type.includes("POLYGON")) return "polygon";
  return null;
}

/**
 * A short, readable label for a dataset's time range, or "" when it has none.
 * Dates only; ODP's timestamps are midnight or end-of-day.
 */
export function odpTimeRange(dataset: Pick<OdpDataset, "start" | "end">): string {
  const day = (value: string | null) => (value ? value.slice(0, 10) : "");
  const start = day(dataset.start);
  const end = day(dataset.end);
  if (start && end && start !== end) return `${start} – ${end}`;
  return start || end;
}
