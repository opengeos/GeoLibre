import type { FeatureCollection } from "geojson";

export const ARCGIS_HUB_PORTAL_URL = "https://www.arcgis.com";
export const ARCGIS_HUB_PAGE_URL = "https://hub.arcgis.com";

export interface ArcGisHubItem {
  id: string;
  title: string;
  owner: string;
  type: string;
  description?: string;
  snippet?: string;
  url?: string;
  extent?: [[number, number], [number, number]];
  thumbnail?: string;
}

export interface ArcGisHubSearchResult {
  results: ArcGisHubItem[];
  total: number;
  nextStart: number;
}

interface ArcGisErrorEnvelope {
  error?: { message?: string };
}

const SEARCH_TYPES = ["Feature Service", "GeoJson", "CSV", "Shapefile", "KML", "File Geodatabase"];
const LUCENE_METACHARACTERS_RE = /["\\/(){}[\]^~:!?+]|&&|\|\|/g;

export function sanitizeArcGisHubSearchText(value: string): string {
  return value
    .replace(LUCENE_METACHARACTERS_RE, " ")
    .replace(/\b(?:AND|OR|NOT)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildArcGisHubSearchUrl(
  query: string,
  options: {
    start?: number;
    num?: number;
    bbox?: [number, number, number, number];
    portalUrl?: string;
  } = {},
): string {
  const portalUrl = options.portalUrl ?? ARCGIS_HUB_PORTAL_URL;
  const url = new URL("/sharing/rest/search", portalUrl);
  const text = sanitizeArcGisHubSearchText(query);
  const typeQuery = SEARCH_TYPES.map((type) => `type:"${type}"`).join(" OR ");
  url.searchParams.set("q", `${text ? `(${text}) AND ` : ""}(${typeQuery}) AND access:public`);
  url.searchParams.set("f", "json");
  url.searchParams.set("start", String(options.start ?? 1));
  url.searchParams.set("num", String(options.num ?? 20));
  url.searchParams.set("sortField", "relevance");
  url.searchParams.set("sortOrder", "desc");
  if (options.bbox) url.searchParams.set("bbox", options.bbox.join(","));
  return url.href;
}

export async function searchArcGisHub(
  query: string,
  options: {
    start?: number;
    num?: number;
    bbox?: [number, number, number, number];
    portalUrl?: string;
    signal?: AbortSignal;
  } = {},
): Promise<ArcGisHubSearchResult> {
  const response = await fetch(buildArcGisHubSearchUrl(query, options), {
    signal: options.signal,
  });
  if (!response.ok) throw new Error(`ArcGIS Hub search failed with ${response.status}.`);
  const json = (await response.json()) as ArcGisHubSearchResult & ArcGisErrorEnvelope;
  if (json.error) throw new Error(json.error.message || "ArcGIS Hub search failed.");
  if (!Array.isArray(json.results)) throw new Error("ArcGIS Hub returned an invalid response.");
  return json;
}

export function arcGisHubItemPageUrl(item: Pick<ArcGisHubItem, "id">): string {
  return `${ARCGIS_HUB_PAGE_URL}/datasets/${encodeURIComponent(item.id)}/about`;
}

export function arcGisHubItemDataUrl(
  item: Pick<ArcGisHubItem, "id">,
  portalUrl = ARCGIS_HUB_PORTAL_URL,
): string {
  return new URL(`/sharing/rest/content/items/${encodeURIComponent(item.id)}/data`, portalUrl).href;
}

export function arcGisHubItemThumbnailUrl(
  item: Pick<ArcGisHubItem, "id" | "thumbnail">,
  portalUrl = ARCGIS_HUB_PORTAL_URL,
): string | null {
  const thumbnail = item.thumbnail?.trim();
  if (!thumbnail) return null;
  // `thumbnail` is published by whoever owns the Hub item. Dot segments survive
  // `encodeURIComponent` untouched (they are unreserved), and the URL parser
  // then collapses them — so a value like `../../../sharing/rest/portals/self`
  // would steer this `<img src>` to an arbitrary path on the portal origin,
  // sent with the viewer's ambient arcgis.com cookies. Drop them before joining.
  const encodedThumbnail = thumbnail
    .split("/")
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .map(encodeURIComponent)
    .join("/");
  if (!encodedThumbnail) return null;
  return new URL(
    `/sharing/rest/content/items/${encodeURIComponent(item.id)}/info/${encodedThumbnail}`,
    portalUrl,
  ).href;
}

// Mirrors the geographic-bounds check `arcgis-layer.ts` applies to portal item
// extents. Kept inline rather than imported so this module stays free of the
// store and MapLibre dependencies that file pulls in.
function isGeoBounds(west: number, south: number, east: number, north: number): boolean {
  return (
    [west, south, east, north].every(Number.isFinite) &&
    west >= -180 &&
    east <= 180 &&
    south >= -90 &&
    north <= 90 &&
    west < east &&
    south < north
  );
}

export function itemBounds(item: ArcGisHubItem): [number, number, number, number] | null {
  const extent = item.extent;
  if (!extent || extent.length !== 2) return null;
  const [[west, south], [east, north]] = extent;
  // A Hub item can advertise a degenerate or non-WGS84 extent; handing that to
  // fitBounds produces a nonsensical viewport jump, so treat it as absent.
  return isGeoBounds(west, south, east, north) ? [west, south, east, north] : null;
}

export async function fetchFeatureServiceGeoJson(
  serviceUrl: string,
  signal?: AbortSignal,
  onProgress?: (completed: number, total: number) => void,
  // Called when the service holds more than one downloadable layer, since only
  // the first is exported. Lets the caller say so instead of silently handing
  // back a partial dataset.
  onExtraLayers?: (layerCount: number) => void,
): Promise<FeatureCollection> {
  const { url: layerUrl, layerCount } = await resolveFeatureLayerUrl(serviceUrl, signal);
  if (layerCount > 1) onExtraLayers?.(layerCount);
  const idsUrl = new URL(`${layerUrl}/query`);
  idsUrl.searchParams.set("where", "1=1");
  idsUrl.searchParams.set("returnIdsOnly", "true");
  idsUrl.searchParams.set("f", "json");
  const idsResponse = await fetch(idsUrl, { signal });
  if (!idsResponse.ok) {
    throw new Error(`ArcGIS feature ID request failed with ${idsResponse.status}.`);
  }
  const idsJson = (await idsResponse.json()) as ArcGisErrorEnvelope & {
    objectIds?: number[];
  };
  if (idsJson.error) throw new Error(idsJson.error.message || "ArcGIS feature ID request failed.");
  const objectIds = idsJson.objectIds;
  if (!Array.isArray(objectIds) || objectIds.length === 0) {
    return { type: "FeatureCollection", features: [] };
  }

  const result: FeatureCollection = { type: "FeatureCollection", features: [] };
  // Keep object-id query strings short. Some ArcGIS deployments sit behind
  // IIS/WAF proxies that answer an overlong GET URL with 404 even though the
  // same layer works through an ordinary `where=1=1` map query. One hundred
  // numeric IDs stays comfortably below common URL limits while still avoiding
  // the service's maxRecordCount truncation.
  const objectIdPageSize = 100;
  for (let offset = 0; offset < objectIds.length; offset += objectIdPageSize) {
    const url = new URL(`${layerUrl}/query`);
    url.searchParams.set("objectIds", objectIds.slice(offset, offset + objectIdPageSize).join(","));
    url.searchParams.set("outFields", "*");
    url.searchParams.set("returnGeometry", "true");
    url.searchParams.set("outSR", "4326");
    url.searchParams.set("f", "geojson");
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`ArcGIS feature download failed with ${response.status}.`);
    const json = (await response.json()) as FeatureCollection & ArcGisErrorEnvelope;
    if (json.error) throw new Error(json.error.message || "ArcGIS feature download failed.");
    if (json.type !== "FeatureCollection" || !Array.isArray(json.features)) {
      throw new Error("ArcGIS did not return GeoJSON features.");
    }
    result.features.push(...json.features);
    onProgress?.(Math.min(offset + objectIdPageSize, objectIds.length), objectIds.length);
  }
  return result;
}

interface ResolvedFeatureLayer {
  url: string;
  /** How many downloadable (non-group) layers the service exposes. */
  layerCount: number;
}

async function resolveFeatureLayerUrl(
  serviceUrl: string,
  signal?: AbortSignal,
): Promise<ResolvedFeatureLayer> {
  const service = new URL(serviceUrl);
  service.hash = "";
  service.search = "";
  service.pathname = service.pathname.replace(/\/+$/, "");
  if (/\/FeatureServer\/\d+$/i.test(service.pathname)) {
    return { url: service.href, layerCount: 1 };
  }
  const metadataUrl = new URL(service);
  metadataUrl.searchParams.set("f", "json");
  const response = await fetch(metadataUrl, { signal });
  if (!response.ok) throw new Error(`ArcGIS service metadata failed with ${response.status}.`);
  const metadata = (await response.json()) as {
    layers?: Array<{ id?: number; subLayerIds?: number[] }>;
    error?: { message?: string };
  };
  if (metadata.error) throw new Error(metadata.error.message || "ArcGIS service metadata failed.");
  // Group layers carry subLayerIds and hold no features of their own.
  const featureLayers = (metadata.layers ?? []).filter(
    (layer) => Number.isInteger(layer.id) && !layer.subLayerIds,
  );
  const layerId = featureLayers[0]?.id;
  if (layerId === undefined) throw new Error("This feature service has no feature layer.");
  service.pathname = `${service.pathname}/${layerId}`;
  return { url: service.href, layerCount: featureLayers.length };
}
