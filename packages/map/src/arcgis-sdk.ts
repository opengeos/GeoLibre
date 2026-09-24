/**
 * Runtime loader for the ArcGIS Maps SDK for JavaScript (issue #2421).
 *
 * The SDK is never bundled. `@arcgis/core` is 84 MB unpacked across 18,810
 * files, and Vite would split it into hundreds of lazy chunks that all land in
 * `dist/`, the Python wheel and the desktop installers. Instead the engine
 * imports the modules it needs straight from Esri's ES-module CDN at runtime —
 * the same pattern the PostGIS (PGlite) and Sedona (CereusDB) engines use with
 * jsDelivr — so GeoLibre only ships the adapter code around it.
 *
 * Everything the engine touches is typed here by hand rather than through
 * `@arcgis/core`'s own declarations: adding the package as a devDependency
 * solely for `import type` would still pull those 18,810 files into every
 * `npm ci`. The version is pinned by {@link ARCGIS_SDK_VERSION}; bump it
 * deliberately and re-run the engine tests and the Playwright spec, since a
 * major release can change the surface described below (5.0 deprecated the
 * legacy widgets in favour of web components, for instance).
 *
 * `import()` of a URL has to stay out of Vite's module graph, hence the
 * `@vite-ignore` comments; the browser resolves the URL itself. The CSP of the
 * desktop app (`tauri.conf.json`) and of the Docker image (`docker/nginx.conf`)
 * allow-list `https://js.arcgis.com/` for that reason.
 */

/** The pinned SDK release. Esri's CDN serves `MAJOR.MINOR`; patches are implicit. */
export const ARCGIS_SDK_VERSION = "5.1";

/** The CDN root every module and asset URL is built from. */
export const ARCGIS_SDK_CDN = `https://js.arcgis.com/${ARCGIS_SDK_VERSION}`;

/** Host allow-listed in the CSPs and in the service worker's CDN cache rule. */
export const ARCGIS_SDK_HOST = "js.arcgis.com";

/** URL of one `@arcgis/core` ES module on the CDN, e.g. `views/MapView`. */
export function arcgisModuleUrl(module: string): string {
  return `${ARCGIS_SDK_CDN}/@arcgis/core/${module}.js`;
}

/** URL of the SDK's stylesheet for a theme. */
export function arcgisCssUrl(theme: "light" | "dark"): string {
  return `${ARCGIS_SDK_CDN}/esri/themes/${theme}/main.css`;
}

// ---------------------------------------------------------------- SDK types
//
// Only the members the engine and canvas use. Everything is `readonly`-free
// because the SDK's Accessor objects are mutable by design (`layer.opacity = x`
// is how a property is set).

/** An ArcGIS `Accessor` handle returned by `watch`/`on`. */
export interface ArcgisHandle {
  remove(): void;
}

export interface ArcgisSpatialReference {
  wkid?: number;
  isWebMercator?: boolean;
  isWGS84?: boolean;
}

export interface ArcgisPoint {
  type: "point";
  x: number;
  y: number;
  longitude: number;
  latitude: number;
  /** Height of the point; a SceneView's `toMap` gives the ground's here. */
  z?: number;
  spatialReference: ArcgisSpatialReference;
}

export interface ArcgisExtent {
  type: "extent";
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
  spatialReference: ArcgisSpatialReference;
  clone(): ArcgisExtent;
  expand(factor: number): ArcgisExtent;
}

/** Any ArcGIS geometry, as JSON the SDK autocasts (`{ type, ... }`). */
export interface ArcgisGeometryJson {
  type: "point" | "polyline" | "polygon" | "extent" | "multipoint";
  spatialReference?: { wkid: number };
  [key: string]: unknown;
}

export interface ArcgisGraphic {
  attributes: Record<string, unknown>;
  geometry: ArcgisGeometryJson | ArcgisPoint | ArcgisExtent | null;
  layer: ArcgisLayer | null;
  symbol?: unknown;
  /** Whether the graphic is a cluster or bin summarizing several features. */
  isAggregate?: boolean;
}

export interface ArcgisCollection<T> {
  length: number;
  add(item: T, index?: number): void;
  addMany(items: T[]): void;
  remove(item: T): void;
  removeAll(): void;
  removeMany(items: T[]): void;
  reorder(item: T, index: number): void;
  indexOf(item: T): number;
  includes(item: T): boolean;
  toArray(): T[];
  forEach(callback: (item: T, index: number) => void): void;
  every(callback: (item: T, index: number) => boolean): boolean;
  at(index: number): T | undefined;
  getItemAt(index: number): T | undefined;
}

export interface ArcgisLayer {
  id: string;
  title: string | null;
  type: string;
  opacity: number;
  visible: boolean;
  listMode?: "show" | "hide" | "hide-children";
  /** CSS filter functions applied to the layer (a `MapView` only; a `SceneView` ignores it). */
  effect?: string | null;
  /**
   * How the layer composites with the layers beneath it: every layer on a
   * `MapView`, tiled and imagery layers only in a `SceneView`.
   */
  blendMode?: string;
  minScale: number;
  maxScale: number;
  loaded: boolean;
  loadStatus: "not-loaded" | "loading" | "loaded" | "failed";
  loadError: { message: string; name?: string } | null;
  fullExtent: ArcgisExtent | null;
  destroyed?: boolean;
  load(): Promise<unknown>;
  when(): Promise<unknown>;
  destroy(): void;
  /** `GraphicsLayer` only. */
  graphics?: ArcgisCollection<ArcgisGraphic>;
  /** `GeoJSONLayer` / `FeatureLayer` only. */
  renderer?: unknown;
  labelingInfo?: unknown[];
  /** `WebTileLayer` only. */
  urlTemplate?: string;
  /** `FeatureLayer` only: query the service. */
  queryFeatures?(
    query: Record<string, unknown>,
  ): Promise<{ features: ArcgisGraphic[]; exceededTransferLimit?: boolean }>;
}

export interface ArcgisBasemap {
  baseLayers: ArcgisCollection<ArcgisLayer>;
  referenceLayers: ArcgisCollection<ArcgisLayer>;
  title?: string;
  /** Resolves once the basemap (a named style's layers included) has loaded. */
  when?(): Promise<unknown>;
  destroy(): void;
}

/** A map's ground: the elevation surface a `SceneView` drapes layers on. */
export interface ArcgisGround {
  layers: ArcgisCollection<ArcgisLayer>;
  /** Colour of the surface where no basemap tile draws. */
  surfaceColor: unknown;
}

export interface ArcgisMap {
  basemap: ArcgisBasemap | null;
  /** Only read by a `SceneView`; a `MapView` ignores it. */
  ground?: ArcgisGround | null;
  layers: ArcgisCollection<ArcgisLayer>;
  allLayers: ArcgisCollection<ArcgisLayer>;
  add(layer: ArcgisLayer, index?: number): void;
  remove(layer: ArcgisLayer): ArcgisLayer | null;
  destroy(): void;
}

export interface ArcgisScreenPoint {
  x: number;
  y: number;
}

export interface ArcgisHitTestResult {
  results: Array<{
    type: "graphic" | "media" | "route";
    graphic?: ArcgisGraphic;
    layer?: ArcgisLayer | null;
    mapPoint?: ArcgisPoint;
  }>;
  screenPoint: ArcgisScreenPoint;
}

export interface ArcgisViewEvent {
  x: number;
  y: number;
  button?: number;
  stopPropagation(): void;
  native?: Event;
  /** `drag` events carry the phase; the rest do not. */
  action?: "start" | "update" | "end";
  origin?: ArcgisScreenPoint;
}

export interface ArcgisGoToTarget {
  target?: unknown;
  center?: [number, number] | ArcgisPoint;
  zoom?: number;
  scale?: number;
  /** `MapView` only: clockwise rotation of north from the top of the screen. */
  rotation?: number;
  /** `SceneView` only: the compass direction the camera looks towards. */
  heading?: number;
  /** `SceneView` only: degrees from looking straight down. */
  tilt?: number;
}

export interface ArcgisGoToOptions {
  animate?: boolean;
  duration?: number;
  easing?: string;
}

export interface ArcgisUI {
  components: string[];
  add(component: unknown, position?: string | { position: string; index?: number }): void;
  remove(component: unknown): void;
  empty(position?: string): void;
  find(id: string): unknown;
}

export interface ArcgisNavigation {
  browserTouchPanEnabled: boolean;
  mouseWheelZoomEnabled: boolean;
  momentumEnabled: boolean;
}

export interface ArcgisConstraints {
  minZoom?: number;
  maxZoom?: number;
  minScale?: number;
  maxScale?: number;
  rotationEnabled?: boolean;
  snapToZoom?: boolean;
  geometry?: ArcgisExtent | ArcgisGeometryJson | null;
  /** Read-only, resolved from the basemap's tiling scheme. */
  effectiveMaxZoom?: number;
  effectiveMinZoom?: number;
}

/** Members a `MapView` and a `SceneView` share, which is most of the engine's surface. */
interface ArcgisViewBase {
  container: HTMLElement | null;
  map: ArcgisMap;
  center: ArcgisPoint;
  zoom: number;
  scale: number;
  extent: ArcgisExtent;
  spatialReference: ArcgisSpatialReference;
  stationary: boolean;
  updating: boolean;
  ready: boolean;
  interacting: boolean;
  animation: unknown | null;
  width: number;
  height: number;
  ui: ArcgisUI;
  navigation: ArcgisNavigation;
  /**
   * Whether the view should show attribution, and the credits to show: the
   * 5.x replacement for the deprecated Attribution widget. The core SDK only
   * computes the items; drawing them is the host's job.
   */
  attributionVisible: boolean;
  attributionItems: { text: string; score?: number }[];
  /** The popup component; `null` when none is attached (5.x). */
  popup: { autoOpenEnabled?: boolean } | null;
  popupEnabled: boolean;
  destroyed: boolean;
  /** The views drawing the basemap's layers; `null` until the view is ready. */
  basemapView?: {
    baseLayerViews: ArcgisCollection<{ updating: boolean }>;
  } | null;
  when(): Promise<unknown>;
  goTo(
    target: ArcgisGoToTarget | ArcgisExtent | ArcgisGraphic[],
    options?: ArcgisGoToOptions,
  ): Promise<void>;
  toScreen(point: ArcgisPoint | ArcgisGeometryJson): ArcgisScreenPoint | null;
  toMap(screenPoint: ArcgisScreenPoint): ArcgisPoint | null;
  hitTest(
    screenPoint: ArcgisScreenPoint,
    options?: { include?: ArcgisLayer[]; exclude?: ArcgisLayer[] },
  ): Promise<ArcgisHitTestResult>;
  takeScreenshot(options?: {
    format?: "png" | "jpg";
    quality?: number;
    width?: number;
    height?: number;
    ignoreBackground?: boolean;
    ignorePadding?: boolean;
  }): Promise<{ dataUrl: string; data: ImageData }>;
  on(
    type:
      | "click"
      | "double-click"
      | "drag"
      | "pointer-move"
      | "pointer-leave"
      | "pointer-down"
      | "mouse-wheel"
      | "key-down"
      | "layerview-create-error"
      | "layerview-create"
      | "resize",
    handler: (event: ArcgisViewEvent & Record<string, unknown>) => void,
  ): ArcgisHandle;
  destroy(): void;
}

export interface ArcgisMapView extends ArcgisViewBase {
  type: "2d";
  rotation: number;
  resolution: number;
  constraints: ArcgisConstraints;
  background: { type: "color"; color: unknown } | null;
}

export interface ArcgisCamera {
  /** Compass direction the camera looks towards, clockwise from north. */
  heading: number;
  /** Degrees from nadir: 0 looks straight down. */
  tilt: number;
  /** The camera's location; `z` is its height in metres. */
  position: ArcgisPoint & { z?: number };
  /** The diagonal field of view in degrees. */
  fov?: number;
}

export interface ArcgisSceneView extends ArcgisViewBase {
  type: "3d";
  /** `global` draws a globe; `local` a flat, projected scene. */
  viewingMode: "global" | "local";
  camera: ArcgisCamera | null;
  constraints: {
    tilt?: { max?: number; mode?: "auto" | "manual" };
    /** Camera height limits in metres; a global scene only. */
    altitude?: { min?: number; max?: number } | null;
  };
  environment: {
    background?: { type: "color"; color: unknown } | null;
    atmosphereEnabled?: boolean;
    starsEnabled?: boolean;
  };
}

/** Either view the engine can drive. Narrow on `type` before a view-specific member. */
export type ArcgisView = ArcgisMapView | ArcgisSceneView;

export interface ArcgisReactiveUtils {
  watch<T>(
    getValue: () => T,
    callback: (newValue: T, oldValue: T | undefined) => void,
    options?: { initial?: boolean; once?: boolean; sync?: boolean; equals?: unknown },
  ): ArcgisHandle;
  when<T>(
    getValue: () => T,
    callback: (newValue: T, oldValue: T | undefined) => void,
    options?: { initial?: boolean; once?: boolean; sync?: boolean },
  ): ArcgisHandle;
  on(...args: unknown[]): ArcgisHandle;
}

export interface ArcgisWebMercatorUtils {
  webMercatorToGeographic<T>(geometry: T, isLinear?: boolean): T;
  geographicToWebMercator<T>(geometry: T): T;
  canProject(source: unknown, target: unknown): boolean;
}

export interface ArcgisConfig {
  apiKey: string | null;
  assetsPath: string;
  request: {
    interceptors: unknown[];
    trustedServers: string[];
    useIdentity: boolean;
  };
}

/** A widget (legacy `@arcgis/core/widgets/*`): mounted through `view.ui`. */
export interface ArcgisWidget {
  view?: ArcgisView | null;
  destroy(): void;
  /** What to hand `view.ui.add`; the widget itself when absent. */
  uiComponent?: unknown;
}

/** Constructor of an autocasting SDK class: plain props in, an instance out. */
export type ArcgisClass<T, P = Record<string, unknown>> = new (properties?: P) => T;

/** Custom raster tile layer provided by the SDK. */
export interface ArcgisRasterLayer extends ArcgisLayer {
  addResolvingPromise(promise: Promise<unknown>): void;
  fetchTile(
    level: number,
    row: number,
    column: number,
    options?: { signal?: AbortSignal },
  ): Promise<HTMLCanvasElement>;
}

/**
 * The SDK surface the engine drives, loaded from the CDN by
 * {@link loadArcgisSdk}. Grouped the way Esri's module tree is so a reader can
 * find each member's documentation from its key.
 */
export interface ArcgisSdk {
  config: ArcgisConfig;
  Map: ArcgisClass<ArcgisMap>;
  MapView: ArcgisClass<ArcgisMapView>;
  Basemap: ArcgisClass<ArcgisBasemap> & { fromId(id: string): ArcgisBasemap | null };
  Graphic: ArcgisClass<ArcgisGraphic>;
  Point: ArcgisClass<ArcgisPoint>;
  Extent: ArcgisClass<ArcgisExtent>;
  layers: {
    GeoJSONLayer: ArcgisClass<ArcgisLayer>;
    GraphicsLayer: ArcgisClass<ArcgisLayer>;
    BaseTileLayer: ArcgisClass<ArcgisRasterLayer> & {
      createSubclass(definition: Record<string, unknown>): ArcgisClass<ArcgisRasterLayer>;
    };
    WebTileLayer: ArcgisClass<ArcgisLayer>;
    WMSLayer: ArcgisClass<ArcgisLayer>;
    WMTSLayer: ArcgisClass<ArcgisLayer>;
    VectorTileLayer: ArcgisClass<ArcgisLayer>;
    FeatureLayer: ArcgisClass<ArcgisLayer>;
    TileLayer: ArcgisClass<ArcgisLayer>;
    MapImageLayer: ArcgisClass<ArcgisLayer>;
    ImageryLayer: ArcgisClass<ArcgisLayer>;
    ImageryTileLayer: ArcgisClass<ArcgisLayer>;
    MediaLayer: ArcgisClass<ArcgisLayer>;
  };
  media: {
    ImageElement: ArcgisClass<unknown>;
    ExtentAndRotationGeoreference: ArcgisClass<unknown>;
    ControlPointsGeoreference: ArcgisClass<unknown>;
  };
  widgets: {
    Zoom: ArcgisClass<ArcgisWidget>;
    Compass: ArcgisClass<ArcgisWidget>;
    Fullscreen: ArcgisClass<ArcgisWidget>;
    Locate: ArcgisClass<ArcgisWidget>;
    LayerList: ArcgisClass<ArcgisWidget>;
    Expand: ArcgisClass<ArcgisWidget>;
  };
  reactiveUtils: ArcgisReactiveUtils;
  webMercatorUtils: ArcgisWebMercatorUtils;
}

// ------------------------------------------------------------------- loader

/** How a module URL is imported; injectable so tests can hand in fakes. */
export type ArcgisModuleImporter = (url: string) => Promise<Record<string, unknown>>;

const defaultImporter: ArcgisModuleImporter = (url) =>
  import(/* @vite-ignore */ url) as Promise<Record<string, unknown>>;

/** The module path of every member of {@link ArcgisSdk}, in load order. */
const SDK_MODULES = {
  config: "config",
  Map: "Map",
  MapView: "views/MapView",
  Basemap: "Basemap",
  Graphic: "Graphic",
  Point: "geometry/Point",
  Extent: "geometry/Extent",
  GeoJSONLayer: "layers/GeoJSONLayer",
  GraphicsLayer: "layers/GraphicsLayer",
  BaseTileLayer: "layers/BaseTileLayer",
  WebTileLayer: "layers/WebTileLayer",
  WMSLayer: "layers/WMSLayer",
  WMTSLayer: "layers/WMTSLayer",
  VectorTileLayer: "layers/VectorTileLayer",
  FeatureLayer: "layers/FeatureLayer",
  TileLayer: "layers/TileLayer",
  MapImageLayer: "layers/MapImageLayer",
  ImageryLayer: "layers/ImageryLayer",
  ImageryTileLayer: "layers/ImageryTileLayer",
  MediaLayer: "layers/MediaLayer",
  ImageElement: "layers/support/ImageElement",
  ExtentAndRotationGeoreference: "layers/support/ExtentAndRotationGeoreference",
  ControlPointsGeoreference: "layers/support/ControlPointsGeoreference",
  Zoom: "widgets/Zoom",
  Compass: "widgets/Compass",
  Fullscreen: "widgets/Fullscreen",
  Locate: "widgets/Locate",
  LayerList: "widgets/LayerList",
  Expand: "widgets/Expand",
  reactiveUtils: "core/reactiveUtils",
  webMercatorUtils: "geometry/support/webMercatorUtils",
} as const;

type ModuleKey = keyof typeof SDK_MODULES;

/** Modules that export a namespace rather than a default class. */
const NAMESPACE_MODULES: ReadonlySet<ModuleKey> = new Set<ModuleKey>([
  "config",
  "reactiveUtils",
  "webMercatorUtils",
]);

/**
 * Build the {@link ArcgisSdk} from freshly imported modules. Exposed for the
 * tests, which exercise the shape without touching the network.
 */
export function assembleArcgisSdk(modules: Record<ModuleKey, Record<string, unknown>>): ArcgisSdk {
  const member = <T>(key: ModuleKey): T => {
    const module = modules[key];
    // `config` is exported as the default *and* as a namespace; the classes
    // are default exports. The utils modules only have named exports.
    const value = NAMESPACE_MODULES.has(key) ? (module.default ?? module) : module.default;
    if (value === undefined)
      throw new Error(`ArcGIS SDK module ${SDK_MODULES[key]} has no default export`);
    return value as T;
  };
  return {
    config: member("config"),
    Map: member("Map"),
    MapView: member("MapView"),
    Basemap: member("Basemap"),
    Graphic: member("Graphic"),
    Point: member("Point"),
    Extent: member("Extent"),
    layers: {
      GeoJSONLayer: member("GeoJSONLayer"),
      GraphicsLayer: member("GraphicsLayer"),
      BaseTileLayer: member("BaseTileLayer"),
      WebTileLayer: member("WebTileLayer"),
      WMSLayer: member("WMSLayer"),
      WMTSLayer: member("WMTSLayer"),
      VectorTileLayer: member("VectorTileLayer"),
      FeatureLayer: member("FeatureLayer"),
      TileLayer: member("TileLayer"),
      MapImageLayer: member("MapImageLayer"),
      ImageryLayer: member("ImageryLayer"),
      ImageryTileLayer: member("ImageryTileLayer"),
      MediaLayer: member("MediaLayer"),
    },
    media: {
      ImageElement: member("ImageElement"),
      ExtentAndRotationGeoreference: member("ExtentAndRotationGeoreference"),
      ControlPointsGeoreference: member("ControlPointsGeoreference"),
    },
    widgets: {
      Zoom: member("Zoom"),
      Compass: member("Compass"),
      Fullscreen: member("Fullscreen"),
      Locate: member("Locate"),
      LayerList: member("LayerList"),
      Expand: member("Expand"),
    },
    reactiveUtils: member("reactiveUtils"),
    webMercatorUtils: member("webMercatorUtils"),
  };
}

let sdkPromise: Promise<ArcgisSdk> | null = null;

/**
 * Load the SDK from the CDN once per page. Every ArcGIS pane shares the
 * result; a failed load is forgotten so the next mount retries (a flaky first
 * connection must not wedge the renderer for the session).
 */
export function loadArcgisSdk(
  importer: ArcgisModuleImporter = defaultImporter,
): Promise<ArcgisSdk> {
  if (!sdkPromise) {
    const keys = Object.keys(SDK_MODULES) as ModuleKey[];
    sdkPromise = Promise.all(keys.map((key) => importer(arcgisModuleUrl(SDK_MODULES[key]))))
      .then((loaded) => {
        const modules = Object.fromEntries(
          keys.map((key, index) => [key, loaded[index]]),
        ) as Record<ModuleKey, Record<string, unknown>>;
        return assembleArcgisSdk(modules);
      })
      .catch((error: unknown) => {
        sdkPromise = null;
        throw error;
      });
  }
  return sdkPromise;
}

/** Test hook: forget a loaded SDK so the next {@link loadArcgisSdk} imports again. */
export function resetArcgisSdkForTests(): void {
  sdkPromise = null;
  scenePromise = null;
}

// -------------------------------------------------------------- 3D modules

/**
 * An elevation layer: the SDK's tiled elevation service client, or a
 * `BaseElevationLayer` subclass that post-processes its tiles.
 */
export interface ArcgisElevationLayer extends ArcgisLayer {
  tileInfo?: unknown;
  spatialReference?: unknown;
  fetchTile(
    level: number,
    row: number,
    col: number,
    options?: unknown,
  ): Promise<{ values: Float32Array | number[]; [key: string]: unknown }>;
}

/**
 * The modules only a 3D scene needs. `views/SceneView` alone is ~840 KB of
 * minified JavaScript (before its own chunks), so they load separately from
 * {@link loadArcgisSdk}, and only when a pane actually renders in 3D.
 */
export interface ArcgisSceneSdk {
  SceneView: ArcgisClass<ArcgisSceneView>;
  ElevationLayer: ArcgisClass<ArcgisElevationLayer>;
  BaseElevationLayer: ArcgisClass<ArcgisElevationLayer> & {
    /** The SDK's Accessor subclassing, which is how its samples extend layers. */
    createSubclass(definition: Record<string, unknown>): ArcgisClass<ArcgisElevationLayer>;
  };
}

const SCENE_MODULES = {
  SceneView: "views/SceneView",
  ElevationLayer: "layers/ElevationLayer",
  BaseElevationLayer: "layers/BaseElevationLayer",
} as const;

type SceneModuleKey = keyof typeof SCENE_MODULES;

let scenePromise: Promise<ArcgisSceneSdk> | null = null;

/**
 * Load the 3D modules from the CDN once per page, after the core SDK (the
 * scene classes extend it). A failed load is forgotten so the next 3D mount
 * retries, as with {@link loadArcgisSdk}.
 */
export function loadArcgisSceneSdk(
  importer: ArcgisModuleImporter = defaultImporter,
): Promise<ArcgisSceneSdk> {
  if (!scenePromise) {
    const keys = Object.keys(SCENE_MODULES) as SceneModuleKey[];
    scenePromise = loadArcgisSdk(importer)
      .then(() => Promise.all(keys.map((key) => importer(arcgisModuleUrl(SCENE_MODULES[key])))))
      .then((loaded) => {
        const scene = Object.fromEntries(
          keys.map((key, index) => {
            const value = loaded[index].default;
            if (value === undefined)
              throw new Error(`ArcGIS SDK module ${SCENE_MODULES[key]} has no default export`);
            return [key, value];
          }),
        );
        return scene as unknown as ArcgisSceneSdk;
      })
      .catch((error: unknown) => {
        scenePromise = null;
        throw error;
      });
  }
  return scenePromise;
}

// ---------------------------------------------------------------------- CSS

const CSS_STYLE_ID = "geolibre-arcgis-sdk-css";
let cssPromise: Promise<void> | null = null;
let cssTheme: "light" | "dark" | null = null;
/** Bumped per request so a slow older theme fetch cannot overwrite a newer one. */
let cssRequest = 0;

/** Fetch the stylesheet text, treating an HTTP error as a failure rather than CSS. */
async function fetchCssText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`ArcGIS stylesheet request failed: HTTP ${response.status}`);
  return response.text();
}

/**
 * Rewrite the stylesheet's relative `url(...)` references against the CDN so
 * fonts and cursors still resolve once the text is inlined into this document.
 * Absolute, `data:` and `blob:` references pass through.
 */
export function absolutizeCssUrls(css: string, cssUrl: string): string {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (match, quote: string, ref: string) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref)) return match;
    try {
      return `url(${quote}${new URL(ref, cssUrl).href}${quote})`;
    } catch {
      return match;
    }
  });
}

/**
 * Inject the SDK stylesheet as an inline `<style>`.
 *
 * A `<link>` to the CDN would be the obvious route, but the desktop CSP's
 * `style-src` is `'self' 'unsafe-inline'` with no external host, and widening it
 * for one renderer is a larger policy change than fetching the text (which
 * `connect-src https:` already permits) and inlining it. The service worker's
 * CDN rule caches the fetch, so this works offline after first use like the
 * modules themselves.
 */
export function ensureArcgisCss(
  theme: "light" | "dark",
  fetcher: (url: string) => Promise<string> = fetchCssText,
): Promise<void> {
  if (typeof document === "undefined") return Promise.resolve();
  if (cssPromise && cssTheme === theme) return cssPromise;
  cssTheme = theme;
  const request = ++cssRequest;
  const url = arcgisCssUrl(theme);
  cssPromise = fetcher(url)
    .then((text) => {
      // A newer theme request superseded this one while it was in flight;
      // its stylesheet is the one that should land.
      if (request !== cssRequest) return;
      let style = document.getElementById(CSS_STYLE_ID) as HTMLStyleElement | null;
      if (!style) {
        style = document.createElement("style");
        style.id = CSS_STYLE_ID;
        document.head.append(style);
      }
      style.textContent = absolutizeCssUrls(text, url);
    })
    .catch((error: unknown) => {
      // Only the current request may reset the shared state: an older
      // rejection must not forget a newer, still-pending theme.
      if (request === cssRequest) {
        cssPromise = null;
        cssTheme = null;
      }
      throw error;
    });
  return cssPromise;
}

/** Test hook: forget the injected stylesheet. */
export function resetArcgisCssForTests(): void {
  cssPromise = null;
  cssTheme = null;
  cssRequest = 0;
  document.getElementById(CSS_STYLE_ID)?.remove();
}

/** Strip an ArcGIS API key or token from an error message before it reaches the UI. */
export function redactArcgisError(message: string): string {
  return (
    message
      .replace(/((?:^|[?&\s"'])(?:token|apiKey|api_key)=)[^&\s"']+/gi, "$1[redacted]")
      // Esri API keys: `AAPK…` (legacy API keys) and `AAPT…` (API key credentials).
      .replace(/\bAAP[KT][\w.-]+/g, "[redacted]")
  );
}
