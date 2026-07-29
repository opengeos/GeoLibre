import type { BBox, Feature, Geometry } from "geojson";

export const STAC_INDEX_CATALOGS_URL = "https://stacindex.org/api/catalogs";

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
  root: Record<string, unknown>;
}

export interface StacSearchOptions {
  bbox?: [number, number, number, number];
  datetime?: string;
  collections?: string[];
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

async function fetchJson(url: string, init: RequestInit, fetcher: FetchLike): Promise<unknown> {
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

function normalizeItem(item: StacItem, base: string): StacItem {
  const assets = Object.fromEntries(
    Object.entries(item.assets ?? {}).flatMap(([key, asset]) => {
      if (!asset?.href) return [];
      try {
        return [[key, { ...asset, href: absoluteHref(asset.href, base) }]];
      } catch {
        return [];
      }
    }),
  );
  return { ...item, assets, links: linksOf(item.links, base) };
}

export async function connectStac(
  inputUrl: string,
  fetcher: FetchLike = fetch,
  signal?: AbortSignal,
): Promise<StacConnection> {
  if (!httpUrl(inputUrl)) throw new Error("Enter a valid HTTP or HTTPS STAC URL");
  const url = new URL(inputUrl).href;
  const raw = await fetchJson(url, { signal }, fetcher);
  if (!raw || typeof raw !== "object") throw new Error("The URL did not return a STAC document");
  const root = raw as Record<string, unknown>;
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
      const data = (await fetchJson(collectionsLink.href, { signal }, fetcher)) as {
        collections?: StacCollection[];
      };
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
    root,
  };
}

function parseItems(raw: unknown, responseUrl: string): StacSearchResult {
  if (!raw || typeof raw !== "object")
    throw new Error("The STAC server returned invalid search data");
  const data = raw as Record<string, unknown>;
  const features = Array.isArray(data.features) ? data.features : [];
  const items = features
    .filter(
      (feature): feature is StacItem =>
        Boolean(feature) &&
        typeof feature === "object" &&
        typeof (feature as StacItem).id === "string" &&
        Boolean((feature as StacItem).assets),
    )
    .map((item) => normalizeItem(item, responseUrl));
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
export async function searchStaticStac(
  connection: StacConnection,
  options: StacSearchOptions,
  fetcher: FetchLike = fetch,
): Promise<StacSearchResult> {
  const queue: Array<{ url: string; document?: Record<string, unknown> }> = [
    { url: connection.url, document: connection.root },
  ];
  const visited = new Set<string>();
  const items: StacItem[] = [];
  const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
  while (queue.length && visited.size < 300 && items.length < limit) {
    const current = queue.shift()!;
    if (visited.has(current.url)) continue;
    visited.add(current.url);
    const document =
      current.document ??
      ((await fetchJson(current.url, { signal: options.signal }, fetcher)) as Record<
        string,
        unknown
      >);
    if (document.type === "Feature") {
      const item = normalizeItem(document as unknown as StacItem, current.url);
      // itemBbox flattens 3D (6-element) bboxes; item.bbox[2]/[3] would be minZ/maxX there.
      const bbox = itemBbox(item);
      if (
        (!options.collections?.length ||
          (item.collection && options.collections.includes(item.collection))) &&
        (!options.bbox || (bbox && intersects(bbox, options.bbox))) &&
        inTime(item, options.datetime)
      ) {
        items.push(item);
      }
      continue;
    }
    for (const link of linksOf(document.links, current.url)) {
      if (link.rel === "item" || link.rel === "child") queue.push({ url: link.href });
    }
  }
  return { items, matched: items.length };
}

export function itemBbox(item: StacItem): [number, number, number, number] | undefined {
  if (item.bbox?.length && item.bbox.length >= 4) {
    return [
      item.bbox[0],
      item.bbox[1],
      item.bbox[item.bbox.length / 2],
      item.bbox[item.bbox.length / 2 + 1],
    ];
  }
  return undefined;
}

export function isVisualizableAsset(asset: StacAsset): boolean {
  const value = `${asset.type ?? ""} ${asset.href}`.toLowerCase();
  return (
    value.includes("geotiff") ||
    /\.tiff?($|\?)/i.test(asset.href) ||
    value.includes("geo+json") ||
    /\.geojson($|\?)/i.test(asset.href)
  );
}
