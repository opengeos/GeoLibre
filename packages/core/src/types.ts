import type { FeatureCollection } from "geojson";

export const OPENFREEMAP_BASEMAPS = [
  {
    id: "liberty",
    name: "Liberty",
    styleUrl: "https://tiles.openfreemap.org/styles/liberty",
  },
  {
    id: "positron",
    name: "Positron",
    styleUrl: "https://tiles.openfreemap.org/styles/positron",
  },
  {
    id: "bright",
    name: "Bright",
    styleUrl: "https://tiles.openfreemap.org/styles/bright",
  },
  {
    id: "dark",
    name: "Dark",
    styleUrl: "https://tiles.openfreemap.org/styles/dark",
  },
  {
    id: "fiord",
    name: "Fiord",
    styleUrl: "https://tiles.openfreemap.org/styles/fiord",
  },
  {
    id: "liberty-3d",
    name: "3D",
    styleUrl: "https://tiles.openfreemap.org/styles/liberty",
  },
] as const;

export const DEFAULT_BASEMAP = "https://tiles.openfreemap.org/styles/liberty";

export const BLANK_BASEMAP = "";

export const PROJECT_VERSION = "0.1.0";

export type LayerType =
  | "geojson"
  | "raster"
  | "wms"
  | "wmts"
  | "xyz"
  | "vector-tiles"
  | "arcgis"
  | "pmtiles"
  | "mbtiles"
  | "zarr"
  | "lidar"
  | "gaussian-splat"
  | "3d-tiles"
  | "cog"
  | "flatgeobuf"
  | "geoparquet"
  | "duckdb-query";

export type VectorStyleMode =
  | "single"
  | "graduated"
  | "categorized"
  | "expression";

export interface VectorStyleStop {
  value: string | number;
  color: string;
  label?: string;
}

export interface LayerStyle {
  minZoom: number;
  maxZoom: number;
  fillColor: string;
  strokeColor: string;
  strokeWidth: number;
  fillOpacity: number;
  circleRadius: number;
  extrusionEnabled: boolean;
  extrusionColor: string;
  extrusionOpacity: number;
  extrusionHeightProperty: string;
  extrusionHeightScale: number;
  extrusionBase: number;
  extrusionAdvancedStyleEnabled: boolean;
  extrusionColorExpression: string;
  extrusionHeightExpression: string;
  vectorStyleMode: VectorStyleMode;
  vectorStyleProperty: string;
  vectorStyleClassCount: number;
  vectorStyleColorRamp: string;
  vectorStyleClassificationScheme: string;
  vectorStyleStops: VectorStyleStop[];
  vectorStyleExpression: string;
  rasterBrightnessMin: number;
  rasterBrightnessMax: number;
  rasterSaturation: number;
  rasterContrast: number;
  rasterHueRotate: number;
}

export const DEFAULT_LAYER_STYLE: LayerStyle = {
  minZoom: 0,
  maxZoom: 24,
  fillColor: "#3b82f6",
  strokeColor: "#1e40af",
  strokeWidth: 2,
  fillOpacity: 0.6,
  circleRadius: 6,
  extrusionEnabled: false,
  extrusionColor: "#3b82f6",
  extrusionOpacity: 0.8,
  extrusionHeightProperty: "height",
  extrusionHeightScale: 1,
  extrusionBase: 0,
  extrusionAdvancedStyleEnabled: false,
  extrusionColorExpression: "",
  extrusionHeightExpression: "",
  vectorStyleMode: "single",
  vectorStyleProperty: "",
  vectorStyleClassCount: 5,
  vectorStyleColorRamp: "viridis",
  vectorStyleClassificationScheme: "equal-interval",
  vectorStyleStops: [
    { value: 0, color: "#dbeafe" },
    { value: 1, color: "#2563eb" },
  ],
  vectorStyleExpression: "",
  rasterBrightnessMin: 0,
  rasterBrightnessMax: 1,
  rasterSaturation: 0,
  rasterContrast: 0,
  rasterHueRotate: 0,
};

/**
 * Read a layer style property, falling back to the shared default when the
 * layer does not define it. Shared by `@geolibre/map` and the desktop app so
 * the two consumers cannot drift.
 */
export function styleValue<K extends keyof LayerStyle>(
  style: LayerStyle,
  key: K,
): LayerStyle[K] {
  return style[key] ?? DEFAULT_LAYER_STYLE[key];
}

export interface GeoLibreLayer {
  id: string;
  name: string;
  type: LayerType;
  source: Record<string, unknown>;
  visible: boolean;
  opacity: number;
  style: LayerStyle;
  metadata: Record<string, unknown>;
  beforeId?: string;
  geojson?: FeatureCollection;
  sourcePath?: string;
}

export interface MapViewState {
  center: [number, number];
  zoom: number;
  bearing: number;
  pitch: number;
  bbox?: [number, number, number, number];
}

export interface MapPreferences {
  restrictBounds: boolean;
  bounds: [number, number, number, number];
  minZoom: number;
  maxZoom: number;
  maxPitch: number;
  renderWorldCopies: boolean;
}

export interface RuntimeEnvironmentVariable {
  key: string;
  value: string;
  enabled: boolean;
}

declare global {
  interface Window {
    // Runtime environment variables published from project preferences. Shared
    // here so the desktop app and plugins type the global from one source.
    __GEOLIBRE_RUNTIME_ENV__?: Record<string, string>;
  }
}

export interface ProjectPreferences {
  map: MapPreferences;
  environmentVariables: RuntimeEnvironmentVariable[];
}

export type ProjectPluginControlPosition =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

export interface ProjectPluginState {
  manifestUrls: string[];
  activePluginIds: string[];
  mapControlPositions: Record<string, ProjectPluginControlPosition>;
  settings: Record<string, unknown>;
}

export const DEFAULT_PROJECT_PREFERENCES: ProjectPreferences = {
  map: {
    restrictBounds: false,
    bounds: [-180, -85, 180, 85],
    minZoom: 0,
    maxZoom: 24,
    maxPitch: 85,
    renderWorldCopies: true,
  },
  environmentVariables: [],
};

export interface GeoLibreProject {
  version: string;
  name: string;
  mapView: MapViewState;
  basemapStyleUrl: string;
  basemapVisible: boolean;
  basemapOpacity: number;
  layers: GeoLibreLayer[];
  styles: Record<string, LayerStyle>;
  preferences: ProjectPreferences;
  plugins?: ProjectPluginState;
  metadata: Record<string, unknown>;
}

export interface RecentProjectEntry {
  path: string;
  name: string;
  openedAt: string;
}
