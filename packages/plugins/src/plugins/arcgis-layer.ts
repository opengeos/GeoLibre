/// <reference path="../arcgis-maplibre.d.ts" />

import { DEFAULT_LAYER_STYLE, type GeoLibreLayer, useAppStore } from "@geolibre/core";
import type { HostedLayer, VectorTileLayer } from "@esri/maplibre-arcgis";
import type { FeatureCollection } from "geojson";
import type maplibregl from "maplibre-gl";
import type { GeoLibreAppAPI } from "../types";

export type ArcGISLayerType = "feature" | "vector-tile";
export type ArcGISSourceType = "url" | "portal-item";

export interface ArcGISLayerOptions {
  beforeLayerId?: string | null;
  itemId?: string;
  layerType: ArcGISLayerType;
  name?: string;
  portalUrl?: string;
  sourceType: ArcGISSourceType;
  token?: string;
  url?: string;
}

interface ArcGISFeatureLayerInfo {
  copyrightText?: string;
  extent?: ArcGISExtent;
  geometryType?: string;
  name?: string;
}

interface ArcGISFeatureServiceInfo {
  layers?: Array<{
    id: number;
    subLayerIds?: number[];
  }>;
}

interface ArcGISServiceInfo {
  extent?: ArcGISExtent;
  fullExtent?: ArcGISExtent;
  initialExtent?: ArcGISExtent;
}

interface ArcGISPortalItemInfo {
  extent?: [[number, number], [number, number]];
  url?: string;
}

interface ArcGISExtent {
  spatialReference?: {
    latestWkid?: number;
    wkid?: number;
  };
  xmax: number;
  xmin: number;
  ymax: number;
  ymin: number;
}

type ArcGISLayerModule = typeof import("@esri/maplibre-arcgis");
interface ArcGISRuntimeLayer {
  readonly bounds?: [number, number, number, number];
  readonly layers: Readonly<maplibregl.LayerSpecification[]>;
  readonly sources: Readonly<Record<string, maplibregl.SourceSpecification>>;
  addSourcesAndLayersTo(map: maplibregl.Map): ArcGISRuntimeLayer;
  setSourceId(oldId: string, newId: string): void;
}

let arcgisLayerSequence = 0;
const arcgisLayerInstances = new Map<string, ArcGISRuntimeLayer>();
let arcgisStoreUnsubscribe: (() => void) | null = null;

export async function addArcGISLayer(
  app: GeoLibreAppAPI,
  options: ArcGISLayerOptions,
): Promise<string> {
  const input = getArcGISInput(options);

  // A feature layer is just attributed vector data, so load it as a regular
  // GeoJSON layer rather than an opaque external-native layer. That unlocks the
  // host's full vector styling surface for it — labels (with uppercase/offset/
  // rotation formatting), the attribute table, identify, symbology, and export —
  // instead of only the fill/stroke paint an external-native layer exposes.
  if (options.layerType === "feature") {
    return addArcGISFeatureLayerAsGeoJson(app, options, input);
  }

  const map = app.getMap?.();
  if (!map) {
    throw new Error("The map is not ready.");
  }

  const arcgis = await import("@esri/maplibre-arcgis");
  const hostedLayer = await createArcGISHostedLayer(arcgis, options, input);
  const id = createArcGISLayerId();
  const sourceIds = prefixArcGISSourceIds(hostedLayer, id);
  const nativeLayerIds = prefixArcGISStyleLayerIds(hostedLayer, id);
  const bounds = await resolveArcGISLayerBounds(input, options, hostedLayer);

  addArcGISRuntimeLayerToMap(hostedLayer, map);
  ensureArcGISStoreCleanup();
  arcgisLayerInstances.set(id, hostedLayer);

  const layer = createArcGISStoreLayer({
    id,
    input,
    nativeLayerIds,
    options,
    bounds,
    sourceIds,
  });
  const store = useAppStore.getState();
  store.addLayer(layer, options.beforeLayerId);
  if (bounds) app.fitBounds?.(bounds);
  return id;
}

function ensureArcGISStoreCleanup(): void {
  arcgisStoreUnsubscribe ??= useAppStore.subscribe((state, previous) => {
    for (const layer of previous.layers) {
      if (layer.type === "arcgis" && !state.layers.some((current) => current.id === layer.id)) {
        arcgisLayerInstances.delete(layer.id);
      }
    }
  });
}

async function createArcGISHostedLayer(
  arcgis: ArcGISLayerModule,
  options: ArcGISLayerOptions,
  input: string,
): Promise<ArcGISRuntimeLayer> {
  const layerOptions = {
    portalUrl: options.portalUrl?.trim() || undefined,
    token: options.token?.trim() || undefined,
  };

  return options.sourceType === "url"
    ? (arcgis.VectorTileLayer as typeof VectorTileLayer).fromUrl(input, layerOptions)
    : (arcgis.VectorTileLayer as typeof VectorTileLayer).fromPortalItem(input, layerOptions);
}

function getArcGISInput(options: ArcGISLayerOptions): string {
  const input = options.sourceType === "url" ? options.url?.trim() : options.itemId?.trim();
  if (!input) {
    throw new Error(
      options.sourceType === "url"
        ? "Enter an ArcGIS service URL."
        : "Enter an ArcGIS portal item ID.",
    );
  }
  return input;
}

function prefixArcGISSourceIds(hostedLayer: ArcGISRuntimeLayer, layerId: string): string[] {
  const originalSourceIds = Object.keys(hostedLayer.sources);
  return originalSourceIds.map((sourceId, index) => {
    const nextSourceId = `${layerId}-source-${index}-${sanitizeIdPart(sourceId)}`;
    hostedLayer.setSourceId(sourceId, nextSourceId);
    return nextSourceId;
  });
}

function prefixArcGISStyleLayerIds(hostedLayer: ArcGISRuntimeLayer, layerId: string): string[] {
  const mutableLayers = hostedLayer.layers as maplibregl.LayerSpecification[];
  return mutableLayers.map((styleLayer, index) => {
    const nextLayerId = `${layerId}-layer-${index}-${sanitizeIdPart(styleLayer.id)}`;
    styleLayer.id = nextLayerId;
    return nextLayerId;
  });
}

function addArcGISRuntimeLayerToMap(hostedLayer: ArcGISRuntimeLayer, map: maplibregl.Map): void {
  for (const [sourceId, source] of Object.entries(hostedLayer.sources)) {
    if (!map.getSource(sourceId)) {
      map.addSource(sourceId, source);
    }
  }

  for (const layer of hostedLayer.layers) {
    if (!map.getLayer(layer.id)) {
      map.addLayer(layer);
    }
  }
}

/**
 * Load an ArcGIS FeatureServer layer as a host-managed GeoJSON layer.
 *
 * The features are fetched up front (`/query?f=geojson`) and handed to the
 * store's GeoJSON layer path, so the layer is a first-class vector layer with
 * its attributes available — enabling labels and their formatting, the
 * attribute table, identify, symbology, and export. Vector tile layers keep the
 * external-native runtime path; only feature layers come through here.
 *
 * @param app - The host app API (used to fit the view to the layer extent).
 * @param options - The ArcGIS layer options (source type, URL/item, token).
 * @param input - The resolved service URL or portal item id from the options.
 * @returns The new GeoLibre layer's id.
 */
async function addArcGISFeatureLayerAsGeoJson(
  app: GeoLibreAppAPI,
  options: ArcGISLayerOptions,
  input: string,
): Promise<string> {
  const layerUrl =
    options.sourceType === "url"
      ? await resolveFeatureLayerUrl(input, options, undefined)
      : await resolvePortalFeatureLayerUrl(input, options, undefined);
  const layerInfo = await fetchArcGISJson<ArcGISFeatureLayerInfo>(layerUrl, options, undefined);
  if (!layerInfo.geometryType) {
    throw new Error("The ArcGIS feature layer metadata is missing geometry type.");
  }

  // The token is kept out of the persisted refresh URL so it is never written
  // to a saved project; it is only appended to the one-off request below.
  const refreshUrl = appendArcGISParams(`${trimTrailingSlash(layerUrl)}/query`, {
    f: "geojson",
    outFields: "*",
    returnGeometry: "true",
    where: "1=1",
  });
  const requestUrl = appendArcGISParams(refreshUrl, {
    token: options.token?.trim(),
  });
  const geojson = await fetchArcGISGeoJson(requestUrl);

  const name =
    options.name?.trim() || layerInfo.name || layerNameFromArcGISInput(layerUrl, "ArcGIS Layer");
  const store = useAppStore.getState();
  // Persist the GeoJSON query endpoint (not the service-description base URL) as
  // the source path so the layer's GeoJSON refresh re-fetches valid features.
  const id = store.addGeoJsonLayer(name, geojson, refreshUrl, options.beforeLayerId ?? null);

  // Preserve the service's copyright watermark in MapLibre's attribution
  // control, matching the prior URL-source behavior.
  const attribution = layerInfo.copyrightText?.trim();
  if (attribution) {
    store.updateLayer(id, { source: { type: "geojson", attribution } });
  }

  const bounds = arcgisExtentToBounds(layerInfo.extent);
  if (bounds) app.fitBounds?.(bounds);
  return id;
}

/**
 * Fetch and validate a GeoJSON FeatureCollection from an ArcGIS query URL.
 *
 * ArcGIS can answer a `f=geojson` request with a JSON error envelope rather than
 * GeoJSON, so both the transport status and the payload shape are checked. A
 * result truncated at the service's `maxRecordCount` is loaded as-is but warned
 * about, so a partial attribute table or export is not mistaken for the full
 * dataset.
 *
 * @param url - The fully-built `/query?f=geojson` request URL.
 * @returns The parsed FeatureCollection.
 */
async function fetchArcGISGeoJson(url: string): Promise<FeatureCollection> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`ArcGIS feature query failed with ${response.status}.`);
  }
  // ArcGIS Enterprise (and services behind a WAF) can answer 200 with an HTML
  // login/redirect page when a token is missing or expired. Read the body as
  // text first so that surfaces as a clear message instead of a raw
  // `SyntaxError: Unexpected token '<'` from JSON.parse.
  const text = await response.text();
  if (/^\s*</.test(text)) {
    throw new Error(
      "The ArcGIS service returned HTML instead of GeoJSON (the layer may require a token or sign-in).",
    );
  }
  let json: FeatureCollection & {
    error?: { message?: string };
    exceededTransferLimit?: boolean;
  };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("The ArcGIS feature layer did not return GeoJSON features.");
  }
  if (json.error) {
    throw new Error(json.error.message || "ArcGIS feature query failed.");
  }
  if (json.type !== "FeatureCollection" || !Array.isArray(json.features)) {
    throw new Error("The ArcGIS feature layer did not return GeoJSON features.");
  }
  // ArcGIS caps a single query at the service's maxRecordCount and flags the
  // shortfall with `exceededTransferLimit`. The partial data still loads (it is
  // the same subset the previous URL-source path rendered), but the truncation
  // is surfaced so the caller knows the layer is not the complete dataset.
  if (json.exceededTransferLimit) {
    console.warn(
      `[GeoLibre] ArcGIS feature query was truncated at the service record ` +
        `limit; loaded ${json.features.length} features (partial dataset).`,
    );
  }
  return json;
}

async function resolveFeatureLayerUrl(
  input: string,
  options: ArcGISLayerOptions,
  cause: unknown,
): Promise<string> {
  if (/\/FeatureServer\/\d+\/?$/i.test(input)) return trimTrailingSlash(input);
  if (!/\/FeatureServer\/?$/i.test(input)) {
    throw new Error("Enter an ArcGIS FeatureServer layer URL.", { cause });
  }

  const serviceInfo = await fetchArcGISJson<ArcGISFeatureServiceInfo>(input, options, cause);
  const layerId = serviceInfo.layers?.find((layer) => !layer.subLayerIds)?.id;
  if (layerId == null) {
    throw new Error("The ArcGIS feature service does not list a feature layer.", {
      cause,
    });
  }
  return `${trimTrailingSlash(input)}/${layerId}`;
}

async function resolvePortalFeatureLayerUrl(
  itemId: string,
  options: ArcGISLayerOptions,
  cause: unknown,
): Promise<string> {
  const itemInfo = await fetchArcGISPortalItemInfo(itemId, options, cause);
  if (!itemInfo.url) {
    throw new Error("The ArcGIS portal item does not include a service URL.", {
      cause,
    });
  }
  return resolveFeatureLayerUrl(itemInfo.url, options, cause);
}

async function fetchArcGISPortalItemInfo(
  itemId: string,
  options: ArcGISLayerOptions,
  cause: unknown,
): Promise<ArcGISPortalItemInfo> {
  const portalUrl = options.portalUrl?.trim() || "https://www.arcgis.com/sharing/rest";
  const itemUrl = appendArcGISParams(`${trimTrailingSlash(portalUrl)}/content/items/${itemId}`, {
    f: "json",
    token: options.token?.trim(),
  });
  const response = await fetch(itemUrl);
  if (!response.ok) {
    throw new Error(`ArcGIS portal item request failed with ${response.status}.`, {
      cause,
    });
  }
  return (await response.json()) as ArcGISPortalItemInfo;
}

async function fetchArcGISJson<T>(
  url: string,
  options: ArcGISLayerOptions,
  cause: unknown,
): Promise<T> {
  const response = await fetch(
    appendArcGISParams(url, {
      f: "json",
      token: options.token?.trim(),
    }),
  );
  if (!response.ok) {
    throw new Error(`ArcGIS service request failed with ${response.status}.`, {
      cause,
    });
  }
  const json = (await response.json()) as T & {
    error?: { message?: string };
  };
  if (json.error) {
    throw new Error(json.error.message || "ArcGIS service request failed.", {
      cause,
    });
  }
  return json;
}

async function resolveArcGISLayerBounds(
  input: string,
  options: ArcGISLayerOptions,
  hostedLayer: ArcGISRuntimeLayer,
): Promise<[number, number, number, number] | undefined> {
  const sourceBounds = getArcGISSourceBounds(hostedLayer);
  if (sourceBounds) return sourceBounds;
  if (hostedLayer.bounds) return hostedLayer.bounds;

  try {
    if (options.sourceType === "portal-item") {
      const itemInfo = await fetchArcGISPortalItemInfo(input, options, undefined);
      const itemBounds = arcgisPortalItemExtentToBounds(itemInfo.extent);
      if (itemBounds) return itemBounds;
      if (itemInfo.url) {
        return resolveArcGISServiceBounds(itemInfo.url, options);
      }
      return undefined;
    }

    return resolveArcGISServiceBounds(input, options);
  } catch {
    return undefined;
  }
}

async function resolveArcGISServiceBounds(
  url: string,
  options: ArcGISLayerOptions,
): Promise<[number, number, number, number] | undefined> {
  const serviceInfo = await fetchArcGISJson<ArcGISServiceInfo>(url, options, undefined);
  return arcgisExtentToBounds(
    serviceInfo.fullExtent ?? serviceInfo.initialExtent ?? serviceInfo.extent,
  );
}

function getArcGISSourceBounds(
  hostedLayer: ArcGISRuntimeLayer,
): [number, number, number, number] | undefined {
  for (const source of Object.values(hostedLayer.sources)) {
    const bounds = "bounds" in source ? source.bounds : undefined;
    if (isGeoBounds(bounds)) return bounds;
  }
  return undefined;
}

function arcgisPortalItemExtentToBounds(
  extent: ArcGISPortalItemInfo["extent"],
): [number, number, number, number] | undefined {
  if (!Array.isArray(extent) || extent.length !== 2) return undefined;
  const [[west, south], [east, north]] = extent;
  return isGeoBounds([west, south, east, north]) ? [west, south, east, north] : undefined;
}

function arcgisExtentToBounds(
  extent: ArcGISExtent | undefined,
): [number, number, number, number] | undefined {
  if (!extent) return undefined;
  const wkid = extent.spatialReference?.latestWkid ?? extent.spatialReference?.wkid;
  if (wkid === 102100 || wkid === 102113 || wkid === 3857) {
    return [
      mercatorXToLongitude(extent.xmin),
      mercatorYToLatitude(extent.ymin),
      mercatorXToLongitude(extent.xmax),
      mercatorYToLatitude(extent.ymax),
    ];
  }

  const bounds: [number, number, number, number] = [
    extent.xmin,
    extent.ymin,
    extent.xmax,
    extent.ymax,
  ];
  return isGeoBounds(bounds) ? bounds : undefined;
}

function mercatorXToLongitude(x: number): number {
  return (x / 20037508.34) * 180;
}

function mercatorYToLatitude(y: number): number {
  const latitude = (y / 20037508.34) * 180;
  return (180 / Math.PI) * (2 * Math.atan(Math.exp((latitude * Math.PI) / 180)) - Math.PI / 2);
}

function isGeoBounds(value: unknown): value is [number, number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((item) => typeof item === "number" && Number.isFinite(item)) &&
    value[0] >= -180 &&
    value[2] <= 180 &&
    value[1] >= -90 &&
    value[3] <= 90 &&
    value[0] < value[2] &&
    value[1] < value[3]
  );
}

function appendArcGISParams(url: string, params: Record<string, string | undefined>): string {
  const parsedUrl = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    if (value) parsedUrl.searchParams.set(key, value);
  }
  return parsedUrl.toString();
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function createArcGISStoreLayer(args: {
  bounds?: [number, number, number, number];
  id: string;
  input: string;
  nativeLayerIds: string[];
  options: ArcGISLayerOptions;
  sourceIds: string[];
}): GeoLibreLayer {
  const { bounds, id, input, nativeLayerIds, options, sourceIds } = args;
  const sourceKind = `arcgis-${options.layerType}-${options.sourceType}`;
  const sourceType = options.layerType === "feature" ? "geojson" : "vector";
  const name = options.name?.trim() || layerNameFromArcGISInput(input, id);

  return {
    id,
    name,
    type: "arcgis",
    source: {
      itemId: options.sourceType === "portal-item" ? input : undefined,
      bounds,
      layerType: options.layerType,
      portalUrl: options.portalUrl?.trim() || undefined,
      sourceId: sourceIds[0],
      sourceIds,
      type: sourceType,
      url: options.sourceType === "url" ? input : undefined,
    },
    visible: true,
    opacity: 1,
    style: {
      ...DEFAULT_LAYER_STYLE,
      fillColor: "#2563eb",
      fillOpacity: 0.45,
      strokeColor: "#1d4ed8",
    },
    metadata: {
      arcgisLayerType: options.layerType,
      arcgisSourceType: options.sourceType,
      bounds,
      externalNativeLayer: true,
      hasAccessToken: Boolean(options.token?.trim()),
      nativeLayerIds,
      portalUrl: options.portalUrl?.trim() || undefined,
      sourceId: sourceIds[0],
      sourceIds,
      sourceKind,
    },
    sourcePath: input,
  };
}

function layerNameFromArcGISInput(input: string, fallback: string): string {
  try {
    const url = new URL(input);
    const parts = url.pathname.split("/").filter(Boolean);
    const serverIndex = parts.findIndex((part) => /^(FeatureServer|VectorTileServer)$/i.test(part));
    const namePart = serverIndex > 0 ? parts[serverIndex - 1] : parts[parts.length - 1];
    return decodeURIComponent(namePart ?? "").replaceAll("_", " ") || fallback;
  } catch {
    return input || fallback;
  }
}

function sanitizeIdPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "id";
}

function createArcGISLayerId(): string {
  arcgisLayerSequence += 1;
  return `arcgis-layer-${arcgisLayerSequence}`;
}
