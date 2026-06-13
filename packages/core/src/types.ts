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
  | "duckdb-query"
  | "deckgl-viz"
  | "video";

export type VectorStyleMode =
  | "single"
  | "graduated"
  | "categorized"
  | "expression";

/**
 * How a point layer is rendered: as individual markers, a density heatmap, or
 * clustered bubbles. Only applies to point geometry.
 */
export type PointRenderer = "single" | "heatmap" | "cluster";

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
  textColor: string;
  textHaloColor: string;
  textHaloWidth: number;
  textSize: number;
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
  pointRenderer: PointRenderer;
  heatmapRadius: number;
  heatmapIntensity: number;
  clusterRadius: number;
  clusterMaxZoom: number;
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
  textColor: "#111827",
  textHaloColor: "#ffffff",
  textHaloWidth: 2,
  textSize: 16,
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
  pointRenderer: "single",
  heatmapRadius: 30,
  heatmapIntensity: 1,
  clusterRadius: 50,
  clusterMaxZoom: 14,
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

/**
 * Detect a DuckDB query layer rendered through the plugin's external deck.gl
 * overlay. Shared by `@geolibre/map`, `@geolibre/plugins`, and the desktop
 * app so the detection criteria cannot drift.
 */
export function isDuckDBQueryLayer(
  layer: Pick<GeoLibreLayer, "metadata" | "type"> | undefined,
): boolean {
  return (
    layer?.type === "duckdb-query" &&
    layer.metadata.sourceKind === "duckdb-query" &&
    layer.metadata.externalDeckLayer === true
  );
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

/**
 * A single user override for one legend item, keyed in {@link LegendConfig.overrides}
 * by a stable item key (a layer id for a whole entry, or `${layerId}::${index}`
 * for an individual class within a graduated/categorized entry).
 */
export interface LegendItemOverride {
  /** User-supplied label that replaces the auto-generated one. */
  label?: string;
  /** When true, the item is omitted from the rendered legend. */
  hidden?: boolean;
}

/**
 * User customizations for the Print Layout legend. The legend itself is always
 * derived from the visible layers' symbology; this record only stores the edits
 * layered on top (title, ordering, per-item rename/hide), so it survives layer
 * additions and removals and is persisted in the `.geolibre.json` project.
 */
export interface LegendConfig {
  /** Heading drawn above the legend entries. */
  title: string;
  /** When true, classes are grouped under a per-layer heading. */
  groupByLayer: boolean;
  /**
   * Custom top-level entry order by layer id, top-first. Layer ids not listed
   * keep their default order after the listed ones.
   */
  order: string[];
  /** Per-item overrides keyed by stable item key. */
  overrides: Record<string, LegendItemOverride>;
}

export const DEFAULT_LEGEND_CONFIG: LegendConfig = {
  title: "Legend",
  groupByLayer: true,
  order: [],
  overrides: {},
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
  /** User customizations for the Print Layout legend. */
  legend?: LegendConfig;
  metadata: Record<string, unknown>;
}

export interface RecentProjectEntry {
  path: string;
  name: string;
  openedAt: string;
}
