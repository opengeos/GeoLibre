import {
  DEFAULT_LAYER_STYLE,
  type GeoLibreLayer,
  useAppStore,
} from "@geolibre/core";
import type {
  HostedLayer,
  VectorTileLayer,
} from "@esri/maplibre-arcgis";
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
  geometryType?: string;
  name?: string;
}

interface ArcGISFeatureServiceInfo {
  layers?: Array<{
    id: number;
    subLayerIds?: number[];
  }>;
}

type ArcGISLayerModule = typeof import("@esri/maplibre-arcgis");
type ArcGISRuntimeLayer = Pick<
  HostedLayer,
  "addSourcesAndLayersTo" | "layers" | "setSourceId" | "sources"
>;

let arcgisLayerSequence = 0;
const arcgisLayerInstances = new Map<string, ArcGISRuntimeLayer>();
let arcgisStoreUnsubscribe: (() => void) | null = null;

export async function addArcGISLayer(
  app: GeoLibreAppAPI,
  options: ArcGISLayerOptions,
): Promise<string> {
  const map = app.getMap?.();
  if (!map) {
    throw new Error("The map is not ready.");
  }

  const input = getArcGISInput(options);
  const arcgis = await import("@esri/maplibre-arcgis");
  const hostedLayer = await createArcGISHostedLayer(arcgis, options, input);
  const id = createArcGISLayerId();
  const sourceIds = prefixArcGISSourceIds(hostedLayer, id);
  const nativeLayerIds = prefixArcGISStyleLayerIds(hostedLayer, id);

  hostedLayer.addSourcesAndLayersTo(map);
  ensureArcGISStoreCleanup();
  arcgisLayerInstances.set(id, hostedLayer);

  const layer = createArcGISStoreLayer({
    id,
    input,
    nativeLayerIds,
    options,
    sourceIds,
  });
  const store = useAppStore.getState();
  store.addLayer(layer, options.beforeLayerId);
  return id;
}

function ensureArcGISStoreCleanup(): void {
  arcgisStoreUnsubscribe ??= useAppStore.subscribe((state, previous) => {
    for (const layer of previous.layers) {
      if (
        layer.type === "arcgis" &&
        !state.layers.some((current) => current.id === layer.id)
      ) {
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

  if (options.layerType === "feature") return createFallbackFeatureLayer(input, options);

  return options.sourceType === "url"
    ? (arcgis.VectorTileLayer as typeof VectorTileLayer).fromUrl(
        input,
        layerOptions,
      )
    : (arcgis.VectorTileLayer as typeof VectorTileLayer).fromPortalItem(
        input,
        layerOptions,
      );
}

function getArcGISInput(options: ArcGISLayerOptions): string {
  const input =
    options.sourceType === "url" ? options.url?.trim() : options.itemId?.trim();
  if (!input) {
    throw new Error(
      options.sourceType === "url"
        ? "Enter an ArcGIS service URL."
        : "Enter an ArcGIS portal item ID.",
    );
  }
  return input;
}

function prefixArcGISSourceIds(
  hostedLayer: ArcGISRuntimeLayer,
  layerId: string,
): string[] {
  const originalSourceIds = Object.keys(hostedLayer.sources);
  return originalSourceIds.map((sourceId, index) => {
    const nextSourceId = `${layerId}-source-${index}-${sanitizeIdPart(sourceId)}`;
    hostedLayer.setSourceId(sourceId, nextSourceId);
    return nextSourceId;
  });
}

function prefixArcGISStyleLayerIds(
  hostedLayer: ArcGISRuntimeLayer,
  layerId: string,
): string[] {
  const mutableLayers = hostedLayer.layers as maplibregl.LayerSpecification[];
  return mutableLayers.map((styleLayer, index) => {
    const nextLayerId = `${layerId}-layer-${index}-${sanitizeIdPart(
      styleLayer.id,
    )}`;
    styleLayer.id = nextLayerId;
    return nextLayerId;
  });
}

async function createFallbackFeatureLayer(
  input: string,
  options: ArcGISLayerOptions,
  cause: unknown = undefined,
): Promise<ArcGISRuntimeLayer> {
  const layerUrl =
    options.sourceType === "url"
      ? await resolveFeatureLayerUrl(input, options, cause)
      : await resolvePortalFeatureLayerUrl(input, options, cause);
  const layerInfo = await fetchArcGISJson<ArcGISFeatureLayerInfo>(
    layerUrl,
    options,
    cause,
  );
  if (!layerInfo.geometryType) {
    throw new Error("The ArcGIS feature layer metadata is missing geometry type.", {
      cause,
    });
  }

  const sourceId = layerInfo.name || layerNameFromArcGISInput(layerUrl, "arcgis");
  const styleLayerType = arcgisGeometryLayerType(layerInfo.geometryType);
  const styleLayerId = `${sourceId}-layer`;
  const queryUrl = appendArcGISParams(`${trimTrailingSlash(layerUrl)}/query`, {
    f: "geojson",
    outFields: "*",
    returnGeometry: "true",
    token: options.token?.trim(),
    where: "1=1",
  });

  return createStaticArcGISRuntimeLayer({
    layers: [
      {
        id: styleLayerId,
        source: sourceId,
        type: styleLayerType,
        paint: arcgisFallbackPaint(styleLayerType),
      } as maplibregl.LayerSpecification,
    ],
    sources: {
      [sourceId]: {
        type: "geojson",
        data: queryUrl,
        attribution: layerInfo.copyrightText || "ArcGIS Feature Service",
      },
    },
  });
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

  const serviceInfo = await fetchArcGISJson<ArcGISFeatureServiceInfo>(
    input,
    options,
    cause,
  );
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
  const portalUrl =
    options.portalUrl?.trim() || "https://www.arcgis.com/sharing/rest";
  const itemUrl = appendArcGISParams(
    `${trimTrailingSlash(portalUrl)}/content/items/${itemId}`,
    { f: "json", token: options.token?.trim() },
  );
  const response = await fetch(itemUrl);
  if (!response.ok) {
    throw new Error(`ArcGIS portal item request failed with ${response.status}.`, {
      cause,
    });
  }
  const itemInfo = (await response.json()) as { url?: string };
  if (!itemInfo.url) {
    throw new Error("The ArcGIS portal item does not include a service URL.", {
      cause,
    });
  }
  return resolveFeatureLayerUrl(itemInfo.url, options, cause);
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

function createStaticArcGISRuntimeLayer(args: {
  layers: maplibregl.LayerSpecification[];
  sources: Record<string, maplibregl.AnySourceData>;
}): ArcGISRuntimeLayer {
  return {
    get layers() {
      return args.layers;
    },
    get sources() {
      return args.sources;
    },
    setSourceId(oldId: string, newId: string) {
      args.sources[newId] = args.sources[oldId];
      delete args.sources[oldId];
      for (const layer of args.layers) {
        if ("source" in layer && layer.source === oldId) {
          layer.source = newId;
        }
      }
    },
    addSourcesAndLayersTo(map: maplibregl.Map) {
      for (const [sourceId, source] of Object.entries(args.sources)) {
        map.addSource(sourceId, source);
      }
      for (const layer of args.layers) {
        map.addLayer(layer);
      }
      return this;
    },
  };
}

function arcgisGeometryLayerType(
  geometryType: string,
): "circle" | "fill" | "line" {
  if (geometryType === "esriGeometryPoint") return "circle";
  if (geometryType === "esriGeometryMultipoint") return "circle";
  if (geometryType === "esriGeometryPolyline") return "line";
  return "fill";
}

function arcgisFallbackPaint(
  layerType: "circle" | "fill" | "line",
): maplibregl.LayerSpecification["paint"] {
  if (layerType === "circle") {
    return {
      "circle-color": DEFAULT_LAYER_STYLE.fillColor,
      "circle-radius": DEFAULT_LAYER_STYLE.circleRadius,
      "circle-stroke-color": DEFAULT_LAYER_STYLE.strokeColor,
      "circle-stroke-width": DEFAULT_LAYER_STYLE.strokeWidth,
    };
  }
  if (layerType === "line") {
    return {
      "line-color": DEFAULT_LAYER_STYLE.strokeColor,
      "line-width": DEFAULT_LAYER_STYLE.strokeWidth,
    };
  }
  return {
    "fill-color": DEFAULT_LAYER_STYLE.fillColor,
    "fill-opacity": DEFAULT_LAYER_STYLE.fillOpacity,
    "fill-outline-color": DEFAULT_LAYER_STYLE.strokeColor,
  };
}

function appendArcGISParams(
  url: string,
  params: Record<string, string | undefined>,
): string {
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
  id: string;
  input: string;
  nativeLayerIds: string[];
  options: ArcGISLayerOptions;
  sourceIds: string[];
}): GeoLibreLayer {
  const { id, input, nativeLayerIds, options, sourceIds } = args;
  const sourceKind = `arcgis-${options.layerType}-${options.sourceType}`;
  const sourceType = options.layerType === "feature" ? "geojson" : "vector";
  const name = options.name?.trim() || layerNameFromArcGISInput(input, id);

  return {
    id,
    name,
    type: "arcgis",
    source: {
      itemId: options.sourceType === "portal-item" ? input : undefined,
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
    const serverIndex = parts.findIndex((part) =>
      /^(FeatureServer|VectorTileServer)$/i.test(part),
    );
    const namePart =
      serverIndex > 0 ? parts[serverIndex - 1] : parts[parts.length - 1];
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
