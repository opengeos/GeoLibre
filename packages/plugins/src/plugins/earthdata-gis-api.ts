/**
 * NASA Earthdata GIS catalog client.
 *
 * Earthdata GIS (https://gis.earthdata.nasa.gov) is NASA's ArcGIS Enterprise
 * portal. It publishes EOSDIS data as OGC-adjacent ArcGIS services across
 * several federated servers (`/image`, `/gis05`, `/maphost`, …), which is why
 * this module never enumerates the REST service directory: the portal's item
 * search returns each item's absolute service URL, so a new federated server
 * needs no change here.
 *
 * Three item types are servable in MapLibre and are the only ones searched:
 *
 * - **Image Service** — an ArcGIS ImageServer. Rendered through its
 *   `exportImage` endpoint as web-mercator PNG tiles.
 * - **Map Service** — an ArcGIS MapServer. Same, through `export`.
 * - **Feature Service** — an ArcGIS FeatureServer. Loaded as GeoJSON (by the
 *   host's ArcGIS feature-layer path) so it gets full vector styling, the
 *   attribute table, and export.
 *
 * Both the portal search API and the service endpoints reflect the requesting
 * `Origin` in `Access-Control-Allow-Origin`, so every request here works from a
 * plain browser fetch — no proxy and no Tauri native-HTTP fallback needed.
 */

/** The Earthdata GIS portal root. */
export const EARTHDATA_GIS_PORTAL_URL = "https://gis.earthdata.nasa.gov/portal";

/** The portal's ArcGIS sharing REST base. */
export const EARTHDATA_GIS_SHARING_URL = `${EARTHDATA_GIS_PORTAL_URL}/sharing/rest`;

/** Attribution applied to every layer added from the catalog. */
export const EARTHDATA_GIS_ATTRIBUTION =
  '<a href="https://gis.earthdata.nasa.gov/" target="_blank" rel="noopener">NASA Earthdata GIS</a>';

/** Tile size used for the `exportImage`/`export` requests. */
export const EARTHDATA_GIS_TILE_SIZE = 256;

/** Default page size for a catalog search. The portal caps `num` at 100. */
export const EARTHDATA_GIS_PAGE_SIZE = 20;

/** The servable ArcGIS service flavors this catalog exposes. */
export type EarthdataServiceKind = "image" | "map" | "feature";

/** The portal `type` string for each servable kind. */
const PORTAL_TYPE_BY_KIND: Record<EarthdataServiceKind, string> = {
  image: "Image Service",
  map: "Map Service",
  feature: "Feature Service",
};

/** Every servable kind, in the order the panel offers them. */
export const EARTHDATA_SERVICE_KINDS: readonly EarthdataServiceKind[] = [
  "image",
  "map",
  "feature",
] as const;

/** One Earthdata GIS catalog item, normalized from a portal search result. */
export interface EarthdataGisItem {
  /** Portal item id. */
  id: string;
  /** Human-readable title. */
  title: string;
  /** Short summary line, when the item has one. */
  snippet: string;
  /** Long description as plain text (the portal stores it as HTML). */
  description: string;
  /** Which servable ArcGIS service this item points at. */
  kind: EarthdataServiceKind;
  /** Absolute service URL (`…/ImageServer`, `…/MapServer`, `…/FeatureServer`). */
  url: string;
  /** Preview thumbnail URL, when the item has one. */
  thumbnailUrl: string | null;
  /** WGS84 bounds [west, south, east, north], when the item declares them. */
  bbox: [number, number, number, number] | null;
  /** Item tags, used for the details view. */
  tags: string[];
  /** Portal account that published the item. */
  owner: string;
  /** Last-modified date as `YYYY-MM-DD`, when known. */
  modified: string | null;
  /** Provider / credits line, when the item has one. */
  accessInformation: string;
  /** Use constraints as plain text, when the item has them. */
  licenseInfo: string;
  /** The item's page on the Earthdata GIS portal. */
  itemPageUrl: string;
  /** The raw search record, surfaced verbatim in the details view. */
  raw: unknown;
}

/** A page of catalog search results. */
export interface EarthdataGisSearchResult {
  /** Normalized items for this page. */
  items: EarthdataGisItem[];
  /** Total number of items matching the query across all pages. */
  total: number;
  /** 1-indexed record offset to request for the next page, or null at the end. */
  nextStart: number | null;
}

/** Options describing a catalog search. */
export interface EarthdataGisSearchOptions {
  /** Free-text search terms. Empty searches the whole catalog. */
  terms?: string;
  /** Restrict to these service kinds. Defaults to all of them. */
  kinds?: readonly EarthdataServiceKind[];
  /** Restrict to items intersecting this WGS84 [w, s, e, n] box. */
  bbox?: [number, number, number, number] | null;
  /** Maximum results per page. @default {@link EARTHDATA_GIS_PAGE_SIZE} */
  num?: number;
  /** 1-indexed record offset of the first result. @default 1 */
  start?: number;
  /** Overrides the sharing REST base URL (used by tests). */
  endpoint?: string;
  /** Aborts the request (e.g. when a newer search supersedes this one). */
  signal?: AbortSignal;
}

/** Minimal fetch shape so tests can stub without a DOM. */
export type EarthdataGisFetch = (
  url: string,
  signal?: AbortSignal,
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

const defaultFetch: EarthdataGisFetch = (url, signal) =>
  fetch(url, signal ? { signal } : undefined);

/** Matches an absolute http(s) URL. */
export const HTTP_URL_RE = /^https?:\/\//i;

/**
 * Lucene metacharacters that would make the portal's query parser reject an
 * otherwise ordinary search phrase. They are replaced with spaces rather than
 * escaped so a stray bracket or colon degrades into a plain word search instead
 * of a 400. `-` and `*` survive because they are the two operators a user
 * plausibly means (negation and a trailing wildcard).
 */
const LUCENE_METACHARACTERS_RE = /["\\/(){}[\]^~:!?+]|&&|\|\|/g;

/** Strips a single trailing slash from a URL. */
function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/** Reads a non-empty string from an unknown value, else "". */
function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Converts the portal's HTML description/license fields to plain text.
 *
 * Tags are stripped with a regex rather than parsed into a detached DOM: the
 * text is only ever assigned to `textContent`, and never round-tripping it
 * through `innerHTML` keeps an `<img onerror=…>` in the source HTML from ever
 * becoming a live node.
 *
 * Portal descriptions are authored in a rich-text editor that hard-wraps the
 * source at ~80 columns *inside* each paragraph. Those newlines are cosmetic in
 * HTML but would survive into a `white-space: pre-wrap` details view as ragged
 * short lines, so only real paragraph breaks (`<p>`/`<br>`/blank lines) are
 * kept; a lone newline collapses back to a space.
 *
 * @param html - Raw HTML from a portal item field
 * @returns Plain text with paragraph breaks preserved
 */
export function plainText(html: unknown): string {
  const raw = asText(html);
  if (!raw) return "";
  // A sentinel that cannot occur in the portal's text, so real paragraph breaks
  // survive the pass that collapses the cosmetic in-paragraph newlines.
  const PARAGRAPH_BREAK = "\u0000";
  return raw
    .replace(/<br\s*\/?>/gi, "\n\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/[ \t]*\n[ \t]*\n[\s]*/g, PARAGRAPH_BREAK)
    .replace(/[ \t]*\n[ \t]*/g, " ")
    .replace(/[ \t]+/g, " ")
    .split(PARAGRAPH_BREAK)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Maps a portal `type` string onto a servable service kind.
 *
 * @param type - The portal item type (e.g. "Image Service")
 * @returns The matching kind, or null when the type is not servable here
 */
export function kindFromPortalType(type: unknown): EarthdataServiceKind | null {
  const normalized = asText(type).trim().toLowerCase();
  for (const kind of EARTHDATA_SERVICE_KINDS) {
    if (PORTAL_TYPE_BY_KIND[kind].toLowerCase() === normalized) return kind;
  }
  return null;
}

/**
 * Builds the portal search `q` clause for a set of terms and service kinds.
 *
 * @param terms - Free-text search terms (may be empty)
 * @param kinds - Service kinds to include (empty means all of them)
 * @returns The `q` value to send to the search API
 */
export function buildSearchQuery(
  terms: string | undefined,
  kinds: readonly EarthdataServiceKind[] = EARTHDATA_SERVICE_KINDS,
): string {
  const selected = kinds.length > 0 ? kinds : EARTHDATA_SERVICE_KINDS;
  const typeClause = selected.map((kind) => `type:"${PORTAL_TYPE_BY_KIND[kind]}"`).join(" OR ");
  const scoped = selected.length > 1 ? `(${typeClause})` : typeClause;
  const cleaned = asText(terms).replace(LUCENE_METACHARACTERS_RE, " ").replace(/\s+/g, " ").trim();
  return cleaned ? `(${cleaned}) AND ${scoped}` : scoped;
}

/**
 * Builds the portal item-search request URL for a query.
 *
 * @param options - Terms, kinds, bbox, and paging
 * @returns The fully-formed `/search` URL
 */
export function buildSearchUrl(options: EarthdataGisSearchOptions = {}): string {
  const endpoint = trimTrailingSlash(options.endpoint ?? EARTHDATA_GIS_SHARING_URL);
  const params = new URLSearchParams({
    f: "json",
    q: buildSearchQuery(options.terms, options.kinds),
    num: String(options.num ?? EARTHDATA_GIS_PAGE_SIZE),
    start: String(options.start ?? 1),
  });
  // Relevance ranking only means something once there are terms to rank
  // against; an unfiltered browse is far more useful newest-first.
  if (!asText(options.terms).trim()) {
    params.set("sortField", "modified");
    params.set("sortOrder", "desc");
  }
  if (options.bbox) params.set("bbox", options.bbox.join(","));
  return `${endpoint}/search?${params.toString()}`;
}

/**
 * Builds the URL of an item's preview thumbnail.
 *
 * @param itemId - Portal item id
 * @param thumbnail - The item's `thumbnail` path, relative to its info folder
 * @param endpoint - Sharing REST base URL
 * @returns An absolute thumbnail URL, or null when the item has none
 */
export function buildThumbnailUrl(
  itemId: string,
  thumbnail: unknown,
  endpoint: string = EARTHDATA_GIS_SHARING_URL,
): string | null {
  const path = asText(thumbnail).trim();
  if (!path) return null;
  return `${trimTrailingSlash(endpoint)}/content/items/${encodeURIComponent(
    itemId,
  )}/info/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * Builds an item's page URL on the Earthdata GIS portal.
 *
 * @param itemId - Portal item id
 * @returns The portal item page URL
 */
export function buildItemPageUrl(itemId: string): string {
  return `${EARTHDATA_GIS_PORTAL_URL}/home/item.html?id=${encodeURIComponent(itemId)}`;
}

/**
 * Builds a MapLibre raster tile template that renders an ImageServer or
 * MapServer through its ArcGIS export endpoint.
 *
 * The query string is assembled by hand because `{bbox-epsg-3857}` — the token
 * MapLibre substitutes per tile — must reach the URL with its braces intact,
 * and `URLSearchParams` would percent-encode them.
 *
 * @param item - A normalized catalog item
 * @returns A raster tile template, or null for a non-raster item
 */
export function buildExportTileUrl(item: EarthdataGisItem): string | null {
  if (item.kind === "feature") return null;
  if (!HTTP_URL_RE.test(item.url)) return null;
  const operation = item.kind === "image" ? "exportImage" : "export";
  const size = `${EARTHDATA_GIS_TILE_SIZE},${EARTHDATA_GIS_TILE_SIZE}`;
  const query = [
    "bbox={bbox-epsg-3857}",
    "bboxSR=3857",
    "imageSR=3857",
    `size=${size}`,
    "format=png32",
    "transparent=true",
    "dpi=96",
    "f=image",
  ].join("&");
  return `${trimTrailingSlash(item.url)}/${operation}?${query}`;
}

/**
 * Reads a portal item `extent` ([[west, south], [east, north]]) as a bbox.
 *
 * @param value - The raw `extent` field
 * @returns A [w, s, e, n] bbox, or null when absent or degenerate
 */
function asBbox(value: unknown): [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [southWest, northEast] = value;
  if (!Array.isArray(southWest) || !Array.isArray(northEast)) return null;
  const [west, south] = southWest;
  const [east, north] = northEast;
  const bounds = [west, south, east, north];
  if (!bounds.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  // A zero-width or inverted box cannot be fitted or sent back as a search
  // filter, so treat it as "no extent" rather than propagating a bad box.
  if (west >= east || south >= north) return null;
  return [west, south, east, north];
}

/** Formats an epoch-milliseconds field as `YYYY-MM-DD`, else null. */
function asDate(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

/** Reads a string array (the portal's `tags`), else an empty array. */
function asTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((tag): tag is string => typeof tag === "string" && tag.trim() !== "");
}

/**
 * Normalizes one raw portal search record into an {@link EarthdataGisItem}.
 *
 * @param raw - A single `results[]` entry
 * @param endpoint - Sharing REST base URL, used to build the thumbnail URL
 * @returns The normalized item, or null when it is not a servable service
 */
export function normalizeItem(
  raw: unknown,
  endpoint: string = EARTHDATA_GIS_SHARING_URL,
): EarthdataGisItem | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const id = asText(record.id).trim();
  const kind = kindFromPortalType(record.type);
  const url = asText(record.url).trim();
  // Every servable item needs all three: an id (thumbnail/details), a known
  // service kind, and an http(s) service URL to render or query.
  if (!id || !kind || !HTTP_URL_RE.test(url)) return null;

  return {
    id,
    title: asText(record.title).trim() || "Untitled service",
    snippet: plainText(record.snippet),
    description: plainText(record.description),
    kind,
    url,
    thumbnailUrl: buildThumbnailUrl(id, record.thumbnail, endpoint),
    bbox: asBbox(record.extent),
    tags: asTags(record.tags),
    owner: asText(record.owner).trim(),
    modified: asDate(record.modified),
    accessInformation: plainText(record.accessInformation),
    licenseInfo: plainText(record.licenseInfo),
    itemPageUrl: buildItemPageUrl(id),
    raw,
  };
}

/**
 * Normalizes a raw portal `/search` response body.
 *
 * @param body - Parsed JSON body from the search API
 * @param endpoint - Sharing REST base URL, used to build thumbnail URLs
 * @returns Normalized items plus the total match count and next page offset
 * @throws When the portal answered with an error envelope
 */
export function parseSearchResponse(
  body: unknown,
  endpoint: string = EARTHDATA_GIS_SHARING_URL,
): EarthdataGisSearchResult {
  const parsed = (body ?? {}) as {
    error?: { message?: string; messages?: string[] };
    nextStart?: unknown;
    results?: unknown;
    total?: unknown;
  };
  // The portal answers a malformed query with HTTP 200 and an error envelope,
  // so the body — not the status — is what tells us the search failed.
  if (parsed.error) {
    const detail = parsed.error.messages?.join(" ") || parsed.error.message;
    throw new Error(detail || "Earthdata GIS search failed.");
  }
  const results = Array.isArray(parsed.results) ? parsed.results : [];
  const items = results
    .map((result) => normalizeItem(result, endpoint))
    .filter((item): item is EarthdataGisItem => item !== null);
  // The portal reports -1 for nextStart on the last page.
  const nextStart =
    typeof parsed.nextStart === "number" && parsed.nextStart > 0 ? parsed.nextStart : null;
  return {
    items,
    total: typeof parsed.total === "number" && parsed.total >= 0 ? parsed.total : items.length,
    nextStart,
  };
}

/**
 * Searches the Earthdata GIS portal for servable ArcGIS services.
 *
 * @param options - Terms, kinds, bbox, and paging
 * @param fetchImpl - Fetch-like function (defaults to the global `fetch`)
 * @returns A page of normalized items plus the total match count
 * @throws When the request fails or the portal returns an error envelope
 */
export async function searchEarthdataGis(
  options: EarthdataGisSearchOptions = {},
  fetchImpl: EarthdataGisFetch = defaultFetch,
): Promise<EarthdataGisSearchResult> {
  const response = await fetchImpl(buildSearchUrl(options), options.signal);
  if (!response.ok) {
    throw new Error(`Earthdata GIS request failed (${response.status})`);
  }
  return parseSearchResponse(await response.json(), options.endpoint ?? EARTHDATA_GIS_SHARING_URL);
}
