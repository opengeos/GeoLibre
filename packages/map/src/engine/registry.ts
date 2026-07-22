import type { GeoLibreLayer, LayerType } from "@geolibre/core";
import type { MapEngine, MapEngineCapability, MapEngineId } from "./types";

export type MapEngineFactory = () => Promise<MapEngine>;

export interface MapEngineDescriptor {
  readonly id: MapEngineId;
  readonly available: boolean;
  readonly capabilities: readonly MapEngineCapability[];
  readonly supportedLayerTypes: "all" | readonly LayerType[];
}

const mapLibreCapabilities: readonly MapEngineCapability[] = [
  "capture",
  "controls",
  "feature-query",
  "interactions",
  "markers",
  "popups",
  "transient-overlays",
];

const descriptors: Readonly<Record<MapEngineId, MapEngineDescriptor>> = {
  maplibre: {
    id: "maplibre",
    available: true,
    capabilities: mapLibreCapabilities,
    supportedLayerTypes: "all",
  },
  cesium: {
    id: "cesium",
    available: true,
    capabilities: [],
    supportedLayerTypes: ["geojson", "raster", "xyz", "wms", "wmts", "3d-tiles"],
  },
  arcgis: {
    id: "arcgis",
    available: true,
    capabilities: ["capture", "feature-query", "popups", "transient-overlays"],
    supportedLayerTypes: ["geojson", "raster", "xyz", "wms", "wmts"],
  },
  "arcgis-scene": {
    id: "arcgis-scene",
    available: true,
    capabilities: ["capture", "feature-query", "popups", "transient-overlays"],
    supportedLayerTypes: ["geojson", "raster", "xyz", "wms", "wmts"],
  },
};

export function getMapEngineDescriptor(id: MapEngineId): MapEngineDescriptor {
  return descriptors[id];
}

export function registeredEngineSupports(
  id: MapEngineId,
  capability: MapEngineCapability,
): boolean {
  return descriptors[id].capabilities.includes(capability);
}

export function isMapEngineLayerSupported(id: MapEngineId, layer: GeoLibreLayer): boolean {
  const supported = descriptors[id].supportedLayerTypes;
  return supported === "all" || supported.includes(layer.type);
}

export async function loadRegisteredMapEngine(id: MapEngineId): Promise<MapEngine> {
  if (id === "maplibre") {
    const { createMapLibreEngine } = await import("./maplibre-engine");
    return createMapLibreEngine();
  }
  if (id === "cesium") {
    const { createCesiumEngine } = await import("./cesium-engine");
    return createCesiumEngine();
  }
  if (id === "arcgis-scene") {
    const { createArcGISSceneEngine } = await import("./arcgis-scene-engine");
    return createArcGISSceneEngine();
  }
  const { createArcGISMapEngine } = await import("./arcgis-map-engine");
  return createArcGISMapEngine();
}

export function resolvePrimaryEngineId(search: string): "maplibre" | "arcgis" {
  const requested = new URLSearchParams(search).get("engine");
  if (requested === null || requested === "" || requested === "maplibre") {
    return "maplibre";
  }

  if (requested === "arcgis") return "arcgis";

  if (requested === "cesium") {
    console.warn('Map engine "cesium" is not available for the primary pane; using "maplibre".');
  } else {
    console.warn(`Unknown map engine "${requested}"; using "maplibre".`);
  }
  return "maplibre";
}
