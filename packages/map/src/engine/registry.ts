import type { MapEngine, MapEngineCapability, MapEngineId } from "./types";

export type MapEngineFactory = () => Promise<MapEngine>;

export interface MapEngineDescriptor {
  readonly id: MapEngineId;
  readonly available: boolean;
  readonly capabilities: readonly MapEngineCapability[];
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
  },
  cesium: {
    id: "cesium",
    available: false,
    capabilities: [],
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

export async function loadRegisteredMapEngine(id: MapEngineId): Promise<MapEngine> {
  if (id === "maplibre") {
    const { createMapLibreEngine } = await import("./maplibre-engine");
    return createMapLibreEngine();
  }

  throw new Error(`Map engine "${id}" is not available yet.`);
}

export function resolvePrimaryEngineId(search: string): "maplibre" {
  const requested = new URLSearchParams(search).get("engine");
  if (requested === null || requested === "" || requested === "maplibre") {
    return "maplibre";
  }

  if (requested === "cesium") {
    console.warn('Map engine "cesium" is not available for the primary pane; using "maplibre".');
  } else {
    console.warn(`Unknown map engine "${requested}"; using "maplibre".`);
  }
  return "maplibre";
}
