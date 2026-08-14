/**
 * Client for **OGC API - Features** services (the successor to WFS).
 *
 * A service is a tree of JSON documents rooted at a landing page: `/collections`
 * lists the feature collections, and `/collections/{id}/items` returns GeoJSON.
 * Unlike WFS there is no capabilities document and no output-format negotiation
 * to guess at — GeoJSON is the mandated encoding — but responses are **paged**:
 * a server answers with at most its own page size and advertises a `next` link,
 * so a naive single request commonly yields only the first 10 features.
 *
 * This module owns the three things the Add Data source needs:
 *
 * - {@link parseOgcFeaturesUrl}, which accepts whatever URL the user has in
 *   hand (landing page, `/collections`, a collection, or a full `/items` URL,
 *   which is what a service's HTML browser puts in the address bar) and splits
 *   it into a base URL plus collection id.
 * - {@link fetchOgcFeatureCollections}, the collection picker's list.
 * - {@link fetchOgcFeatureItems}, which follows `next` links until the
 *   requested feature count is reached and reports whether more remain.
 */

import type { Feature, FeatureCollection } from "geojson";
import { fetchOgcJson } from "./ogc-json";

/** Default number of features an Add OGC API - Features request asks for. */
export const DEFAULT_OGC_FEATURES_MAX_FEATURES = 1000;

/**
 * `metadata.sourceKind` tag carried by layers added from an OGC API - Features
 * collection. `layer-refresh` keys off it to replay the paged items walk instead
 * of re-fetching only the stored first page.
 */
export const OGC_FEATURES_SOURCE_KIND = "ogc-features-items";

/**
 * Features requested per page. Servers clamp `limit` to their own maximum (and
 * a few reject an oversized one outright), so ask for a conservative page and
 * let the `next` links carry the rest rather than betting on a large limit.
 */
const OGC_FEATURES_PAGE_SIZE = 1000;

/**
 * Safety net for the paging loop: a server whose `next` link always points at
 * another non-empty page (or at a page that never advances) cannot make this
 * fetch run forever. At the page size above this still allows far more features
 * than the max the dialog accepts.
 */
const MAX_ITEM_PAGES = 200;

/** Overall deadline shared by every request of one fetch, in milliseconds. */
const REQUEST_BUDGET_MS = 60_000;

/**
 * Query parameters this module sets itself. They are stripped from a pasted URL
 * so a copied `…/items?f=html&limit=10` cannot fight the request built on top of
 * it (which would otherwise return an HTML page, or silently cap the layer at
 * the pasted limit). Any other parameter — an API key, a service-specific
 * filter — is preserved and re-sent with every request.
 */
const OGC_ITEM_PARAMS: ReadonlySet<string> = new Set([
  "f",
  "limit",
  "offset",
  "startindex",
  "bbox",
  "datetime",
]);

/** A service URL split into the parts the requests are built from. */
export interface OgcFeaturesEndpoint {
  /** The service base URL (its landing page), without a query or trailing slash. */
  baseUrl: string;
  /** The collection id read from a `/collections/{id}` URL, or `""` if none. */
  collectionId: string;
  /** Non-OGC query parameters from the pasted URL, re-sent with every request. */
  extraQuery: string;
}

/** A feature collection advertised by a service's `/collections` document. */
export interface OgcFeaturesCollectionOption {
  /** The collection `id` — the path segment used to request its items. */
  id: string;
  /** The collection's human-readable `title`; falls back to the id. */
  title: string;
}

/** A resolved items request. */
export interface OgcFeaturesRequest {
  baseUrl: string;
  collectionId: string;
  extraQuery?: string;
  /** Upper bound on features to load across all pages. */
  maxFeatures: number;
  /** Optional `west,south,east,north` filter (CRS84). */
  bbox?: string;
  /** Optional RFC 3339 instant or interval for the `datetime` filter. */
  datetime?: string;
}

/** The outcome of an items fetch. */
export interface OgcFeaturesResult {
  /** The loaded features, capped at the request's `maxFeatures`. */
  data: FeatureCollection;
  /** The first page's request URL, persisted so the layer can be refreshed. */
  url: string;
  /** The server's `numberMatched` for the query, when it advertises one. */
  numberMatched?: number;
  /** True when the collection holds more features than were loaded. */
  truncated: boolean;
  /** How many pages were fetched (1 when the server returned everything). */
  pages: number;
}

/**
 * Appends query parameters to a URL that has none of its own, merging in the
 * endpoint's preserved parameters. The built-in parameters win, so a stray
 * `f=html` carried over from a pasted URL can never override `f=json`.
 */
function withQuery(url: string, extraQuery: string, params: Array<[string, string]>): string {
  const search = new URLSearchParams(extraQuery);
  for (const [key, value] of params) search.set(key, value);
  const query = search.toString();
  return query ? `${url}?${query}` : url;
}

/**
 * Splits a user-entered OGC API - Features URL into a base URL and (when the
 * URL points at one) a collection id.
 *
 * Everything from `https://example.com/ogcapi` down to
 * `https://example.com/ogcapi/collections/parking/items?f=json&limit=10` is
 * accepted, because all of them are URLs a user plausibly has in hand: the
 * service's own HTML browser navigates to the deepest form. The path is cut at
 * the last `collections` segment, so a service that happens to be mounted under
 * a path containing that word still resolves against its real base.
 *
 * @param input - The service URL as entered.
 * @returns The base URL, collection id (or `""`), and preserved query.
 * @throws If the input is empty or is not an absolute http(s) URL.
 */
export function parseOgcFeaturesUrl(input: string): OgcFeaturesEndpoint {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Enter an OGC API - Features service URL.");
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(
      "Enter an absolute OGC API - Features service URL, starting with http or https.",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      "Enter an absolute OGC API - Features service URL, starting with http or https.",
    );
  }

  for (const key of Array.from(url.searchParams.keys())) {
    if (OGC_ITEM_PARAMS.has(key.toLowerCase())) url.searchParams.delete(key);
  }

  // Path segments stay percent-encoded here: they are re-joined into the base
  // URL as-is, and only the collection id is decoded (it is shown in the form
  // and re-encoded when the items URL is built).
  const segments = url.pathname.split("/").filter(Boolean);
  const index = segments.lastIndexOf("collections");
  let collectionId = "";
  if (index !== -1) {
    const candidate = segments[index + 1];
    // `/collections` alone lists them all; `/collections/{id}/items` names one.
    if (candidate && candidate !== "items") {
      try {
        collectionId = decodeURIComponent(candidate);
      } catch {
        collectionId = candidate;
      }
    }
    segments.length = index;
  }

  const path = segments.length > 0 ? `/${segments.join("/")}` : "";
  return {
    baseUrl: `${url.origin}${path}`,
    collectionId,
    extraQuery: url.searchParams.toString(),
  };
}

/**
 * Builds the `/collections` request URL for a service.
 *
 * @param endpoint - The parsed service endpoint.
 * @returns The collections document URL.
 */
export function createOgcCollectionsUrl(
  endpoint: Pick<OgcFeaturesEndpoint, "baseUrl" | "extraQuery">,
): string {
  return withQuery(`${endpoint.baseUrl}/collections`, endpoint.extraQuery ?? "", [["f", "json"]]);
}

/**
 * Builds an `/items` request URL for one collection.
 *
 * @param request - The collection, page size, and optional bbox/datetime filters.
 * @returns The items request URL.
 */
export function createOgcItemsUrl(request: {
  baseUrl: string;
  collectionId: string;
  extraQuery?: string;
  limit?: number;
  bbox?: string;
  datetime?: string;
}): string {
  const params: Array<[string, string]> = [["f", "json"]];
  if (request.limit !== undefined) params.push(["limit", String(request.limit)]);
  if (request.bbox) params.push(["bbox", request.bbox]);
  if (request.datetime) params.push(["datetime", request.datetime]);
  const path = `${request.baseUrl}/collections/${encodeURIComponent(request.collectionId)}/items`;
  return withQuery(path, request.extraQuery ?? "", params);
}

/**
 * Reads the feature collections from a `/collections` document, in document
 * order and deduplicated by id.
 *
 * Collections whose `itemType` is present and not `"feature"` are skipped: a
 * service can publish coverage or record collections alongside feature ones,
 * and those have no `/items` GeoJSON to add as a layer. An absent `itemType`
 * means `"feature"` per the specification, so it is kept.
 *
 * @param doc - The parsed `/collections` document.
 * @returns The feature collections it advertises.
 * @throws If the document has no `collections` array.
 */
export function parseOgcCollections(doc: unknown): OgcFeaturesCollectionOption[] {
  const collections = (doc as { collections?: unknown } | null)?.collections;
  if (!Array.isArray(collections)) {
    throw new Error("The response is not an OGC API - Features collections document.");
  }
  const options: OgcFeaturesCollectionOption[] = [];
  const seen = new Set<string>();
  for (const entry of collections) {
    if (!entry || typeof entry !== "object") continue;
    const collection = entry as { id?: unknown; title?: unknown; itemType?: unknown };
    const id = typeof collection.id === "string" ? collection.id.trim() : "";
    if (!id || seen.has(id)) continue;
    if (typeof collection.itemType === "string" && collection.itemType !== "feature") continue;
    seen.add(id);
    const title = typeof collection.title === "string" ? collection.title.trim() : "";
    options.push({ id, title: title || id });
  }
  return options;
}

/**
 * The `next` page URL advertised by an items response, resolved against the URL
 * it came from.
 *
 * The link is only followed when it stays on the same origin as the request:
 * `next` is server-controlled and this client reaches it through the desktop
 * app's native HTTP path (which bypasses browser CORS), so a service must not
 * be able to redirect the paging loop at an unrelated host. `f=json` is
 * re-asserted for the few servers that emit a `next` without it.
 *
 * @param doc - The parsed items response.
 * @param currentUrl - The URL the response was fetched from.
 * @returns The next page URL, or null when there is none to follow.
 */
export function nextItemsPageUrl(doc: unknown, currentUrl: string): string | null {
  const links = (doc as { links?: unknown } | null)?.links;
  if (!Array.isArray(links)) return null;
  for (const entry of links) {
    if (!entry || typeof entry !== "object") continue;
    const link = entry as { rel?: unknown; href?: unknown; type?: unknown };
    if (link.rel !== "next" || typeof link.href !== "string" || !link.href.trim()) continue;
    // An `alternate`-style next link for HTML/CSV is not a page of this
    // response's encoding; only follow JSON (or an unlabelled) link.
    if (typeof link.type === "string" && link.type && !/\bjson\b/i.test(link.type)) continue;
    let next: URL;
    try {
      next = new URL(link.href, currentUrl);
    } catch {
      continue;
    }
    if (next.origin !== new URL(currentUrl).origin) continue;
    if (!next.searchParams.has("f")) next.searchParams.set("f", "json");
    return next.toString();
  }
  return null;
}

/** Narrows a parsed document to a GeoJSON FeatureCollection. */
function asFeatureCollection(doc: unknown): FeatureCollection {
  const value = doc as { type?: unknown; features?: unknown } | null;
  if (!value || value.type !== "FeatureCollection" || !Array.isArray(value.features)) {
    throw new Error("The response is not a GeoJSON FeatureCollection.");
  }
  return doc as FeatureCollection;
}

/**
 * Lists a service's feature collections.
 *
 * @param endpoint - The parsed service endpoint.
 * @param options - Optional abort signal.
 * @returns The collections the service advertises.
 */
export async function fetchOgcFeatureCollections(
  endpoint: Pick<OgcFeaturesEndpoint, "baseUrl" | "extraQuery">,
  options: { signal?: AbortSignal } = {},
): Promise<OgcFeaturesCollectionOption[]> {
  const doc = await fetchOgcJson(createOgcCollectionsUrl(endpoint), {
    signal: options.signal,
    context: "OGC API - Features collections",
  });
  return parseOgcCollections(doc);
}

/**
 * Fetches a collection's features, following the service's `next` links until
 * `maxFeatures` is reached (or the collection is exhausted).
 *
 * Every page shares one {@link REQUEST_BUDGET_MS} deadline rather than each
 * getting a fresh timeout, so a slow service cannot stack up N × 30s of hang
 * before the error surfaces.
 *
 * @param request - The collection to load and how much of it to load.
 * @param options - Optional abort signal.
 * @returns The loaded features, the first page's URL, and whether more remain.
 */
export async function fetchOgcFeatureItems(
  request: OgcFeaturesRequest,
  options: { signal?: AbortSignal } = {},
): Promise<OgcFeaturesResult> {
  const maxFeatures = Math.max(1, Math.floor(request.maxFeatures));
  const firstUrl = createOgcItemsUrl({
    ...request,
    limit: Math.min(maxFeatures, OGC_FEATURES_PAGE_SIZE),
  });

  const budget = AbortSignal.timeout(REQUEST_BUDGET_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, budget]) : budget;

  const features: Feature[] = [];
  // Guards a service whose `next` link points back at a page already read,
  // which would otherwise cycle until the page cap.
  const visited = new Set<string>();
  let numberMatched: number | undefined;
  let pages = 0;
  let nextUrl: string | null = firstUrl;

  while (nextUrl && features.length < maxFeatures && pages < MAX_ITEM_PAGES) {
    if (visited.has(nextUrl)) {
      nextUrl = null;
      break;
    }
    visited.add(nextUrl);
    const doc = await fetchOgcJson(nextUrl, {
      signal,
      context: "OGC API - Features items",
    });
    const page = asFeatureCollection(doc);
    pages += 1;
    if (numberMatched === undefined) {
      const matched = (doc as { numberMatched?: unknown }).numberMatched;
      if (typeof matched === "number" && Number.isFinite(matched)) numberMatched = matched;
    }
    features.push(...page.features);
    // Many services advertise a `next` link even on the final page, so an empty
    // page — not the absence of a link — is what ends the walk.
    nextUrl = page.features.length === 0 ? null : nextItemsPageUrl(doc, nextUrl);
  }

  const loaded = features.length > maxFeatures ? features.slice(0, maxFeatures) : features;
  return {
    data: { type: "FeatureCollection", features: loaded },
    url: firstUrl,
    numberMatched,
    // `numberMatched` is the authoritative count when advertised; otherwise fall
    // back to "we stopped with a page still pending".
    truncated:
      numberMatched !== undefined
        ? loaded.length < numberMatched
        : features.length > maxFeatures || nextUrl !== null,
    pages,
  };
}
