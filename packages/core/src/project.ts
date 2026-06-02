import {
  DEFAULT_BASEMAP,
  DEFAULT_LAYER_STYLE,
  DEFAULT_PROJECT_PREFERENCES,
  PROJECT_VERSION,
  type GeoLibreLayer,
  type GeoLibreProject,
  type LayerStyle,
  type MapViewState,
  type ProjectPluginControlPosition,
  type ProjectPluginState,
  type ProjectPreferences,
  type RuntimeEnvironmentVariable,
} from "./types";

export interface CreateProjectOptions {
  basemapStyleUrl?: string;
  mapView?: MapViewState;
}

export function createDefaultMapView(): MapViewState {
  return {
    center: [-100, 40],
    zoom: 2,
    bearing: 0,
    pitch: 0,
  };
}

export function createEmptyProject(
  name = "Untitled Project",
  options: CreateProjectOptions = {},
): GeoLibreProject {
  return {
    version: PROJECT_VERSION,
    name,
    mapView: options.mapView ?? createDefaultMapView(),
    basemapStyleUrl: options.basemapStyleUrl ?? DEFAULT_BASEMAP,
    basemapVisible: true,
    basemapOpacity: 1,
    layers: [],
    styles: {},
    preferences: DEFAULT_PROJECT_PREFERENCES,
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
    basemapVisible: data.basemapVisible ?? true,
    basemapOpacity: data.basemapOpacity ?? 1,
    layers: (data.layers ?? []).map(normalizeLayer),
    styles: data.styles ?? {},
    preferences: normalizeProjectPreferences(data.preferences),
    plugins: normalizeProjectPlugins(data.plugins) ?? undefined,
    metadata: data.metadata ?? {},
  };
}

function normalizeProjectPreferences(
  preferences: unknown,
): ProjectPreferences {
  if (!preferences || typeof preferences !== "object") {
    return DEFAULT_PROJECT_PREFERENCES;
  }

  const candidate = preferences as Partial<ProjectPreferences>;
  const map = candidate.map ?? {};
  // Every MapPreferences field is normalized explicitly below, so the map
  // object is not spread in: that would forward unknown keys from a
  // hand-edited project file straight into app state.
  return {
    map: {
      ...DEFAULT_PROJECT_PREFERENCES.map,
      bounds: normalizeBounds(
        (map as Partial<ProjectPreferences["map"]>).bounds,
      ),
      minZoom: normalizeNumber(
        (map as Partial<ProjectPreferences["map"]>).minZoom,
        DEFAULT_PROJECT_PREFERENCES.map.minZoom,
      ),
      maxZoom: normalizeNumber(
        (map as Partial<ProjectPreferences["map"]>).maxZoom,
        DEFAULT_PROJECT_PREFERENCES.map.maxZoom,
      ),
      maxPitch: normalizeNumber(
        (map as Partial<ProjectPreferences["map"]>).maxPitch,
        DEFAULT_PROJECT_PREFERENCES.map.maxPitch,
      ),
      restrictBounds: Boolean(
        (map as Partial<ProjectPreferences["map"]>).restrictBounds,
      ),
      renderWorldCopies: normalizeBoolean(
        (map as Partial<ProjectPreferences["map"]>).renderWorldCopies,
        true,
      ),
    },
    environmentVariables: Array.isArray(candidate.environmentVariables)
      ? candidate.environmentVariables
          .map(normalizeEnvironmentVariable)
          .filter((variable): variable is RuntimeEnvironmentVariable =>
            Boolean(variable),
          )
      : [],
  };
}

function normalizeBounds(
  bounds: unknown,
): ProjectPreferences["map"]["bounds"] {
  if (
    Array.isArray(bounds) &&
    bounds.length === 4 &&
    bounds.every((value) => Number.isFinite(value))
  ) {
    // Clamp to valid lng/lat ranges so the stored bounds match what the map
    // controller applies, then keep the ordering check so an empty or
    // inverted region falls back to the default instead of being persisted.
    const west = clampCoordinate(Number(bounds[0]), -180, 180);
    const south = clampCoordinate(Number(bounds[1]), -85, 85);
    const east = clampCoordinate(Number(bounds[2]), -180, 180);
    const north = clampCoordinate(Number(bounds[3]), -85, 85);
    if (west < east && south < north) {
      return [west, south, east, north];
    }
  }

  return DEFAULT_PROJECT_PREFERENCES.map.bounds;
}

function normalizeNumber(value: unknown, fallback: number): number {
  return Number.isFinite(value) ? Number(value) : fallback;
}

function clampCoordinate(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

const ENVIRONMENT_VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function normalizeEnvironmentVariable(
  variable: unknown,
): RuntimeEnvironmentVariable | null {
  if (!variable || typeof variable !== "object") return null;
  const candidate = variable as Partial<RuntimeEnvironmentVariable>;
  const key = typeof candidate.key === "string" ? candidate.key.trim() : "";
  if (!key || !ENVIRONMENT_VARIABLE_NAME_PATTERN.test(key)) return null;

  return {
    key,
    value: typeof candidate.value === "string" ? candidate.value : "",
    enabled: normalizeBoolean(candidate.enabled, true),
  };
}

const PROJECT_PLUGIN_CONTROL_POSITIONS = new Set<ProjectPluginControlPosition>([
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
]);

function normalizeProjectPlugins(
  plugins: unknown,
): ProjectPluginState | null {
  if (!plugins || typeof plugins !== "object") return null;

  const candidate = plugins as Partial<ProjectPluginState>;
  const activePluginIds = Array.isArray(candidate.activePluginIds)
    ? uniqueStrings(candidate.activePluginIds)
    : [];
  const mapControlPositions: Record<string, ProjectPluginControlPosition> = {};
  const settings: Record<string, unknown> = {};

  if (
    candidate.mapControlPositions &&
    typeof candidate.mapControlPositions === "object"
  ) {
    for (const [pluginId, position] of Object.entries(
      candidate.mapControlPositions,
    )) {
      if (
        typeof pluginId === "string" &&
        pluginId.trim() &&
        PROJECT_PLUGIN_CONTROL_POSITIONS.has(
          position as ProjectPluginControlPosition,
        )
      ) {
        mapControlPositions[pluginId.trim()] =
          position as ProjectPluginControlPosition;
      }
    }
  }

  if (candidate.settings && typeof candidate.settings === "object") {
    for (const [pluginId, value] of Object.entries(candidate.settings)) {
      if (
        typeof pluginId === "string" &&
        pluginId.trim() &&
        isJsonCompatible(value)
      ) {
        settings[pluginId.trim()] = value;
      }
    }
  }

  return {
    activePluginIds,
    mapControlPositions,
    settings,
  };
}

function uniqueStrings(values: unknown[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const value of values) {
    if (typeof value !== "string") continue;
    const id = value.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    normalized.push(id);
  }

  return normalized;
}

function isJsonCompatible(value: unknown): boolean {
  if (value === null) return true;

  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object":
      if (Array.isArray(value)) return value.every(isJsonCompatible);
      if (!isPlainObject(value)) return false;
      return Object.values(value).every(isJsonCompatible);
    default:
      return false;
  }
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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
  basemapVisible: boolean;
  basemapOpacity: number;
  layers: GeoLibreLayer[];
  preferences: ProjectPreferences;
  plugins?: ProjectPluginState | null;
  metadata: Record<string, unknown>;
}): GeoLibreProject {
  const styles: Record<string, LayerStyle> = {};
  for (const layer of state.layers) {
    styles[layer.id] = layer.style;
  }
  const plugins = normalizeProjectPlugins(state.plugins);
  return {
    version: PROJECT_VERSION,
    name: state.projectName,
    mapView: state.mapView,
    basemapStyleUrl: state.basemapStyleUrl,
    basemapVisible: state.basemapVisible,
    basemapOpacity: state.basemapOpacity,
    layers: state.layers.map(prepareLayerForSave),
    styles,
    preferences: state.preferences,
    ...(plugins ? { plugins } : {}),
    metadata: state.metadata,
  };
}

function prepareLayerForSave(layer: GeoLibreLayer): GeoLibreLayer {
  if (layer.type !== "xyz") return layer;

  const originalUrl =
    typeof layer.metadata.originalUrl === "string" &&
    layer.metadata.originalUrl.trim()
      ? layer.metadata.originalUrl
      : typeof layer.source.url === "string" && layer.source.url.trim()
        ? layer.source.url
        : null;
  if (!originalUrl) return layer;

  const metadata = { ...layer.metadata };
  delete metadata.resolvedUrl;

  return {
    ...layer,
    source: {
      ...layer.source,
      tiles: [originalUrl],
      url: originalUrl,
    },
    metadata,
  };
}

export function applyProjectToStore(project: GeoLibreProject): {
  projectName: string;
  mapView: MapViewState;
  basemapStyleUrl: string;
  basemapVisible: boolean;
  basemapOpacity: number;
  layers: GeoLibreLayer[];
  preferences: ProjectPreferences;
  projectPlugins: ProjectPluginState | null;
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
    basemapVisible: project.basemapVisible ?? true,
    basemapOpacity: project.basemapOpacity ?? 1,
    layers,
    preferences: normalizeProjectPreferences(project.preferences),
    projectPlugins: normalizeProjectPlugins(project.plugins),
    metadata: project.metadata,
  };
}
