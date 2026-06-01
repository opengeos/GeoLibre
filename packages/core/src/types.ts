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
  | "cog"
  | "flatgeobuf"
  | "geoparquet"
  | "duckdb-query";

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

export interface GeoLibreProject {
  version: string;
  name: string;
  mapView: MapViewState;
  basemapStyleUrl: string;
  basemapVisible: boolean;
  basemapOpacity: number;
  layers: GeoLibreLayer[];
  styles: Record<string, LayerStyle>;
  metadata: Record<string, unknown>;
}

export interface RecentProjectEntry {
  path: string;
  name: string;
  openedAt: string;
}
