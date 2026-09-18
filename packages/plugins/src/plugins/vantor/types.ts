import type { Polygon, MultiPolygon } from "geojson";
import type { CogAdder, CogRenderEngine, CogRenderEngineSetter, RasterLoader } from "./cog-layer";

export interface StacLink {
  rel: string;
  href: string;
  type?: string;
  title?: string;
}

export interface StacCatalog {
  type: "Catalog";
  id: string;
  stac_version: string;
  description: string;
  license?: string;
  links: StacLink[];
}

export interface StacCollection {
  type: "Collection";
  id: string;
  stac_version: string;
  title?: string;
  description: string;
  license?: string;
  extent: {
    spatial: { bbox: number[][] };
    temporal: { interval: [string, string][] };
  };
  links: StacLink[];
}

export interface StacAsset {
  href: string;
  type: string;
  title?: string;
  roles?: string[];
}

export interface StacItemProperties {
  title?: string;
  datetime?: string;
  phase?: "pre" | "post" | string;
  vehicle_name?: string;
  constellation?: string;
  "eo:cloud_cover"?: number;
  pan_gsd?: number;
  multispectral_gsd?: number;
  "view:off_nadir"?: number;
  "view:azimuth"?: number;
  "view:sun_azimuth"?: number;
  "view:sun_elevation"?: number;
  published?: string;
  [key: string]: unknown;
}

export interface StacItem {
  type: "Feature";
  id: string;
  stac_version?: string;
  geometry: Polygon | MultiPolygon | null;
  bbox?: [number, number, number, number];
  properties: StacItemProperties;
  assets: Record<string, StacAsset>;
  links: StacLink[];
  collection?: string;
  stac_extensions?: string[];
}

export interface EventInfo {
  id: string;
  title: string;
  href: string;
}

export interface BBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

export type VantorTranslate = (
  key: string,
  defaultValue: string,
  params?: Record<string, string | number>,
) => string;

export type PhaseFilter = "all" | "pre" | "post";

export interface ItemProperties {
  id: string;
  datetime: string;
  phase: string;
  sensor: string;
  cloud_cover: number | string;
  pan_gsd: number | string;
  ms_gsd: number | string;
  off_nadir: number | string;
}

export interface VantorControlOptions {
  catalogUrl?: string;
  position?: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  collapsed?: boolean;
  panelWidth?: number;
  maxHeight?: number | string;
  /**
   * Color theme for the panel.
   * - 'auto' (default): follow the OS `prefers-color-scheme`.
   * - 'light' / 'dark': force the theme regardless of OS preference.
   * Use {@link VantorControl.setTheme} to switch at runtime (e.g. to sync with
   * a host app that has its own dark-mode toggle).
   */
  theme?: "auto" | "light" | "dark";
  /** Initial COG rendering engine. Defaults to the faster GPU renderer. */
  renderEngine?: CogRenderEngine;
  /** Translate panel text; the English default is used when omitted. */
  translate?: VantorTranslate;
  /**
   * Supplies the maplibre-gl-raster module used for COG rendering. Defaults to a
   * dynamic `import('maplibre-gl-raster')`. A host such as GeoLibre can pass its
   * own instance (via `app.getMaplibreGlRaster()`) so COGs render on the host's
   * single deck.gl/luma.gl instead of a bundled second copy.
   */
  rasterLoader?: RasterLoader;
  /**
   * Renders a COG through the host instead of the bundled deck.gl pipeline. When
   * provided (e.g. GeoLibre's `app.addCogLayer`), each COG becomes a native
   * host-managed layer that appears in the host's Layers panel; takes precedence
   * over {@link rasterLoader}. Omit for standalone use.
   */
  cogAdder?: CogAdder;
  /** Switches the host's control-wide renderer for existing COG layers. */
  cogRenderEngineSetter?: CogRenderEngineSetter;
  onItemsLoaded?: (items: StacItem[]) => void;
  onSelectionChange?: (selectedItems: StacItem[]) => void;
}
