import type { BBox, Feature, Geometry } from "geojson";

export const STAC_INDEX_CATALOGS_URL = "https://stacindex.org/api/catalogs";
// No item-search endpoint to ask, so a page is however much of the tree the walk covers.
const STATIC_SEARCH_READS_PER_PAGE = 300;
const STATIC_SEARCH_CONCURRENCY = 12;

export interface StacIndexCatalog {
  id: number;
  url: string;
  slug: string;
  title: string;
  summary: string;
  access: "public" | "protected" | "private";
  isApi: boolean;
}

export interface StacLink {
  rel: string;
  href: string;
  title?: string;
  type?: string;
  method?: string;
  body?: Record<string, unknown>;
}

export interface StacAsset {
  href: string;
  title?: string;
  type?: string;
  roles?: string[];
}

export interface StacItem extends Feature<Geometry | null> {
  id: string;
  bbox?: BBox;
  collection?: string;
  properties: Record<string, unknown> & { datetime?: string; start_datetime?: string };
  assets: Record<string, StacAsset>;
  links?: StacLink[];
}

export interface StacCollection {
  id: string;
  title?: string;
  description?: string;
  extent?: {
    spatial?: { bbox?: number[][] };
    temporal?: { interval?: Array<[string | null, string | null]> };
  };
}

export interface StacConnection {
  url: string;
  title: string;
  description?: string;
  isApi: boolean;
  searchUrl?: string;
  collections: StacCollection[];
  /** A static catalog's top-level children, to be opened on demand. Empty for an API. */
  children?: StacCatalogNode[];
  root: Record<string, unknown>;
}

export interface StacCatalogNode {
  href: string;
  title: string;
  /** A collection can be searched; a container is opened to see what is inside. Only the link
   *  says which, so a container may turn out to be a collection once it is read. */
  kind: "collection" | "container";
}

/** What a node turned out to be, and what it holds. */
export interface StacOpenedNode {
  kind: "collection" | "container";
  children: StacCatalogNode[];
  /** Items linked from the node itself, which a catalog is allowed to carry without a collection. */
  items?: number;
  /** A collection's own extent, so the map can be sent to it without reading any item. */
  bbox?: [number, number, number, number];
}

/** A walk in progress; hand it back to continue. Mutated in place rather than copied. */
export interface StacSearchCursor {
  items: Unread[];
  folders: Unread[];
  visited: Set<string>;
  /** Items already delivered, so the last page can report a real total. */
  offset: number;
  /** Documents given up on; with any of these the catalog was not fully read. */
  dropped: number;
  /** The filters this walk began with, so later pages filter the way page one did. */
  filters: Pick<StacSearchOptions, "bbox" | "collections" | "datetime">;
}

export interface StacSearchOptions {
  bbox?: [number, number, number, number];
  datetime?: string;
  collections?: string[];
  /** Documents to search instead of the whole catalog, from the tree's selection. */
  entries?: string[];
  cursor?: StacSearchCursor;
  /** Additional STAC API Item Search members such as query, filter, sortby, or fields. */
  additional?: Record<string, unknown>;
  limit?: number;
  next?: StacNextPage;
  signal?: AbortSignal;
}

export interface StacNextPage {
  href: string;
  method: "GET" | "POST";
  body?: Record<string, unknown>;
}

export interface StacSearchResult {
  items: StacItem[];
  next?: StacNextPage;
  cursor?: StacSearchCursor;
  matched?: number;
}

type FetchLike = typeof fetch;

function httpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function absoluteHref(href: string, base: string): string {
  return new URL(href, base).href;
}

/**
 * Converts an anonymous S3 object URI into the HTTPS form browsers and raster
 * range readers can fetch. STAC APIs such as Earth Search legitimately return
 * `s3://` asset hrefs even though the catalog itself is accessed over HTTPS.
 */
export function browserAssetHref(href: string, base: string): string {
  const resolved = absoluteHref(href, base);
  const url = new URL(resolved);
  if (url.protocol !== "s3:") return resolved;
  const bucket = url.hostname;
  if (!bucket) return resolved;
  return `https://${bucket}.s3.amazonaws.com${url.pathname}${url.search}${url.hash}`;
}

async function fetchJson<T>(url: string, init: RequestInit, fetcher: FetchLike): Promise<T> {
  const response = await fetcher(url, {
    ...init,
    headers: { Accept: "application/geo+json, application/json", ...init.headers },
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`.trim());
  return response.json();
}

export async function loadStacIndex(
  fetcher: FetchLike = fetch,
  signal?: AbortSignal,
): Promise<StacIndexCatalog[]> {
  const raw = await fetchJson(STAC_INDEX_CATALOGS_URL, { signal }, fetcher);
  if (!Array.isArray(raw)) throw new Error("STAC Index returned an invalid catalog list");
  return raw
    .filter(
      (entry): entry is StacIndexCatalog =>
        Boolean(entry) &&
        typeof entry === "object" &&
        httpUrl((entry as StacIndexCatalog).url) &&
        typeof (entry as StacIndexCatalog).title === "string" &&
        (entry as StacIndexCatalog).access === "public",
    )
    .sort((a, b) => a.title.localeCompare(b.title));
}

function linksOf(value: unknown, base: string): StacLink[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((link) => {
    if (!link || typeof link !== "object" || typeof link.rel !== "string" || !link.href) return [];
    try {
      return [{ ...link, href: absoluteHref(String(link.href), base) } as StacLink];
    } catch {
      return [];
    }
  });
}

function isStacItem(value: unknown): value is StacItem {
  if (typeof value !== "object" || value === null) return false;
  return (
    "id" in value && typeof value.id === "string" && "assets" in value && Boolean(value.assets)
  );
}

function normalizeItem(item: StacItem, base: string): StacItem {
  const assets = Object.fromEntries(
    Object.entries(item.assets ?? {}).flatMap(([key, asset]) => {
      if (!asset?.href) return [];
      try {
        return [[key, { ...asset, href: browserAssetHref(asset.href, base) }]];
      } catch {
        return [];
      }
    }),
  );
  return { ...item, assets, links: linksOf(item.links, base) };
}

/** Names an untitled node after the folder it sits in. */
function folderName(href: string): string {
  const segments = new URL(href).pathname.split("/").filter(Boolean);
  const last = segments.at(-1);
  // A file at the root has no folder to be named after, so its own name will have to do.
  const named = /\.json$/i.test(last ?? "")
    ? (segments.at(-2) ?? last?.replace(/\.json$/i, ""))
    : last;
  const name = named ?? href;
  try {
    return decodeURIComponent(name);
  } catch {
    // A bare % is legal in a path and fatal to decodeURIComponent; a raw name beats no catalog.
    return name;
  }
}

/** The `child` links of an already-read document, as tree nodes. */
function catalogChildren(document: Record<string, unknown>, base: string): StacCatalogNode[] {
  return linksOf(document.links, base)
    .filter((link) => link.rel === "child")
    .map(
      (link): StacCatalogNode => ({
        href: link.href,
        title: link.title || folderName(link.href),
        kind: /\/collection\.json($|[?#])/i.test(link.href) ? "collection" : "container",
      }),
    );
}

/**
 * The horizontal corners of a STAC bounding box, which carries elevation in its middle when it
 * has any: four numbers or six, never an odd count — half of five is not an index.
 */
export function horizontalBbox(values: unknown): [number, number, number, number] | undefined {
  if (!Array.isArray(values) || values.length < 4 || values.length % 2 !== 0) return undefined;
  if (!values.every((value) => typeof value === "number" && Number.isFinite(value)))
    return undefined;
  const half = values.length / 2;
  return [values[0], values[1], values[half], values[half + 1]];
}

/** The first spatial extent a collection declares, which covers the rest. */
function collectionBbox(
  document: Record<string, unknown>,
): [number, number, number, number] | undefined {
  const extent = document.extent;
  if (typeof extent !== "object" || extent === null || !("spatial" in extent)) return undefined;
  const spatial = extent.spatial;
  if (typeof spatial !== "object" || spatial === null || !("bbox" in spatial)) return undefined;
  const boxes = spatial.bbox;
  return horizontalBbox(Array.isArray(boxes) ? boxes[0] : undefined);
}

export async function openCatalogNode(
  href: string,
  fetcher: FetchLike = fetch,
  signal?: AbortSignal,
): Promise<StacOpenedNode> {
  const document = await fetchJson<Record<string, unknown>>(href, { signal }, fetcher);
  if (typeof document !== "object" || document === null || Array.isArray(document))
    throw new Error("The link did not return a STAC document");
  const links = linksOf(document.links, href);
  return {
    kind: document.type === "Collection" ? "collection" : "container",
    children: catalogChildren(document, href),
    items: links.filter((link) => link.rel === "item").length,
    bbox: collectionBbox(document),
  };
}

export async function connectStac(
  inputUrl: string,
  fetcher: FetchLike = fetch,
  signal?: AbortSignal,
): Promise<StacConnection> {
  if (!httpUrl(inputUrl)) throw new Error("Enter a valid HTTP or HTTPS STAC URL");
  const url = new URL(inputUrl).href;
  const root = await fetchJson<Record<string, unknown>>(url, { signal }, fetcher);
  if (typeof root !== "object" || root === null)
    throw new Error("The URL did not return a STAC document");
  const links = linksOf(root.links, url);
  const conforms = Array.isArray(root.conformsTo) ? root.conformsTo.map(String) : [];
  const searchLink = links.find((link) => link.rel === "search");
  const isApi =
    Boolean(searchLink) ||
    conforms.some((entry) => entry.toLowerCase().includes("item-search")) ||
    links.some((link) => link.rel === "data");

  let collections: StacCollection[] = [];
  const collectionsLink = links.find(
    (link) => link.rel === "data" || (link.rel === "collections" && link.type?.includes("json")),
  );
  if (collectionsLink) {
    try {
      const data = await fetchJson<{ collections?: StacCollection[] }>(
        collectionsLink.href,
        { signal },
        fetcher,
      );
      if (Array.isArray(data.collections)) collections = data.collections;
    } catch {
      // Collection discovery is helpful but not required for item search.
    }
  }

  return {
    url,
    title: typeof root.title === "string" ? root.title : String(root.id ?? "STAC catalog"),
    description: typeof root.description === "string" ? root.description : undefined,
    isApi,
    searchUrl:
      searchLink?.href ??
      (isApi ? absoluteHref("search", url.endsWith("/") ? url : `${url}/`) : undefined),
    collections,
    // An API is searched through its endpoint, and a branch of one can only be searched through
    // the endpoint that branch advertises, so its hierarchy is not a way in from here.
    children: isApi ? [] : catalogChildren(root, url),
    root,
  };
}

function parseItems(raw: unknown, responseUrl: string): StacSearchResult {
  if (!raw || typeof raw !== "object")
    throw new Error("The STAC server returned invalid search data");
  const data = raw as Record<string, unknown>;
  const features = Array.isArray(data.features) ? data.features : [];
  const items = features.filter(isStacItem).map((item) => normalizeItem(item, responseUrl));
  const nextLink = linksOf(data.links, responseUrl).find((link) => link.rel === "next");
  const context = data.context as { matched?: unknown } | undefined;
  const numberMatched = data.numberMatched;
  return {
    items,
    matched:
      typeof numberMatched === "number"
        ? numberMatched
        : typeof context?.matched === "number"
          ? context.matched
          : undefined,
    next: nextLink
      ? {
          href: nextLink.href,
          method: nextLink.method?.toUpperCase() === "POST" ? "POST" : "GET",
          body: nextLink.body,
        }
      : undefined,
  };
}

export async function searchStacApi(
  connection: StacConnection,
  options: StacSearchOptions,
  fetcher: FetchLike = fetch,
): Promise<StacSearchResult> {
  if (!connection.searchUrl) throw new Error("This catalog does not advertise STAC Item Search");
  const body: Record<string, unknown> = {
    ...options.additional,
    limit: Math.max(1, Math.min(options.limit ?? 20, 100)),
  };
  if (options.bbox) body.bbox = options.bbox;
  if (options.datetime) body.datetime = options.datetime;
  if (options.collections?.length) body.collections = options.collections;

  const page = options.next;
  const href = page?.href ?? connection.searchUrl;
  const method = page?.method ?? "POST";
  const requestBody = page?.body ? { ...body, ...page.body } : body;
  try {
    const raw = await fetchJson(
      href,
      {
        signal: options.signal,
        method,
        ...(method === "POST"
          ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(requestBody) }
          : {}),
      },
      fetcher,
    );
    return parseItems(raw, href);
  } catch (error) {
    if (page || method !== "POST") throw error;
    // Core Item Search requires GET and POST to have equivalent semantics.
    // Some older implementations expose only GET despite advertising search.
    const query = new URLSearchParams({ limit: String(body.limit) });
    if (options.bbox) query.set("bbox", options.bbox.join(","));
    if (options.datetime) query.set("datetime", options.datetime);
    if (options.collections?.length) query.set("collections", options.collections.join(","));
    for (const [key, value] of Object.entries(options.additional ?? {})) {
      if (["limit", "bbox", "datetime", "collections"].includes(key) || value === undefined) {
        continue;
      }
      query.set(key, typeof value === "string" ? value : JSON.stringify(value));
    }
    const getUrl = `${href}${href.includes("?") ? "&" : "?"}${query}`;
    return parseItems(await fetchJson(getUrl, { signal: options.signal }, fetcher), getUrl);
  }
}

function intersects(a: number[], b: [number, number, number, number]): boolean {
  return a.length >= 4 && a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

function inTime(item: StacItem, interval?: string): boolean {
  if (!interval) return true;
  const [rawStart, rawEnd = rawStart] = interval.split("/");
  const start = rawStart === ".." ? undefined : rawStart;
  const end = rawEnd === ".." ? undefined : rawEnd;
  const value = item.properties.datetime ?? item.properties.start_datetime;
  if (!value) return true;
  const time = Date.parse(String(value));
  return (
    Number.isFinite(time) &&
    (!start || time >= Date.parse(start)) &&
    (!end || time <= Date.parse(end))
  );
}

/** Searches a static catalog by following child/item links, with a hard safety cap. */
/** Queued but unread; the root arrives already read. */
type Unread = { url: string; document?: Record<string, unknown>; retried?: boolean };

/** A read about to happen, and the queue it came out of, so a failure can go back there. */
type Pending = { entry: Unread; from: Unread[] };

export async function searchStaticStac(
  connection: StacConnection,
  options: StacSearchOptions,
  fetcher: FetchLike = fetch,
): Promise<StacSearchResult> {
  // Where a search starts and what it filters by belong to the walk, not to the call: both can
  // change between pages, and one accumulated list filtered two ways is worse than either.
  const roots: Unread[] = (options.entries?.length ? options.entries : [connection.url]).map(
    // The root is already in hand, so a chosen entry that is the root costs no read. Any other
    // entry is read here even when the tree read it to classify it: passing that document along
    // would mean the tree holding every document it has opened, to save one request per search.
    (url) => (url === connection.url ? { url, document: connection.root } : { url }),
  );
  const walk = options.cursor ?? {
    items: [],
    folders: roots,
    visited: new Set<string>(),
    offset: 0,
    dropped: 0,
    filters: { bbox: options.bbox, collections: options.collections, datetime: options.datetime },
  };
  const found: StacItem[] = [];
  const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
  let reads = 0;

  const accepts = (item: StacItem): boolean => {
    // itemBbox flattens 3D (6-element) bboxes; item.bbox[2]/[3] would be minZ/maxX there.
    const bbox = itemBbox(item);
    const filters = walk.filters;
    if (filters.collections?.length && !filters.collections.includes(item.collection ?? "")) {
      return false;
    }
    if (filters.bbox && !(bbox && intersects(bbox, filters.bbox))) return false;
    return inTime(item, filters.datetime);
  };

  const takeBatch = (): Pending[] => {
    const room = Math.min(
      STATIC_SEARCH_CONCURRENCY,
      limit - found.length,
      STATIC_SEARCH_READS_PER_PAGE - reads,
    );
    const batch: Pending[] = [];
    while (batch.length < room && (walk.items.length || walk.folders.length)) {
      const from = walk.items.length ? walk.items : walk.folders;
      const entry = from.shift()!;
      if (walk.visited.has(entry.url)) continue;
      walk.visited.add(entry.url);
      batch.push({ entry, from });
    }
    return batch;
  };

  /**
   * A batch leaves its queue before the requests go out, so a failed read has to put the entry
   * back or it is lost, and a folder takes its subtree with it. Twice failed is dropped.
   */
  const read = async ({ entry, from }: Pending): Promise<Record<string, unknown> | undefined> => {
    if (entry.document) return entry.document;
    try {
      return await fetchJson<Record<string, unknown>>(
        entry.url,
        { signal: options.signal },
        fetcher,
      );
    } catch {
      if (entry.retried) {
        walk.dropped += 1;
        return undefined;
      }
      walk.visited.delete(entry.url);
      from.unshift({ url: entry.url, retried: true });
      return undefined;
    }
  };

  const collect = (document: Record<string, unknown>, url: string): void => {
    if (document.type !== "Feature") {
      for (const link of linksOf(document.links, url)) {
        if (link.rel === "item") walk.items.push({ url: link.href });
        else if (link.rel === "child") walk.folders.push({ url: link.href });
      }
      return;
    }
    if (!isStacItem(document)) return;
    const item = normalizeItem(document, url);
    if (accepts(item)) found.push(item);
  };

  while (found.length < limit && reads < STATIC_SEARCH_READS_PER_PAGE) {
    // Abandoned: stop, rather than read to the budget and count each cancelled read as a failure.
    if (options.signal?.aborted) break;
    const batch = takeBatch();
    if (!batch.length) break;
    reads += batch.length;
    const documents = await Promise.all(batch.map(read));
    documents.forEach((document, index) => {
      if (document) collect(document, batch[index].entry.url);
    });
  }

  const offset = walk.offset + found.length;
  const done = !walk.items.length && !walk.folders.length;
  // Counting every page, not the last: the panel accumulates, so a page total reads "25 of 5".
  // A dropped document leaves part of the catalog unread, so the count is no longer a total.
  if (done) return { items: found, matched: walk.dropped ? undefined : offset };
  walk.offset = offset;
  return { items: found, cursor: walk };
}

export function itemBbox(item: StacItem): [number, number, number, number] | undefined {
  return horizontalBbox(item.bbox);
}

/** A format {@link assetFormat} recognizes, and {@link visualizeAsset} knows how to add. */
export type StacAssetFormat = "pmtiles" | "geojson" | "cog";
export type StacAssetDisplayFormat = StacAssetFormat | "parquet";

interface AssetFormatRule {
  format: StacAssetDisplayFormat;
  /** Matched within the asset's media type, which catalogs write with varying parameters. */
  mediaType: string;
  /** Read only when no rule's media type matched, for a catalog that omits the type. */
  extension: RegExp;
}

/** Formats the panel labels, and the two ways an asset can name each of them. */
const ASSET_FORMATS: readonly AssetFormatRule[] = [
  { format: "pmtiles", mediaType: "pmtiles", extension: /\.pmtiles($|\?)/i },
  { format: "geojson", mediaType: "geo+json", extension: /\.geojson($|\?)/i },
  { format: "cog", mediaType: "geotiff", extension: /\.tiff?($|\?)/i },
  { format: "parquet", mediaType: "parquet", extension: /\.parquet($|\?)/i },
];

export function assetDisplayFormat(asset: StacAsset): StacAssetDisplayFormat | null {
  const mediaType = (asset.type ?? "").toLowerCase();
  const declared = ASSET_FORMATS.find((rule) => mediaType.includes(rule.mediaType));
  if (declared) return declared.format;

  return ASSET_FORMATS.find((rule) => rule.extension.test(asset.href))?.format ?? null;
}

/**
 * Which format an asset is, or null when the panel cannot draw it. Both the enabled state of Add
 * and the routing behind it read this, so the button and the click cannot disagree.
 */
export function assetFormat(asset: StacAsset): StacAssetFormat | null {
  const format = assetDisplayFormat(asset);
  return format === "parquet" ? null : format;
}

export function isVisualizableAsset(asset: StacAsset): boolean {
  return assetFormat(asset) !== null;
}
