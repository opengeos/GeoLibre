import type { BBox, Feature, Geometry } from "geojson";

export const STAC_INDEX_CATALOGS_URL = "https://stacindex.org/api/catalogs";
const USGS_ASTROGEOLOGY_API_URL = "https://stac.astrogeology.usgs.gov/api";
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

/** The Azure account a catalog names beside an href, in either of the two spellings in use. */
interface StorageOptions {
  account_name?: string;
}

interface XarrayOpenKwargs {
  storage_options?: StorageOptions;
}

export interface StacAsset {
  href: string;
  title?: string;
  type?: string;
  roles?: string[];
  /**
   * Table extension storage options. Catalogs that publish `abfs://` hrefs keep the Azure
   * account out of the URL and name it here — the href's first segment is the *container*.
   */
  "table:storage_options"?: StorageOptions;
  /** Where a Zarr asset names that same account. */
  "xarray:open_kwargs"?: XarrayOpenKwargs;
  /** Present on an Icechunk store, which is a manifest rather than a Zarr hierarchy. */
  "icechunk:branch"?: string;
  /** Projection extension code, e.g. `EPSG:32632`, when the asset is not in WGS84. */
  "proj:code"?: string;
  "proj:epsg"?: number;
}

export interface StacItem extends Feature<Geometry | null> {
  id: string;
  bbox?: BBox;
  collection?: string;
  properties: Record<string, unknown> & {
    datetime?: string;
    start_datetime?: string;
    end_datetime?: string;
    "table:storage_options"?: StorageOptions;
    "xarray:open_kwargs"?: XarrayOpenKwargs;
    "icechunk:branch"?: string;
  };
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

/**
 * S3 website endpoints only support HTTP. Catalog indexes and older STAC documents still
 * publish those URLs, which makes them mixed content in the web app. The equivalent REST
 * S3 endpoint supports HTTPS and serves the same public object. A bucket whose name holds
 * a dot has to go through the path-style endpoint: the wildcard on the virtual hosted-style
 * certificate covers one label, so `a.b.s3.<region>.amazonaws.com` fails TLS validation.
 */
function browserCatalogHref(href: string): string {
  const url = new URL(href);
  // STAC Index still advertises this 2022 static catalog. Its planetary child buckets have
  // since been removed, while USGS publishes the same data through its supported STAC API.
  if (
    url.hostname.toLowerCase() === "asc-stacbrowser.s3-website-us-west-2.amazonaws.com" &&
    url.pathname === "/catalog.json"
  ) {
    return USGS_ASTROGEOLOGY_API_URL;
  }
  const website = url.hostname.match(/^(.+)\.s3-website[.-]([a-z0-9-]+)\.amazonaws\.com$/i);
  if (!website) return url.href;
  const [, bucket, region] = website;
  url.protocol = "https:";
  if (bucket.includes(".")) {
    url.hostname = `s3.${region}.amazonaws.com`;
    url.pathname = `/${bucket}${url.pathname}`;
  } else {
    url.hostname = `${bucket}.s3.${region}.amazonaws.com`;
  }
  return url.href;
}

function absoluteHref(href: string, base: string): string {
  return browserCatalogHref(new URL(href, base).href);
}

/**
 * Converts an anonymous object-store URI into the HTTPS form browsers and raster
 * range readers can fetch. STAC APIs such as Earth Search legitimately return
 * `s3://` asset hrefs even though the catalog itself is accessed over HTTPS, and
 * Planetary Computer publishes GeoParquet as `abfs://`.
 *
 * `accountName` comes from the asset's `table:storage_options`. Azure hrefs name the
 * *container* first and carry the account out of band, so without an account name there
 * is nothing to resolve against and the href is returned untouched.
 */
export function browserAssetHref(href: string, base: string, accountName?: string): string {
  const resolved = absoluteHref(href, base);
  const url = new URL(resolved);
  if (url.protocol === "s3:") {
    const bucket = url.hostname;
    if (!bucket) return resolved;
    return `https://${bucket}.s3.amazonaws.com${url.pathname}${url.search}${url.hash}`;
  }
  if (AZURE_SCHEMES.has(url.protocol)) {
    // Canonical form names both parts: abfs[s]://<container>@<account>.dfs.core.windows.net/<path>.
    // The shorthand names only the container and leans on the account beside it.
    const canonical = url.hostname.endsWith(DFS_SUFFIX);
    const container = canonical ? decodeURIComponent(url.username) : url.hostname;
    const account = canonical ? url.hostname.slice(0, -DFS_SUFFIX.length) : accountName;
    if (!container || !account) return resolved;
    return `https://${account}.blob.core.windows.net/${container}${url.pathname}${url.search}${url.hash}`;
  }
  return resolved;
}

const DFS_SUFFIX = ".dfs.core.windows.net";

/** fsspec/adlfs spellings for an Azure blob path, all container-first. */
const AZURE_SCHEMES = new Set(["abfs:", "abfss:", "az:"]);

/** Whether an href points at Azure blob storage, which may need a SAS token to read. */
export function isAzureBlobHref(href: string): boolean {
  try {
    return new URL(href).hostname.endsWith(".blob.core.windows.net");
  } catch {
    return false;
  }
}

async function fetchJson<T>(url: string, init: RequestInit, fetcher: FetchLike): Promise<T> {
  const response = await fetcher(browserCatalogHref(url), {
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
  // The table extension allows the storage options to sit on the item instead of on each asset.
  const itemAccount =
    item.properties?.["table:storage_options"]?.account_name ??
    item.properties?.["xarray:open_kwargs"]?.storage_options?.account_name;
  const assets = Object.fromEntries(
    Object.entries(item.assets ?? {}).flatMap(([key, asset]) => {
      if (!asset?.href) return [];
      const account =
        asset["table:storage_options"]?.account_name ??
        asset["xarray:open_kwargs"]?.storage_options?.account_name ??
        itemAccount;
      try {
        return [[key, { ...asset, href: browserAssetHref(asset.href, base, account) }]];
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

/** Presents a Collection's own assets as one item so the existing asset browser can render it. */
function collectionAssetItem(document: Record<string, unknown>, url: string): StacItem | undefined {
  if (document.type !== "Collection" || typeof document.id !== "string") return undefined;
  if (typeof document.assets !== "object" || document.assets === null) return undefined;
  const assets = document.assets as Record<string, StacAsset>;
  if (!Object.keys(assets).length) return undefined;
  const extent = document.extent as StacCollection["extent"] | undefined;
  const spatialBoxes = extent?.spatial?.bbox;
  const spatialBboxes = (Array.isArray(spatialBoxes) ? spatialBoxes : []).flatMap((bbox) => {
    const horizontal = horizontalBbox(bbox);
    return horizontal ? [horizontal] : [];
  });
  const temporalIntervals = extent?.temporal?.interval ?? [];
  const interval = temporalIntervals[0];
  const start = interval?.[0] ?? undefined;
  const end = interval?.[1] ?? undefined;
  return normalizeItem(
    {
      type: "Feature",
      id: `${document.id}::collection-assets`,
      collection: document.id,
      geometry: null,
      bbox: collectionBbox(document),
      properties: {
        ...(typeof document.title === "string" ? { title: document.title } : {}),
        ...(typeof document.description === "string" ? { description: document.description } : {}),
        "geolibre:spatial_bboxes": spatialBboxes,
        "geolibre:temporal_intervals": temporalIntervals,
        ...(start && start === end ? { datetime: start } : {}),
        ...(start && start !== end ? { start_datetime: start } : {}),
        ...(end && start !== end ? { end_datetime: end } : {}),
      },
      assets,
      links: document.links as StacLink[] | undefined,
    },
    url,
  );
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
  const url = browserCatalogHref(inputUrl);
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
  const queryStart = rawStart === ".." ? undefined : Date.parse(rawStart);
  const queryEnd = rawEnd === ".." ? undefined : Date.parse(rawEnd);
  const advertised = item.properties["geolibre:temporal_intervals"];
  const intervals =
    Array.isArray(advertised) && advertised.length
      ? advertised
      : [
          [
            item.properties.datetime ?? item.properties.start_datetime ?? null,
            item.properties.datetime ?? item.properties.end_datetime ?? null,
          ],
        ];
  return intervals.some((candidate) => {
    if (!Array.isArray(candidate)) return false;
    const itemStart = candidate[0] === null ? undefined : Date.parse(String(candidate[0] ?? ""));
    const itemEnd = candidate[1] === null ? undefined : Date.parse(String(candidate[1] ?? ""));
    if (!Number.isFinite(itemStart) && !Number.isFinite(itemEnd)) return true;
    return (
      (queryEnd === undefined || itemStart === undefined || itemStart <= queryEnd) &&
      (queryStart === undefined || itemEnd === undefined || itemEnd >= queryStart)
    );
  });
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
    const collectionBboxes = item.properties["geolibre:spatial_bboxes"];
    const bboxes = Array.isArray(collectionBboxes) ? collectionBboxes : bbox ? [bbox] : [];
    if (filters.bbox && !bboxes.some((candidate) => intersects(candidate, filters.bbox!))) {
      return false;
    }
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
      const collectionItem = collectionAssetItem(document, url);
      if (collectionItem && accepts(collectionItem)) found.push(collectionItem);
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
  const advertised = horizontalBbox(item.bbox);
  if (
    advertised &&
    advertised[0] >= -180 &&
    advertised[0] <= 180 &&
    advertised[2] >= -180 &&
    advertised[2] <= 180 &&
    advertised[1] >= -90 &&
    advertised[1] <= 90 &&
    advertised[3] >= -90 &&
    advertised[3] <= 90 &&
    advertised[1] <= advertised[3]
  ) {
    return advertised;
  }

  // Some planetary records (notably USGS Mars THEMIS mosaics) incorrectly put
  // their projected metre extent in the STAC bbox while their required GeoJSON
  // geometry is correctly expressed as lon/lat. Derive the camera extent from
  // that geometry instead of handing MapLibre impossible million-degree values.
  const positions: Array<[number, number]> = [];
  const collect = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    if (
      value.length >= 2 &&
      typeof value[0] === "number" &&
      Number.isFinite(value[0]) &&
      typeof value[1] === "number" &&
      Number.isFinite(value[1])
    ) {
      positions.push([value[0], value[1]]);
      return;
    }
    for (const child of value) collect(child);
  };
  // A GeometryCollection may hold another one, so walk rather than reading one level.
  const collectGeometry = (geometry: Geometry | null | undefined): void => {
    if (!geometry) return;
    if (geometry.type === "GeometryCollection") {
      for (const child of geometry.geometries) collectGeometry(child);
      return;
    }
    collect(geometry.coordinates);
  };
  collectGeometry(item.geometry);
  // Anything still here failed the lon/lat check above, so falling back to it
  // would hand out the impossible values this whole branch exists to replace.
  // Without a usable geometry the honest answer is that there is no extent.
  if (!positions.length) return undefined;

  const latitudes = positions.map(([, latitude]) => latitude);
  if (latitudes.some((latitude) => latitude < -90 || latitude > 90)) return undefined;
  // The wrap below would fold any magnitude into a plausible-looking angle, so
  // a geometry carrying the same projected-metre bug as the bbox has to be
  // rejected the way an impossible latitude is. The bound is 360 rather than
  // 180 because planetary catalogs legitimately write 0-360 east longitude.
  if (positions.some(([longitude]) => longitude < -360 || longitude > 360)) return undefined;
  const longitudes = positions
    .map(([longitude]) => ((longitude % 360) + 360) % 360)
    .sort((a, b) => a - b);
  let gapIndex = longitudes.length - 1;
  let largestGap = longitudes[0] + 360 - longitudes.at(-1)!;
  for (let index = 0; index < longitudes.length - 1; index += 1) {
    const gap = longitudes[index + 1] - longitudes[index];
    if (gap > largestGap) {
      largestGap = gap;
      gapIndex = index;
    }
  }
  const start = longitudes[(gapIndex + 1) % longitudes.length];
  const west = start >= 180 ? start - 360 : start;
  return [west, Math.min(...latitudes), west + (360 - largestGap), Math.max(...latitudes)];
}

/** A format {@link assetFormat} recognizes, and {@link visualizeAsset} knows how to add. */
export type StacAssetFormat = "pmtiles" | "geojson" | "cog" | "parquet" | "zarr";
export type StacAssetDisplayFormat = StacAssetFormat;

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
  { format: "zarr", mediaType: "zarr", extension: /\.zarr(\/|$|\?)/i },
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
 *
 * Narrower than {@link assetDisplayFormat}: an asset is named by its format even when it cannot
 * be reached. {@link browserAssetHref} leaves an object-store URI alone when nothing resolves it
 * — an `abfs://` href whose catalog omits `table:storage_options`, say — and none of the readers
 * behind Add speak those schemes, so such an asset is labelled but not offered.
 */
export function assetFormat(asset: StacAsset): StacAssetFormat | null {
  if (!isFetchableHref(asset.href)) return null;
  return assetDisplayFormat(asset);
}

/** Whether an href is one the readers behind Add can actually open. */
function isFetchableHref(href: string): boolean {
  try {
    const { protocol } = new URL(href);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

export function isVisualizableAsset(asset: StacAsset): boolean {
  return assetFormat(asset) !== null;
}

/** One of the things inside an asset that can become a layer. */
export interface AssetTarget {
  /** What the reader is asked for: a Zarr variable today, a PMTiles source layer later. */
  id: string;
  label: string;
}

/** An object's own entries, or none when it is anything else — an array included. */
function entriesOf(value: unknown): [string, Record<string, unknown>][] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  return Object.entries(value).map(([key, entry]) => [
    key,
    (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>,
  ]);
}

/**
 * The arrays in a Zarr store that can be drawn: those spanning two of the item's spatial
 * dimensions, which leaves out coordinate bounds and other one-dimensional companions.
 */
export function zarrTargets(item: StacItem, assetKey: string): AssetTarget[] {
  const spatialDimensions = entriesOf(item.properties?.["cube:dimensions"]).filter(
    ([, dimension]) => dimension.type === "spatial",
  );
  const spatial = new Set(spatialDimensions.map(([name]) => name));
  // Only an axis the datacube extension defines counts as named; anything else — a spelling the
  // spec does not use, a number — says nothing, and saying nothing is not the same as saying no.
  const axisOf = new Map(
    spatialDimensions.map(([name, dimension]) => {
      const axis = String(dimension.axis ?? "").toLowerCase();
      return [name, ["x", "y", "z"].includes(axis) ? axis : ""];
    }),
  );
  const declared = entriesOf(item.properties?.["cube:variables"]);
  const drawable = declared.filter(([, variable]) => {
    const dimensions = variable.dimensions;
    if (!Array.isArray(dimensions)) return false;
    const across = dimensions.map(String).filter((name) => spatial.has(name));
    if (across.length < 2) return false;
    // The renderer draws a horizontal raster, so two spatial dimensions are not enough on their
    // own — a vertical cross-section spans latitude and depth. Judge by the axes only when every
    // one of them is named, since a partly labelled cube says less than it appears to.
    const axes = across.map((name) => axisOf.get(name) ?? "");
    if (axes.some((axis) => axis === "")) return true;
    return axes.includes("x") && axes.includes("y");
  });
  // An asset keyed by a variable holds that one, not the whole store (Planetary Computer). A key
  // that names a variable which cannot be drawn holds nothing — offering the item's other
  // variables would name arrays that asset's own store may not contain.
  const named = drawable.filter(([name]) => name === assetKey);
  const keyed = declared.some(([name]) => name === assetKey);
  return (named.length || keyed ? named : drawable).map(([name, variable]) => ({
    id: name,
    label: typeof variable.unit === "string" ? `${name} (${variable.unit})` : name,
  }));
}

/**
 * Where a Zarr asset's store begins, and the array inside it the href points at. Catalogs address
 * either the whole store or one array within it (EOPF names a Sentinel band that way).
 */
export function zarrStorePath(href: string): { url: string; path?: string } {
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    // Not a URL to take apart — hand it back and let the reader fail on its own terms.
    return { url: href };
  }
  const marker = /\.zarr\//i.exec(parsed.pathname);
  if (!marker) return { url: href };
  const cut = marker.index + ".zarr".length;
  // Only the path names the array: a query string belongs to the request, not to the key.
  const path = parsed.pathname.slice(cut + 1);
  const root = new URL(parsed.href);
  root.pathname = parsed.pathname.slice(0, cut);
  return path ? { url: root.href, path } : { url: root.href };
}

/**
 * Whether a store URL can have keys appended to it. A reader asks for `<store>/<key>`, so anything
 * after the path — a SAS token, a presigned signature — would land in the middle of the request.
 */
export function zarrStoreTakesKeys(url: string): boolean {
  try {
    const { search, hash } = new URL(url);
    return !search && !hash;
  } catch {
    return true;
  }
}

/** What the Zarr renderer is asked for: the store, the array inside it, and how to colour it. */
export interface ZarrLayerRequest {
  url: string;
  variable: string;
  colormap?: string;
  clim?: [number, number];
  crs?: string;
}

/** An `EPSG:<code>` string from any of the spellings catalogs use, or undefined for none. */
function epsgCode(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return `EPSG:${value}`;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (/^epsg:\d+$/i.test(trimmed)) return trimmed.toUpperCase();
  // The datacube extension also allows an OGC CRS URI, e.g. `…/def/crs/EPSG/0/32612`.
  const uri = /\/def\/crs\/EPSG\/\d+\/(\d+)$/i.exec(trimmed);
  if (uri) return `EPSG:${uri[1]}`;
  return /^\d+$/.test(trimmed) ? `EPSG:${trimmed}` : undefined;
}

/**
 * The CRS a Zarr store's coordinates are in. The renderer assumes WGS84, so a store on a projected
 * grid lands in the wrong place unless it is told — EOPF publishes Sentinel scenes on UTM zones.
 * The asset's own projection wins over the item's, and the datacube dimensions are the fallback.
 */
export function zarrCrs(item: StacItem, asset: StacAsset): string | undefined {
  const spatial = entriesOf(item.properties?.["cube:dimensions"]).filter(
    ([, dimension]) => dimension.type === "spatial",
  );
  return (
    epsgCode(asset["proj:code"]) ??
    epsgCode(asset["proj:epsg"]) ??
    epsgCode(item.properties?.["proj:code"]) ??
    epsgCode(item.properties?.["proj:epsg"]) ??
    spatial.map(([, dimension]) => epsgCode(dimension.reference_system)).find(Boolean)
  );
}

/**
 * Turns an asset href and the panel's raster options into a Zarr layer request. The options are
 * shared with COG, and without a range a store whose values sit outside the renderer's default
 * paints as one flat wash.
 */
export function zarrLayerRequest(
  href: string,
  variable: string,
  options: { colormap?: string; rescaleMin?: number; rescaleMax?: number; crs?: string } = {},
): ZarrLayerRequest {
  const { colormap, rescaleMin, rescaleMax, crs } = options;
  return {
    url: zarrStorePath(href).url,
    variable,
    // WGS84 is what the renderer already assumes, so saying it adds nothing.
    ...(crs && crs !== "EPSG:4326" ? { crs } : {}),
    ...(colormap ? { colormap } : {}),
    // Half a range would leave the renderer to invent the other end, so both bounds or neither.
    ...(rescaleMin !== undefined && rescaleMax !== undefined
      ? { clim: [rescaleMin, rescaleMax] as [number, number] }
      : {}),
  };
}

/**
 * A layer's metadata with the item's extent recorded on it. The Zarr renderer places data from the
 * store's own coordinates and reports no extent, so without this Zoom to layer has nothing to fly
 * to; a STAC bbox is WGS84, which is what the map wants.
 */
export function withItemBounds(
  metadata: Record<string, unknown>,
  item: StacItem,
): Record<string, unknown> {
  const bounds = itemBbox(item);
  return bounds ? { ...metadata, bounds } : metadata;
}

/**
 * The documents a node answers to: v3 says what it is in one file, while v2 splits the answer —
 * `.zarray` for an array, `.zgroup` for a group.
 */
const ZARR_NODE_KEYS = ["zarr.json", ".zarray", ".zgroup"];

/**
 * What the store said about a variable. The failures need different words: a group is a real path
 * that simply cannot be drawn, a refusal means credentials this build cannot supply, `missing` is a
 * store that answered and does not hold the variable, and the rest is a store nothing can read.
 *
 * Only {@link zarrReaderTargetCheck} reports `missing`. Over HTTP the two are not separable — a
 * gateway that omits CORS headers on its 404s throws for a key that is merely absent, so an absent
 * variable and an unreachable store arrive identically.
 */
export type ZarrTargetCheck =
  | "array"
  | "group"
  | "missing"
  | "unauthorized"
  | "unsupported-url"
  | "unavailable";

/** As much of a node's metadata as the verdict depends on. */
interface Node {
  node_type?: string;
}

/** Statuses an object store answers with when a token is missing rather than the object. */
const UNAUTHORIZED_STATUSES = new Set([401, 403, 409]);

/**
 * What one metadata document says a node is. v2 splits the answer across two files; v3 says which
 * it is, and says so explicitly. A body that is not metadata says nothing at all.
 */
function nodeVerdict(key: string, body: unknown): ZarrTargetCheck | null {
  // An array parses and is `typeof "object"`, but no Zarr node is one, so it says nothing either.
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  if (key === ".zarray") return "array";
  if (key === ".zgroup") return "group";
  // A v3 node says which it is. One that says neither is not a node either, whatever else it holds.
  const nodeType = (body as Node).node_type;
  return nodeType === "array" || nodeType === "group" ? nodeType : null;
}

/**
 * The same verdict, for a store that is read through its own reader rather than over HTTP — an
 * Icechunk repository resolves a Zarr key through its manifest, so there is no URL to probe.
 */
export async function zarrReaderTargetCheck(
  read: (key: `/${string}`, options?: { signal?: AbortSignal }) => Promise<Uint8Array | undefined>,
  variable: string,
  signal?: AbortSignal,
): Promise<ZarrTargetCheck> {
  // "No such key" is about the variable; a throw is about the store. The difference is the two
  // verdicts below, so which happened is remembered rather than collapsed. `IcechunkStore.get`
  // catches its own `NotFoundError` and resolves undefined, so an absent variable reports
  // `missing`; a reader that threw would report `unavailable`, which is honest for one whose
  // absences cannot be told from its failures.
  let failed = false;
  // Both Zarr versions are asked for, as over HTTP. An Icechunk repository answers only the v3
  // name, and answers the other two from the snapshot it holds rather than by asking.
  for (const key of ZARR_NODE_KEYS) {
    signal?.throwIfAborted();
    let bytes: Uint8Array | undefined;
    try {
      bytes = await read(`/${variable}/${key}`, { signal });
    } catch (error) {
      // One key failing is not the whole store, the same way it is not over HTTP: a manifest can
      // refuse a key it does not carry. Keep asking, and report only once every key has been.
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      failed = true;
      continue;
    }
    if (!bytes) continue;
    // Bytes that are not usable metadata — unparseable, or parsed into something that is not a
    // node — are the store failing to answer rather than the variable being absent, however well
    // formed they are.
    try {
      const verdict = nodeVerdict(key, JSON.parse(new TextDecoder().decode(bytes)) as unknown);
      if (verdict) return verdict;
      failed = true;
    } catch {
      failed = true;
    }
  }
  return failed ? "unavailable" : "missing";
}

/**
 * Whether a variable really is a drawable array in the store. Asking for the array's own metadata
 * settles it in one request: the store is reachable, the path exists, and it is an array rather
 * than a group — EOPF keys an asset to `.../r10m`, which holds four bands and draws nothing.
 */
export async function zarrTargetCheck(
  store: string,
  variable: string,
  fetcher: FetchLike = fetch,
  signal?: AbortSignal,
): Promise<ZarrTargetCheck> {
  // Asked here rather than by the caller, so one function owns the whole verdict.
  if (!zarrStoreTakesKeys(store)) return "unsupported-url";
  // Some gateways answer a refusal for a key that is merely absent (S3 without `ListBucket`), so a
  // refusal is remembered and only reported once every key has been asked.
  let refused = false;
  for (const key of ZARR_NODE_KEYS) {
    try {
      const response = await fetcher(storeKeyUrl(store, `${variable}/${key}`), { signal });
      if (UNAUTHORIZED_STATUSES.has(response.status)) {
        refused = true;
        continue;
      }
      if (!response.ok) continue;
      // A host answering 200 for everything — a CDN catch-all, a dev proxy — says nothing about
      // the store, so every key is believed only once its body parses as metadata.
      const metadata = await response
        .json()
        .then((body: unknown) => (body && typeof body === "object" ? (body as Node) : null))
        .catch(() => null);
      const verdict = nodeVerdict(key, metadata);
      if (verdict) return verdict;
    } catch (error) {
      // Not every failure is the whole host: a gateway that omits CORS headers on its 404s throws
      // for a key that is merely absent, so keep asking rather than condemning a store that would
      // have answered on the next one.
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      continue;
    }
  }
  return refused ? "unauthorized" : "unavailable";
}

/** `<store>/<key>`, with any query kept where it belongs rather than buried in the path. */
function storeKeyUrl(store: string, key: string): string {
  try {
    const url = new URL(store);
    url.pathname = `${url.pathname.replace(/\/$/, "")}/${key}`;
    return url.href;
  } catch {
    return `${store.replace(/\/$/, "")}/${key}`;
  }
}

/** What the panel would add from an asset, for the formats that hold more than one thing. */
export function assetTargets(item: StacItem, key: string, asset: StacAsset): AssetTarget[] {
  if (assetFormat(asset) !== "zarr") return [];
  // An href reaching into the store already names its array; there is nothing left to choose. An
  // Icechunk repository is no different: the reader gets the root, the path becomes the variable.
  const path = zarrStorePath(asset.href).path;
  if (path) return [{ id: path, label: asset.title || path.split("/").pop() || path }];
  return zarrTargets(item, key);
}

/**
 * Icechunk keeps its objects behind a manifest, so the URL-driven Zarr reader cannot open one.
 * Read from the item as well as the asset, the way the storage options are: a catalog is free to
 * say it once for every asset it publishes.
 */
export function isIcechunkAsset(asset: StacAsset, item?: StacItem): boolean {
  // Presence, not usability: naming the field at all declares the format, and an empty or
  // malformed value means no branch was named rather than that this is a plain store. Falling back
  // to the URL reader would give 404s and "unavailable"; the default branch gives the layer.
  return "icechunk:branch" in asset || "icechunk:branch" in (item?.properties ?? {});
}

/**
 * The branch an Icechunk asset names, or undefined when it names none — the default is
 * {@link openIcechunkStore}'s. Declared a string but arriving as catalog JSON, so it is checked
 * here rather than trusted, and this is the only reading of it.
 */
export function icechunkBranch(asset: StacAsset, item?: StacItem): string | undefined {
  for (const value of [asset["icechunk:branch"], item?.properties?.["icechunk:branch"]]) {
    // Trimmed on the way out too: the name is interpolated into a request path, so accepting one
    // form and sending another would ask for a branch the catalog did not name.
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/** Whether a format is one whose assets are read one target at a time. */
export function requiresTarget(asset: StacAsset): boolean {
  return assetFormat(asset) === "zarr";
}

/** Whether Add can proceed: a format the panel draws, holding something it can draw. */
export function canAddAsset(item: StacItem, key: string, asset: StacAsset): boolean {
  if (!isVisualizableAsset(asset)) return false;
  if (!requiresTarget(asset)) return true;
  // Answerable without asking the host, so answer it here rather than enabling Add and refusing
  // the click. It holds for an Icechunk repository too: the manifest reader still asks for
  // `<store>/<key>` (`HttpStorage.getUrl` concatenates), so a token in the URL lands mid-request.
  if (!zarrStoreTakesKeys(zarrStorePath(asset.href).url)) return false;
  return assetTargets(item, key, asset).length > 0;
}
