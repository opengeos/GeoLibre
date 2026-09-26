import type { FeatureCollection, Position } from "geojson";
import type { ArcGisHubItem, ArcGisHubSearchResult } from "./arcgis-hub-api";

export const SOCRATA_CATALOG_API_URL = "https://api.us.socrata.com/api/catalog/v1";
// A dataset is added as its GeoJSON export, which Socrata pages; one request
// is capped here so a city-wide incident log cannot stall the map.
export const SOCRATA_GEOJSON_LIMIT = 50000;
// The catalog cannot filter by column type, so non-spatial tables are dropped
// client-side. Each request reads this many entries, and a search keeps reading
// until it has a page's worth of spatial ones or has read this many batches.
const SCAN_BATCH = 100;
const MAX_SCAN_BATCHES = 5;
// Column types whose values the GeoJSON export turns into geometries.
const GEOMETRY_TYPES = new Set([
  "point",
  "multipoint",
  "line",
  "multiline",
  "polygon",
  "multipolygon",
  "location",
]);
// Socrata dataset ids ("four-by-four") are two groups of four characters.
const DATASET_ID_RE = /^[a-z0-9]{4}-[a-z0-9]{4}$/;
const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

interface SocrataCatalogEntry {
  resource?: {
    id?: string;
    name?: string;
    description?: string;
    attribution?: string;
    columns_datatype?: unknown;
  };
  metadata?: { domain?: string };
  classification?: { domain_category?: string };
}

/**
 * Tell whether a string is a bare hostname a Socrata catalog can be scoped to.
 *
 * Args:
 *   domain: The candidate hostname.
 *
 * Returns:
 *   True for a lowercase hostname without scheme, port, or path.
 */
export function isSocrataDomain(domain: string): boolean {
  return HOSTNAME_RE.test(domain);
}

/**
 * Build the Discovery API URL for one batch of a portal's datasets.
 *
 * `search_context` is what makes the API list a portal's own catalog: without
 * it, `domains` alone misses the datasets a portal shares only in context.
 *
 * Args:
 *   domain: The portal's hostname.
 *   query: The keyword; empty to browse the whole catalog by name.
 *   offset: How many catalog entries to skip.
 *   limit: How many entries to read.
 *
 * Returns:
 *   The request URL.
 */
export function buildSocrataCatalogUrl(
  domain: string,
  query: string,
  offset: number,
  limit = SCAN_BATCH,
): string {
  const url = new URL(SOCRATA_CATALOG_API_URL);
  url.searchParams.set("search_context", domain);
  url.searchParams.set("domains", domain);
  url.searchParams.set("only", "dataset");
  const text = query.trim();
  if (text) url.searchParams.set("q", text);
  else url.searchParams.set("order", "name");
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("limit", String(limit));
  return url.href;
}

/**
 * Turn one catalog entry into a result card, if it is a spatial dataset of
 * the portal.
 *
 * The data and page URLs are built from the configured domain rather than
 * taken from the response, so a federated or malformed entry cannot point
 * the panel at another host.
 */
function toItem(entry: SocrataCatalogEntry, domain: string): ArcGisHubItem | null {
  const resource = entry.resource;
  const id = resource?.id;
  if (!resource || !id || !DATASET_ID_RE.test(id)) return null;
  // Federated entries belong to another portal; the catalog lists its own.
  if (entry.metadata?.domain !== domain) return null;
  const columnTypes = Array.isArray(resource.columns_datatype) ? resource.columns_datatype : [];
  const spatial = columnTypes.some(
    (type) => typeof type === "string" && GEOMETRY_TYPES.has(type.toLowerCase()),
  );
  if (!spatial) return null;
  return {
    id,
    title: resource.name || id,
    owner: entry.classification?.domain_category || resource.attribution || domain,
    type: "GeoJson",
    snippet: resource.description || undefined,
    dataUrl: `https://${domain}/resource/${id}.geojson?$limit=${SOCRATA_GEOJSON_LIMIT}`,
    pageUrl: `https://${domain}/d/${id}`,
  };
}

/**
 * Search one Socrata portal for spatial datasets.
 *
 * The result follows the ArcGIS Hub search contract so the Hub panel can page
 * it: `nextStart` is the catalog offset to continue from (0 when the catalog
 * is exhausted), and `total` is only an upper bound, since it counts the
 * non-spatial tables the scan drops.
 *
 * Args:
 *   domain: The portal's hostname.
 *   query: The keyword; empty to browse the catalog by name.
 *   options: `start` (1-based catalog offset, as Hub pages), `num` (how many
 *     spatial datasets to aim for), and an abort `signal`.
 *
 * Returns:
 *   The spatial datasets found, the catalog size, and where to continue.
 */
export async function searchSocrataCatalog(
  domain: string,
  query: string,
  options: { start?: number; num?: number; signal?: AbortSignal } = {},
): Promise<ArcGisHubSearchResult> {
  if (!isSocrataDomain(domain)) throw new Error(`Invalid Socrata domain: ${domain}`);
  const wanted = options.num ?? 20;
  let offset = Math.max(0, (options.start ?? 1) - 1);
  let total = 0;
  const results: ArcGisHubItem[] = [];
  for (let batch = 0; batch < MAX_SCAN_BATCHES && results.length < wanted; batch += 1) {
    const response = await fetch(buildSocrataCatalogUrl(domain, query, offset), {
      signal: options.signal,
    });
    if (!response.ok) throw new Error(`Socrata search failed with ${response.status}.`);
    const payload = (await response.json()) as {
      resultSetSize?: number;
      results?: SocrataCatalogEntry[];
      error?: string;
    };
    if (payload.error) throw new Error(`Socrata search failed: ${payload.error}`);
    if (!Array.isArray(payload.results)) throw new Error("Socrata returned an invalid response.");
    total = payload.resultSetSize ?? 0;
    for (const entry of payload.results) {
      const item = toItem(entry, domain);
      if (item) results.push(item);
    }
    offset += payload.results.length;
    if (payload.results.length === 0 || offset >= total) {
      return { results, total, nextStart: 0 };
    }
  }
  return { results, total, nextStart: offset + 1 };
}

/**
 * Compute the bounding box of a feature collection's coordinates.
 *
 * Args:
 *   data: The features to measure.
 *
 * Returns:
 *   `[west, south, east, north]`, or null when no feature has a geometry.
 */
export function featureCollectionBounds(
  data: FeatureCollection,
): [number, number, number, number] | null {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  const visit = (coordinates: unknown): void => {
    if (!Array.isArray(coordinates)) return;
    if (typeof coordinates[0] === "number") {
      const [x, y] = coordinates as Position;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      west = Math.min(west, x);
      east = Math.max(east, x);
      south = Math.min(south, y);
      north = Math.max(north, y);
      return;
    }
    coordinates.forEach(visit);
  };
  for (const feature of data.features) {
    const geometry = feature?.geometry;
    if (!geometry) continue;
    if (geometry.type === "GeometryCollection") {
      geometry.geometries.forEach((part) => "coordinates" in part && visit(part.coordinates));
    } else {
      visit(geometry.coordinates);
    }
  }
  return Number.isFinite(west) ? [west, south, east, north] : null;
}
