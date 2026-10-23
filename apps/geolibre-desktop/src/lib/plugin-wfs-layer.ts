import { useAppStore } from "@geolibre/core";
import type { GeoLibreWfsLayerOptions } from "@geolibre/plugins";
import { buildWfsGeoJsonLayer } from "../components/layout/add-data/apply-service";
import { stripOgcOperationParams } from "../components/layout/add-data/helpers";
import { fetchWfsGeoJson } from "./layer-refresh";
import { pluginLayerMetadata } from "./plugin-layer-metadata";

function validateBbox(
  value: unknown,
): asserts value is [number, number, number, number] | undefined {
  if (value === undefined) return;
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    !value.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate))
  ) {
    throw new Error("addWfsLayer: options.bbox must be a WGS84 [west, south, east, north] extent.");
  }
  const [west, south, east, north] = value;
  if (west < -180 || east > 180 || south < -90 || north > 90 || west > east || south > north) {
    throw new Error("addWfsLayer: options.bbox must be a WGS84 [west, south, east, north] extent.");
  }
}

export async function addPluginWfsLayer(
  name: string,
  options: GeoLibreWfsLayerOptions,
): Promise<string> {
  const url = typeof options?.url === "string" ? options.url.trim() : "";
  if (!url) throw new Error("addWfsLayer: options.url must be a non-empty string.");
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error("addWfsLayer: options.url must be an absolute HTTP(S) URL.");
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error("addWfsLayer: options.url must be an absolute HTTP(S) URL.");
  }
  const typeName = typeof options?.typeName === "string" ? options.typeName.trim() : "";
  if (!typeName) throw new Error("addWfsLayer: options.typeName must be a non-empty string.");
  const version =
    options?.version === undefined
      ? "2.0.0"
      : typeof options.version === "string"
        ? options.version.trim()
        : "";
  if (!version) throw new Error("addWfsLayer: options.version must be a non-empty string.");
  validateBbox(options?.bbox);

  const maxFeatures = options?.maxFeatures === undefined ? 1000 : options.maxFeatures;
  if (typeof maxFeatures !== "number" || !Number.isSafeInteger(maxFeatures) || maxFeatures < 1) {
    throw new Error("addWfsLayer: options.maxFeatures must be a positive integer.");
  }
  const metadata = pluginLayerMetadata("addWfsLayer", options?.metadata);

  const projectGeneration = useAppStore.getState().projectGeneration;
  // A fragment would swallow the GetFeature parameters appended below it — the
  // request line never carries the fragment, so the service would receive the
  // bare endpoint and answer with something other than the feature collection.
  const endpoint = stripOgcOperationParams(url.split("#", 1)[0], "WFS");
  const result = await fetchWfsGeoJson(
    {
      endpoint,
      typeName,
      version,
      outputFormat: "application/json",
      srsName: "EPSG:4326",
      maxFeatures: String(maxFeatures),
      bbox: options?.bbox,
    },
    { useWfsProxy: true },
  );
  if (useAppStore.getState().projectGeneration !== projectGeneration) {
    throw new Error("addWfsLayer: the project changed while the layer was loading.");
  }
  if (result.data.features.length === 0) {
    throw new Error("addWfsLayer: the service returned no features.");
  }
  const layer = buildWfsGeoJsonLayer({
    name,
    featureUrl: result.url,
    data: result.data,
    typeName,
    version,
    outputFormat: result.outputFormat,
    srsName: "EPSG:4326",
  });
  if (metadata) layer.metadata = { ...metadata, ...layer.metadata };
  useAppStore.getState().addLayer(layer);
  return layer.id;
}
