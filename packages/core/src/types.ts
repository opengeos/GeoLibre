import type { FeatureCollection } from "geojson";

export const DEFAULT_BASEMAP =
  "https://tiles.openfreemap.org/styles/liberty";

export const PROJECT_VERSION = "0.1.0";

export type LayerType =
  | "geojson"
  | "xyz"
  | "vector-tiles"
  | "pmtiles"
  | "cog"
  | "flatgeobuf"
  | "geoparquet"
  | "duckdb-query";

export interface LayerStyle {
  fillColor: string;
  strokeColor: string;
  strokeWidth: number;
  fillOpacity: number;
  circleRadius: number;
}

export const DEFAULT_LAYER_STYLE: LayerStyle = {
  fillColor: "#3b82f6",
  strokeColor: "#1e40af",
  strokeWidth: 2,
  fillOpacity: 0.6,
  circleRadius: 6,
};

export interface GeoLibreLayer {
  id: string;
  name: string;
  type: LayerType;
  source: Record<string, unknown>;
  visible: boolean;
  opacity: number;
  style: LayerStyle;
  metadata: Record<string, unknown>;
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
  layers: GeoLibreLayer[];
  styles: Record<string, LayerStyle>;
  metadata: Record<string, unknown>;
}

export interface RecentProjectEntry {
  path: string;
  name: string;
  openedAt: string;
}
