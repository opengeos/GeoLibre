/**
 * NASA Earthdata search and access, the browser counterpart of the Python
 * `earthaccess` library: find datasets (collections) and files (granules) in
 * NASA's Common Metadata Repository (CMR), and fetch them with an Earthdata
 * Login (EDL) token.
 *
 * CMR answers with `Access-Control-Allow-Origin: *`, so search works from any
 * build. The DAACs that serve the files do not send CORS headers and refuse a
 * preflighted `Authorization` header, so authenticated downloads need the
 * desktop app's native transport.
 */
import type { Feature, FeatureCollection, Geometry, Position } from "geojson";
import { detectSpaceborneLidarProduct } from "./spaceborne-lidar";

/** CMR search root. */
export const CMR_SEARCH_URL = "https://cmr.earthdata.nasa.gov/search";
/** Where a user generates an EDL token by hand. */
export const EARTHDATA_TOKEN_PAGE_URL =
  "https://urs.earthdata.nasa.gov/documentation/for_users/user_token";
/** EDL endpoint that returns (creating if needed) a user token for basic-auth credentials. */
export const EARTHDATA_FIND_OR_CREATE_TOKEN_URL =
  "https://urs.earthdata.nasa.gov/api/users/find_or_create_token";
/** Earthdata Search, for a granule's or collection's own page. */
export const EARTHDATA_SEARCH_URL = "https://search.earthdata.nasa.gov/search";

const HTTP_URL_RE = /^https?:\/\//i;

export {
  EARTHDATA_PROXY_ENDPOINT,
  earthdataProxyUrl,
  isEarthdataDataUrl,
  isEarthdataProxyUrl,
} from "./earthdata-relay";

/** A dataset in CMR. */
export interface EarthdataCollection {
  /** CMR concept id, e.g. `C2237824918-ORNL_CLOUD`. */
  conceptId: string;
  shortName: string;
  version: string;
  title: string;
  /** Archiving data center (DAAC), e.g. `ORNL_CLOUD`. */
  dataCenter: string;
  cloudHosted: boolean;
  timeStart: string | null;
  timeEnd: string | null;
  summary: string;
}

/** A file (granule) in CMR. */
export interface EarthdataGranule {
  /** CMR concept id, e.g. `G4316079212-NSIDC_CPRD`. */
  conceptId: string;
  /** Producer file name, falling back to the CMR title. */
  name: string;
  collectionConceptId: string;
  timeStart: string | null;
  timeEnd: string | null;
  /** Size in megabytes, when CMR reports one. */
  sizeMb: number | null;
  /** Percent cloud cover, when the collection records it. */
  cloudCover: number | null;
  /** HTTPS links to the granule's data files (several for multi-band products). */
  dataLinks: string[];
  /** HTTPS browse images. */
  browseLinks: string[];
  /** Footprint, or null when CMR has no spatial extent for it. */
  geometry: Geometry | null;
}

/** A page of search results and the total number of hits. */
export interface EarthdataSearchPage<T> {
  items: T[];
  hits: number;
}

/** Bounding box as [west, south, east, north] in degrees. */
export type Bbox = [number, number, number, number];

export interface CollectionSearchOptions {
  keyword?: string;
  shortName?: string;
  bbox?: Bbox | null;
  /** [start, end] as ISO dates or date-times; either end may be empty. */
  temporal?: [string, string] | null;
  /** Restrict to datasets in NASA's cloud (Earthdata Cloud). */
  cloudHosted?: boolean;
  pageSize?: number;
  pageNum?: number;
}

export interface GranuleSearchOptions {
  collectionConceptId: string;
  bbox?: Bbox | null;
  temporal?: [string, string] | null;
  pageSize?: number;
  pageNum?: number;
  /** Newest first by default. */
  sortKey?: string;
}

/** A dataset offered as a one-click pick. */
export interface EarthdataPreset {
  shortName: string;
  label: string;
}

/**
 * Datasets offered without a keyword search: the spaceborne LiDAR products the
 * ICESat-2 / GEDI reader opens, plus widely used imagery.
 */
export const EARTHDATA_PRESETS: EarthdataPreset[] = [
  { shortName: "ATL06", label: "ICESat-2 ATL06 Land Ice Height" },
  { shortName: "ATL08", label: "ICESat-2 ATL08 Land and Vegetation Height" },
  { shortName: "GEDI02_A", label: "GEDI L2A Elevation and Height Metrics" },
  { shortName: "GEDI02_B", label: "GEDI L2B Canopy Cover and Vertical Profile" },
  { shortName: "GEDI_L4A_AGB_Density_V2_1_2056", label: "GEDI L4A Aboveground Biomass Density" },
  { shortName: "HLSL30", label: "HLS Landsat 30 m Surface Reflectance" },
  { shortName: "HLSS30", label: "HLS Sentinel-2 30 m Surface Reflectance" },
  { shortName: "NASADEM_HGT", label: "NASADEM Elevation" },
];

/** CMR's `bounding_box` value, clamped and rounded. */
function bboxParam(bbox: Bbox): string {
  const [w, s, e, n] = bbox;
  const clampLat = (v: number) => Math.max(-90, Math.min(90, v));
  const clampLon = (v: number) => Math.max(-180, Math.min(180, v));
  return [clampLon(w), clampLat(s), clampLon(e), clampLat(n)].map((v) => +v.toFixed(5)).join(",");
}

/** CMR's `temporal` value, or null when both ends are empty. */
export function temporalParam(temporal: [string, string] | null | undefined): string | null {
  if (!temporal) return null;
  const [start, end] = temporal.map((value) => value.trim());
  if (!start && !end) return null;
  // A bare date as the end means the whole day.
  const endValue = /^\d{4}-\d{2}-\d{2}$/.test(end) ? `${end}T23:59:59Z` : end;
  const startValue = /^\d{4}-\d{2}-\d{2}$/.test(start) ? `${start}T00:00:00Z` : start;
  return `${startValue},${endValue}`;
}

/**
 * Build a CMR collection search URL.
 *
 * @param options Search terms.
 * @returns The `collections.json` URL.
 */
export function buildCollectionSearchUrl(options: CollectionSearchOptions): string {
  const params = new URLSearchParams();
  const keyword = options.keyword?.trim();
  if (keyword) params.set("keyword", keyword);
  const shortName = options.shortName?.trim();
  if (shortName) params.set("short_name", shortName);
  if (options.bbox) params.set("bounding_box", bboxParam(options.bbox));
  const temporal = temporalParam(options.temporal);
  if (temporal) params.set("temporal", temporal);
  if (options.cloudHosted) params.set("cloud_hosted", "true");
  params.set("has_granules", "true");
  params.set("page_size", String(options.pageSize ?? 20));
  params.set("page_num", String(options.pageNum ?? 1));
  return `${CMR_SEARCH_URL}/collections.json?${params}`;
}

/**
 * Build a CMR granule search URL.
 *
 * @param options Search terms.
 * @returns The `granules.json` URL.
 */
export function buildGranuleSearchUrl(options: GranuleSearchOptions): string {
  const params = new URLSearchParams();
  params.set("collection_concept_id", options.collectionConceptId);
  if (options.bbox) params.set("bounding_box", bboxParam(options.bbox));
  const temporal = temporalParam(options.temporal);
  if (temporal) params.set("temporal", temporal);
  params.set("page_size", String(options.pageSize ?? 25));
  params.set("page_num", String(options.pageNum ?? 1));
  params.set("sort_key", options.sortKey ?? "-start_date");
  return `${CMR_SEARCH_URL}/granules.json?${params}`;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberOrNull(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number.parseFloat(text(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function entries(body: unknown): Record<string, unknown>[] {
  const feed = (body as { feed?: { entry?: unknown } } | null)?.feed;
  return Array.isArray(feed?.entry) ? (feed.entry as Record<string, unknown>[]) : [];
}

/**
 * Parse a `collections.json` response.
 *
 * @param body The decoded JSON.
 * @returns The collections it lists.
 */
export function parseCollections(body: unknown): EarthdataCollection[] {
  return entries(body)
    .filter((entry) => text(entry.id))
    .map((entry) => ({
      conceptId: text(entry.id),
      shortName: text(entry.short_name),
      version: text(entry.version_id),
      title: text(entry.title) || text(entry.dataset_id),
      dataCenter: text(entry.data_center),
      cloudHosted: entry.cloud_hosted === true || entry.cloud_hosted === "true",
      timeStart: text(entry.time_start) || null,
      timeEnd: text(entry.time_end) || null,
      summary: text(entry.summary),
    }));
}

/**
 * The newest version of a dataset among CMR results for one short name,
 * preferring Earthdata Cloud copies (DAACs retire their on-premises archives).
 * CMR cannot sort collections by version, so this compares versions here.
 *
 * @param collections Results of a `short_name` search.
 * @returns The collection to use, or null when there are none.
 */
export function newestCollection(collections: EarthdataCollection[]): EarthdataCollection | null {
  const rank = (c: EarthdataCollection) => (c.cloudHosted ? 1 : 0);
  const compareVersions = (a: string, b: string) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
  let best: EarthdataCollection | null = null;
  for (const collection of collections) {
    if (
      !best ||
      rank(collection) > rank(best) ||
      (rank(collection) === rank(best) && compareVersions(collection.version, best.version) > 0)
    ) {
      best = collection;
    }
  }
  return best;
}

/** Links of one CMR relation (`data`, `browse`, …) that are plain HTTPS files. */
function linksOf(entry: Record<string, unknown>, relation: string): string[] {
  const links = Array.isArray(entry.links) ? (entry.links as Record<string, unknown>[]) : [];
  const out: string[] = [];
  for (const link of links) {
    const rel = text(link.rel);
    const href = text(link.href);
    // Collection-level links ride along on every granule; they are not its files.
    if (link.inherited === true) continue;
    if (!rel.endsWith(`/${relation}#`) || !HTTP_URL_RE.test(href)) continue;
    if (relation === "data" && isMetadataHref(href)) continue;
    if (!out.includes(href)) out.push(href);
  }
  return out;
}

/** Whether a "data" link is really a sidecar (checksum, metadata, S3 credentials). */
function isMetadataHref(href: string): boolean {
  const path = href.split("?")[0].toLowerCase();
  return (
    path.endsWith("/s3credentials") ||
    path.endsWith(".xml") ||
    path.endsWith(".cmr.json") ||
    path.endsWith(".md5") ||
    path.endsWith(".sha256") ||
    path.endsWith(".dmrpp")
  );
}

/**
 * Parse a `granules.json` response.
 *
 * @param body The decoded JSON.
 * @returns The granules it lists.
 */
export function parseGranules(body: unknown): EarthdataGranule[] {
  return entries(body)
    .filter((entry) => text(entry.id))
    .map((entry) => ({
      conceptId: text(entry.id),
      name: text(entry.producer_granule_id) || text(entry.title),
      collectionConceptId: text(entry.collection_concept_id),
      timeStart: text(entry.time_start) || null,
      timeEnd: text(entry.time_end) || null,
      sizeMb: numberOrNull(entry.granule_size),
      cloudCover: numberOrNull(entry.cloud_cover),
      dataLinks: linksOf(entry, "data"),
      browseLinks: linksOf(entry, "browse"),
      geometry: granuleGeometry(entry),
    }));
}

/** Parse CMR's "lat lon lat lon …" coordinate string into [lon, lat] positions. */
export function parseLatLonString(value: string): Position[] {
  const numbers = value
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const positions: Position[] = [];
  for (let i = 0; i + 1 < numbers.length; i += 2) {
    const lat = numbers[i];
    const lon = numbers[i + 1];
    if (Number.isFinite(lat) && Number.isFinite(lon)) positions.push([lon, lat]);
  }
  return positions;
}

/**
 * Make a line or ring continuous across the antimeridian by shifting each
 * longitude by ±360° when it jumps more than 180° from the previous one, so a
 * footprint crossing 180° draws as one shape (MapLibre accepts |lon| > 180).
 */
export function unwrapLongitudes(positions: Position[]): Position[] {
  const out: Position[] = [];
  let offset = 0;
  for (let i = 0; i < positions.length; i += 1) {
    const [lon, lat] = positions[i];
    if (i > 0) {
      const delta = lon + offset - out[i - 1][0];
      if (delta > 180) offset -= 360;
      else if (delta < -180) offset += 360;
    }
    out.push([lon + offset, lat]);
  }
  return out;
}

function closeRing(ring: Position[]): Position[] {
  if (ring.length === 0) return ring;
  const [first, last] = [ring[0], ring[ring.length - 1]];
  return first[0] === last[0] && first[1] === last[1] ? ring : [...ring, first];
}

/** A CMR value that may be one string or an array of them. */
function stringList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

/**
 * The footprint CMR reports for a granule: polygons, bounding boxes, lines
 * (an ICESat-2 or GEDI ground track) or points, in that order of preference.
 *
 * @param entry A raw `granules.json` entry.
 * @returns GeoJSON geometry, or null when the entry has no spatial extent.
 */
export function granuleGeometry(entry: Record<string, unknown>): Geometry | null {
  const polygons: Position[][][] = [];
  for (const polygon of stringList(entry.polygons)) {
    // Each polygon is [outer, ...holes]; older responses send a bare string.
    const rings = stringList(polygon)
      .filter((ring): ring is string => typeof ring === "string")
      .map((ring) => closeRing(unwrapLongitudes(parseLatLonString(ring))))
      .filter((ring) => ring.length >= 4);
    if (rings.length > 0) polygons.push(rings);
  }
  if (polygons.length === 0) {
    for (const box of stringList(entry.boxes)) {
      if (typeof box !== "string") continue;
      const [s, w, n, e] = box.trim().split(/\s+/).map(Number);
      if (![s, w, n, e].every(Number.isFinite)) continue;
      const east = e < w ? e + 360 : e;
      polygons.push([
        [
          [w, s],
          [east, s],
          [east, n],
          [w, n],
          [w, s],
        ],
      ]);
    }
  }
  if (polygons.length === 1) return { type: "Polygon", coordinates: polygons[0] };
  if (polygons.length > 1) return { type: "MultiPolygon", coordinates: polygons };

  const lines = stringList(entry.lines)
    .filter((line): line is string => typeof line === "string")
    .map((line) => unwrapLongitudes(parseLatLonString(line)))
    .filter((line) => line.length >= 2);
  if (lines.length === 1) return { type: "LineString", coordinates: lines[0] };
  if (lines.length > 1) return { type: "MultiLineString", coordinates: lines };

  const points = stringList(entry.points)
    .filter((point): point is string => typeof point === "string")
    .flatMap((point) => parseLatLonString(point));
  if (points.length === 1) return { type: "Point", coordinates: points[0] };
  if (points.length > 1) return { type: "MultiPoint", coordinates: points };
  return null;
}

/** Properties carried by a granule footprint feature. */
export interface EarthdataFootprintProps {
  id: string;
  name: string;
  time_start: string | null;
  size_mb: number | null;
}

/**
 * Footprints for a list of granules, skipping granules without geometry.
 *
 * @param granules Search results.
 * @returns A FeatureCollection whose feature ids are the granule concept ids.
 */
export function granuleFootprints(
  granules: EarthdataGranule[],
): FeatureCollection<Geometry, EarthdataFootprintProps> {
  const features: Feature<Geometry, EarthdataFootprintProps>[] = [];
  for (const granule of granules) {
    if (!granule.geometry) continue;
    features.push({
      type: "Feature",
      id: granule.conceptId,
      geometry: granule.geometry,
      properties: {
        id: granule.conceptId,
        name: granule.name,
        time_start: granule.timeStart,
        size_mb: granule.sizeMb,
      },
    });
  }
  return { type: "FeatureCollection", features };
}

/**
 * The granule's page in Earthdata Search. CMR serves granule records only as
 * metadata formats (`.json`, `.umm_json`, `.xml`), not as HTML.
 *
 * @param granule The granule.
 * @returns A URL that opens the granule in Earthdata Search.
 */
export function granuleDetailsUrl(
  granule: Pick<EarthdataGranule, "conceptId" | "collectionConceptId">,
): string {
  const params = new URLSearchParams({ p: granule.collectionConceptId, g: granule.conceptId });
  return `${EARTHDATA_SEARCH_URL}/granules?${params}`;
}

/** The last path segment of a URL, without its query string. */
export function fileNameFromUrl(url: string): string {
  const path = url.split(/[?#]/)[0];
  const name = path.split("/").pop() ?? "";
  try {
    return decodeURIComponent(name) || "granule";
  } catch {
    return name || "granule";
  }
}

/**
 * The data link a one-file action (Open, Download) should use: the first HDF5
 * file for a spaceborne LiDAR granule, otherwise the first data link.
 */
export function primaryDataLink(granule: EarthdataGranule): string | null {
  const h5 = granule.dataLinks.find((href) => /\.(h5|hdf5|he5)$/i.test(href.split("?")[0]));
  return h5 ?? granule.dataLinks[0] ?? null;
}

/**
 * Whether the ICESat-2 / GEDI footprint reader can open a granule.
 *
 * @param collection The granule's dataset.
 * @param granule The granule.
 * @returns True for ATL06, ATL08, GEDI L2A, L2B and L4A HDF5 files.
 */
export function isSpaceborneLidarGranule(
  collection: Pick<EarthdataCollection, "shortName">,
  granule: EarthdataGranule,
): boolean {
  const link = primaryDataLink(granule);
  if (!link || !/\.(h5|hdf5|he5)$/i.test(link.split("?")[0])) return false;
  return detectSpaceborneLidarProduct(collection.shortName, fileNameFromUrl(link)) !== null;
}

/**
 * Read the total hit count from CMR's `CMR-Hits` header.
 *
 * @param headers Response headers.
 * @param fallback Used when the header is missing.
 * @returns The hit count.
 */
export function parseHits(headers: Headers, fallback: number): number {
  const hits = Number.parseInt(headers.get("cmr-hits") ?? "", 10);
  return Number.isFinite(hits) ? hits : fallback;
}

async function fetchJson(
  url: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<{ body: unknown; headers: Headers }> {
  const response = await fetchImpl(url, { signal, headers: { Accept: "application/json" } });
  if (!response.ok) {
    let detail = "";
    try {
      const errors = ((await response.json()) as { errors?: unknown }).errors;
      if (Array.isArray(errors)) detail = errors.map(String).join("; ");
    } catch {
      // Not a CMR error body; report the status alone.
    }
    throw new Error(detail || `CMR returned ${response.status} ${response.statusText}`.trim());
  }
  return { body: await response.json(), headers: response.headers };
}

/**
 * Search CMR for datasets.
 *
 * @param options Search terms.
 * @param fetchImpl The fetch to use (the global one by default).
 * @param signal Aborts the request.
 * @returns One page of collections and the total hit count.
 */
export async function searchEarthdataCollections(
  options: CollectionSearchOptions,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<EarthdataSearchPage<EarthdataCollection>> {
  const { body, headers } = await fetchJson(buildCollectionSearchUrl(options), fetchImpl, signal);
  const items = parseCollections(body);
  return { items, hits: parseHits(headers, items.length) };
}

/**
 * Search CMR for a dataset's granules.
 *
 * @param options Search terms.
 * @param fetchImpl The fetch to use (the global one by default).
 * @param signal Aborts the request.
 * @returns One page of granules and the total hit count.
 */
export async function searchEarthdataGranules(
  options: GranuleSearchOptions,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<EarthdataSearchPage<EarthdataGranule>> {
  const { body, headers } = await fetchJson(buildGranuleSearchUrl(options), fetchImpl, signal);
  const items = parseGranules(body);
  return { items, hits: parseHits(headers, items.length) };
}

/**
 * Exchange Earthdata Login credentials for a user token (created if the
 * account has none). The endpoint sends no CORS headers, so this needs a
 * native fetch (the desktop app's `nativeFetch`).
 *
 * @param username EDL user name.
 * @param password EDL password.
 * @param fetchImpl A fetch that is not subject to CORS.
 * @returns The bearer token.
 * @throws When EDL rejects the credentials or answers without a token.
 */
export async function requestEarthdataToken(
  username: string,
  password: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const utf8 = new TextEncoder().encode(`${username}:${password}`);
  const basic = btoa(String.fromCharCode(...utf8));
  const response = await fetchImpl(EARTHDATA_FIND_OR_CREATE_TOKEN_URL, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, Accept: "application/json" },
  });
  if (response.status === 401)
    throw new Error("Earthdata Login rejected the user name or password.");
  if (!response.ok) throw new Error(`Earthdata Login returned ${response.status}.`);
  const token = ((await response.json()) as { access_token?: unknown }).access_token;
  if (typeof token !== "string" || !token) throw new Error("Earthdata Login returned no token.");
  return token;
}

/**
 * When an EDL token expires, read from its JWT `exp` claim.
 *
 * @param token The bearer token.
 * @returns The expiry, or null when the token is not a readable JWT.
 */
export function earthdataTokenExpiry(token: string): Date | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const exp = (JSON.parse(json) as { exp?: unknown }).exp;
    return typeof exp === "number" && Number.isFinite(exp) ? new Date(exp * 1000) : null;
  } catch {
    return null;
  }
}

/**
 * Format a size in megabytes for a result card.
 *
 * @param sizeMb Size in MB.
 * @returns e.g. "64 MB" or "1.6 GB".
 */
export function formatSizeMb(sizeMb: number | null): string | null {
  if (sizeMb === null || !Number.isFinite(sizeMb) || sizeMb <= 0) return null;
  if (sizeMb >= 1024) return `${(sizeMb / 1024).toFixed(1)} GB`;
  if (sizeMb >= 10) return `${Math.round(sizeMb)} MB`;
  return `${sizeMb.toFixed(1)} MB`;
}
