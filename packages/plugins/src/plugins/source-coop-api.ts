/**
 * Source Cooperative (https://source.coop) API client.
 *
 * Source Cooperative is Radiant Earth's public repository of cloud-native
 * geospatial data. It hosts a lot of GeoParquet, PMTiles, and COG, all served
 * from `data.source.coop` with `Access-Control-Allow-Origin: *` and byte-range
 * support — so the *data* can be read straight from the browser by MapLibre's
 * PMTiles protocol, DuckDB-WASM, or a COG reader, with no proxy in between.
 *
 * The *metadata* API is the awkward part, and shapes most of this module:
 *
 *  1. `source.coop/api/v1` sends **no CORS headers at all**, so a browser
 *     cannot call it directly. The desktop app fetches it over Tauri's native
 *     HTTP (no CORS); the web/dev/embed builds go through the `/source-coop`
 *     route on the tiles Worker, which re-emits the JSON with CORS. This
 *     mirrors what `openaerialmap-api.ts` does for the OAM `/meta` API.
 *
 *  2. **There is no public search endpoint.** Source Cooperative's own site
 *     searches via a Next.js Server Action (a per-build, non-addressable RPC),
 *     not REST. `GET /api/v1/products?search=…` does not exist — unknown
 *     `/api/v1` paths fall through to the site's page catch-all and return an
 *     HTML 404 body with **status 200**, which is why every read here checks
 *     the parsed shape rather than trusting `response.ok`.
 *
 *     So search is assembled client-side from the three public listings that
 *     do exist — the RSS feed (50 newest), `/products/featured` (10), and
 *     `/products/{account_id}` (one account, unpaginated) — and filtered in
 *     `filterProducts`. A query of the form `account/product` is resolved
 *     directly against `/products/{account_id}/{product_id}` instead, so any
 *     product is still reachable by id even when it is outside the catalog.
 *
 * Files are enumerated with S3 ListObjectsV2 against `data.source.coop`, where
 * the **account is the bucket** and the product is a key prefix. Two quirks
 * that the URL builder exists to hide: `/{account}/` with a trailing slash is
 * a `NoSuchBucket` 404, and `/{account}/{product}/{sub}/?list-type=2` is an
 * `InvalidRequest` 400 — subfolders must be addressed as `?prefix=`, not as a
 * path. Returned `<Key>` values are relative to the account and already
 * include `{product_id}/`.
 *
 * This module is deliberately DOM-free and framework-free so it can be unit
 * tested under `node --test`; everything that touches the map or the document
 * lives in `maplibre-source-coop.ts`.
 */

/** The Source Cooperative website (used for human-facing product links). */
export const SOURCE_COOP_SITE = "https://source.coop";

/**
 * A product's page on source.coop — the human-facing link, not the data URL
 * (that is `buildObjectUrl`, on a different host).
 */
export function productUrl(accountId: string, productId: string): string {
  return `${SOURCE_COOP_SITE}/${accountId}/${productId}`;
}

/** The metadata API. Not reachable from a browser: it sends no CORS headers. */
export const SOURCE_COOP_API_BASE = "https://source.coop/api/v1";

/** The data proxy. CORS-enabled and range-capable, so browser-readable. */
export const SOURCE_COOP_DATA_BASE = "https://data.source.coop";

/** The tiles Worker route that re-emits the metadata API with CORS. */
export const SOURCE_COOP_PROXY_ENDPOINT = "https://tiles.geolibre.app/source-coop";

/** S3 page size for a file listing. The proxy's own ceiling is 1000. */
export const SOURCE_COOP_LIST_MAX_KEYS = 200;

/** One product (a dataset) on Source Cooperative. */
export interface SourceCoopProduct {
  /** Owning account, e.g. `protomaps`. Doubles as the S3 bucket name. */
  accountId: string;
  /** Product slug, e.g. `openstreetmap`. Doubles as the S3 key prefix. */
  productId: string;
  title: string;
  description: string;
  /** From `metadata.tags`; empty when the product declares none. */
  tags: string[];
  /** ISO timestamp, or null when the source did not report one. */
  updatedAt: string | null;
  /** Whether Source Cooperative flags this product as featured. */
  featured: boolean;
  /** The product's page on source.coop. */
  url: string;
}

/**
 * A data format GeoLibre can act on. Everything GeoLibre cannot render is
 * `other` and offers download only.
 */
export type SourceCoopFormat =
  | "pmtiles"
  | "geoparquet"
  | "cog"
  | "geojson"
  | "flatgeobuf"
  | "gpkg"
  | "csv"
  | "other";

/** One file in a product. */
export interface SourceCoopObject {
  /** S3 key, relative to the account — it already includes `{productId}/`. */
  key: string;
  /** Trailing path segment, for display. */
  name: string;
  /** Size in bytes. */
  size: number;
  /** ISO timestamp, or null when absent. */
  lastModified: string | null;
  format: SourceCoopFormat;
  /** Absolute, browser-fetchable URL on `data.source.coop`. */
  url: string;
}

/** One page of a product's file listing. */
export interface SourceCoopListing {
  objects: SourceCoopObject[];
  /** Subfolder prefixes (S3 `CommonPrefixes`), relative to the account. */
  folders: string[];
  /** Cursor for the next page, or null when the listing is complete. */
  nextToken: string | null;
}

/**
 * Minimal fetch shape, so tests can stub the network without a DOM. Mirrors
 * `OamFetch` in `openaerialmap-api.ts`.
 */
export type SourceCoopFetch = (
  url: string,
  signal?: AbortSignal,
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

const defaultFetch: SourceCoopFetch = (url, signal) =>
  fetch(url, signal ? { signal } : undefined);

/** Guards a value before it reaches an `<a href>` or a map source. */
export const HTTP_URL_RE = /^https?:\/\//i;

/** `account/product`, the id form a user can paste into the search box. */
const PRODUCT_REF_RE = /^([a-z0-9][a-z0-9-_.]*)\/([a-z0-9][a-z0-9-_.]*)\/?$/i;

/**
 * Splits `account/product` out of a query string, or returns null when the
 * query is free text. Lets the panel resolve an exact product by id even
 * though no search endpoint exists (see the module comment).
 */
export function parseProductRef(
  query: string,
): { accountId: string; productId: string } | null {
  const match = PRODUCT_REF_RE.exec(query.trim());
  return match ? { accountId: match[1], productId: match[2] } : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Normalizes one raw `/products/*` record. Returns null when the record has no
 * usable identity, which is also how the HTML-404 body (see the module
 * comment) gets rejected: it parses as JSON-less text upstream, and any object
 * that survives without `account_id`/`product_id` is not a product.
 */
export function parseProduct(raw: unknown): SourceCoopProduct | null {
  const record = asRecord(raw);
  const accountId = asString(record.account_id);
  const productId = asString(record.product_id);
  if (!accountId || !productId) return null;
  // `disabled` products and non-public ones are filtered out: their data is
  // not anonymously readable, so offering them would only produce 403s.
  if (record.disabled === true) return null;
  const visibility = asString(record.visibility);
  if (visibility && visibility !== "public") return null;

  const metadata = asRecord(record.metadata);
  const rawTags = metadata.tags;
  const tags = Array.isArray(rawTags)
    ? rawTags.filter((tag): tag is string => typeof tag === "string")
    : [];

  return {
    accountId,
    productId,
    title: asString(record.title) || productId,
    description: asString(record.description),
    tags,
    updatedAt: asString(record.updated_at) || null,
    // `featured` is a *number* in the API (a rank), not a boolean.
    featured: typeof record.featured === "number" && record.featured > 0,
    url: productUrl(accountId, productId),
  };
}

/**
 * Builds a product record from an id alone, without touching the network.
 *
 * A product's *files* are listed straight off `data.source.coop` from the
 * account and product id (see `buildListObjectsUrl`), so a panel pinned to a
 * known product needs no metadata read to be useful — and this keeps it working
 * when the metadata API, or the Worker proxy in front of it, is unreachable.
 * The fields the API would supply are left empty for a later `fetchProduct` to
 * fill in.
 */
export function synthesizeProduct(
  accountId: string,
  productId: string,
  title: string,
): SourceCoopProduct {
  return {
    accountId,
    productId,
    title,
    description: "",
    tags: [],
    updatedAt: null,
    featured: false,
    url: productUrl(accountId, productId),
  };
}

/**
 * Normalizes a `/products/featured` or `/products/{account}` body, which wrap
 * the array in `{ products: [...] }`. A bare array is also accepted.
 */
export function parseProductList(body: unknown): SourceCoopProduct[] {
  const raw = Array.isArray(body) ? body : asRecord(body).products;
  if (!Array.isArray(raw)) return [];
  return raw
    .map(parseProduct)
    .filter((product): product is SourceCoopProduct => product !== null);
}

/** Unescapes the five XML entities that can appear in RSS/S3 text nodes. */
function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Reads the first `<tag>` text node out of an XML fragment. The responses
 * parsed here (RSS, S3 ListObjectsV2) are small, flat, and machine-generated,
 * so a scoped regex is enough — and it keeps this module DOM-free, which
 * `DOMParser` would not (it does not exist under `node --test`).
 */
function xmlTag(fragment: string, tag: string): string {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(fragment);
  return match ? decodeXml(match[1]).trim() : "";
}

function xmlBlocks(xml: string, tag: string): string[] {
  return xml.match(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "g")) ?? [];
}

/**
 * Parses `source.coop/feed.xml` (the 50 newest public products) into products.
 * The feed carries no tags and no account/product fields, so identity is
 * recovered from each `<link>`; entries whose link is not a product URL (the
 * channel's own link, say) are dropped.
 */
export function parseFeed(xml: string): SourceCoopProduct[] {
  const products: SourceCoopProduct[] = [];
  for (const item of xmlBlocks(xml, "item")) {
    const link = xmlTag(item, "link");
    const path = link.startsWith(`${SOURCE_COOP_SITE}/`)
      ? link.slice(SOURCE_COOP_SITE.length + 1)
      : "";
    const ref = parseProductRef(path);
    if (!ref) continue;
    const pubDate = xmlTag(item, "pubDate");
    const parsedDate = pubDate ? new Date(pubDate) : null;
    products.push({
      accountId: ref.accountId,
      productId: ref.productId,
      title: xmlTag(item, "title") || ref.productId,
      description: xmlTag(item, "description"),
      tags: [],
      updatedAt:
        parsedDate && !Number.isNaN(parsedDate.getTime())
          ? parsedDate.toISOString()
          : null,
      featured: false,
      url: productUrl(ref.accountId, ref.productId),
    });
  }
  return products;
}

/**
 * Extension → format, first match wins. The patterns are mutually exclusive, so
 * the order is presentational rather than load-bearing. Note `.geo.json` needs
 * its own rule: the `geojson` alternative below requires that literal token, so
 * it does not match a `.geo.json` suffix.
 */
const FORMAT_BY_EXTENSION: [RegExp, SourceCoopFormat][] = [
  [/\.pmtiles$/i, "pmtiles"],
  [/\.(geo)?parquet$/i, "geoparquet"],
  [/\.(tif|tiff)$/i, "cog"],
  [/\.(geojson|geojsonl|ndjson)$/i, "geojson"],
  [/\.geo\.json$/i, "geojson"],
  [/\.fgb$/i, "flatgeobuf"],
  [/\.gpkg$/i, "gpkg"],
  [/\.csv$/i, "csv"],
];

/**
 * Classifies a key by extension. Extension-based because a `HEAD` per file
 * would cost one request per row, and Source Cooperative's content types are
 * mostly `application/octet-stream` anyway.
 */
export function classifyKey(key: string): SourceCoopFormat {
  for (const [pattern, format] of FORMAT_BY_EXTENSION) {
    if (pattern.test(key)) return format;
  }
  return "other";
}

/**
 * Which reader puts a format on the map — the one fact both {@link isAddable}
 * and {@link usesDuckDB} are really asking about:
 *
 * - `duckdb` — read through the vector control, so DuckDB-WASM's limits apply
 *   (see {@link isTooLargeToOpen}).
 * - `range` — has its own range-request reader (MapLibre's PMTiles protocol, a
 *   COG reader). Streams by nature, and none of the DuckDB limits apply.
 * - `none` — GeoLibre cannot render it; download only.
 *
 * One `Record` over the whole union rather than a set per question: adding a
 * member to {@link SourceCoopFormat} then fails to compile until it is
 * classified here, so a new format cannot silently inherit the wrong reader's
 * size rules. Deriving one set from the other would not hold — "addable" and
 * "goes through DuckDB" are independent facts about a format, and treating
 * DuckDB as everything-but-PMTiles/COG would quietly subject the next
 * range-request format to a 2 GiB gate that does not apply to it.
 */
const FORMAT_READER: Record<SourceCoopFormat, "duckdb" | "range" | "none"> = {
  pmtiles: "range",
  cog: "range",
  geoparquet: "duckdb",
  geojson: "duckdb",
  flatgeobuf: "duckdb",
  gpkg: "duckdb",
  csv: "duckdb",
  other: "none",
};

/** Whether GeoLibre can put a format on the map (the rest are download-only). */
export function isAddable(format: SourceCoopFormat): boolean {
  return FORMAT_READER[format] !== "none";
}

/** How a vector file is read into DuckDB. Mirrors `IngestMode` in maplibre-gl-vector. */
export type SourceCoopIngestMode = "table" | "stream";

/** Whether a format reaches the map through the vector control, and so DuckDB-WASM. */
export function usesDuckDB(format: SourceCoopFormat): boolean {
  return FORMAT_READER[format] === "duckdb";
}

/**
 * Whether a file can be queried in place rather than copied into DuckDB.
 * GeoParquet only: the vector control ignores `stream` for every other format
 * and quietly falls back to a copy, so offering the choice elsewhere would be a
 * button that does nothing different.
 */
export function canStream(format: SourceCoopFormat): boolean {
  return format === "geoparquet";
}

/**
 * Largest remote file DuckDB-WASM can open, mirroring `MAX_REMOTE_FILE_BYTES`
 * in maplibre-gl-vector. Duplicated rather than imported because the constant
 * is internal to that package; {@link isTooLargeToOpen} explains why this
 * module needs to know it.
 */
export const MAX_VECTOR_BYTES = 2 ** 31 - 1;

/**
 * PMTiles/COG at or above this size get a note that they stream rather than
 * download. Deliberately not applied to the DuckDB formats: those do not read
 * only the parts in view unless the user picks Stream, and at this size they do
 * not open at all.
 */
export const LARGE_FILE_BYTES = 2 * 1024 ** 3;

/**
 * GeoParquet at or above this size gets a note nudging toward Stream. A copy
 * materializes into the WASM heap and memory roughly tracks the *decompressed*
 * dataset — several times a Parquet's on-disk size — which is where a large
 * file runs the tab out of memory. Below this a copy is cheap enough that the
 * nudge would be noise; the Stream button is still offered.
 */
export const STREAM_HINT_BYTES = 100 * 1024 ** 2;

/**
 * Whether the browser cannot open a file at all, at either ingest mode.
 *
 * DuckDB-WASM's HTTP filesystem holds remote file sizes in 32 bits, so it
 * rejects anything of 2 GiB or more — and it rejects it *before* the ingest
 * mode is consulted (`_registerSource` runs ahead of the stream branch in
 * maplibre-gl-vector's DuckDBEngine), so streaming does not get past this.
 * Knowing the limit lets the panel say so up front instead of offering an Add
 * that is certain to fail.
 */
export function isTooLargeToOpen(object: SourceCoopObject): boolean {
  return usesDuckDB(object.format) && object.size > MAX_VECTOR_BYTES;
}

/**
 * Which advisory line a file's card should carry, if any. The cases are
 * mutually exclusive and turn on format, because "large" means something
 * different per reader: a PMTiles/COG of any size really does read only the
 * parts in view, a DuckDB-format file past the 2 GiB limit cannot be opened at
 * either mode, and a big GeoParquet has a real choice to make.
 *
 * Returns the decision only — the panel owns the wording (see
 * `SourceCoopLabels`), which keeps this module DOM- and i18n-free.
 */
export type SourceCoopNote = "none" | "streams" | "streamChoice" | "tooLarge";

export function objectNote(object: SourceCoopObject): SourceCoopNote {
  if (!isAddable(object.format)) return "none";
  if (isTooLargeToOpen(object)) return "tooLarge";
  if (!usesDuckDB(object.format)) {
    return object.size >= LARGE_FILE_BYTES ? "streams" : "none";
  }
  if (canStream(object.format) && object.size >= STREAM_HINT_BYTES) {
    return "streamChoice";
  }
  return "none";
}

/**
 * Builds the browser-fetchable URL for a key. `key` is account-relative and
 * already carries the product prefix, so it is *not* repeated here.
 *
 * Each segment is encoded individually: keys legitimately contain `/`, and
 * Source Cooperative's Hive-partitioned products contain `=` (for example
 * `country_iso=AFG/AFG.pmtiles`), which must survive intact.
 */
export function buildObjectUrl(accountId: string, key: string): string {
  const path = key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${SOURCE_COOP_DATA_BASE}/${encodeURIComponent(accountId)}/${path}`;
}

/**
 * Builds an S3 ListObjectsV2 URL for a product or one of its subfolders.
 *
 * Addressed as `bucket=account` + `?prefix=`, never as a subfolder path, and
 * never with a trailing slash after the account — both of those are errors on
 * the Source Cooperative proxy (see the module comment).
 */
export function buildListObjectsUrl(options: {
  accountId: string;
  /** Account-relative prefix, e.g. `openstreetmap/tiles/`. */
  prefix: string;
  /** Continuation cursor from a previous page. */
  token?: string | null;
  maxKeys?: number;
  /** Set false to list every key beneath the prefix instead of one level. */
  delimited?: boolean;
}): string {
  // Encoded like buildObjectUrl's account segment: `accountId` comes from
  // unvalidated API/feed text, so a `#` or `?` in it would otherwise silently
  // truncate the path here.
  const url = new URL(
    `${SOURCE_COOP_DATA_BASE}/${encodeURIComponent(options.accountId)}`,
  );
  url.searchParams.set("list-type", "2");
  url.searchParams.set("prefix", options.prefix);
  url.searchParams.set(
    "max-keys",
    String(options.maxKeys ?? SOURCE_COOP_LIST_MAX_KEYS),
  );
  if (options.delimited !== false) url.searchParams.set("delimiter", "/");
  // URLSearchParams percent-encodes the token's `+`, `/` and `=` for us.
  if (options.token) url.searchParams.set("continuation-token", options.token);
  return url.href;
}

/**
 * Parses an S3 ListObjectsV2 XML body. Zero-byte keys ending in `/` are the
 * folder placeholder objects some tools write; they are dropped so they do not
 * show up as empty files next to the real `CommonPrefixes` folders.
 */
export function parseListObjects(
  xml: string,
  accountId: string,
): SourceCoopListing {
  const objects: SourceCoopObject[] = [];
  for (const block of xmlBlocks(xml, "Contents")) {
    const key = xmlTag(block, "Key");
    if (!key || key.endsWith("/")) continue;
    const size = Number(xmlTag(block, "Size"));
    const lastModified = xmlTag(block, "LastModified");
    objects.push({
      key,
      name: key.split("/").pop() ?? key,
      size: Number.isFinite(size) ? size : 0,
      lastModified: lastModified || null,
      format: classifyKey(key),
      url: buildObjectUrl(accountId, key),
    });
  }

  const folders: string[] = [];
  for (const block of xmlBlocks(xml, "CommonPrefixes")) {
    const prefix = xmlTag(block, "Prefix");
    if (prefix) folders.push(prefix);
  }

  return {
    objects,
    folders,
    nextToken:
      xmlTag(xml, "IsTruncated") === "true"
        ? xmlTag(xml, "NextContinuationToken") || null
        : null,
  };
}

/**
 * Ranks and filters a catalog against free-text `query`, matching the fields a
 * user would expect to search: title, description, account, product, and tags.
 *
 * This is the whole of "search" — see the module comment for why it has to be
 * client-side. Source Cooperative's own search is likewise a substring scan,
 * so this is not a downgrade in matching behaviour, only in corpus size.
 */
export function filterProducts(
  products: SourceCoopProduct[],
  query: string,
): SourceCoopProduct[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return products;
  const scored: { product: SourceCoopProduct; score: number }[] = [];

  for (const product of products) {
    const title = product.title.toLowerCase();
    const id = `${product.accountId}/${product.productId}`.toLowerCase();
    const haystack = [
      title,
      id,
      product.description.toLowerCase(),
      product.tags.join(" ").toLowerCase(),
    ].join("\n");

    // Every term must appear somewhere, so multi-word queries narrow rather
    // than widen (matching how a user reads a search box).
    if (!terms.every((term) => haystack.includes(term))) continue;

    // Rank title/id hits above description/tag hits so an exact-ish name match
    // does not sink below a product that merely mentions the word in prose.
    let score = 0;
    for (const term of terms) {
      if (title.includes(term)) score += 4;
      if (id.includes(term)) score += 3;
      if (product.tags.some((tag) => tag.toLowerCase().includes(term))) {
        score += 2;
      }
    }
    if (product.featured) score += 1;
    scored.push({ product, score });
  }

  return scored
    .sort((a, b) => b.score - a.score || a.product.title.localeCompare(b.product.title))
    .map((entry) => entry.product);
}

/** Merges catalog sources, preferring the richer record for a duplicate id. */
export function mergeProducts(
  ...groups: SourceCoopProduct[][]
): SourceCoopProduct[] {
  const byId = new Map<string, SourceCoopProduct>();
  for (const group of groups) {
    for (const product of group) {
      const id = `${product.accountId}/${product.productId}`;
      const existing = byId.get(id);
      // The feed carries no tags, `/products/*` does; prefer whichever record
      // actually has them so a merged entry never loses searchable text.
      if (
        !existing ||
        (existing.tags.length === 0 && product.tags.length > 0) ||
        (!existing.description && product.description)
      ) {
        byId.set(id, { ...existing, ...product });
      }
    }
  }
  return [...byId.values()];
}

/** Human-readable byte size, e.g. `1.1 GB`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** exponent;
  return `${value >= 100 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`;
}

/**
 * Reads a JSON body, rejecting the HTML-404 trap described in the module
 * comment: an unknown `/api/v1` path returns **status 200** with an HTML page,
 * so `response.ok` proves nothing and only a successful JSON parse does.
 */
async function readJson(
  fetchImpl: SourceCoopFetch,
  url: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetchImpl(url, signal);
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Source Cooperative request failed (${response.status})`);
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error("Source Cooperative returned an unexpected response");
  }
}

/**
 * Where the metadata API is read from. The desktop app passes the API base
 * directly (Tauri's native HTTP ignores CORS); web/dev/embed pass the Worker
 * proxy route. Both expose the same `/products/...` paths.
 */
export interface SourceCoopClientOptions {
  /** Defaults to the Worker proxy, the only origin a browser can use. */
  endpoint?: string;
  /**
   * Where the RSS feed is read from. The Worker exposes it under the same
   * prefix as the products routes (`{endpoint}/feed`, the default), but on the
   * real site it sits at `source.coop/feed.xml` — off the `/api/v1` base — so
   * the desktop's direct-fetch path has to override it.
   */
  feedUrl?: string;
  fetchImpl?: SourceCoopFetch;
  signal?: AbortSignal;
}

/** The RSS feed's real location, for callers that bypass the Worker proxy. */
export const SOURCE_COOP_FEED_URL = `${SOURCE_COOP_SITE}/feed.xml`;

function resolveEndpoint(options: SourceCoopClientOptions): string {
  return (options.endpoint ?? SOURCE_COOP_PROXY_ENDPOINT).replace(/\/+$/, "");
}

/** Fetches the 10 featured products. */
export async function fetchFeaturedProducts(
  options: SourceCoopClientOptions = {},
): Promise<SourceCoopProduct[]> {
  const body = await readJson(
    options.fetchImpl ?? defaultFetch,
    `${resolveEndpoint(options)}/products/featured`,
    options.signal,
  );
  return parseProductList(body);
}

/** Fetches every public product owned by one account. */
export async function fetchAccountProducts(
  accountId: string,
  options: SourceCoopClientOptions = {},
): Promise<SourceCoopProduct[]> {
  const body = await readJson(
    options.fetchImpl ?? defaultFetch,
    `${resolveEndpoint(options)}/products/${encodeURIComponent(accountId)}`,
    options.signal,
  );
  return parseProductList(body);
}

/** Fetches one product by id, or null when it does not exist or is private. */
export async function fetchProduct(
  accountId: string,
  productId: string,
  options: SourceCoopClientOptions = {},
): Promise<SourceCoopProduct | null> {
  try {
    const body = await readJson(
      options.fetchImpl ?? defaultFetch,
      `${resolveEndpoint(options)}/products/${encodeURIComponent(accountId)}/${encodeURIComponent(productId)}`,
      options.signal,
    );
    return parseProduct(body);
  } catch {
    return null;
  }
}

/** Fetches the 50 newest public products from the RSS feed. */
export async function fetchRecentProducts(
  options: SourceCoopClientOptions = {},
): Promise<SourceCoopProduct[]> {
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const response = await fetchImpl(
    options.feedUrl ?? `${resolveEndpoint(options)}/feed`,
    options.signal,
  );
  if (!response.ok) {
    throw new Error(`Source Cooperative request failed (${response.status})`);
  }
  const body = await response.text();
  // The HTML-404 trap again (see the module comment): an HTML body parses to
  // an empty product list perfectly happily, which would surface as "no
  // results" instead of "Source Cooperative is unreachable". Only a body that
  // is actually RSS is allowed to report zero products.
  if (!/<rss[\s>]/i.test(body)) {
    throw new Error("Source Cooperative returned an unexpected response");
  }
  return parseFeed(body);
}

/**
 * Builds the browsable catalog: the newest products plus the featured ones.
 * Both are fetched together and merged, so a featured product that has aged
 * out of the 50-item feed still appears. If one source fails the other is
 * still used — a partial catalog beats an empty panel.
 */
export async function fetchCatalog(
  options: SourceCoopClientOptions = {},
): Promise<SourceCoopProduct[]> {
  const [recent, featured] = await Promise.allSettled([
    fetchRecentProducts(options),
    fetchFeaturedProducts(options),
  ]);
  if (recent.status === "rejected" && featured.status === "rejected") {
    throw recent.reason instanceof Error
      ? recent.reason
      : new Error("Source Cooperative is unreachable");
  }
  return mergeProducts(
    featured.status === "fulfilled" ? featured.value : [],
    recent.status === "fulfilled" ? recent.value : [],
  );
}

/**
 * Lists one page of a product's files.
 *
 * `data.source.coop` is CORS-enabled, so this goes direct from the browser and
 * never through the metadata proxy.
 */
export async function listProductObjects(
  options: {
    accountId: string;
    /** Account-relative prefix; defaults to the product root. */
    prefix: string;
    token?: string | null;
    maxKeys?: number;
    delimited?: boolean;
  },
  fetchImpl: SourceCoopFetch = defaultFetch,
  signal?: AbortSignal,
): Promise<SourceCoopListing> {
  const response = await fetchImpl(buildListObjectsUrl(options), signal);
  const body = await response.text();
  if (!response.ok) {
    // The proxy reports failures as S3 XML; surface its code when present.
    const code = xmlTag(body, "Code");
    throw new Error(
      code
        ? `Source Cooperative listing failed (${code})`
        : `Source Cooperative listing failed (${response.status})`,
    );
  }
  return parseListObjects(body, options.accountId);
}
