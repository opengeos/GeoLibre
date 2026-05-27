import {
  DEFAULT_BASEMAP,
  DEFAULT_LAYER_STYLE,
  PROJECT_VERSION,
  type GeoLibreLayer,
  type GeoLibreProject,
  type LayerStyle,
  type MapViewState,
} from "./types";

export function createDefaultMapView(): MapViewState {
  return {
    center: [-98.5795, 39.8283],
    zoom: 3,
    bearing: 0,
    pitch: 0,
  };
}

export function createEmptyProject(name = "Untitled Project"): GeoLibreProject {
  return {
    version: PROJECT_VERSION,
    name,
    mapView: createDefaultMapView(),
    basemapStyleUrl: DEFAULT_BASEMAP,
    layers: [],
    styles: {},
    metadata: {},
  };
}

export function serializeProject(project: GeoLibreProject): string {
  return JSON.stringify(project, null, 2);
}

export function parseProject(json: string): GeoLibreProject {
  const data = JSON.parse(json) as Partial<GeoLibreProject>;
  if (!data.version || !data.name || !data.mapView) {
    throw new Error("Invalid GeoLibre project: missing required fields");
  }
  return {
    version: data.version,
    name: data.name,
    mapView: data.mapView,
    basemapStyleUrl: data.basemapStyleUrl ?? DEFAULT_BASEMAP,
    layers: (data.layers ?? []).map(normalizeLayer),
    styles: data.styles ?? {},
    metadata: data.metadata ?? {},
  };
}

function normalizeLayer(layer: GeoLibreLayer): GeoLibreLayer {
  return {
    ...layer,
    style: { ...DEFAULT_LAYER_STYLE, ...layer.style },
    visible: layer.visible ?? true,
    opacity: layer.opacity ?? 1,
    metadata: layer.metadata ?? {},
    source: layer.source ?? {},
  };
}

export function projectFromStore(state: {
  projectName: string;
  mapView: MapViewState;
  basemapStyleUrl: string;
  layers: GeoLibreLayer[];
  metadata: Record<string, unknown>;
}): GeoLibreProject {
  const styles: Record<string, LayerStyle> = {};
  for (const layer of state.layers) {
    styles[layer.id] = layer.style;
  }
  return {
    version: PROJECT_VERSION,
    name: state.projectName,
    mapView: state.mapView,
    basemapStyleUrl: state.basemapStyleUrl,
    layers: state.layers,
    styles,
    metadata: state.metadata,
  };
}

export function applyProjectToStore(project: GeoLibreProject): {
  projectName: string;
  mapView: MapViewState;
  basemapStyleUrl: string;
  layers: GeoLibreLayer[];
  metadata: Record<string, unknown>;
} {
  const layers = project.layers.map((layer) => ({
    ...layer,
    style: project.styles[layer.id]
      ? { ...DEFAULT_LAYER_STYLE, ...project.styles[layer.id] }
      : { ...DEFAULT_LAYER_STYLE, ...layer.style },
  }));
  return {
    projectName: project.name,
    mapView: project.mapView,
    basemapStyleUrl: project.basemapStyleUrl,
    layers,
    metadata: project.metadata,
  };
}
