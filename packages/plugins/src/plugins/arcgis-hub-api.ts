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
  modified?: number;
  size?: number;
  tags?: string[];
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
  const text = query.trim();
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

export function itemBounds(item: ArcGisHubItem): [number, number, number, number] | null {
  const extent = item.extent;
  if (!extent || extent.length !== 2) return null;
  const [[west, south], [east, north]] = extent;
  return [west, south, east, north].every(Number.isFinite) ? [west, south, east, north] : null;
}

export async function fetchFeatureServiceGeoJson(
  serviceUrl: string,
  signal?: AbortSignal,
): Promise<FeatureCollection> {
  const layerUrl = await resolveFeatureLayerUrl(serviceUrl, signal);
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
  // ArcGIS services publish different maxRecordCount values. A conservative
  // 1,000-ID page works across old Enterprise portals and prevents the first
  // page limit from silently truncating a download.
  for (let offset = 0; offset < objectIds.length; offset += 1_000) {
    const url = new URL(`${layerUrl}/query`);
    url.searchParams.set("objectIds", objectIds.slice(offset, offset + 1_000).join(","));
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
  }
  return result;
}

async function resolveFeatureLayerUrl(serviceUrl: string, signal?: AbortSignal): Promise<string> {
  const trimmed = serviceUrl.replace(/\/+$/, "");
  if (/\/FeatureServer\/\d+$/i.test(trimmed)) return trimmed;
  const metadataUrl = new URL(trimmed);
  metadataUrl.searchParams.set("f", "json");
  const response = await fetch(metadataUrl, { signal });
  if (!response.ok) throw new Error(`ArcGIS service metadata failed with ${response.status}.`);
  const metadata = (await response.json()) as {
    layers?: Array<{ id?: number }>;
    error?: { message?: string };
  };
  if (metadata.error) throw new Error(metadata.error.message || "ArcGIS service metadata failed.");
  const layerId = metadata.layers?.find((layer) => Number.isInteger(layer.id))?.id;
  if (layerId === undefined) throw new Error("This feature service has no feature layer.");
  return `${trimmed}/${layerId}`;
}
