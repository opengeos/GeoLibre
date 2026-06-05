import {
  DEFAULT_LAYER_STYLE,
  type GeoLibreLayer,
  useAppStore,
} from "@geolibre/core";
import type { Layer } from "@deck.gl/core";
import type { MapboxOverlay } from "@deck.gl/mapbox";
import {
  RasterLayer,
  type RasterLayerProps,
} from "@developmentseed/deck.gl-raster";
import { fromArrayBuffer } from "geotiff";
import type maplibregl from "maplibre-gl";
import proj4 from "proj4";
import type {
  AddVectorControl,
  AddVectorEventHandler,
  AddVectorLayerInfo,
  AddVectorControlOptions,
  CogLayerControl,
  CogLayerControlOptions,
  CogLayerEventHandler,
  CogLayerInfo,
  ColorbarGuiControl,
  ColorbarGuiControlOptions,
  ControlGrid,
  ControlGridOptions,
  DefaultControlName,
  GaussianSplatControl,
  GaussianSplatLayerAdapter,
  HtmlGuiControl,
  HtmlGuiControlOptions,
  LegendGuiControl,
  LegendGuiControlOptions,
  LidarControl,
  LidarLayerAdapter,
  PMTilesLayerControl,
  PMTilesLayerControlOptions,
  PMTilesLayerEventHandler,
  PMTilesLayerInfo,
  SearchControl,
  SearchControlOptions,
  StacSearchControl,
  StacSearchControlOptions,
  StacSearchEventHandler,
  StacSearchItem,
  ZarrLayerControl,
  ZarrLayerControlOptions,
  ZarrLayerEventHandler,
  ZarrLayerInfo,
} from "maplibre-gl-components";
import type {
  LidarControlEventHandler,
  PointCloudInfo,
} from "maplibre-gl-lidar";
import type {
  GeoLibreAppAPI,
  GeoLibreMapControlPosition,
  GeoLibrePlugin,
} from "../types";
import { ensureMercatorProjection } from "./map-projection-utils";

type ControlGridConstructor =
  (typeof import("maplibre-gl-components"))["ControlGrid"];
type AddVectorControlConstructor =
  (typeof import("maplibre-gl-components"))["AddVectorControl"];
type CogLayerControlConstructor =
  (typeof import("maplibre-gl-components"))["CogLayerControl"];
type ColorbarGuiControlConstructor =
  (typeof import("maplibre-gl-components"))["ColorbarGuiControl"];
type PMTilesLayerControlConstructor =
  (typeof import("maplibre-gl-components"))["PMTilesLayerControl"];
type SearchControlConstructor =
  (typeof import("maplibre-gl-components"))["SearchControl"];
type StacSearchControlConstructor =
  (typeof import("maplibre-gl-components"))["StacSearchControl"];
type ZarrLayerControlConstructor =
  (typeof import("maplibre-gl-components"))["ZarrLayerControl"];
type HtmlGuiControlConstructor =
  (typeof import("maplibre-gl-components"))["HtmlGuiControl"];
type LegendGuiControlConstructor =
  (typeof import("maplibre-gl-components"))["LegendGuiControl"];
type LidarControlConstructor =
  (typeof import("maplibre-gl-components"))["LidarControl"];
type LidarLayerAdapterConstructor =
  (typeof import("maplibre-gl-components"))["LidarLayerAdapter"];
type GaussianSplatControlConstructor =
  (typeof import("maplibre-gl-components"))["GaussianSplatControl"];
type GaussianSplatLayerAdapterConstructor =
  (typeof import("maplibre-gl-components"))["GaussianSplatLayerAdapter"];

interface LidarControlClickOutsideState {
  _clickOutsideHandler?: ((event: MouseEvent) => void) | null;
}

interface SplattingControlVisibilityState {
  _container?: HTMLElement | null;
}

interface ComponentsConstructors {
  AddVectorControl: AddVectorControlConstructor;
  CogLayerControl: CogLayerControlConstructor;
  ColorbarGuiControl: ColorbarGuiControlConstructor;
  ControlGrid: ControlGridConstructor;
  GaussianSplatControl: GaussianSplatControlConstructor;
  GaussianSplatLayerAdapter: GaussianSplatLayerAdapterConstructor;
  HtmlGuiControl: HtmlGuiControlConstructor;
  LegendGuiControl: LegendGuiControlConstructor;
  LidarControl: LidarControlConstructor;
  LidarLayerAdapter: LidarLayerAdapterConstructor;
  PMTilesLayerControl: PMTilesLayerControlConstructor;
  SearchControl: SearchControlConstructor;
  StacSearchControl: StacSearchControlConstructor;
  ZarrLayerControl: ZarrLayerControlConstructor;
}

let componentsControlPosition: GeoLibreMapControlPosition = "top-right";
const cogRasterControlPosition: GeoLibreMapControlPosition = "top-left";
const flatGeobufControlPosition: GeoLibreMapControlPosition = "top-left";
const pmtilesControlPosition: GeoLibreMapControlPosition = "top-left";
const searchControlPosition: GeoLibreMapControlPosition = "top-right";
const stacSearchControlPosition: GeoLibreMapControlPosition = "top-left";
const zarrControlPosition: GeoLibreMapControlPosition = "top-left";
const colorbarControlPosition: GeoLibreMapControlPosition = "top-left";
const legendControlPosition: GeoLibreMapControlPosition = "top-left";
const htmlControlPosition: GeoLibreMapControlPosition = "top-left";
const lidarControlPosition: GeoLibreMapControlPosition = "top-left";
const splattingControlPosition: GeoLibreMapControlPosition = "top-left";

const FLATGEOBUF_SAMPLE_URL =
  "https://flatgeobuf.org/test/data/UScounties.fgb";
const PMTILES_SAMPLE_URL =
  "https://overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com/tiles/2026-05-20.0/buildings.pmtiles";
const ZARR_SAMPLE_URL =
  "https://carbonplan-maps.s3.us-west-2.amazonaws.com/v2/demo/4d/tavg-prec-month";
const LIDAR_SAMPLE_URL =
  "https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz";
const SPLATTING_SAMPLE_URL =
  "https://maplibre.org/maplibre-gl-js/docs/assets/34M_17/34M_17.gltf";
const RASTER_PROXY_PATH = "/__geolibre_raster_proxy";
const GUI_PANEL_VIEWPORT_MARGIN = 16;

const COMPONENT_CONTROL_NAMES = [
  "spinGlobe",
  "fullscreen",
  "north",
  "terrain",
  "search",
  "viewState",
  "inspect",
  "vectorDataset",
  "basemap",
  "measure",
  "geoEditor",
  "bookmark",
  "print",
  "swipe",
  "streetView",
  "addVector",
  "cogLayer",
  "zarrLayer",
  "pmtilesLayer",
  "stacLayer",
  "stacSearch",
  "planetaryComputer",
  "gaussianSplat",
  "colorbarGui",
  "legendGui",
  "htmlGui",
  "lidar",
  "usgsLidar",
] satisfies DefaultControlName[];

const COMPONENTS_OPTIONS = {
  className: "geolibre-components-control",
  collapsed: false,
  columns: 5,
  defaultControls: COMPONENT_CONTROL_NAMES,
  excludeLayers: [
    "usgs-lidar-*",
    "lidar-*",
    "mapbox-gl-draw-*",
    "gl-draw-*",
    "gm_*",
    "inspect-highlight-*",
    "measure-*",
  ],
  gap: 2,
  rows: 5,
  showRowColumnControls: true,
} satisfies Omit<ControlGridOptions, "position" | "basemapStyleUrl">;

const ADD_VECTOR_OPTIONS = {
  backgroundColor: "hsl(var(--popover))",
  className: "geolibre-flatgeobuf-control",
  collapsed: false,
  defaultFormat: "flatgeobuf",
  defaultPickable: false,
  defaultUrl: FLATGEOBUF_SAMPLE_URL,
  fontColor: "hsl(var(--popover-foreground))",
} satisfies AddVectorControlOptions;

const COG_RASTER_OPTIONS = {
  backgroundColor: "hsl(var(--popover))",
  className: "geolibre-cog-raster-control",
  collapsed: true,
  defaultBands: "1",
  defaultColormap: "none",
  defaultOpacity: 1,
  defaultPickable: false,
  defaultRescaleMax: 255,
  defaultRescaleMin: 0,
  fontColor: "hsl(var(--popover-foreground))",
  visible: false,
} satisfies CogLayerControlOptions;

const PMTILES_OPTIONS = {
  backgroundColor: "hsl(var(--popover))",
  className: "geolibre-pmtiles-control",
  collapsed: false,
  defaultCircleColor: DEFAULT_LAYER_STYLE.fillColor,
  defaultFillColor: DEFAULT_LAYER_STYLE.fillColor,
  defaultLineColor: DEFAULT_LAYER_STYLE.strokeColor,
  defaultOpacity: 0.8,
  defaultPickable: false,
  defaultUrl: PMTILES_SAMPLE_URL,
  fontColor: "hsl(var(--popover-foreground))",
} satisfies PMTilesLayerControlOptions;

const SEARCH_OPTIONS = {
  backgroundColor: "hsl(var(--popover))",
  className: "geolibre-search-control",
  collapsed: false,
  fontColor: "hsl(var(--popover-foreground))",
  maxResults: 8,
  placeholder: "Search places...",
  width: 320,
} satisfies SearchControlOptions;

const STAC_SEARCH_OPTIONS = {
  backgroundColor: "hsl(var(--popover))",
  className: "geolibre-stac-search-control",
  collapsed: false,
  defaultColormap: "viridis",
  defaultRescaleMax: 10000,
  defaultRescaleMin: 0,
  defaultRgbMode: true,
  fontColor: "hsl(var(--popover-foreground))",
  maxHeight: 560,
  panelWidth: 365,
  showFootprints: true,
} satisfies StacSearchControlOptions;

const COLORBAR_OPTIONS = {
  backgroundColor: "hsl(var(--popover))",
  className: "geolibre-colorbar-control",
  collapsed: false,
  fontColor: "hsl(var(--popover-foreground))",
  maxHeight: 520,
  panelWidth: 320,
  position: colorbarControlPosition,
} satisfies ColorbarGuiControlOptions;

const LEGEND_OPTIONS = {
  backgroundColor: "hsl(var(--popover))",
  className: "geolibre-legend-control",
  collapsed: false,
  fontColor: "hsl(var(--popover-foreground))",
  maxHeight: 520,
  panelWidth: 320,
  position: legendControlPosition,
} satisfies LegendGuiControlOptions;

const HTML_OPTIONS = {
  backgroundColor: "hsl(var(--popover))",
  className: "geolibre-html-control",
  collapsed: false,
  fontColor: "hsl(var(--popover-foreground))",
  maxHeight: 520,
  panelWidth: 340,
  position: htmlControlPosition,
} satisfies HtmlGuiControlOptions;

const STAC_COLOR_RAMP_MODULE = {
  name: "geolibre-stac-color-ramp",
  inject: {
    "fs:DECKGL_FILTER_COLOR": `
      float v = clamp(color.r, 0.0, 1.0);
      vec3 c0 = vec3(0.267, 0.005, 0.329);
      vec3 c1 = vec3(0.283, 0.141, 0.458);
      vec3 c2 = vec3(0.254, 0.265, 0.530);
      vec3 c3 = vec3(0.207, 0.372, 0.553);
      vec3 c4 = vec3(0.164, 0.471, 0.558);
      vec3 c5 = vec3(0.128, 0.567, 0.551);
      vec3 c6 = vec3(0.135, 0.659, 0.518);
      vec3 c7 = vec3(0.267, 0.749, 0.441);
      vec3 c8 = vec3(0.478, 0.821, 0.318);
      vec3 c9 = vec3(0.741, 0.873, 0.150);
      vec3 c10 = vec3(0.993, 0.906, 0.144);
      vec3 rgb = mix(c0, c1, smoothstep(0.0, 0.1, v));
      rgb = mix(rgb, c2, smoothstep(0.1, 0.2, v));
      rgb = mix(rgb, c3, smoothstep(0.2, 0.3, v));
      rgb = mix(rgb, c4, smoothstep(0.3, 0.4, v));
      rgb = mix(rgb, c5, smoothstep(0.4, 0.5, v));
      rgb = mix(rgb, c6, smoothstep(0.5, 0.6, v));
      rgb = mix(rgb, c7, smoothstep(0.6, 0.7, v));
      rgb = mix(rgb, c8, smoothstep(0.7, 0.8, v));
      rgb = mix(rgb, c9, smoothstep(0.8, 0.9, v));
      rgb = mix(rgb, c10, smoothstep(0.9, 1.0, v));
      color = vec4(rgb, color.a);
    `,
  },
};

const STAC_COLOR_RAMP_COLORS: Record<string, string[]> = {
  cividis: [
    "vec3(0.000, 0.126, 0.302)",
    "vec3(0.188, 0.243, 0.416)",
    "vec3(0.337, 0.372, 0.431)",
    "vec3(0.505, 0.504, 0.375)",
    "vec3(0.735, 0.680, 0.308)",
    "vec3(0.996, 0.909, 0.218)",
  ],
  hot: [
    "vec3(0.041, 0.000, 0.000)",
    "vec3(0.365, 0.000, 0.000)",
    "vec3(0.729, 0.000, 0.000)",
    "vec3(1.000, 0.318, 0.000)",
    "vec3(1.000, 0.729, 0.000)",
    "vec3(1.000, 1.000, 0.700)",
  ],
  inferno: [
    "vec3(0.001, 0.000, 0.014)",
    "vec3(0.197, 0.038, 0.368)",
    "vec3(0.472, 0.111, 0.428)",
    "vec3(0.730, 0.212, 0.333)",
    "vec3(0.929, 0.472, 0.178)",
    "vec3(0.988, 0.998, 0.645)",
  ],
  magma: [
    "vec3(0.001, 0.000, 0.014)",
    "vec3(0.172, 0.067, 0.372)",
    "vec3(0.445, 0.123, 0.507)",
    "vec3(0.716, 0.215, 0.475)",
    "vec3(0.945, 0.464, 0.365)",
    "vec3(0.987, 0.991, 0.749)",
  ],
  plasma: [
    "vec3(0.050, 0.030, 0.528)",
    "vec3(0.363, 0.003, 0.649)",
    "vec3(0.611, 0.090, 0.620)",
    "vec3(0.798, 0.280, 0.470)",
    "vec3(0.929, 0.512, 0.298)",
    "vec3(0.940, 0.975, 0.131)",
  ],
  terrain: [
    "vec3(0.200, 0.200, 0.600)",
    "vec3(0.000, 0.600, 0.450)",
    "vec3(0.450, 0.700, 0.300)",
    "vec3(0.750, 0.650, 0.350)",
    "vec3(0.600, 0.450, 0.300)",
    "vec3(1.000, 1.000, 1.000)",
  ],
  turbo: [
    "vec3(0.190, 0.072, 0.232)",
    "vec3(0.252, 0.357, 0.813)",
    "vec3(0.276, 0.718, 0.650)",
    "vec3(0.663, 0.864, 0.196)",
    "vec3(0.974, 0.573, 0.040)",
    "vec3(0.480, 0.016, 0.011)",
  ],
  viridis: [
    "vec3(0.267, 0.005, 0.329)",
    "vec3(0.254, 0.265, 0.530)",
    "vec3(0.164, 0.471, 0.558)",
    "vec3(0.135, 0.659, 0.518)",
    "vec3(0.478, 0.821, 0.318)",
    "vec3(0.993, 0.906, 0.144)",
  ],
};

function getStacColorRampModule(colormap: string): typeof STAC_COLOR_RAMP_MODULE {
  const colors = STAC_COLOR_RAMP_COLORS[colormap.toLowerCase()];
  if (!colors) return STAC_COLOR_RAMP_MODULE;

  const step = 1 / (colors.length - 1);
  const mixes = colors.slice(1).map((color, index) => {
    const lower = (index * step).toFixed(3);
    const upper = ((index + 1) * step).toFixed(3);
    return `rgb = mix(rgb, ${color}, smoothstep(${lower}, ${upper}, v));`;
  });

  return {
    name: `geolibre-stac-color-ramp-${colormap.toLowerCase()}`,
    inject: {
      "fs:DECKGL_FILTER_COLOR": `
        float v = clamp(color.r, 0.0, 1.0);
        vec3 rgb = ${colors[0]};
        ${mixes.join("\n")}
        color = vec4(rgb, color.a);
      `,
    },
  };
}

const ZARR_OPTIONS = {
  backgroundColor: "hsl(var(--popover))",
  className: "geolibre-zarr-control",
  collapsed: false,
  defaultClim: [0, 300],
  defaultColormap: [
    "#f7fbff",
    "#deebf7",
    "#c6dbef",
    "#9ecae1",
    "#6baed6",
    "#4292c6",
    "#2171b5",
    "#08519c",
    "#08306b",
  ],
  defaultOpacity: 0.85,
  defaultPickable: false,
  defaultSelector: { band: "prec", month: 1 },
  defaultUrl: ZARR_SAMPLE_URL,
  defaultVariable: "climate",
  fontColor: "hsl(var(--popover-foreground))",
} satisfies ZarrLayerControlOptions;

const LIDAR_OPTIONS = {
  title: "Add LiDAR Layer",
  collapsed: false,
  className: "geolibre-lidar-layer-control",
  panelWidth: 365,
  maxHeight: 520,
  pointSize: 2,
  colorScheme: "elevation",
  pickable: false,
  autoZoom: true,
} satisfies ConstructorParameters<LidarControlConstructor>[0];

const SPLATTING_OPTIONS = {
  className: "geolibre-splatting-control",
  collapsed: false,
  defaultAltitude: 0,
  defaultLatitude: -35.39847,
  defaultLongitude: 148.9819,
  defaultRotation: [-90, 90, 0],
  defaultScale: 0.03,
  defaultUrl: SPLATTING_SAMPLE_URL,
  flyTo: true,
  maxHeight: 520,
  panelWidth: 365,
  title: "Gaussian Splats",
} satisfies ConstructorParameters<GaussianSplatControlConstructor>[0];

let componentsControl: ControlGrid | null = null;
let cogRasterControl: CogLayerControl | null = null;
let flatGeobufControl: AddVectorControl | null = null;
let pmtilesControl: PMTilesLayerControl | null = null;
let searchControl: SearchControl | null = null;
let stacSearchControl: StacSearchControl | null = null;
let zarrControl: ZarrLayerControl | null = null;
let colorbarControl: ColorbarGuiControl | null = null;
let legendControl: LegendGuiControl | null = null;
let htmlControl: HtmlGuiControl | null = null;
let lidarControl: LidarControl | null = null;
let lidarLayerAdapter: LidarLayerAdapter | null = null;
let splattingControl: GaussianSplatControl | null = null;
let splattingLayerAdapter: GaussianSplatLayerAdapter | null = null;
let geoTiffRasterOverlay: MapboxOverlay | null = null;
let flatGeobufControlMounted = false;
let cogRasterControlMounted = false;
let geoTiffRasterOverlayMounted = false;
let pmtilesControlMounted = false;
let searchControlMounted = false;
let stacSearchControlMounted = false;
let zarrControlMounted = false;
let colorbarControlMounted = false;
let legendControlMounted = false;
let htmlControlMounted = false;
let lidarControlMounted = false;
let splattingControlMounted = false;
let flatGeobufStoreUnsubscribe: (() => void) | null = null;
let cogRasterStoreUnsubscribe: (() => void) | null = null;
let geoTiffRasterStoreUnsubscribe: (() => void) | null = null;
let pmtilesStoreUnsubscribe: (() => void) | null = null;
let stacSearchStoreUnsubscribe: (() => void) | null = null;
let zarrStoreUnsubscribe: (() => void) | null = null;
let lidarStoreUnsubscribe: (() => void) | null = null;
let splattingStoreUnsubscribe: (() => void) | null = null;
let pluginActive = false;
let componentsControlRevision = 0;
let componentsConstructorsPromise: Promise<ComponentsConstructors> | null =
  null;
let searchPlacesPanelVisible = false;
const searchPlacesPanelListeners = new Set<() => void>();
let colorbarPanelVisible = false;
const colorbarPanelListeners = new Set<() => void>();
let legendPanelVisible = false;
const legendPanelListeners = new Set<() => void>();
let htmlPanelVisible = false;
const htmlPanelListeners = new Set<() => void>();

function constrainGuiPanelToViewport(panelSelector: string): void {
  // Defer measurement until after the expanded panel has been laid out so
  // getBoundingClientRect() reflects the fully expanded dimensions.
  requestAnimationFrame(() => {
    const panel = document.querySelector<HTMLElement>(panelSelector);
    if (!panel) return;

    // Clear previously-applied inline constraints before re-measuring so
    // they don't suppress the overflow check on subsequent opens.
    panel.style.maxHeight = "";
    panel.style.maxWidth = "";

    const rect = panel.getBoundingClientRect();
    const availableHeight = Math.floor(
      window.innerHeight - rect.top - GUI_PANEL_VIEWPORT_MARGIN,
    );
    if (availableHeight > 160 && rect.bottom > window.innerHeight) {
      panel.style.maxHeight = `${availableHeight}px`;
    }

    const availableWidth = Math.floor(
      window.innerWidth - rect.left - GUI_PANEL_VIEWPORT_MARGIN,
    );
    if (availableWidth > 220 && rect.right > window.innerWidth) {
      panel.style.maxWidth = `${availableWidth}px`;
    }
  });
}

export interface CogRasterLayerOptions {
  url: string;
  data?: ArrayBuffer;
  name?: string;
  bands?: string;
  colormap?: CogLayerControlOptions["defaultColormap"];
  rescaleMin?: number;
  rescaleMax?: number;
  nodata?: number;
  opacity?: number;
  beforeLayerId?: string | null;
}

type MutableCogLayerControl = {
  _options?: CogLayerControlOptions;
  _render?: () => void;
  _state?: {
    bands: string;
    colormap: CogLayerControlOptions["defaultColormap"];
    layerName: string;
    layerOpacity: number;
    nodata: number | undefined;
    pickable: boolean;
    rescaleMax: number;
    rescaleMin: number;
    url: string;
  };
};

const pendingCogRasterLayerOptions: CogRasterLayerOptions[] = [];
const ignoredCogRasterLayerUrls = new Set<string>();
const geoTiffRasterLayerProps = new Map<string, GeoTiffRasterLayerState>();
const geoTiffRasterLayers = new Map<string, Layer>();
let geoTiffRasterLayerSequence = 0;
let stacCogLayerPatched = false;
let stacGeoKeysParserPromise: Promise<StacGeoKeysParser> | null = null;

interface GeoTiffRasterLayerState {
  bounds?: [number, number, number, number];
  id: string;
  raster: GeoTiffRasterData;
  name: string;
  opacity: number;
  options: CogRasterLayerOptions;
  url: string;
  visible: boolean;
}

interface GeoTiffRasterData {
  height: number;
  image: ImageData;
  reprojectionFns: RasterLayerProps["reprojectionFns"];
  width: number;
}

interface GeoTiffImageLike {
  getHeight: () => number;
  getOrigin: () => number[];
  getResolution: () => number[];
  getWidth: () => number;
}

interface MutableStacSearchControl {
  _addCogLayer?: (
    url: string,
    item: StacSearchItem,
    assetKey: string,
  ) => Promise<void>;
  _cogLayers?: Map<string, StacSearchRenderableLayer>;
  _convertS3ToHttps?: (url: string) => string;
  _deckOverlay?: MapboxOverlay | null;
  _ensureOverlay?: () => Promise<void>;
  _emit?: (type: string, detail?: Record<string, unknown>) => void;
  _layerCounter?: number;
  _map?: maplibregl.Map;
  _removeLayer?: (id?: string) => void;
  _render?: () => void;
  _state?: {
    colormap?: string;
    hasLayer?: boolean;
    isRgbMode?: boolean;
    layerCount?: number;
    rescaleMax?: number;
    rescaleMin?: number;
    rgbBands?: {
      b?: string | null;
      g?: string | null;
      r?: string | null;
    };
    selectedBand?: string | null;
    status?: string | null;
  };
}

type StacSearchRenderableLayer =
  | Layer
  | {
      layerId?: string;
      sourceId?: string;
      type?: string;
    };

interface StacSearchLayerSnapshot {
  id: string;
  layer: StacSearchRenderableLayer;
}

interface StacLayerControlPatcher {
  _patchCOGLayer?: (COGLayerClass: unknown) => void;
  _patchCOGLayerForFloat?: (COGLayerClass: unknown) => void;
  _patchCOGLayerForOpacity?: (COGLayerClass: unknown) => void;
}

type StacGeoKeysParser = (geoKeys: Record<string, unknown>) => Promise<{
  coordinatesUnits: string;
  def: string;
  parsed: Record<string, unknown>;
} | null>;

type RasterBandValues =
  | Float32Array
  | Float64Array
  | Int8Array
  | Int16Array
  | Int32Array
  | Uint8Array
  | Uint8ClampedArray
  | Uint16Array
  | Uint32Array;

interface StacCogImageLike {
  cachedTags?: {
    bitsPerSample?: ArrayLike<number>;
    nodata?: number | null;
    photometric?: number;
    sampleFormat?: ArrayLike<number>;
    samplesPerPixel?: number;
  };
  fetchTile: (
    x: number,
    y: number,
    options: {
      boundless: boolean;
      pool?: unknown;
      signal?: AbortSignal;
    },
  ) => Promise<{
    array: {
      data: RasterBandValues;
      height: number;
      layout?: string;
      mask?: Uint8Array | null;
      nodata?: number | null;
      width: number;
    };
  }>;
}

interface StacCogTileOptions {
  device: {
    createTexture: (props: Record<string, unknown>) => unknown;
  };
  pool?: unknown;
  signal?: AbortSignal;
  x: number;
  y: number;
}

interface StacCogTileData {
  byteLength: number;
  height: number;
  isRgb: boolean;
  texture: unknown;
  width: number;
}

interface StacColorStop {
  color: string;
  position: number;
}

interface StacCogRenderOptions {
  colormap: string;
  isRgbMode: boolean;
  rescaleMax: number;
  rescaleMin: number;
}

interface StacCogTextureHelper {
  inferTextureFormat?: (
    samplesPerPixel: number,
    bitsPerSample: unknown,
    sampleFormat: unknown,
  ) => string;
}

const getComponentsConstructors = (): Promise<ComponentsConstructors> => {
  componentsConstructorsPromise ??= import("maplibre-gl-components").then(
    ({
      AddVectorControl: AddVectorControlClass,
      CogLayerControl: CogLayerControlClass,
      ColorbarGuiControl: ColorbarGuiControlClass,
      ControlGrid: ControlGridClass,
      GaussianSplatControl: GaussianSplatControlClass,
      GaussianSplatLayerAdapter: GaussianSplatLayerAdapterClass,
      HtmlGuiControl: HtmlGuiControlClass,
      LegendGuiControl: LegendGuiControlClass,
      LidarControl: LidarControlClass,
      LidarLayerAdapter: LidarLayerAdapterClass,
      PMTilesLayerControl: PMTilesLayerControlClass,
      SearchControl: SearchControlClass,
      StacSearchControl: StacSearchControlClass,
      ZarrLayerControl: ZarrLayerControlClass,
    }) => ({
      AddVectorControl: AddVectorControlClass,
      CogLayerControl: CogLayerControlClass,
      ColorbarGuiControl: ColorbarGuiControlClass,
      ControlGrid: ControlGridClass,
      GaussianSplatControl: GaussianSplatControlClass,
      GaussianSplatLayerAdapter: GaussianSplatLayerAdapterClass,
      HtmlGuiControl: HtmlGuiControlClass,
      LegendGuiControl: LegendGuiControlClass,
      LidarControl: LidarControlClass,
      LidarLayerAdapter: LidarLayerAdapterClass,
      PMTilesLayerControl: PMTilesLayerControlClass,
      SearchControl: SearchControlClass,
      StacSearchControl: StacSearchControlClass,
      ZarrLayerControl: ZarrLayerControlClass,
    }),
  );
  return componentsConstructorsPromise;
};

const createComponentsControl = async (
  app: GeoLibreAppAPI,
): Promise<ControlGrid | null> => {
  const { ControlGrid: ControlGridClass } = await getComponentsConstructors();
  if (!pluginActive) return null;
  return new ControlGridClass(getComponentsOptions(app));
};

const createAndMountComponentsControl = (app: GeoLibreAppAPI): void => {
  const revision = ++componentsControlRevision;
  void createComponentsControl(app).then((control) => {
    if (
      !pluginActive ||
      componentsControl ||
      !control ||
      revision !== componentsControlRevision
    ) {
      return;
    }
    componentsControl = control;
    mountComponentsControl(app);
  });
};

const mountComponentsControl = (app: GeoLibreAppAPI): boolean => {
  if (!componentsControl) return false;
  const added = app.addMapControl(
    componentsControl,
    componentsControlPosition,
  );
  if (!added) {
    componentsControl = null;
    return false;
  }
  setTimeout(() => componentsControl?.expand(), 0);
  return true;
};

export const maplibreComponentsPlugin: GeoLibrePlugin = {
  id: "maplibre-gl-components",
  name: "Components",
  version: "0.18.1",
  activate: (app: GeoLibreAppAPI) => {
    pluginActive = true;
    if (componentsControl) return mountComponentsControl(app);
    createAndMountComponentsControl(app);
  },
  deactivate: (app: GeoLibreAppAPI) => {
    pluginActive = false;
    componentsControlRevision += 1;
    teardownCogRasterControl(app);
    teardownGeoTiffRasterOverlay(app);
    teardownFlatGeobufControl(app);
    teardownPMTilesControl(app);
    teardownSearchControl(app);
    teardownStacSearchControl(app);
    teardownZarrControl(app);
    teardownColorbarControl(app);
    teardownLegendControl(app);
    teardownHtmlControl(app);
    teardownLidarControl(app);
    teardownSplattingControl(app);
    if (!componentsControl) return;
    app.removeMapControl(componentsControl);
    componentsControl = null;
  },
  getMapControlPosition: () => componentsControlPosition,
  setMapControlPosition: (
    app: GeoLibreAppAPI,
    position: GeoLibreMapControlPosition,
  ) => {
    componentsControlPosition = position;
    if (!componentsControl) return;
    app.removeMapControl(componentsControl);
    componentsControl = null;
    createAndMountComponentsControl(app);
  },
};

export function openFlatGeobufAddVectorLayerPanel(
  app: GeoLibreAppAPI,
): void {
  void openStandaloneFlatGeobufControl(app);
}

export async function addCogRasterLayer(
  app: GeoLibreAppAPI,
  options: CogRasterLayerOptions,
): Promise<string> {
  if (options.data || shouldUseGenericGeoTiffRenderer(options.url)) {
    return addGeoTiffRasterLayer(app, options);
  }

  ensureMercatorProjection(app.getMap?.());
  const control = await ensureCogRasterControl(app);
  if (!control) {
    throw new Error("The COG raster layer control could not be added to the map.");
  }

  try {
    return await addLayerWithCogRasterControl(control, options);
  } catch (error) {
    if (isRemoteHttpUrl(options.url)) throw error;
    return addGeoTiffRasterLayer(app, options, error);
  }
}

export function openPMTilesLayerPanel(app: GeoLibreAppAPI): void {
  void openStandalonePMTilesControl(app);
}

// The standalone Search panel is intentionally independent from the
// ControlGrid search sub-control so it can be used from the Controls menu.
export function openSearchPlacesPanel(app: GeoLibreAppAPI): void {
  void openStandaloneSearchControl(app);
}

export function closeSearchPlacesPanel(): void {
  hideSearchControl();
}

export function isSearchPlacesPanelVisible(): boolean {
  return searchPlacesPanelVisible;
}

export function subscribeSearchPlacesPanel(
  listener: () => void,
): () => void {
  searchPlacesPanelListeners.add(listener);
  return () => searchPlacesPanelListeners.delete(listener);
}

export function openColorbarPanel(app: GeoLibreAppAPI): void {
  void openStandaloneColorbarControl(app);
}

export function closeColorbarPanel(app: GeoLibreAppAPI): void {
  teardownColorbarControl(app);
}

export function isColorbarPanelVisible(): boolean {
  return colorbarPanelVisible;
}

export function subscribeColorbarPanel(listener: () => void): () => void {
  colorbarPanelListeners.add(listener);
  return () => colorbarPanelListeners.delete(listener);
}

export function openLegendPanel(app: GeoLibreAppAPI): void {
  void openStandaloneLegendControl(app);
}

export function closeLegendPanel(app: GeoLibreAppAPI): void {
  teardownLegendControl(app);
}

export function isLegendPanelVisible(): boolean {
  return legendPanelVisible;
}

export function subscribeLegendPanel(listener: () => void): () => void {
  legendPanelListeners.add(listener);
  return () => legendPanelListeners.delete(listener);
}

export function openHtmlPanel(app: GeoLibreAppAPI): void {
  void openStandaloneHtmlControl(app);
}

export function closeHtmlPanel(app: GeoLibreAppAPI): void {
  teardownHtmlControl(app);
}

export function isHtmlPanelVisible(): boolean {
  return htmlPanelVisible;
}

export function subscribeHtmlPanel(listener: () => void): () => void {
  htmlPanelListeners.add(listener);
  return () => htmlPanelListeners.delete(listener);
}

export function openStacSearchLayerPanel(app: GeoLibreAppAPI): void {
  void openStandaloneStacSearchControl(app);
}

export function openZarrLayerPanel(app: GeoLibreAppAPI): void {
  void openStandaloneZarrControl(app);
}

export function openLidarLayerPanel(app: GeoLibreAppAPI): void {
  void openStandaloneLidarControl(app);
}

export function openSplattingLayerPanel(app: GeoLibreAppAPI): void {
  void openStandaloneSplattingControl(app);
}

function getComponentsOptions(
  app: GeoLibreAppAPI,
): ControlGridOptions {
  return {
    ...COMPONENTS_OPTIONS,
    basemapStyleUrl: app.getActiveBasemap(),
    position: componentsControlPosition,
  };
}

async function openStandaloneFlatGeobufControl(
  app: GeoLibreAppAPI,
): Promise<boolean> {
  const { AddVectorControl: AddVectorControlClass } =
    await getComponentsConstructors();

  flatGeobufControl ??= createFlatGeobufControl(AddVectorControlClass);

  if (!flatGeobufControlMounted) {
    const added = app.addMapControl(
      flatGeobufControl,
      flatGeobufControlPosition,
    );
    if (!added) {
      flatGeobufControl = null;
      return false;
    }
    flatGeobufControlMounted = true;
  }

  setTimeout(() => {
    flatGeobufControl?.show();
    flatGeobufControl?.expand();
  }, 0);
  return true;
}

async function ensureCogRasterControl(
  app: GeoLibreAppAPI,
): Promise<CogLayerControl | null> {
  const { CogLayerControl: CogLayerControlClass } =
    await getComponentsConstructors();

  cogRasterControl ??= createCogRasterControl(CogLayerControlClass);

  if (!cogRasterControlMounted) {
    const added = app.addMapControl(cogRasterControl, cogRasterControlPosition);
    if (!added) {
      cogRasterControl = null;
      return null;
    }
    cogRasterControlMounted = true;
  }

  setTimeout(() => {
    cogRasterControl?.hide();
    cogRasterControl?.collapse();
  }, 0);
  return cogRasterControl;
}

async function openStandalonePMTilesControl(
  app: GeoLibreAppAPI,
): Promise<boolean> {
  const { PMTilesLayerControl: PMTilesLayerControlClass } =
    await getComponentsConstructors();

  pmtilesControl ??= createPMTilesControl(PMTilesLayerControlClass);

  if (!pmtilesControlMounted) {
    const added = app.addMapControl(pmtilesControl, pmtilesControlPosition);
    if (!added) {
      pmtilesControl = null;
      return false;
    }
    pmtilesControlMounted = true;
  }

  setTimeout(() => {
    pmtilesControl?.show();
    pmtilesControl?.expand();
  }, 0);
  return true;
}

async function openStandaloneSearchControl(
  app: GeoLibreAppAPI,
): Promise<boolean> {
  const { SearchControl: SearchControlClass } = await getComponentsConstructors();

  searchControl ??= createSearchControl(SearchControlClass);

  if (!searchControlMounted) {
    const added = app.addMapControl(searchControl, searchControlPosition);
    if (!added) {
      searchControl = null;
      return false;
    }
    searchControlMounted = true;
  }

  setTimeout(() => {
    searchControl?.show();
    searchControl?.expand();
    setSearchPlacesPanelVisible(true);
  }, 0);
  return true;
}

async function openStandaloneStacSearchControl(
  app: GeoLibreAppAPI,
): Promise<boolean> {
  const { StacSearchControl: StacSearchControlClass } =
    await getComponentsConstructors();

  stacSearchControl ??= createStacSearchControl(StacSearchControlClass);

  if (!stacSearchControlMounted) {
    const added = app.addMapControl(stacSearchControl, stacSearchControlPosition);
    if (!added) {
      stacSearchControl = null;
      return false;
    }
    stacSearchControlMounted = true;
  }

  setTimeout(() => {
    stacSearchControl?.show();
    stacSearchControl?.expand();
  }, 0);
  return true;
}

async function openStandaloneZarrControl(
  app: GeoLibreAppAPI,
): Promise<boolean> {
  const { ZarrLayerControl: ZarrLayerControlClass } =
    await getComponentsConstructors();

  zarrControl ??= createZarrControl(ZarrLayerControlClass);

  if (!zarrControlMounted) {
    const added = app.addMapControl(zarrControl, zarrControlPosition);
    if (!added) {
      zarrControl = null;
      return false;
    }
    zarrControlMounted = true;
  }

  setTimeout(() => {
    zarrControl?.show();
    zarrControl?.expand();
  }, 0);
  return true;
}

async function openStandaloneColorbarControl(
  app: GeoLibreAppAPI,
): Promise<boolean> {
  const { ColorbarGuiControl: ColorbarGuiControlClass } =
    await getComponentsConstructors();

  colorbarControl ??= createColorbarControl(ColorbarGuiControlClass);

  if (!colorbarControlMounted) {
    const added = app.addMapControl(colorbarControl, colorbarControlPosition);
    if (!added) {
      colorbarControl = null;
      return false;
    }
    colorbarControlMounted = true;
  }

  setTimeout(() => {
    colorbarControl?.show();
    // expand() fires the "expand" handler, which applies the viewport
    // constraint, so no separate constrainGuiPanelToViewport call is needed.
    colorbarControl?.expand();
    setColorbarPanelVisible(true);
  }, 0);
  return true;
}

async function openStandaloneLegendControl(
  app: GeoLibreAppAPI,
): Promise<boolean> {
  const { LegendGuiControl: LegendGuiControlClass } =
    await getComponentsConstructors();

  legendControl ??= createLegendControl(LegendGuiControlClass);

  if (!legendControlMounted) {
    const added = app.addMapControl(legendControl, legendControlPosition);
    if (!added) {
      legendControl = null;
      return false;
    }
    legendControlMounted = true;
  }

  setTimeout(() => {
    legendControl?.show();
    legendControl?.expand();
    setLegendPanelVisible(true);
  }, 0);
  return true;
}

async function openStandaloneHtmlControl(
  app: GeoLibreAppAPI,
): Promise<boolean> {
  const { HtmlGuiControl: HtmlGuiControlClass } =
    await getComponentsConstructors();

  htmlControl ??= createHtmlControl(HtmlGuiControlClass);

  if (!htmlControlMounted) {
    const added = app.addMapControl(htmlControl, htmlControlPosition);
    if (!added) {
      htmlControl = null;
      return false;
    }
    htmlControlMounted = true;
  }

  setTimeout(() => {
    htmlControl?.show();
    htmlControl?.expand();
    setHtmlPanelVisible(true);
  }, 0);
  return true;
}

async function openStandaloneLidarControl(
  app: GeoLibreAppAPI,
): Promise<boolean> {
  const {
    LidarControl: LidarControlClass,
    LidarLayerAdapter: LidarLayerAdapterClass,
  } =
    await getComponentsConstructors();

  lidarControl ??= createLidarControl(
    LidarControlClass,
    LidarLayerAdapterClass,
  );

  if (!lidarControlMounted) {
    const added = app.addMapControl(lidarControl, lidarControlPosition);
    if (!added) {
      lidarControl = null;
      return false;
    }
    lidarControlMounted = true;
  }

  setTimeout(() => {
    disableLidarClickOutsideCollapse(lidarControl);
    showLidarControl(lidarControl);
    lidarControl?.expand();
    seedLidarDefaultUrl(lidarControl);
  }, 0);
  return true;
}

async function openStandaloneSplattingControl(
  app: GeoLibreAppAPI,
): Promise<boolean> {
  const {
    GaussianSplatControl: GaussianSplatControlClass,
    GaussianSplatLayerAdapter: GaussianSplatLayerAdapterClass,
  } = await getComponentsConstructors();

  splattingControl ??= createSplattingControl(
    GaussianSplatControlClass,
    GaussianSplatLayerAdapterClass,
  );

  if (!splattingControlMounted) {
    const added = app.addMapControl(
      splattingControl,
      splattingControlPosition,
    );
    if (!added) {
      splattingControl = null;
      return false;
    }
    splattingControlMounted = true;
  }

  setTimeout(() => {
    showSplattingControl(splattingControl);
    splattingControl?.expand();
  }, 0);
  return true;
}

function createFlatGeobufControl(
  AddVectorControlClass: AddVectorControlConstructor,
): AddVectorControl {
  const control = new AddVectorControlClass(ADD_VECTOR_OPTIONS);
  control.on("collapse", () => control.hide());
  control.on("layeradd", createFlatGeobufLayerAddHandler(control));
  control.on("layerremove", (event) => {
    if (!event.layerId) return;
    const store = useAppStore.getState();
    if (store.layers.some((layer) => layer.id === event.layerId)) {
      store.removeLayer(event.layerId);
    }
  });
  flatGeobufStoreUnsubscribe ??= useAppStore.subscribe((state, previous) => {
    const removedLayers = previous.layers.filter(
      (layer) =>
        isFlatGeobufControlLayer(layer) &&
        !state.layers.some((current) => current.id === layer.id),
    );
    for (const layer of removedLayers) {
      flatGeobufControl?.removeLayer(layer.id);
    }
  });
  return control;
}

function createCogRasterControl(
  CogLayerControlClass: CogLayerControlConstructor,
): CogLayerControl {
  const control = new CogLayerControlClass(COG_RASTER_OPTIONS);
  control.on("layeradd", createCogRasterLayerAddHandler());
  control.on("layerremove", (event) => {
    const store = useAppStore.getState();
    const activeLayerIds = new Set(event.state.layers.map((layer) => layer.id));
    for (const layer of store.layers) {
      if (!isCogRasterControlLayer(layer)) continue;
      const shouldRemove = event.layerId
        ? layer.id === event.layerId
        : !activeLayerIds.has(layer.id);
      if (shouldRemove) {
        store.removeLayer(layer.id);
      }
    }
  });
  cogRasterStoreUnsubscribe ??= useAppStore.subscribe((state, previous) => {
    const currentById = new Map(state.layers.map((layer) => [layer.id, layer]));

    for (const layer of previous.layers) {
      if (!isCogRasterControlLayer(layer)) continue;

      const currentLayer = currentById.get(layer.id);
      if (!currentLayer) {
        cogRasterControl?.removeLayer(layer.id);
        continue;
      }

      if (!isCogRasterControlLayer(currentLayer)) continue;

      if (currentLayer.visible !== layer.visible) {
        cogRasterControl?.setLayerVisibility(
          currentLayer.id,
          currentLayer.visible,
          currentLayer.opacity,
        );
      }

      if (currentLayer.opacity !== layer.opacity) {
        if (currentLayer.visible) {
          cogRasterControl?.setLayerOpacity(currentLayer.id, currentLayer.opacity);
        } else {
          cogRasterControl?.setLayerVisibility(
            currentLayer.id,
            false,
            currentLayer.opacity,
          );
        }
      }
    }
  });
  return control;
}

function createLidarControl(
  LidarControlClass: LidarControlConstructor,
  LidarLayerAdapterClass: LidarLayerAdapterConstructor,
): LidarControl {
  const control = new LidarControlClass(LIDAR_OPTIONS);
  lidarLayerAdapter = new LidarLayerAdapterClass(control);
  control.on("collapse", () => hideLidarControl(control));
  control.on("load", createLidarLoadHandler());
  control.on("unload", createLidarUnloadHandler());
  lidarStoreUnsubscribe ??= useAppStore.subscribe((state, previous) => {
    const currentById = new Map(state.layers.map((layer) => [layer.id, layer]));

    for (const layer of previous.layers) {
      if (!isLidarControlLayer(layer)) continue;

      const currentLayer = currentById.get(layer.id);
      if (!currentLayer) {
        if (hasLidarPointCloud(layer.id)) {
          lidarLayerAdapter?.removeLayer(layer.id);
        }
        continue;
      }

      if (!isLidarControlLayer(currentLayer)) continue;

      if (currentLayer.visible !== layer.visible) {
        lidarLayerAdapter?.setVisibility(currentLayer.id, currentLayer.visible);
      }

      if (currentLayer.opacity !== layer.opacity) {
        lidarLayerAdapter?.setOpacity(currentLayer.id, currentLayer.opacity);
      }
    }
  });
  return control;
}

function createSplattingControl(
  GaussianSplatControlClass: GaussianSplatControlConstructor,
  GaussianSplatLayerAdapterClass: GaussianSplatLayerAdapterConstructor,
): GaussianSplatControl {
  const control = new GaussianSplatControlClass(SPLATTING_OPTIONS);
  splattingLayerAdapter = new GaussianSplatLayerAdapterClass(control);
  control.on("collapse", () => hideSplattingControl(control));
  control.on("splatload", createSplattingLoadHandler("splat"));
  control.on("modelload", createSplattingLoadHandler("model"));
  control.on("splatremove", createSplattingRemoveHandler());
  control.on("modelremove", createSplattingRemoveHandler());
  splattingStoreUnsubscribe ??= useAppStore.subscribe((state, previous) => {
    const currentById = new Map(state.layers.map((layer) => [layer.id, layer]));

    for (const layer of previous.layers) {
      if (!isSplattingControlLayer(layer)) continue;

      const currentLayer = currentById.get(layer.id);
      if (!currentLayer) {
        splattingLayerAdapter?.removeLayer(layer.id);
        continue;
      }

      if (!isSplattingControlLayer(currentLayer)) continue;

      if (currentLayer.visible !== layer.visible) {
        splattingLayerAdapter?.setVisibility(
          currentLayer.id,
          currentLayer.visible,
        );
      }

      if (currentLayer.opacity !== layer.opacity) {
        splattingLayerAdapter?.setOpacity(currentLayer.id, currentLayer.opacity);
      }
    }
  });
  return control;
}

function createZarrControl(
  ZarrLayerControlClass: ZarrLayerControlConstructor,
): ZarrLayerControl {
  const control = new ZarrLayerControlClass(ZARR_OPTIONS);
  control.on("collapse", () => control.hide());
  control.on("layeradd", createZarrLayerAddHandler());
  control.on("layerremove", (event) => {
    const store = useAppStore.getState();
    const activeLayerIds = new Set(event.state.layers.map((layer) => layer.id));
    for (const layer of store.layers) {
      if (!isZarrControlLayer(layer)) continue;
      const shouldRemove = event.layerId
        ? layer.id === event.layerId
        : !activeLayerIds.has(layer.id);
      if (shouldRemove) {
        store.removeLayer(layer.id);
      }
    }
  });
  zarrStoreUnsubscribe ??= useAppStore.subscribe((state, previous) => {
    const currentById = new Map(state.layers.map((layer) => [layer.id, layer]));

    for (const layer of previous.layers) {
      if (!isZarrControlLayer(layer)) continue;

      const currentLayer = currentById.get(layer.id);
      if (!currentLayer) {
        zarrControl?.removeLayer(layer.id);
        continue;
      }

      if (!isZarrControlLayer(currentLayer)) continue;

      if (currentLayer.visible !== layer.visible) {
        zarrControl?.setLayerVisibility(
          currentLayer.id,
          currentLayer.visible,
          currentLayer.opacity,
        );
      }

      if (currentLayer.opacity !== layer.opacity) {
        if (currentLayer.visible) {
          zarrControl?.setLayerOpacity(currentLayer.id, currentLayer.opacity);
        } else {
          zarrControl?.setLayerVisibility(
            currentLayer.id,
            false,
            currentLayer.opacity,
          );
        }
      }
    }
  });
  return control;
}

function createPMTilesControl(
  PMTilesLayerControlClass: PMTilesLayerControlConstructor,
): PMTilesLayerControl {
  const control = new PMTilesLayerControlClass(PMTILES_OPTIONS);
  control.on("collapse", () => control.hide());
  control.on("layeradd", createPMTilesLayerAddHandler());
  control.on("layerremove", (event) => {
    const store = useAppStore.getState();
    const activeLayerIds = new Set(event.state.layers.map((layer) => layer.id));
    for (const layer of store.layers) {
      if (!isPMTilesControlLayer(layer)) continue;
      const shouldRemove = event.layerId
        ? layer.id === event.layerId
        : !activeLayerIds.has(layer.id);
      if (shouldRemove) {
        store.removeLayer(layer.id);
      }
    }
  });
  pmtilesStoreUnsubscribe ??= useAppStore.subscribe((state, previous) => {
    const removedLayers = previous.layers.filter(
      (layer) =>
        isPMTilesControlLayer(layer) &&
        !state.layers.some((current) => current.id === layer.id),
    );
    for (const layer of removedLayers) {
      pmtilesControl?.removeLayer(layer.id);
    }
  });
  return control;
}

function createSearchControl(
  SearchControlClass: SearchControlConstructor,
): SearchControl {
  const control = new SearchControlClass(SEARCH_OPTIONS);
  control.on("collapse", hideSearchControl);
  return control;
}

function createColorbarControl(
  ColorbarGuiControlClass: ColorbarGuiControlConstructor,
): ColorbarGuiControl {
  const control = new ColorbarGuiControlClass(COLORBAR_OPTIONS);
  control.on("expand", () => {
    constrainGuiPanelToViewport(
      ".geolibre-colorbar-control .colorbar-gui-panel",
    );
    setColorbarPanelVisible(true);
  });
  return control;
}

function createLegendControl(
  LegendGuiControlClass: LegendGuiControlConstructor,
): LegendGuiControl {
  const control = new LegendGuiControlClass(LEGEND_OPTIONS);
  control.on("expand", () => {
    constrainGuiPanelToViewport(
      ".geolibre-legend-control .legend-gui-panel",
    );
    setLegendPanelVisible(true);
  });
  return control;
}

function createHtmlControl(
  HtmlGuiControlClass: HtmlGuiControlConstructor,
): HtmlGuiControl {
  const control = new HtmlGuiControlClass(HTML_OPTIONS);
  control.on("expand", () => {
    constrainGuiPanelToViewport(".geolibre-html-control .html-gui-panel");
    setHtmlPanelVisible(true);
  });
  return control;
}

function createStacSearchControl(
  StacSearchControlClass: StacSearchControlConstructor,
): StacSearchControl {
  const control = new StacSearchControlClass(STAC_SEARCH_OPTIONS);
  control.on("collapse", () => control.hide());
  control.on("display", createStacSearchDisplayHandler(control));
  patchStacSearchCogLayer(control);
  patchStacSearchRasterUrls(control);
  patchStacSearchRemoveLayer(control);
  stacSearchStoreUnsubscribe ??= useAppStore.subscribe((state, previous) => {
    const currentById = new Map(state.layers.map((layer) => [layer.id, layer]));

    for (const layer of previous.layers) {
      if (!isStacSearchControlLayer(layer)) continue;

      const currentLayer = currentById.get(layer.id);
      if (!currentLayer) {
        removeStacSearchControlLayer(layer.id);
        continue;
      }

      if (!isStacSearchControlLayer(currentLayer)) continue;

      if (
        currentLayer.visible !== layer.visible ||
        currentLayer.opacity !== layer.opacity
      ) {
        setStacSearchControlLayerState(
          currentLayer.id,
          currentLayer.visible,
          currentLayer.opacity,
        );
      }
    }
  });
  return control;
}

function teardownFlatGeobufControl(app: GeoLibreAppAPI): void {
  flatGeobufStoreUnsubscribe?.();
  flatGeobufStoreUnsubscribe = null;
  if (flatGeobufControl && flatGeobufControlMounted) {
    app.removeMapControl(flatGeobufControl);
  }
  flatGeobufControl = null;
  flatGeobufControlMounted = false;
}

function teardownCogRasterControl(app: GeoLibreAppAPI): void {
  cogRasterStoreUnsubscribe?.();
  cogRasterStoreUnsubscribe = null;
  if (cogRasterControl && cogRasterControlMounted) {
    app.removeMapControl(cogRasterControl);
  }
  cogRasterControl = null;
  cogRasterControlMounted = false;
}

function teardownGeoTiffRasterOverlay(app: GeoLibreAppAPI): void {
  geoTiffRasterStoreUnsubscribe?.();
  geoTiffRasterStoreUnsubscribe = null;
  geoTiffRasterLayerProps.clear();
  geoTiffRasterLayers.clear();
  updateGeoTiffRasterOverlayLayers();
  if (geoTiffRasterOverlay && geoTiffRasterOverlayMounted) {
    app.removeMapControl(geoTiffRasterOverlay);
  }
  geoTiffRasterOverlay = null;
  geoTiffRasterOverlayMounted = false;
}

function teardownPMTilesControl(app: GeoLibreAppAPI): void {
  pmtilesStoreUnsubscribe?.();
  pmtilesStoreUnsubscribe = null;
  if (pmtilesControl && pmtilesControlMounted) {
    app.removeMapControl(pmtilesControl);
  }
  pmtilesControl = null;
  pmtilesControlMounted = false;
}

function teardownSearchControl(app: GeoLibreAppAPI): void {
  if (searchControl && searchControlMounted) {
    app.removeMapControl(searchControl);
  }
  searchControl = null;
  searchControlMounted = false;
  setSearchPlacesPanelVisible(false);
}

function teardownStacSearchControl(app: GeoLibreAppAPI): void {
  stacSearchStoreUnsubscribe?.();
  stacSearchStoreUnsubscribe = null;
  if (stacSearchControl && stacSearchControlMounted) {
    app.removeMapControl(stacSearchControl);
  }
  stacSearchControl = null;
  stacSearchControlMounted = false;
}

function hideSearchControl(): void {
  searchControl?.hide();
  setSearchPlacesPanelVisible(false);
}

function setSearchPlacesPanelVisible(visible: boolean): void {
  if (searchPlacesPanelVisible === visible) return;
  searchPlacesPanelVisible = visible;
  for (const listener of searchPlacesPanelListeners) {
    listener();
  }
}

function teardownZarrControl(app: GeoLibreAppAPI): void {
  zarrStoreUnsubscribe?.();
  zarrStoreUnsubscribe = null;
  if (zarrControl && zarrControlMounted) {
    app.removeMapControl(zarrControl);
  }
  zarrControl = null;
  zarrControlMounted = false;
}

function teardownColorbarControl(app: GeoLibreAppAPI): void {
  if (colorbarControl && colorbarControlMounted) {
    app.removeMapControl(colorbarControl);
  }
  colorbarControl = null;
  colorbarControlMounted = false;
  setColorbarPanelVisible(false);
}

function setColorbarPanelVisible(visible: boolean): void {
  if (colorbarPanelVisible === visible) return;
  colorbarPanelVisible = visible;
  for (const listener of colorbarPanelListeners) {
    listener();
  }
}

function teardownLegendControl(app: GeoLibreAppAPI): void {
  if (legendControl && legendControlMounted) {
    app.removeMapControl(legendControl);
  }
  legendControl = null;
  legendControlMounted = false;
  setLegendPanelVisible(false);
}

function setLegendPanelVisible(visible: boolean): void {
  if (legendPanelVisible === visible) return;
  legendPanelVisible = visible;
  for (const listener of legendPanelListeners) {
    listener();
  }
}

function teardownHtmlControl(app: GeoLibreAppAPI): void {
  if (htmlControl && htmlControlMounted) {
    app.removeMapControl(htmlControl);
  }
  htmlControl = null;
  htmlControlMounted = false;
  setHtmlPanelVisible(false);
}

function setHtmlPanelVisible(visible: boolean): void {
  if (htmlPanelVisible === visible) return;
  htmlPanelVisible = visible;
  for (const listener of htmlPanelListeners) {
    listener();
  }
}

function teardownLidarControl(app: GeoLibreAppAPI): void {
  lidarStoreUnsubscribe?.();
  lidarStoreUnsubscribe = null;
  lidarLayerAdapter?.destroy();
  lidarLayerAdapter = null;
  if (lidarControl && lidarControlMounted) {
    app.removeMapControl(lidarControl);
  }
  lidarControl = null;
  lidarControlMounted = false;
}

function teardownSplattingControl(app: GeoLibreAppAPI): void {
  splattingStoreUnsubscribe?.();
  splattingStoreUnsubscribe = null;
  splattingLayerAdapter?.destroy();
  splattingLayerAdapter = null;
  if (splattingControl && splattingControlMounted) {
    app.removeMapControl(splattingControl);
  }
  splattingControl = null;
  splattingControlMounted = false;
}

function createLidarLoadHandler(): LidarControlEventHandler {
  return (event) => {
    if (!event.pointCloud || !("source" in event.pointCloud)) return;

    const store = useAppStore.getState();
    const layer = createLidarStoreLayer(event.pointCloud);
    if (store.layers.some((item) => item.id === layer.id)) {
      store.updateLayer(layer.id, {
        metadata: layer.metadata,
        opacity: layer.opacity,
        source: layer.source,
        visible: layer.visible,
      });
      return;
    }
    store.addLayer(layer);
  };
}

function createSplattingLoadHandler(
  assetType: "model" | "splat",
): Parameters<GaussianSplatControl["on"]>[1] {
  return (event) => {
    const id = assetType === "splat" ? event.splatId : event.modelId;
    if (!id || !event.url) return;

    const store = useAppStore.getState();
    const layer = createSplattingStoreLayer(id, event.url, assetType);
    if (store.layers.some((item) => item.id === layer.id)) {
      store.updateLayer(layer.id, {
        metadata: layer.metadata,
        opacity: layer.opacity,
        source: layer.source,
        visible: layer.visible,
      });
      return;
    }
    store.addLayer(layer);
  };
}

function createSplattingRemoveHandler(): Parameters<GaussianSplatControl["on"]>[1] {
  return (event) => {
    const id = event.splatId ?? event.modelId;
    if (!id) return;

    const store = useAppStore.getState();
    const layer = store.layers.find((item) => item.id === id);
    if (layer && isSplattingControlLayer(layer)) {
      store.removeLayer(id);
    }
  };
}

function createLidarUnloadHandler(): LidarControlEventHandler {
  return (event) => {
    const pointCloudId = event.pointCloud?.id;
    if (!pointCloudId) return;

    const store = useAppStore.getState();
    const layer = store.layers.find((item) => item.id === pointCloudId);
    if (layer && isLidarControlLayer(layer)) {
      store.removeLayer(pointCloudId);
    }
  };
}

function createFlatGeobufLayerAddHandler(
  control: AddVectorControl,
): AddVectorEventHandler {
  return (event) => {
    if (!event.layerId) return;
    const layerInfo = event.state.layers.find(
      (layer) => layer.id === event.layerId,
    );
    if (!layerInfo) return;

    const store = useAppStore.getState();
    const layer = createFlatGeobufStoreLayer(event.layerId, layerInfo, control);
    if (store.layers.some((item) => item.id === layer.id)) {
      store.updateLayer(layer.id, {
        metadata: layer.metadata,
        opacity: layer.opacity,
        source: layer.source,
        visible: layer.visible,
      });
      return;
    }
    store.addLayer(layer);
  };
}

function createCogRasterLayerAddHandler(): CogLayerEventHandler {
  return (event) => {
    if (!event.layerId) return;
    const layerInfo = event.state.layers.find(
      (layer) => layer.id === event.layerId,
    );
    if (!layerInfo) return;

    const pendingOptions = pendingCogRasterLayerOptions.shift();
    if (
      !pendingOptions &&
      ignoredCogRasterLayerUrls.delete(layerInfo.url || event.url || "")
    ) {
      cogRasterControl?.removeLayer(event.layerId);
      return;
    }

    const store = useAppStore.getState();
    const layer = createCogRasterStoreLayer(
      event.layerId,
      layerInfo,
      pendingOptions,
    );
    if (store.layers.some((item) => item.id === layer.id)) {
      store.updateLayer(layer.id, {
        metadata: layer.metadata,
        opacity: layer.opacity,
        source: layer.source,
        style: layer.style,
        visible: layer.visible,
      });
      return;
    }
    store.addLayer(layer, pendingOptions?.beforeLayerId);
  };
}

function createZarrLayerAddHandler(): ZarrLayerEventHandler {
  return (event) => {
    if (!event.layerId) return;
    const layerInfo = event.state.layers.find(
      (layer) => layer.id === event.layerId,
    );
    if (!layerInfo) return;

    const store = useAppStore.getState();
    const layer = createZarrStoreLayer(event.layerId, layerInfo);
    if (store.layers.some((item) => item.id === layer.id)) {
      store.updateLayer(layer.id, {
        metadata: layer.metadata,
        opacity: layer.opacity,
        source: layer.source,
        style: layer.style,
        visible: layer.visible,
      });
      return;
    }
    store.addLayer(layer);
  };
}

function createPMTilesLayerAddHandler(): PMTilesLayerEventHandler {
  return (event) => {
    if (!event.layerId) return;
    const layerInfo = event.state.layers.find(
      (layer) => layer.id === event.layerId,
    );
    if (!layerInfo) return;

    const store = useAppStore.getState();
    const layer = createPMTilesStoreLayer(event.layerId, layerInfo);
    if (store.layers.some((item) => item.id === layer.id)) {
      store.updateLayer(layer.id, {
        metadata: layer.metadata,
        opacity: layer.opacity,
        source: layer.source,
        style: layer.style,
        visible: layer.visible,
      });
      return;
    }
    store.addLayer(layer);
  };
}

function createStacSearchDisplayHandler(
  control: StacSearchControl,
): StacSearchEventHandler {
  return (event) => {
    const store = useAppStore.getState();
    for (const snapshot of getStacSearchLayerSnapshots(control)) {
      if (store.layers.some((item) => item.id === snapshot.id)) continue;

      const layer = createStacSearchStoreLayer(
        snapshot,
        event.item ?? event.state.selectedItem,
        event.state.selectedCollection?.id,
        event.state.selectedCatalog?.url,
      );
      store.addLayer(layer);
    }
  };
}

function addLayerWithCogRasterControl(
  control: CogLayerControl,
  options: CogRasterLayerOptions,
): Promise<string> {
  configureCogRasterControl(control, options);
  pendingCogRasterLayerOptions.push(options);

  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = window.setTimeout(() => {
      ignoredCogRasterLayerUrls.add(options.url);
      settle(() =>
        reject(
          new Error(
            "The COG raster layer did not finish loading. Trying generic GeoTIFF rendering.",
          ),
        ),
      );
    }, 30000);
    const cleanup = () => {
      window.clearTimeout(timeout);
      control.off("layeradd", handleLayerAdd);
      control.off("error", handleError);
      const pendingIndex = pendingCogRasterLayerOptions.indexOf(options);
      if (pendingIndex >= 0) {
        pendingCogRasterLayerOptions.splice(pendingIndex, 1);
      }
    };
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const handleLayerAdd: CogLayerEventHandler = (event) => {
      if (!event.layerId || event.url !== options.url) return;
      settle(() => resolve(event.layerId!));
    };
    const handleError: CogLayerEventHandler = (event) => {
      settle(() =>
        reject(new Error(event.error || "Failed to load the COG raster layer.")),
      );
    };

    control.on("layeradd", handleLayerAdd);
    control.on("error", handleError);

    void control.addLayer(options.url).then(() => {
      const state = control.getState();
      if (!settled && state.error) {
        settle(() => reject(new Error(state.error || "Failed to load COG.")));
      }
    });
  });
}

async function addGeoTiffRasterLayer(
  app: GeoLibreAppAPI,
  options: CogRasterLayerOptions,
  cause: unknown = undefined,
): Promise<string> {
  const overlay = await ensureGeoTiffRasterOverlay(app);
  if (!overlay) {
    throw new Error(
      "The generic GeoTIFF raster overlay could not be added to the map.",
      { cause },
    );
  }

  const id = createGeoTiffRasterLayerId();
  const url = options.url.trim();
  const name = options.name?.trim() || layerNameFromUrl(url, id);
  const rasterInput = await fetchGeoTiffRasterInput(app, options, url, cause);
  const { bounds, raster } = await loadGeoTiffRasterData(rasterInput, options);
  const { data: _data, ...stateOptions } = options;
  const state: GeoTiffRasterLayerState = {
    bounds,
    id,
    name,
    opacity: options.opacity ?? 1,
    options: {
      ...stateOptions,
      url,
    },
    raster,
    url,
    visible: true,
  };

  geoTiffRasterLayerProps.set(id, state);
  geoTiffRasterLayers.set(id, createGeoTiffDeckLayer(state));
  updateGeoTiffRasterOverlayLayers();
  addOrUpdateGeoTiffStoreLayer(state);
  app.fitBounds?.(bounds);
  return id;
}

async function ensureGeoTiffRasterOverlay(
  app: GeoLibreAppAPI,
): Promise<MapboxOverlay | null> {
  const { MapboxOverlay: MapboxOverlayClass } = await import("@deck.gl/mapbox");
  geoTiffRasterOverlay ??= new MapboxOverlayClass({
    interleaved: false,
    layers: [],
  });

  if (!geoTiffRasterOverlayMounted) {
    const added = app.addMapControl(
      geoTiffRasterOverlay,
      cogRasterControlPosition,
    );
    if (!added) {
      geoTiffRasterOverlay = null;
      return null;
    }
    geoTiffRasterOverlayMounted = true;
  }

  geoTiffRasterStoreUnsubscribe ??= useAppStore.subscribe(
    (state, previous) => {
      const currentById = new Map(state.layers.map((layer) => [layer.id, layer]));

      for (const layer of previous.layers) {
        if (!isGeoTiffRasterLayer(layer)) continue;

        const currentLayer = currentById.get(layer.id);
        if (!currentLayer) {
          geoTiffRasterLayerProps.delete(layer.id);
          geoTiffRasterLayers.delete(layer.id);
          continue;
        }

        if (!isGeoTiffRasterLayer(currentLayer)) continue;

        if (
          currentLayer.visible !== layer.visible ||
          currentLayer.opacity !== layer.opacity
        ) {
          const rasterState = geoTiffRasterLayerProps.get(layer.id);
          if (!rasterState) continue;
          rasterState.visible = currentLayer.visible;
          rasterState.opacity = currentLayer.opacity;
          geoTiffRasterLayerProps.set(layer.id, rasterState);
          geoTiffRasterLayers.set(
            layer.id,
            createGeoTiffDeckLayer(rasterState),
          );
        }
      }

      updateGeoTiffRasterOverlayLayers();
    },
  );

  return geoTiffRasterOverlay;
}

async function fetchGeoTiffRasterInput(
  app: GeoLibreAppAPI,
  options: CogRasterLayerOptions,
  url: string,
  cause: unknown,
): Promise<ArrayBuffer> {
  if (options.data) return options.data;

  if (app.fetchArrayBuffer) {
    try {
      return await app.fetchArrayBuffer(url);
    } catch (error) {
      throw new Error("The raster URL could not be fetched.", {
        cause: error || cause,
      });
    }
  }

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return await response.arrayBuffer();
  } catch (error) {
    throw new Error("The raster URL could not be fetched.", {
      cause: error || cause,
    });
  }
}

async function loadGeoTiffRasterData(
  input: ArrayBuffer,
  options: CogRasterLayerOptions,
): Promise<{
  bounds: [number, number, number, number];
  raster: GeoTiffRasterData;
}> {
  const tiff = await fromArrayBuffer(input);
  const image = await tiff.getImage();
  const projection = await parseGeoTiffProjection(image.getGeoKeys() ?? {});
  if (!projection) {
    throw new Error("Could not determine the GeoTIFF projection.");
  }

  const imageBounds = image.getBoundingBox();
  if (imageBounds.length !== 4) {
    throw new Error("Could not determine the GeoTIFF bounds.");
  }
  const bounds = getGeoTiffGeographicBounds(
    imageBounds as [number, number, number, number],
    projection.def,
  );
  const reprojectionFns = createGeoTiffReprojectionFns(image, projection.def);
  const sampleCount = image.getSamplesPerPixel();
  const sample = Math.min(getFirstRasterBand(options.bands), sampleCount - 1);
  const bandValues = (await image.readRasters({
    interleave: true,
    samples: [sample],
  })) as RasterBandValues & { height?: number; width?: number };
  const width = bandValues.width ?? image.getWidth();
  const height = bandValues.height ?? image.getHeight();
  const imageData = createRasterImageData(bandValues, width, height, options);

  return {
    bounds,
    raster: {
      height,
      image: imageData,
      reprojectionFns,
      width,
    },
  };
}

async function parseGeoTiffProjection(
  geoKeys: Record<string, unknown>,
): Promise<Awaited<ReturnType<StacGeoKeysParser>>> {
  const parser = await getStacGeoKeysParser();
  return parser(geoKeys);
}

function createGeoTiffReprojectionFns(
  image: GeoTiffImageLike,
  sourceProjection: Parameters<typeof proj4>[0],
): RasterLayerProps["reprojectionFns"] {
  const [originX, originY] = image.getOrigin();
  const [resolutionX, resolutionY] = image.getResolution();
  const converter = proj4(sourceProjection, "EPSG:4326");

  return {
    forwardTransform: (x, y) => [
      originX + x * resolutionX,
      originY + y * resolutionY,
    ],
    inverseTransform: (x, y) => [
      (x - originX) / resolutionX,
      (y - originY) / resolutionY,
    ],
    forwardReproject: (x, y) => converter.forward([x, y]),
    inverseReproject: (x, y) => converter.inverse([x, y]),
  };
}

function getFirstRasterBand(bands: string | undefined): number {
  const parsed = Number.parseInt(bands?.split(",")[0]?.trim() || "1", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed - 1 : 0;
}

function createRasterImageData(
  values: RasterBandValues,
  width: number,
  height: number,
  options: CogRasterLayerOptions,
): ImageData {
  const stats = getRasterValueStats(values, options.nodata);
  const useAutoScale =
    (options.rescaleMin ?? 0) === 0 &&
    (options.rescaleMax ?? 255) === 255 &&
    stats.max > 255;
  const min = useAutoScale ? stats.min : (options.rescaleMin ?? stats.min);
  const max = useAutoScale ? stats.max : (options.rescaleMax ?? stats.max);
  const scale = max > min ? max - min : 1;
  const pixels = new Uint8ClampedArray(width * height * 4);

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    const pixelIndex = index * 4;
    if (
      !Number.isFinite(value) ||
      (options.nodata !== undefined && value === options.nodata)
    ) {
      pixels[pixelIndex + 3] = 0;
      continue;
    }

    const normalized = Math.max(0, Math.min(1, (value - min) / scale));
    const [red, green, blue] = colorFromRasterValue(
      normalized,
      options.colormap,
    );
    pixels[pixelIndex] = red;
    pixels[pixelIndex + 1] = green;
    pixels[pixelIndex + 2] = blue;
    pixels[pixelIndex + 3] = 255;
  }

  return new ImageData(pixels, width, height);
}

function getRasterValueStats(
  values: RasterBandValues,
  nodata: number | undefined,
): { max: number; min: number } {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (!Number.isFinite(value) || (nodata !== undefined && value === nodata)) {
      continue;
    }
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { min: 0, max: 1 };
  }
  return { min, max };
}

function colorFromRasterValue(
  value: number,
  colormap: CogRasterLayerOptions["colormap"],
): [number, number, number] {
  if (colormap === "terrain") {
    return interpolateColorRamp(value, [
      [51, 102, 51],
      [180, 170, 120],
      [255, 255, 255],
    ]);
  }
  if (colormap === "viridis") {
    return interpolateColorRamp(value, [
      [68, 1, 84],
      [33, 145, 140],
      [253, 231, 37],
    ]);
  }
  if (colormap === "plasma") {
    return interpolateColorRamp(value, [
      [13, 8, 135],
      [203, 71, 119],
      [240, 249, 33],
    ]);
  }
  if (colormap === "inferno" || colormap === "magma") {
    return interpolateColorRamp(value, [
      [0, 0, 4],
      [187, 55, 84],
      [252, 255, 164],
    ]);
  }
  if (colormap === "cividis") {
    return interpolateColorRamp(value, [
      [0, 34, 77],
      [126, 124, 120],
      [255, 233, 69],
    ]);
  }
  if (colormap === "turbo" || colormap === "jet") {
    return interpolateColorRamp(value, [
      [48, 18, 59],
      [33, 145, 140],
      [253, 231, 37],
      [122, 4, 3],
    ]);
  }
  const gray = Math.round(value * 255);
  return [gray, gray, gray];
}

function interpolateColorRamp(
  value: number,
  stops: [number, number, number][],
): [number, number, number] {
  if (stops.length === 1) return stops[0];
  const scaled = value * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.floor(scaled));
  const ratio = scaled - index;
  const start = stops[index];
  const end = stops[index + 1];
  return [
    Math.round(start[0] + (end[0] - start[0]) * ratio),
    Math.round(start[1] + (end[1] - start[1]) * ratio),
    Math.round(start[2] + (end[2] - start[2]) * ratio),
  ];
}

function getGeoTiffGeographicBounds(
  projectedBounds: [number, number, number, number],
  sourceProjection: Parameters<typeof proj4>[0],
): [number, number, number, number] {
  const converter = proj4(sourceProjection, "EPSG:4326");
  const [minX, minY, maxX, maxY] = projectedBounds;
  const corners = [
    converter.forward([minX, minY]),
    converter.forward([maxX, minY]),
    converter.forward([maxX, maxY]),
    converter.forward([minX, maxY]),
  ];
  const longitudes = corners.map(([longitude]) => longitude);
  const latitudes = corners.map(([, latitude]) => latitude);
  return [
    Math.min(...longitudes),
    Math.min(...latitudes),
    Math.max(...longitudes),
    Math.max(...latitudes),
  ];
}

function createGeoTiffDeckLayer(
  state: GeoTiffRasterLayerState,
): Layer {
  return new RasterLayer({
    id: state.id,
    image: state.raster.image,
    height: state.raster.height,
    opacity: state.visible ? state.opacity : 0,
    pickable: false,
    reprojectionFns: state.raster.reprojectionFns,
    width: state.raster.width,
  }) as unknown as Layer;
}

function updateGeoTiffRasterOverlayLayers(): void {
  geoTiffRasterOverlay?.setProps({
    layers: Array.from(geoTiffRasterLayers.values()),
  });
}

function addOrUpdateGeoTiffStoreLayer(state: GeoTiffRasterLayerState): void {
  const store = useAppStore.getState();
  const layer = createGeoTiffRasterStoreLayer(state);
  if (store.layers.some((item) => item.id === layer.id)) {
    store.updateLayer(layer.id, {
      metadata: layer.metadata,
      opacity: layer.opacity,
      source: layer.source,
      style: layer.style,
      visible: layer.visible,
    });
    return;
  }
  store.addLayer(layer, state.options.beforeLayerId);
}

function configureCogRasterControl(
  control: CogLayerControl,
  options: CogRasterLayerOptions,
): void {
  const mutableControl = control as unknown as MutableCogLayerControl;
  const state = mutableControl._state;
  if (state) {
    state.url = options.url;
    state.bands = options.bands?.trim() || "1";
    state.colormap = options.colormap ?? "none";
    state.rescaleMin = options.rescaleMin ?? 0;
    state.rescaleMax = options.rescaleMax ?? 255;
    state.nodata = options.nodata;
    state.layerName = options.name?.trim() || "";
    state.layerOpacity = options.opacity ?? 1;
    state.pickable = false;
  }
  if (mutableControl._options) {
    mutableControl._options.beforeId = options.beforeLayerId || "";
  }
  mutableControl._render?.();
}

function createFlatGeobufStoreLayer(
  id: string,
  layerInfo: AddVectorLayerInfo,
  control: AddVectorControl,
): GeoLibreLayer {
  const nativeLayerIds = control
    .getLayerIds()
    .filter((layerId) => layerInfo.layerIds.includes(layerId));
  const url = layerInfo.url;

  return {
    id,
    name: layerNameFromUrl(url, id),
    type: "flatgeobuf",
    source: {
      type: "geojson",
      url,
      sourceId: layerInfo.sourceId,
    },
    visible: true,
    opacity: layerInfo.opacity,
    style: {
      ...DEFAULT_LAYER_STYLE,
      fillOpacity: 1,
      fillColor: layerInfo.fillColor,
      strokeColor: layerInfo.strokeColor,
    },
    metadata: {
      externalNativeLayer: true,
      featureCount: layerInfo.featureCount,
      format: layerInfo.format,
      geometryTypes: layerInfo.geometryTypes,
      nativeLayerIds,
      sourceId: layerInfo.sourceId,
      sourceKind: "flatgeobuf-url",
    },
    sourcePath: url,
  };
}

function createCogRasterStoreLayer(
  id: string,
  layerInfo: CogLayerInfo,
  options?: CogRasterLayerOptions,
): GeoLibreLayer {
  const url = options?.url ?? layerInfo.url;
  const bands = options?.bands?.trim() || layerInfo.bands || "1";
  const colormap = options?.colormap ?? layerInfo.colormap;
  const rescaleMin = options?.rescaleMin ?? layerInfo.rescaleMin;
  const rescaleMax = options?.rescaleMax ?? layerInfo.rescaleMax;
  const nodata = options?.nodata ?? layerInfo.nodata;

  return {
    id,
    name: options?.name?.trim() || layerInfo.name || layerNameFromUrl(url, id),
    type: "cog",
    source: {
      bands,
      colormap,
      nodata,
      rescaleMax,
      rescaleMin,
      sourceId: id,
      type: "raster",
      url,
    },
    visible: true,
    opacity: options?.opacity ?? layerInfo.opacity,
    style: {
      ...DEFAULT_LAYER_STYLE,
      fillOpacity: 1,
    },
    metadata: {
      bands,
      colormap,
      customLayerType: "raster",
      externalNativeLayer: true,
      identifiable: false,
      nativeLayerIds: [id],
      nodata,
      rescaleMax,
      rescaleMin,
      sourceId: id,
      sourceKind: "cog-url",
      tileType: "raster",
    },
    sourcePath: url,
  };
}

function createGeoTiffRasterStoreLayer(
  state: GeoTiffRasterLayerState,
): GeoLibreLayer {
  const bands = state.options.bands?.trim() || "1";
  const colormap = state.options.colormap ?? "none";
  const rescaleMin = state.options.rescaleMin ?? 0;
  const rescaleMax = state.options.rescaleMax ?? 255;
  const nodata = state.options.nodata;

  return {
    id: state.id,
    name: state.name,
    type: "cog",
    source: {
      bands,
      bounds: state.bounds,
      colormap,
      nodata,
      rescaleMax,
      rescaleMin,
      sourceId: state.id,
      type: "raster",
      url: state.url,
    },
    visible: state.visible,
    opacity: state.opacity,
    style: {
      ...DEFAULT_LAYER_STYLE,
      fillOpacity: 1,
    },
    metadata: {
      bands,
      colormap,
      customLayerType: "raster",
      externalNativeLayer: true,
      identifiable: false,
      nativeLayerIds: [state.id],
      nodata,
      rasterFormat: "geotiff",
      rescaleMax,
      rescaleMin,
      sourceId: state.id,
      sourceKind: "geotiff-url",
      tileType: "raster",
    },
    sourcePath: state.url,
  };
}

function createPMTilesStoreLayer(
  id: string,
  layerInfo: PMTilesLayerInfo,
): GeoLibreLayer {
  const firstSourceLayer = layerInfo.sourceLayers[0];
  const fillColor =
    (firstSourceLayer && layerInfo.sourceLayerColors?.[firstSourceLayer]) ??
    DEFAULT_LAYER_STYLE.fillColor;

  return {
    id,
    name: layerInfo.name || layerNameFromUrl(layerInfo.url, id),
    type: "pmtiles",
    source: {
      sourceId: layerInfo.id,
      sourceLayers: layerInfo.sourceLayers,
      tileType: layerInfo.tileType,
      type: layerInfo.tileType === "raster" ? "raster" : "vector",
      url: layerInfo.url,
    },
    visible: true,
    opacity: layerInfo.opacity,
    style: {
      ...DEFAULT_LAYER_STYLE,
      fillOpacity: layerInfo.tileType === "raster" ? 0.6 : 1,
      fillColor,
      strokeColor: fillColor,
    },
    metadata: {
      externalNativeLayer: true,
      nativeLayerIds: layerInfo.layerIds,
      pickable: layerInfo.pickable,
      sourceId: layerInfo.id,
      sourceKind: "pmtiles-url",
      sourceLayerColors: layerInfo.sourceLayerColors,
      sourceLayers: layerInfo.sourceLayers,
      tileType: layerInfo.tileType,
    },
    sourcePath: layerInfo.url,
  };
}

function createZarrStoreLayer(
  id: string,
  layerInfo: ZarrLayerInfo,
): GeoLibreLayer {
  const name =
    layerInfo.name ||
    [layerNameFromUrl(layerInfo.url, id), layerInfo.variable]
      .filter(Boolean)
      .join(" - ");

  return {
    id,
    name,
    type: "zarr",
    source: {
      clim: layerInfo.clim,
      colormap: layerInfo.colormap,
      selector: layerInfo.selector,
      sourceId: layerInfo.id,
      type: "raster",
      url: layerInfo.url,
      variable: layerInfo.variable,
    },
    visible: true,
    opacity: layerInfo.opacity,
    style: {
      ...DEFAULT_LAYER_STYLE,
      fillOpacity: 1,
    },
    metadata: {
      clim: layerInfo.clim,
      colormap: layerInfo.colormap,
      externalNativeLayer: true,
      identifiable: false,
      nativeLayerIds: [layerInfo.id],
      selector: layerInfo.selector,
      sourceId: layerInfo.id,
      sourceKind: "zarr-url",
      tileType: "raster",
      variable: layerInfo.variable,
    },
    sourcePath: layerInfo.url,
  };
}

function createStacSearchStoreLayer(
  snapshot: StacSearchLayerSnapshot,
  item?: StacSearchItem | null,
  collectionId?: string,
  catalogUrl?: string,
): GeoLibreLayer {
  const rasterLayerInfo = getStacSearchRasterLayerInfo(snapshot.layer);
  const deckLayerProps = "props" in snapshot.layer ? snapshot.layer.props : {};
  const sourceKind = rasterLayerInfo
    ? "stac-search-raster"
    : "stac-search-cog";
  const url = rasterLayerInfo?.tileUrl ?? getDeckLayerSourceUrl(snapshot.layer);
  const nativeLayerIds = rasterLayerInfo
    ? [rasterLayerInfo.layerId]
    : [snapshot.id];
  const sourceId = rasterLayerInfo?.sourceId ?? snapshot.id;

  return {
    id: snapshot.id,
    name: stacSearchLayerName(snapshot.id, item, collectionId),
    type: rasterLayerInfo ? "raster" : "cog",
    source: {
      bounds: item?.bbox,
      catalogUrl,
      collectionId,
      itemId: item?.id,
      sourceId,
      type: "raster",
      url,
    },
    visible: true,
    opacity: getStacSearchLayerOpacity(snapshot.layer),
    style: {
      ...DEFAULT_LAYER_STYLE,
      fillOpacity: 1,
    },
    metadata: {
      collectionId,
      customLayerType: "raster",
      externalNativeLayer: true,
      identifiable: false,
      nativeLayerIds,
      sourceId,
      sourceIds: [sourceId],
      sourceKind,
      stacAsset: stacAssetFromLayerId(snapshot.id),
      stacCatalogUrl: catalogUrl,
      stacItemId: item?.id,
      tileType: "raster",
      ...(item?.bbox ? { bounds: item.bbox } : {}),
      ...(deckLayerProps &&
      typeof deckLayerProps === "object" &&
      "_colormap" in deckLayerProps
        ? { colormap: deckLayerProps._colormap }
        : {}),
    },
    sourcePath: url,
  };
}

function createLidarStoreLayer(pointCloud: PointCloudInfo): GeoLibreLayer {
  return {
    id: pointCloud.id,
    name: pointCloud.name || layerNameFromUrl(pointCloud.source, pointCloud.id),
    type: "lidar",
    source: {
      bounds: [
        pointCloud.bounds.minX,
        pointCloud.bounds.minY,
        pointCloud.bounds.maxX,
        pointCloud.bounds.maxY,
      ],
      sourceId: pointCloud.id,
      type: "lidar",
      url: pointCloud.source,
    },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {
      customLayerType: "lidar",
      externalNativeLayer: true,
      hasClassification: pointCloud.hasClassification,
      hasIntensity: pointCloud.hasIntensity,
      hasRGB: pointCloud.hasRGB,
      identifiable: false,
      pointCount: pointCloud.pointCount,
      sourceId: pointCloud.id,
      sourceKind: "lidar-url",
      wkt: pointCloud.wkt,
    },
    sourcePath: pointCloud.source,
  };
}

function createSplattingStoreLayer(
  id: string,
  url: string,
  assetType: "model" | "splat",
): GeoLibreLayer {
  return {
    id,
    name: layerNameFromUrl(url, id),
    type: "gaussian-splat",
    source: {
      assetType,
      sourceId: id,
      type: "gaussian-splat",
      url,
    },
    visible: true,
    opacity: splattingLayerAdapter?.getLayerState(id)?.opacity ?? 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {
      assetType,
      customLayerType: "gaussian-splat",
      externalNativeLayer: true,
      identifiable: false,
      sourceId: id,
      sourceKind: "splatting-url",
    },
    sourcePath: url,
  };
}

function isFlatGeobufControlLayer(layer: GeoLibreLayer): boolean {
  return (
    layer.type === "flatgeobuf" &&
    layer.metadata.sourceKind === "flatgeobuf-url" &&
    layer.metadata.externalNativeLayer === true
  );
}

function isCogRasterControlLayer(layer: GeoLibreLayer): boolean {
  return (
    layer.type === "cog" &&
    layer.metadata.sourceKind === "cog-url" &&
    layer.metadata.externalNativeLayer === true
  );
}

function isGeoTiffRasterLayer(layer: GeoLibreLayer): boolean {
  return (
    layer.type === "cog" &&
    layer.metadata.sourceKind === "geotiff-url" &&
    layer.metadata.externalNativeLayer === true
  );
}

function isPMTilesControlLayer(layer: GeoLibreLayer): boolean {
  return (
    layer.type === "pmtiles" &&
    layer.metadata.sourceKind === "pmtiles-url" &&
    layer.metadata.externalNativeLayer === true
  );
}

function isZarrControlLayer(layer: GeoLibreLayer): boolean {
  return (
    layer.type === "zarr" &&
    layer.metadata.sourceKind === "zarr-url" &&
    layer.metadata.externalNativeLayer === true
  );
}

function isStacSearchControlLayer(layer: GeoLibreLayer): boolean {
  return (
    (layer.type === "cog" || layer.type === "raster") &&
    (layer.metadata.sourceKind === "stac-search-cog" ||
      layer.metadata.sourceKind === "stac-search-raster") &&
    layer.metadata.externalNativeLayer === true
  );
}

function isLidarControlLayer(layer: GeoLibreLayer): boolean {
  return (
    layer.type === "lidar" &&
    layer.metadata.sourceKind === "lidar-url" &&
    layer.metadata.externalNativeLayer === true
  );
}

function isSplattingControlLayer(layer: GeoLibreLayer): boolean {
  return (
    layer.type === "gaussian-splat" &&
    layer.metadata.sourceKind === "splatting-url" &&
    layer.metadata.externalNativeLayer === true
  );
}

function getStacSearchLayerSnapshots(
  control: StacSearchControl,
): StacSearchLayerSnapshot[] {
  const mutableControl = control as unknown as MutableStacSearchControl;
  return Array.from(mutableControl._cogLayers?.entries() ?? []).map(
    ([id, layer]) => ({
      id,
      layer,
    }),
  );
}

function patchStacSearchRemoveLayer(control: StacSearchControl): void {
  const mutableControl = control as unknown as MutableStacSearchControl;
  const removeLayer = mutableControl._removeLayer?.bind(control);
  if (!removeLayer) return;

  mutableControl._removeLayer = (id?: string) => {
    const layerIds = id
      ? [id]
      : Array.from(mutableControl._cogLayers?.keys() ?? []);
    removeLayer(id);
    const store = useAppStore.getState();
    for (const layerId of layerIds) {
      const layer = store.layers.find((item) => item.id === layerId);
      if (layer && isStacSearchControlLayer(layer)) {
        store.removeLayer(layerId);
      }
    }
  };
}

function patchStacSearchRasterUrls(control: StacSearchControl): void {
  const mutableControl = control as unknown as MutableStacSearchControl;
  const convertS3ToHttps = mutableControl._convertS3ToHttps?.bind(control);
  if (!convertS3ToHttps) return;

  mutableControl._convertS3ToHttps = (url: string) =>
    proxyDevRasterUrl(normalizeStacRasterUrl(convertS3ToHttps(url)));
}

function patchStacSearchCogLayer(control: StacSearchControl): void {
  const mutableControl = control as unknown as MutableStacSearchControl;
  if (
    !mutableControl._ensureOverlay ||
    !mutableControl._convertS3ToHttps ||
    !mutableControl._cogLayers
  ) {
    return;
  }

  mutableControl._addCogLayer = async (
    url: string,
    item: StacSearchItem,
    assetKey: string,
  ) => {
    ensureMercatorProjection(mutableControl._map);
    await mutableControl._ensureOverlay?.();
    const selectedAsset = getStacSearchSelectedAsset(mutableControl, item, {
      key: assetKey,
      url,
    });
    const layerUrl = normalizeStacRasterUrl(
      mutableControl._convertS3ToHttps?.(selectedAsset.url) ??
        selectedAsset.url,
    );
    const { COGLayer: COGLayerClass, texture } = await import(
      "@developmentseed/deck.gl-geotiff"
    );
    const renderProps = await createStacCogRenderProps(
      texture,
      getStacSearchRenderOptions(mutableControl),
    );
    await patchStacSearchCOGLayerClass(COGLayerClass);
    const layerCounter = mutableControl._layerCounter ?? 0;
    mutableControl._layerCounter = layerCounter + 1;
    const id = `stac-search-${item.id}-${selectedAsset.key}-${layerCounter}`;
    const CogLayerConstructor = COGLayerClass as unknown as {
      new (props: Record<string, unknown>): Layer;
    };
    const layer = new CogLayerConstructor({
      geotiff: layerUrl,
      id,
      opacity: 1,
      ...renderProps,
    });
    mutableControl._cogLayers?.set(id, layer as unknown as Layer);
    mutableControl._deckOverlay?.setProps({
      layers: Array.from(mutableControl._cogLayers?.values() ?? []) as Layer[],
    });
    if (mutableControl._state) {
      mutableControl._state.hasLayer = true;
      mutableControl._state.layerCount = mutableControl._cogLayers?.size ?? 0;
      mutableControl._state.status = `Displayed: ${id}`;
    }
    mutableControl._render?.();
    mutableControl._emit?.("display", {
      assetKey: selectedAsset.key,
      item,
      layerId: id,
      url: selectedAsset.url,
    });
  };
}

function getStacSearchSelectedAsset(
  control: MutableStacSearchControl,
  item: StacSearchItem,
  fallback: { key: string; url: string },
): { key: string; url: string } {
  const state = control._state;
  if (state?.isRgbMode !== false) return fallback;
  const selectedBand = state.selectedBand;
  if (!selectedBand) return fallback;
  const asset = getStacAsset(item, selectedBand);
  return asset?.href ? { key: selectedBand, url: asset.href } : fallback;
}

function getStacAsset(
  item: StacSearchItem,
  key: string,
): { href?: string } | null {
  const assets = (item as { assets?: Record<string, unknown> }).assets;
  const asset = assets?.[key];
  if (!asset || typeof asset !== "object") return null;
  return asset as { href?: string };
}

function getStacSearchRenderOptions(
  control: MutableStacSearchControl,
): StacCogRenderOptions {
  const state = control._state;
  return {
    colormap: state?.colormap ?? STAC_SEARCH_OPTIONS.defaultColormap,
    isRgbMode: state?.isRgbMode ?? STAC_SEARCH_OPTIONS.defaultRgbMode,
    rescaleMax: state?.rescaleMax ?? STAC_SEARCH_OPTIONS.defaultRescaleMax,
    rescaleMin: state?.rescaleMin ?? STAC_SEARCH_OPTIONS.defaultRescaleMin,
  };
}

async function createStacCogRenderProps(texture: unknown, renderOptions: StacCogRenderOptions): Promise<{
  getTileData: (
    image: StacCogImageLike,
    options: StacCogTileOptions,
  ) => Promise<StacCogTileData>;
  renderTile: (tileData: StacCogTileData) => {
    renderPipeline: Array<{ module: unknown; props?: Record<string, unknown> }>;
  };
}> {
  const {
    BlackIsZero,
    CreateTexture,
    FilterNoDataVal,
    LinearRescale,
  } = await import("@developmentseed/deck.gl-raster/gpu-modules");
  const { getColormap } = (await import("maplibre-gl-components")) as {
    getColormap?: (name: string) => StacColorStop[];
  };
  const inferTextureFormat = (texture as StacCogTextureHelper)
    .inferTextureFormat;

  return {
    getTileData: async (image, options) => {
      const { x, y, device, pool, signal } = options;
      const tile = await image.fetchTile(x, y, {
        boundless: false,
        pool,
        signal,
      });
      const { data, height, layout, mask, nodata, width } = tile.array;
      if (layout === "band-separate") {
        throw new Error("Band-separate GeoTIFF tiles are not supported.");
      }
      const tags = image.cachedTags;
      let samplesPerPixel = tags?.samplesPerPixel ?? 1;
      const bitsPerSample = tags?.bitsPerSample ?? [8];
      const sampleFormat = tags?.sampleFormat ?? [1];
      let textureData: RasterBandValues;
      let textureBitsPerSample = bitsPerSample;
      let textureSampleFormat = sampleFormat;
      let textureFormat: string | undefined;

      if (samplesPerPixel === 1) {
        textureData = createStacSingleBandRgba(data, width, height, {
          colormap: renderOptions.colormap,
          getColormap,
          mask,
          nodata: nodata ?? tags?.nodata ?? null,
          rescaleMax: renderOptions.rescaleMax,
          rescaleMin: renderOptions.rescaleMin,
        });
        samplesPerPixel = 4;
        textureBitsPerSample = [8, 8, 8, 8];
        textureSampleFormat = [1, 1, 1, 1];
        textureFormat = "rgba8unorm";
      } else if (samplesPerPixel === 3) {
        textureData = addOpaqueAlphaChannel(data, width, height, bitsPerSample);
        samplesPerPixel = 4;
      } else {
        textureData = data;
      }

      const format =
        textureFormat ??
        inferTextureFormat?.(
          samplesPerPixel,
          textureBitsPerSample,
          textureSampleFormat,
        ) ??
        "r8unorm";
      const textureObject = device.createTexture({
        data: textureData,
        format,
        height,
        sampler: {
          magFilter: "linear",
          minFilter: "linear",
        },
        width,
      });

      return {
        byteLength: textureData.byteLength,
        height,
        isRgb: samplesPerPixel >= 3,
        texture: textureObject,
        width,
      };
    },
    renderTile: (tileData) => {
      const renderPipeline: Array<{
        module: unknown;
        props?: Record<string, unknown>;
      }> = [
        {
          module: CreateTexture,
          props: { textureName: tileData.texture },
        },
      ];
      if (tileData.isRgb) {
        return { renderPipeline };
      }
      const nodata = getStacCogShaderNoData();
      if (nodata !== null) {
        renderPipeline.push({
          module: FilterNoDataVal,
          props: { value: nodata },
        });
      }
      renderPipeline.push({
        module: LinearRescale,
        props: {
          rescaleMax: renderOptions.rescaleMax,
          rescaleMin: renderOptions.rescaleMin,
        },
      });
      renderPipeline.push(
        renderOptions.colormap === "none"
          ? { module: BlackIsZero }
          : { module: getStacColorRampModule(renderOptions.colormap) },
      );
      return { renderPipeline };
    },
  };
}

function createStacSingleBandRgba(
  data: RasterBandValues,
  width: number,
  height: number,
  options: {
    colormap: string;
    getColormap?: (name: string) => StacColorStop[];
    mask?: Uint8Array | null;
    nodata?: number | null;
    rescaleMax: number;
    rescaleMin: number;
  },
): Uint8Array {
  const pixelCount = width * height;
  const output = new Uint8Array(pixelCount * 4);
  const range = options.rescaleMax - options.rescaleMin || 1;
  const stops = getStacColormapStops(options.colormap, options.getColormap);

  for (let index = 0; index < pixelCount; index += 1) {
    const rawValue = Number(data[index]);
    const target = index * 4;
    if (
      options.mask?.[index] === 0 ||
      !Number.isFinite(rawValue) ||
      (options.nodata !== null &&
        options.nodata !== undefined &&
        rawValue === options.nodata)
    ) {
      output[target] = 0;
      output[target + 1] = 0;
      output[target + 2] = 0;
      output[target + 3] = 0;
      continue;
    }

    const normalized = Math.max(
      0,
      Math.min(1, (rawValue - options.rescaleMin) / range),
    );
    const color = stops
      ? interpolateStacColormap(stops, normalized)
      : [normalized * 255, normalized * 255, normalized * 255];

    output[target] = Math.round(color[0]);
    output[target + 1] = Math.round(color[1]);
    output[target + 2] = Math.round(color[2]);
    output[target + 3] = 255;
  }

  return output;
}

function getStacColormapStops(
  colormap: string,
  getColormap?: (name: string) => StacColorStop[],
): StacColorStop[] | null {
  if (colormap === "none") return null;
  try {
    const stops = getColormap?.(colormap);
    if (stops?.length) return stops;
  } catch {
    // Fall back to the local shader ramp approximations below.
  }

  const colors = STAC_COLOR_RAMP_COLORS[colormap.toLowerCase()];
  if (!colors) return null;
  return colors.map((color, index) => ({
    color,
    position: colors.length === 1 ? 0 : index / (colors.length - 1),
  }));
}

function interpolateStacColormap(
  stops: StacColorStop[],
  value: number,
): [number, number, number] {
  const sortedStops = stops
    .slice()
    .sort((left, right) => left.position - right.position);
  const first = sortedStops[0];
  const last = sortedStops[sortedStops.length - 1];
  if (!first || !last) return [0, 0, 0];
  if (value <= first.position) return parseStacColor(first.color);
  if (value >= last.position) return parseStacColor(last.color);

  for (let index = 1; index < sortedStops.length; index += 1) {
    const upper = sortedStops[index];
    const lower = sortedStops[index - 1];
    if (!upper || !lower || value > upper.position) continue;
    const span = upper.position - lower.position || 1;
    const amount = (value - lower.position) / span;
    const lowerColor = parseStacColor(lower.color);
    const upperColor = parseStacColor(upper.color);
    return [
      lowerColor[0] + (upperColor[0] - lowerColor[0]) * amount,
      lowerColor[1] + (upperColor[1] - lowerColor[1]) * amount,
      lowerColor[2] + (upperColor[2] - lowerColor[2]) * amount,
    ];
  }

  return parseStacColor(last.color);
}

function parseStacColor(color: string): [number, number, number] {
  const hex = color.trim().match(/^#?([0-9a-f]{6})$/i)?.[1];
  if (hex) {
    return [
      Number.parseInt(hex.slice(0, 2), 16),
      Number.parseInt(hex.slice(2, 4), 16),
      Number.parseInt(hex.slice(4, 6), 16),
    ];
  }

  const rgb = color.match(
    /(?:rgb|vec3)\(([\d.]+),\s*([\d.]+),\s*([\d.]+)\)/i,
  );
  if (!rgb) return [0, 0, 0];
  const values = rgb.slice(1, 4).map(Number);
  const scale = values.some((value) => value > 1) ? 1 : 255;
  return [
    Math.round((values[0] ?? 0) * scale),
    Math.round((values[1] ?? 0) * scale),
    Math.round((values[2] ?? 0) * scale),
  ];
}

function addOpaqueAlphaChannel(
  data: RasterBandValues,
  width: number,
  height: number,
  bitsPerSample: ArrayLike<number>,
): RasterBandValues {
  const pixelCount = width * height;
  const Constructor = data.constructor as {
    new (length: number): RasterBandValues;
  };
  const output = new Constructor(pixelCount * 4);
  const alpha = getAlphaValue(data, bitsPerSample);
  for (let index = 0; index < pixelCount; index += 1) {
    const source = index * 3;
    const target = index * 4;
    output[target] = data[source];
    output[target + 1] = data[source + 1];
    output[target + 2] = data[source + 2];
    output[target + 3] = alpha;
  }
  return output;
}

function getAlphaValue(
  data: RasterBandValues,
  bitsPerSample: ArrayLike<number>,
): number {
  if (data instanceof Float32Array || data instanceof Float64Array) return 1;
  const bits = bitsPerSample[0] ?? 8;
  return bits >= 16 ? 65535 : 255;
}

function getStacCogShaderNoData(): number | null {
  return null;
}

async function patchStacSearchCOGLayerClass(
  COGLayerClass: unknown,
): Promise<void> {
  if (stacCogLayerPatched) return;
  const {
    CogLayerControl: CogLayerControlClass,
    StacLayerControl: StacLayerControlClass,
  } = await import("maplibre-gl-components");
  const stacPatcher = new StacLayerControlClass(
    {},
  ) as unknown as StacLayerControlPatcher;
  const cogPatcher = new CogLayerControlClass(
    {},
  ) as unknown as StacLayerControlPatcher;
  stacPatcher._patchCOGLayer?.(COGLayerClass);
  cogPatcher._patchCOGLayerForFloat?.(COGLayerClass);
  cogPatcher._patchCOGLayerForOpacity?.(COGLayerClass);
  stacCogLayerPatched = true;
}

function removeStacSearchControlLayer(id: string): void {
  const mutableControl = stacSearchControl as unknown as
    | MutableStacSearchControl
    | null;
  mutableControl?._removeLayer?.(id);
}

function setStacSearchControlLayerState(
  id: string,
  visible: boolean,
  opacity: number,
): void {
  const mutableControl = stacSearchControl as unknown as
    | MutableStacSearchControl
    | null;
  const layer = mutableControl?._cogLayers?.get(id);
  if (!layer) return;

  const appliedOpacity = visible ? opacity : 0;
  const rasterLayerInfo = getStacSearchRasterLayerInfo(layer);
  if (rasterLayerInfo) {
    const map = (stacSearchControl as unknown as MutableStacSearchControl | null)
      ?._map;
    try {
      map?.setLayoutProperty(
        rasterLayerInfo.layerId,
        "visibility",
        visible ? "visible" : "none",
      );
      map?.setPaintProperty(
        rasterLayerInfo.layerId,
        "raster-opacity",
        appliedOpacity,
      );
    } catch {
      // The layer may have been removed by the upstream control.
    }
    return;
  }

  if (!("clone" in layer) || typeof layer.clone !== "function") return;

  mutableControl?._cogLayers?.set(
    id,
    layer.clone({ opacity: appliedOpacity }) as StacSearchRenderableLayer,
  );
  mutableControl?._deckOverlay?.setProps({
    layers: getStacSearchDeckLayers(mutableControl),
  });
}

function getStacSearchDeckLayers(
  control: MutableStacSearchControl,
): Layer[] {
  return Array.from(control._cogLayers?.values() ?? []).filter(
    (layer): layer is Layer => !getStacSearchRasterLayerInfo(layer),
  );
}

function getStacSearchRasterLayerInfo(
  layer: StacSearchRenderableLayer,
): { layerId: string; sourceId: string; tileUrl?: string } | null {
  if (!("type" in layer) || layer.type !== "raster") return null;
  if (typeof layer.layerId !== "string" || typeof layer.sourceId !== "string") {
    return null;
  }
  const map = (stacSearchControl as unknown as MutableStacSearchControl | null)
    ?._map;
  const source = map?.getSource(layer.sourceId) as
    | { tiles?: string[] }
    | undefined;
  return {
    layerId: layer.layerId,
    sourceId: layer.sourceId,
    tileUrl: source?.tiles?.[0],
  };
}

function getDeckLayerSourceUrl(layer: StacSearchRenderableLayer): string {
  if (!("props" in layer)) return "";
  const props = layer.props as Record<string, unknown> | undefined;
  const geotiff = props?.geotiff;
  if (typeof geotiff === "string") return geotiff;
  const sourceUrl = props?.sourceUrl;
  return typeof sourceUrl === "string" ? sourceUrl : "";
}

function normalizeStacRasterUrl(url: string): string {
  return url.replace(
    "copernicus-dem-30m.s3.us-east-1.amazonaws.com",
    "copernicus-dem-30m.s3.eu-central-1.amazonaws.com",
  );
}

function proxyDevRasterUrl(url: string): string {
  if (!isLocalDevHost() || !isRemoteHttpUrl(url)) return url;
  return `${RASTER_PROXY_PATH}?url=${encodeURIComponent(url)}`;
}

function getStacGeoKeysParser(): Promise<StacGeoKeysParser> {
  stacGeoKeysParserPromise ??= createStacGeoKeysParser();
  return stacGeoKeysParserPromise;
}

async function createStacGeoKeysParser(): Promise<StacGeoKeysParser> {
  const geokeysToProj4 = await import("geotiff-geokeys-to-proj4");
  registerStacCommonProjections();

  return async (geoKeys) => {
    try {
      const projection = geokeysToProj4.toProj4(geoKeys as never);
      if (!projection?.proj4) return null;
      const def = projection.proj4.replace(/\+axis=\w+\s*/g, "");
      proj4.defs("custom", def);
      return {
        coordinatesUnits: projection.coordinatesUnits || "metre",
        def,
        parsed: (proj4.defs("custom") as Record<string, unknown>) ?? {},
      };
    } catch {
      return null;
    }
  };
}

function registerStacCommonProjections(): void {
  proj4.defs(
    "EPSG:4326",
    "+proj=longlat +datum=WGS84 +no_defs +type=crs",
  );
  proj4.defs(
    "EPSG:3857",
    "+proj=merc +a=6378137 +b=6378137 +lat_ts=0.0 +lon_0=0.0 " +
      "+x_0=0.0 +y_0=0 +k=1.0 +units=m +nadgrids=@null +wktext " +
      "+no_defs +type=crs",
  );
}

function isLocalDevHost(): boolean {
  if (typeof window === "undefined") return false;
  return ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
}

function isRemoteHttpUrl(url: string): boolean {
  try {
    const parsedUrl = new URL(url);
    return parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:";
  } catch {
    return false;
  }
}

function getStacSearchLayerOpacity(layer: StacSearchRenderableLayer): number {
  if ("props" in layer && typeof layer.props?.opacity === "number") {
    return layer.props.opacity;
  }
  return 1;
}

function stacSearchLayerName(
  id: string,
  item?: StacSearchItem | null,
  collectionId?: string,
): string {
  return [collectionId, item?.id, stacAssetFromLayerId(id)]
    .filter(Boolean)
    .join(" - ") || id;
}

function stacAssetFromLayerId(id: string): string | undefined {
  if (id.startsWith("stac-search-pc-")) return undefined;
  const parts = id.split("-");
  if (parts.length < 4) return undefined;
  return parts[parts.length - 2];
}

function layerNameFromUrl(url: string, fallback: string): string {
  try {
    const fileName = new URL(url).pathname.split("/").pop() ?? fallback;
    return fileName.replace(/\.[^.]+$/, "") || fallback;
  } catch {
    return fallback;
  }
}

function createGeoTiffRasterLayerId(): string {
  geoTiffRasterLayerSequence += 1;
  return `geotiff-layer-${geoTiffRasterLayerSequence}`;
}

function shouldUseGenericGeoTiffRenderer(url: string): boolean {
  const isTiffPath = /\.tiff?$/i.test(url);
  const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(url);
  if (!hasScheme) return isTiffPath;

  try {
    const parsedUrl = new URL(url);
    const isTiff = /\.tiff?$/i.test(parsedUrl.pathname);
    return isTiff && parsedUrl.protocol === "file:";
  } catch {
    return isTiffPath;
  }
}

function seedLidarDefaultUrl(control: LidarControl | null): void {
  const panel = findLidarPanel(control);
  const input = panel?.querySelector<HTMLInputElement>(".lidar-control-input");
  if (!input || input.value.trim()) return;
  input.value = LIDAR_SAMPLE_URL;
}

function hideLidarControl(control: LidarControl | null): void {
  const container = control?.getContainer();
  if (container) container.style.display = "none";
}

function showLidarControl(control: LidarControl | null): void {
  const container = control?.getContainer();
  if (container) container.style.display = "";
}

function hideSplattingControl(control: GaussianSplatControl | null): void {
  const container = getSplattingControlContainer(control);
  if (container) container.style.display = "none";
}

function showSplattingControl(control: GaussianSplatControl | null): void {
  const container = getSplattingControlContainer(control);
  if (container) container.style.display = "";
}

function getSplattingControlContainer(
  control: GaussianSplatControl | null,
): HTMLElement | null {
  return (
    (control as SplattingControlVisibilityState | null)?._container ?? null
  );
}

function disableLidarClickOutsideCollapse(control: LidarControl | null): void {
  const clickOutsideState = control as unknown as
    | LidarControlClickOutsideState
    | null;
  const handler = clickOutsideState?._clickOutsideHandler;
  if (!handler) return;
  document.removeEventListener("click", handler);
  clickOutsideState._clickOutsideHandler = null;
}

function hasLidarPointCloud(id: string): boolean {
  return lidarControl?.getPointClouds().some((pointCloud) => pointCloud.id === id)
    ?? false;
}

function findLidarPanel(control: LidarControl | null): HTMLElement | null {
  const mapContainer = control?.getMap()?.getContainer();
  if (!mapContainer) return null;

  const panels = Array.from(
    mapContainer.querySelectorAll<HTMLElement>(".lidar-control-panel"),
  );

  return (
    panels.find(
      (panel) =>
        panel.querySelector(".lidar-control-title")?.textContent ===
        LIDAR_OPTIONS.title,
    ) ??
    panels[panels.length - 1] ??
    null
  );
}
