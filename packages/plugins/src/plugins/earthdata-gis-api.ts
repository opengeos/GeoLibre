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

/**
 * The item flavors this catalog exposes. The first three are ArcGIS services
 * that render directly; `webmap` is an Esri Web Map, a saved composition that
 * carries no renderable URL of its own and is expanded into its constituent
 * layers on add (see {@link fetchWebMapLayers}).
 */
export type EarthdataServiceKind = "image" | "map" | "feature" | "webmap";

/** The portal `type` string for each kind. */
const PORTAL_TYPE_BY_KIND: Record<EarthdataServiceKind, string> = {
  image: "Image Service",
  map: "Map Service",
  feature: "Feature Service",
  webmap: "Web Map",
};

/** Every kind, in the order the panel offers them. */
export const EARTHDATA_SERVICE_KINDS: readonly EarthdataServiceKind[] = [
  "image",
  "map",
  "feature",
  "webmap",
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
  if (item.kind === "feature" || item.kind === "webmap") return null;
  if (!HTTP_URL_RE.test(item.url)) return null;
  const operation = item.kind === "image" ? "exportImage" : "export";
  const size = `${EARTHDATA_GIS_TILE_SIZE},${EARTHDATA_GIS_TILE_SIZE}`;
  // A web map can reference a single MapServer sublayer (`…/MapServer/3`).
  // `export` lives on the service, not the sublayer, so the index moves into a
  // `layers=show:` filter instead of being appended to the operation path.
  const sublayer = /^(.*\/MapServer)\/(\d+)$/.exec(trimTrailingSlash(item.url));
  const base = sublayer ? sublayer[1] : trimTrailingSlash(item.url);
  const query = [
    "bbox={bbox-epsg-3857}",
    "bboxSR=3857",
    "imageSR=3857",
    `size=${size}`,
    "format=png32",
    "transparent=true",
    "dpi=96",
    ...(sublayer ? [`layers=show:${sublayer[2]}`] : []),
    "f=image",
  ].join("&");
  return `${base}/${operation}?${query}`;
}

/** Fallback export size cap, used when a service declares none. */
const DEFAULT_MAX_EXPORT_PIXELS = 4096;

/** A service's `exportImage` pixel-dimension caps. */
export interface ExportLimits {
  maxWidth: number;
  maxHeight: number;
}

/** Projects a WGS84 coordinate to web-mercator metres. */
export function toMercator(longitude: number, latitude: number): [number, number] {
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, latitude));
  return [
    (longitude * 20037508.34) / 180,
    (Math.log(Math.tan(((90 + clamped) * Math.PI) / 360)) / (Math.PI / 180)) * (20037508.34 / 180),
  ];
}

/** Converts a WGS84 [w, s, e, n] bbox to a web-mercator one. */
export function bboxToMercator(
  bbox: [number, number, number, number],
): [number, number, number, number] {
  const [west, south, east, north] = bbox;
  const [xmin, ymin] = toMercator(west, south);
  const [xmax, ymax] = toMercator(east, north);
  return [xmin, ymin, xmax, ymax];
}

/**
 * Chooses the pixel dimensions for a one-shot `exportImage` request.
 *
 * ArcGIS refuses a request past the service's `maxImageWidth`/`maxImageHeight`,
 * so the box's aspect ratio is preserved while the long side is pulled down to
 * whichever cap binds first. The result is a resampled view of the extent, not
 * the source raster at native resolution.
 *
 * @param bbox3857 - The area to export, in web-mercator metres
 * @param limits - The service's declared caps
 * @returns Integer pixel dimensions, each at least 1
 */
export function exportImageSize(
  bbox3857: [number, number, number, number],
  limits: ExportLimits,
): { width: number; height: number } {
  const [xmin, ymin, xmax, ymax] = bbox3857;
  const spanX = Math.abs(xmax - xmin);
  const spanY = Math.abs(ymax - ymin);
  const maxWidth = Math.max(1, Math.floor(limits.maxWidth));
  const maxHeight = Math.max(1, Math.floor(limits.maxHeight));
  if (!(spanX > 0) || !(spanY > 0)) return { width: maxWidth, height: maxHeight };
  // Start from the cap on the longer axis, then let the binding cap win.
  const scale = Math.min(maxWidth / spanX, maxHeight / spanY);
  return {
    width: Math.max(1, Math.min(maxWidth, Math.round(spanX * scale))),
    height: Math.max(1, Math.min(maxHeight, Math.round(spanY * scale))),
  };
}

/**
 * Builds a concrete (non-templated) export URL for one area, used for the
 * GeoTIFF download rather than for map tiles.
 *
 * @param item - An image or map service item
 * @param bbox3857 - The area to export, in web-mercator metres
 * @param size - Pixel dimensions from {@link exportImageSize}
 * @param format - ArcGIS export format. @default "tiff"
 * @returns The request URL, or null for an item that cannot be exported
 */
export function buildExportDownloadUrl(
  item: EarthdataGisItem,
  bbox3857: [number, number, number, number],
  size: { width: number; height: number },
  format = "tiff",
): string | null {
  if (item.kind !== "image" && item.kind !== "map") return null;
  if (!HTTP_URL_RE.test(item.url)) return null;
  const operation = item.kind === "image" ? "exportImage" : "export";
  const sublayer = /^(.*\/MapServer)\/(\d+)$/.exec(trimTrailingSlash(item.url));
  const base = sublayer ? sublayer[1] : trimTrailingSlash(item.url);
  const params = new URLSearchParams({
    bbox: bbox3857.join(","),
    bboxSR: "3857",
    imageSR: "3857",
    size: `${size.width},${size.height}`,
    format,
    // Keeps areas outside the mosaic transparent rather than black, which
    // matters once the export is re-encoded as a COG.
    transparent: "true",
    f: "image",
  });
  if (sublayer) params.set("layers", `show:${sublayer[2]}`);
  return `${base}/${operation}?${params.toString()}`;
}

/** What a service's own metadata contributes to an export request. */
export interface ServiceExportInfo {
  /** The service's declared pixel caps, or a conservative default. */
  limits: ExportLimits;
  /**
   * The service's own full extent in web-mercator metres, used when the portal
   * item declares none. Many items ship an empty `extent: []` (every GSSICB
   * coherence service does), which would otherwise leave "Full extent"
   * permanently unavailable even though the service publishes one.
   */
  extent3857: [number, number, number, number] | null;
}

/** Reads an ArcGIS extent object as a web-mercator box, whatever SR it is in. */
function arcgisExtentToMercator(value: unknown): [number, number, number, number] | null {
  if (!value || typeof value !== "object") return null;
  const extent = value as {
    xmin?: unknown;
    ymin?: unknown;
    xmax?: unknown;
    ymax?: unknown;
    spatialReference?: { latestWkid?: number; wkid?: number };
  };
  const box = [extent.xmin, extent.ymin, extent.xmax, extent.ymax];
  if (!box.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  const [xmin, ymin, xmax, ymax] = box as [number, number, number, number];
  if (xmin >= xmax || ymin >= ymax) return null;
  const wkid = extent.spatialReference?.latestWkid ?? extent.spatialReference?.wkid;
  if (METRE_BASED_WKIDS.has(wkid ?? 0)) return [xmin, ymin, xmax, ymax];
  if (wkid === 4326) return bboxToMercator([xmin, ymin, xmax, ymax]);
  return null;
}

/**
 * Reads a service's export pixel caps and its own full extent, falling back to
 * conservative defaults when the service does not declare them or cannot be
 * reached.
 *
 * @param item - An image or map service item
 * @param fetchImpl - Fetch-like function (defaults to the global `fetch`)
 * @param signal - Aborts the request
 * @returns The service's caps and extent
 */
export async function fetchExportLimits(
  item: EarthdataGisItem,
  fetchImpl: EarthdataGisFetch = defaultFetch,
  signal?: AbortSignal,
): Promise<ServiceExportInfo> {
  const fallback: ServiceExportInfo = {
    limits: { maxWidth: DEFAULT_MAX_EXPORT_PIXELS, maxHeight: DEFAULT_MAX_EXPORT_PIXELS },
    extent3857: null,
  };
  try {
    const response = await fetchImpl(`${trimTrailingSlash(item.url)}?f=json`, signal);
    if (!response.ok) return fallback;
    const metadata = (await response.json()) as {
      maxImageWidth?: unknown;
      maxImageHeight?: unknown;
      fullExtent?: unknown;
      extent?: unknown;
    };
    const width = metadata.maxImageWidth;
    const height = metadata.maxImageHeight;
    return {
      limits: {
        maxWidth:
          typeof width === "number" && Number.isFinite(width) && width > 0
            ? width
            : fallback.limits.maxWidth,
        maxHeight:
          typeof height === "number" && Number.isFinite(height) && height > 0
            ? height
            : fallback.limits.maxHeight,
      },
      extent3857:
        arcgisExtentToMercator(metadata.fullExtent) ?? arcgisExtentToMercator(metadata.extent),
    };
  } catch {
    return fallback;
  }
}

/**
 * Builds a filesystem-safe file name for a downloaded service export.
 *
 * @param title - The item title
 * @param extension - File extension without the dot
 * @returns A sanitized file name
 */
export function exportFileName(title: string, extension: string): string {
  const stem =
    asText(title)
      .replace(/[^\w\s.-]+/g, " ")
      .replace(/\s+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^[._-]+|[._-]+$/g, "")
      .slice(0, 80) || "earthdata_gis";
  return `${stem}.${extension}`;
}

/**
 * Builds the URL of a Web Map item's data document, which holds its
 * `operationalLayers`.
 *
 * @param itemId - Portal item id
 * @param endpoint - Sharing REST base URL
 * @returns The item `/data` URL
 */
export function buildWebMapDataUrl(
  itemId: string,
  endpoint: string = EARTHDATA_GIS_SHARING_URL,
): string {
  return `${trimTrailingSlash(endpoint)}/content/items/${encodeURIComponent(itemId)}/data?f=json`;
}

/** Esri `layerType` values this plugin knows how to render, mapped to a kind. */
const WEB_MAP_LAYER_KINDS: Record<string, EarthdataServiceKind> = {
  ArcGISImageServiceLayer: "image",
  ArcGISMapServiceLayer: "map",
  ArcGISTiledMapServiceLayer: "map",
  ArcGISFeatureLayer: "feature",
};

/** One renderable layer pulled out of a Web Map's composition. */
export interface WebMapLayer {
  /** The layer's title within the web map. */
  title: string;
  /** Absolute service URL. */
  url: string;
  /** How the layer should be rendered. */
  kind: EarthdataServiceKind;
}

/**
 * Flattens a Web Map's `operationalLayers` into the layers this plugin can
 * render.
 *
 * Group layers nest arbitrarily deep and carry no URL of their own, so they are
 * walked rather than emitted. Layer types with no MapLibre equivalent (and any
 * entry missing an http(s) URL) are skipped, so a web map contributes only the
 * layers that will actually draw.
 *
 * @param body - Parsed JSON body from {@link buildWebMapDataUrl}
 * @returns The renderable layers, in the web map's own order
 */
export function parseWebMapLayers(body: unknown): WebMapLayer[] {
  const out: WebMapLayer[] = [];
  const seen = new Set<unknown>();

  const walk = (entries: unknown, depth: number): void => {
    // Depth-guard a self-referencing group so a malformed document cannot spin.
    if (!Array.isArray(entries) || depth > 10) return;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || seen.has(entry)) continue;
      seen.add(entry);
      const layer = entry as Record<string, unknown>;
      const layerType = asText(layer.layerType);
      if (layerType === "GroupLayer") {
        walk(layer.layers, depth + 1);
        continue;
      }
      const kind = WEB_MAP_LAYER_KINDS[layerType];
      const url = asText(layer.url).trim();
      if (!kind || !HTTP_URL_RE.test(url)) continue;
      out.push({ title: asText(layer.title).trim() || url, url, kind });
    }
  };

  const parsed = (body ?? {}) as { operationalLayers?: unknown };
  walk(parsed.operationalLayers, 0);
  return out;
}

/**
 * Reads the renderable layers out of a Web Map item.
 *
 * @param item - A `webmap` catalog item
 * @param fetchImpl - Fetch-like function (defaults to the global `fetch`)
 * @param signal - Aborts the request
 * @param endpoint - Sharing REST base URL
 * @returns The web map's renderable layers
 * @throws When the item's data document cannot be read
 */
export async function fetchWebMapLayers(
  item: EarthdataGisItem,
  fetchImpl: EarthdataGisFetch = defaultFetch,
  signal?: AbortSignal,
  endpoint: string = EARTHDATA_GIS_SHARING_URL,
): Promise<WebMapLayer[]> {
  const response = await fetchImpl(buildWebMapDataUrl(item.id, endpoint), signal);
  if (!response.ok) {
    throw new Error(`Earthdata GIS web map request failed (${response.status})`);
  }
  return parseWebMapLayers(await response.json());
}

/**
 * Projects one of a Web Map's layers into a standalone catalog item, so the
 * add path treats it exactly like a service found by search.
 *
 * The parent's extent is inherited because a web map layer carries none of its
 * own, and the parent id is folded into the child id to keep it unique.
 *
 * @param parent - The Web Map item the layer came from
 * @param layer - One renderable layer from {@link parseWebMapLayers}
 * @param index - The layer's position, used to build a stable id
 * @returns A catalog item for the layer
 */
export function webMapLayerAsItem(
  parent: EarthdataGisItem,
  layer: WebMapLayer,
  index: number,
): EarthdataGisItem {
  return {
    ...parent,
    id: `${parent.id}:${index}`,
    title: layer.title,
    kind: layer.kind,
    url: layer.url,
    thumbnailUrl: null,
    raw: layer,
  };
}

/**
 * Ground resolution in metres per pixel at the equator for zoom 0 with 256px
 * tiles — the constant behind every web-mercator zoom/resolution conversion.
 */
const EQUATOR_METRES_PER_PIXEL_Z0 = 156543.03392804097;

/** Spatial-reference well-known ids whose units are metres. */
const METRE_BASED_WKIDS = new Set([3857, 102100, 102113]);

/**
 * Builds the catalog statistics query that reports the coarsest pixel size at
 * which an ImageServer's mosaic still draws.
 *
 * A mosaic dataset row carries `MaxPS` — the largest pixel size at which that
 * raster participates. Requesting an image coarser than every row's `MaxPS`
 * returns a fully transparent PNG rather than an error, which is why so many of
 * this portal's high-resolution disaster services look "broken" when first
 * added: the layer is fine, the view is simply too far out.
 *
 * @param serviceUrl - The `…/ImageServer` URL
 * @returns The `/query` URL returning `MAX(MaxPS)`
 */
export function buildMaxPixelSizeUrl(serviceUrl: string): string {
  const statistics = JSON.stringify([
    { statisticType: "max", onStatisticField: "MaxPS", outStatisticFieldName: "maxPixelSize" },
  ]);
  const params = new URLSearchParams({
    f: "json",
    where: "1=1",
    outStatistics: statistics,
  });
  return `${trimTrailingSlash(serviceUrl)}/query?${params.toString()}`;
}

/**
 * Reads `MAX(MaxPS)` out of a catalog statistics response.
 *
 * @param body - Parsed JSON body from {@link buildMaxPixelSizeUrl}
 * @returns The coarsest visible pixel size, or null when the service does not
 *   report one (multidimensional CRF services have no such column)
 */
export function parseMaxPixelSize(body: unknown): number | null {
  const parsed = (body ?? {}) as { features?: Array<{ attributes?: Record<string, unknown> }> };
  const attributes = parsed.features?.[0]?.attributes;
  if (!attributes) return null;
  const value = attributes.maxPixelSize ?? attributes.MaxPixelSize ?? attributes.MAXPIXELSIZE;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Lowest web-mercator zoom whose ground resolution is fine enough for a mosaic
 * with this `MaxPS` to draw.
 *
 * @param maxPixelSize - Coarsest visible pixel size, in metres
 * @param latitude - Latitude the layer sits at (resolution is latitude-scaled)
 * @param tileSize - Raster source tile size in pixels
 * @returns The minimum zoom, clamped to [0, 24], or null when not computable
 */
export function minZoomForPixelSize(
  maxPixelSize: number,
  latitude: number,
  tileSize: number = EARTHDATA_GIS_TILE_SIZE,
): number | null {
  if (!Number.isFinite(maxPixelSize) || maxPixelSize <= 0) return null;
  if (!Number.isFinite(latitude) || Math.abs(latitude) > 85.05) return null;
  if (!Number.isFinite(tileSize) || tileSize <= 0) return null;
  const resolutionAtZoom0 =
    (EQUATOR_METRES_PER_PIXEL_Z0 * Math.cos((latitude * Math.PI) / 180) * 256) / tileSize;
  const zoom = Math.ceil(Math.log2(resolutionAtZoom0 / maxPixelSize));
  if (!Number.isFinite(zoom)) return null;
  return Math.min(24, Math.max(0, zoom));
}

/**
 * Best-effort lookup of the zoom below which an image service renders nothing.
 *
 * Returns null — meaning "impose no constraint" — whenever the answer would be
 * a guess: a non-image service, a service whose units are not metres (`MaxPS`
 * would then be in degrees and incomparable), a service that reports no
 * `MaxPS`, or any failed/slow request. Being wrong here would hide a layer that
 * actually draws, so every uncertain case falls back to the unconstrained
 * behavior.
 *
 * @param item - The catalog item being added
 * @param fetchImpl - Fetch-like function (defaults to the global `fetch`)
 * @param signal - Aborts the lookup
 * @returns The minimum zoom at which the service draws, or null
 */
export async function fetchMinVisibleZoom(
  item: EarthdataGisItem,
  fetchImpl: EarthdataGisFetch = defaultFetch,
  signal?: AbortSignal,
): Promise<number | null> {
  if (item.kind !== "image" || !item.bbox) return null;
  try {
    const metadataUrl = `${trimTrailingSlash(item.url)}?f=json`;
    const metadataResponse = await fetchImpl(metadataUrl, signal);
    if (!metadataResponse.ok) return null;
    const metadata = (await metadataResponse.json()) as {
      spatialReference?: { latestWkid?: number; wkid?: number };
    };
    const wkid = metadata.spatialReference?.latestWkid ?? metadata.spatialReference?.wkid;
    // `MaxPS` is expressed in the mosaic's own units. Comparing a value in
    // degrees against a metres-per-pixel resolution would be meaningless, so
    // only metre-based services get a constraint.
    if (wkid === undefined || !METRE_BASED_WKIDS.has(wkid)) return null;

    const statsResponse = await fetchImpl(buildMaxPixelSizeUrl(item.url), signal);
    if (!statsResponse.ok) return null;
    const maxPixelSize = parseMaxPixelSize(await statsResponse.json());
    if (maxPixelSize === null) return null;

    const [, south, , north] = item.bbox;
    return minZoomForPixelSize(maxPixelSize, (south + north) / 2);
  } catch {
    return null;
  }
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
  if (!id || !kind) return null;
  // A service item is useless without an http(s) URL to render or query. A Web
  // Map legitimately has none (the portal stores its `url` as ""); its layers
  // are read from the item's data document by id instead.
  if (kind !== "webmap" && !HTTP_URL_RE.test(url)) return null;

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
