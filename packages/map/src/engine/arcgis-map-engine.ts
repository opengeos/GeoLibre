import type { Feature, FeatureCollection } from "geojson";
import type { GeoLibreLayer, MapViewState } from "@geolibre/core";
import { captureArcGISViewport, type ArcGISScreenshotView } from "../capture/arcgis-capture";
import { drawArcGISBounds, pickArcGISPoint } from "./arcgis-interactions";
import { ArcGISDomMarker } from "./arcgis-markers";
import {
  ArcGISControls,
  type ArcGISControlModules,
  type ArcGISControlUI,
} from "./arcgis-controls";
import { getLayerBounds } from "../geojson-loader";
import {
  toArcGISHitFeatures,
  type ArcGISHitTestView,
  withArcGISFeatureIndices,
} from "./arcgis-feature-query";
import {
  arcGISViewToMapViewState,
  isSameArcGISMapView,
  mapViewStateToArcGISView,
  type ArcGISMapViewProperties,
  type ArcGISMapViewSnapshot,
} from "./arcgis-camera";
import type { MapEngineExtensionMap } from "./extensions";
import {
  MapEngineCapabilityError,
  type BBox,
  type BuiltInMapControl,
  type GeoJsonOverlaySpec,
  type HitFeature,
  type LngLat,
  type MapControlState,
  type MapEngine,
  type MapEngineCapability,
  type MapEngineEventMap,
  type MapMarkerHandle,
  type MapMarkerOptions,
  type MapRenderTarget,
  type ScreenPoint,
  type Unsubscribe,
} from "./types";

interface ArcGISHandle {
  remove(): void;
}

interface ArcGISLayer {
  readonly id: string;
  visible: boolean;
  opacity: number;
  urlTemplate?: string | null;
}

interface ArcGISLayerCollection {
  addMany(layers: readonly ArcGISLayer[]): void;
  remove(layer: ArcGISLayer): void;
  removeAll(): void;
}

interface ArcGISMap {
  readonly layers: ArcGISLayerCollection;
}

interface ArcGISPoint {
  readonly longitude?: number;
  readonly latitude?: number;
  readonly x?: number;
  readonly y?: number;
}

interface ArcGISViewInputEvent {
  readonly action?: "start" | "update" | "added" | "removed" | "end";
  readonly x?: number;
  readonly y?: number;
  readonly button?: number;
  readonly mapPoint?: ArcGISPoint | null;
  stopPropagation?(): void;
}

interface ArcGISMapView extends ArcGISMapViewSnapshot, ArcGISHitTestView, ArcGISScreenshotView {
  readonly stationary: boolean;
  readonly container: HTMLElement | null;
  readonly popup?: { readonly visible?: boolean } | null;
  when(): Promise<void>;
  destroy(): void;
  openPopup(options: {
    readonly location: { readonly longitude: number; readonly latitude: number };
    readonly content: HTMLElement;
  }): Promise<void>;
  closePopup(): void;
  goTo(
    target: ArcGISMapViewProperties | Record<string, unknown>,
    options?: unknown,
  ): Promise<unknown>;
  on(event: string, handler: (event: ArcGISViewInputEvent) => void): ArcGISHandle;
  toScreen(point: { readonly longitude: number; readonly latitude: number }): ScreenPoint | null;
  toMap(point: ScreenPoint): ArcGISPoint | null;
  readonly navigation: {
    readonly actionMap: {
      dragPrimary: string;
      dragSecondary: string;
      dragTertiary: string;
      mouseWheel: string;
    };
    browserTouchPanEnabled: boolean;
    momentumEnabled: boolean;
    readonly gamepad?: { enabled: boolean };
  };
  readonly ui: ArcGISControlUI;
}

/**
 * The small constructor surface the adapter needs from the lazy ArcGIS SDK.
 *
 * This is exported solely so deterministic adapter tests can provide a fake
 * SDK. It is deliberately not re-exported from the `@geolibre/map` public
 * entry point, so concrete ArcGIS objects never cross the MapEngine seam.
 */
export interface ArcGISMapEngineModules extends ArcGISControlModules {
  readonly config: { assetsPath: string };
  readonly reactiveUtils: {
    watch(getValue: () => boolean, callback: (stationary: boolean) => void): ArcGISHandle;
  };
  readonly Map: new (properties: { readonly basemap: unknown }) => ArcGISMap;
  readonly Basemap: new (properties: { readonly baseLayers: readonly ArcGISLayer[] }) => unknown;
  readonly MapView: new (
    properties: {
      readonly container: HTMLElement;
      readonly map: ArcGISMap;
      readonly popupEnabled?: boolean;
    } & ArcGISMapViewProperties,
  ) => ArcGISMapView;
  readonly WebTileLayer: new (properties: Record<string, unknown>) => ArcGISLayer;
  readonly GeoJSONLayer: new (properties: Record<string, unknown>) => ArcGISLayer;
  readonly WMSLayer: new (properties: Record<string, unknown>) => ArcGISLayer;
  readonly WMTSLayer: new (properties: Record<string, unknown>) => ArcGISLayer;
  readonly VectorTileLayer: new (properties: Record<string, unknown>) => ArcGISLayer;
  readonly MediaLayer: new (properties: Record<string, unknown>) => ArcGISLayer;
  readonly ImageryTileLayer: new (properties: Record<string, unknown>) => ArcGISLayer;
}

export interface ArcGISMapEngineDependencies {
  readonly loadArcGIS?: () => Promise<ArcGISMapEngineModules>;
  readonly assetsPath?: () => string;
}

const OPEN_STREET_MAP_TILES = "https://tile.openstreetmap.org/{level}/{col}/{row}.png";
const HIGHLIGHT_OVERLAY_ID = "geolibre-selection-highlight";
const supportedLayerTypes = new Set<GeoLibreLayer["type"]>([
  "geojson",
  "raster",
  "xyz",
  "wms",
  "wmts",
  "vector-tiles",
  "image",
  "video",
  "cog",
]);

function localArcGISAssetsPath(): string {
  const base = (import.meta as ImportMeta & { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/";
  return `${base.endsWith("/") ? base : `${base}/`}arcgis-assets`;
}

async function loadArcGISModules(): Promise<ArcGISMapEngineModules> {
  const [
    { default: config },
    { default: Map },
    { default: Basemap },
    { default: MapView },
    { default: WebTileLayer },
    { default: GeoJSONLayer },
    { default: WMSLayer },
    { default: WMTSLayer },
    { default: VectorTileLayer },
    { default: MediaLayer },
    { default: ImageryTileLayer },
    { default: Zoom },
    { default: Compass },
    { default: Fullscreen },
    { default: Locate },
    { default: ScaleBar },
    reactiveUtils,
  ] = await Promise.all([
    import("@arcgis/core/config"),
    import("@arcgis/core/Map"),
    import("@arcgis/core/Basemap"),
    import("@arcgis/core/views/MapView"),
    import("@arcgis/core/layers/WebTileLayer"),
    import("@arcgis/core/layers/GeoJSONLayer"),
    import("@arcgis/core/layers/WMSLayer"),
    import("@arcgis/core/layers/WMTSLayer"),
    import("@arcgis/core/layers/VectorTileLayer"),
    import("@arcgis/core/layers/MediaLayer"),
    import("@arcgis/core/layers/ImageryTileLayer"),
    import("@arcgis/core/widgets/Zoom"),
    import("@arcgis/core/widgets/Compass"),
    import("@arcgis/core/widgets/Fullscreen"),
    import("@arcgis/core/widgets/Locate"),
    import("@arcgis/core/widgets/ScaleBar"),
    import("@arcgis/core/core/reactiveUtils"),
    // Load the SDK theme with the lazy adapter, not the default app entry.
    import("@arcgis/core/assets/esri/themes/light/main.css"),
  ]);
  return {
    config,
    reactiveUtils,
    // These constructors stay adapter-private. Their public SDK declarations
    // carry many more renderer-specific members than this engine needs, so
    // narrow them here rather than leaking an ArcGIS type through MapEngine.
    Map: Map as unknown as ArcGISMapEngineModules["Map"],
    Basemap: Basemap as unknown as ArcGISMapEngineModules["Basemap"],
    MapView: MapView as unknown as ArcGISMapEngineModules["MapView"],
    WebTileLayer: WebTileLayer as unknown as ArcGISMapEngineModules["WebTileLayer"],
    GeoJSONLayer: GeoJSONLayer as unknown as ArcGISMapEngineModules["GeoJSONLayer"],
    WMSLayer: WMSLayer as unknown as ArcGISMapEngineModules["WMSLayer"],
    WMTSLayer: WMTSLayer as unknown as ArcGISMapEngineModules["WMTSLayer"],
    VectorTileLayer: VectorTileLayer as unknown as ArcGISMapEngineModules["VectorTileLayer"],
    MediaLayer: MediaLayer as unknown as ArcGISMapEngineModules["MediaLayer"],
    ImageryTileLayer: ImageryTileLayer as unknown as ArcGISMapEngineModules["ImageryTileLayer"],
    Zoom: Zoom as unknown as ArcGISMapEngineModules["Zoom"],
    Compass: Compass as unknown as ArcGISMapEngineModules["Compass"],
    Fullscreen: Fullscreen as unknown as ArcGISMapEngineModules["Fullscreen"],
    Locate: Locate as unknown as ArcGISMapEngineModules["Locate"],
    ScaleBar: ScaleBar as unknown as ArcGISMapEngineModules["ScaleBar"],
  };
}

function stringSourceValue(source: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function tileTemplate(layer: GeoLibreLayer): string | null {
  const tiles = layer.source.tiles;
  if (!Array.isArray(tiles)) return null;
  const first = tiles.find(
    (tile): tile is string => typeof tile === "string" && tile.trim().length > 0,
  );
  return first?.trim() ?? null;
}

function imageCorners(source: Readonly<Record<string, unknown>>): Record<string, unknown> | null {
  const coordinates = source.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length !== 4) return null;
  const points = coordinates.map((coordinate) =>
    Array.isArray(coordinate) && coordinate.length >= 2 &&
    typeof coordinate[0] === "number" && typeof coordinate[1] === "number"
      ? { longitude: coordinate[0], latitude: coordinate[1], spatialReference: { wkid: 4326 } }
      : null,
  );
  if (points.some((point) => point === null)) return null;
  const [topLeft, topRight, bottomRight, bottomLeft] = points;
  return { type: "corners", topLeft, topRight, bottomRight, bottomLeft };
}

function videoUrl(source: Readonly<Record<string, unknown>>): string | null {
  const urls = source.urls;
  if (!Array.isArray(urls)) return null;
  const url = urls.find((candidate): candidate is string =>
    typeof candidate === "string" && candidate.trim().length > 0,
  );
  return url?.trim() ?? null;
}

function cogUrl(source: Readonly<Record<string, unknown>>): string | null {
  const url = stringSourceValue(source, "url");
  return url?.startsWith("cog://") ? url.slice("cog://".length) : url;
}

function toArcGISLayerId(id: string): string {
  return `geolibre-${id}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Lazy ArcGIS Maps SDK adapter for the opt-in 2D engine.
 *
 * The adapter intentionally starts with the core store layer kinds only. It
 * never owns project state: `syncLayers` recreates native SDK layers from the
 * latest `GeoLibreLayer[]` snapshot supplied by the engine host.
 */
export class ArcGISMapEngine implements MapEngine {
  private readonly listeners = new Map<keyof MapEngineEventMap, Set<(payload: never) => void>>();
  private readonly handles: ArcGISHandle[] = [];
  private readonly objectUrls = new Set<string>();
  private readonly overlayObjectUrls = new Map<string, string>();
  private readonly options: Required<ArcGISMapEngineDependencies>;
  private modules: ArcGISMapEngineModules | null = null;
  private map: ArcGISMap | null = null;
  private view: ArcGISMapView | null = null;
  private container: HTMLElement | null = null;
  private basemapLayer: ArcGISLayer | null = null;
  private readonly nativeLayers = new Map<string, ArcGISLayer>();
  private readonly overlays = new Map<string, GeoJsonOverlaySpec>();
  private readonly transientLayers = new Map<string, ArcGISLayer>();
  private readonly markers = new Set<ArcGISDomMarker>();
  private readonly arcgisControls = new ArcGISControls({ supportsScale: true });
  private layersSnapshot: readonly GeoLibreLayer[] = [];
  private cachedView: MapViewState = {
    center: [-100, 40],
    zoom: 2,
    bearing: 0,
    pitch: 0,
  };
  private lastAppliedView: MapViewState | null = null;
  private activePopup: { readonly id: string; readonly onClose?: () => void } | null = null;
  private doubleClickZoomHandle: ArcGISHandle | null = null;
  private userMoved = false;
  private moving = false;
  private destroyed = false;

  readonly camera = {
    readView: (): MapViewState => this.readView(),
    readBounds: (): BBox | null => this.readBounds(),
    readZoomRange: (): { readonly min: number; readonly max: number } => ({ min: 0, max: 24 }),
    applyView: (view: MapViewState): void => this.applyView(view),
    flyToLocation: (location: MapViewState): void => this.applyView(location),
    playStoryChapter: (location: MapViewState): void => this.applyView(location),
    fitBounds: (bounds: BBox): void => this.fitBounds(bounds),
    fitLayer: (layer: GeoLibreLayer): void => {
      const bounds = getLayerBounds(layer);
      if (bounds) this.fitBounds(bounds);
    },
    zoomIn: (): void => this.applyView({ ...this.readView(), zoom: this.readView().zoom + 1 }),
    zoomOut: (): void => this.applyView({ ...this.readView(), zoom: this.readView().zoom - 1 }),
    resetNorth: (): void => this.applyView({ ...this.readView(), bearing: 0 }),
    resetPitch: (): void => this.applyView({ ...this.readView(), pitch: 0 }),
    resetNorthPitch: (): void => this.applyView({ ...this.readView(), bearing: 0, pitch: 0 }),
    readProjection: () => "mercator" as const,
    isMoving: (): boolean => this.moving,
    whenIdle: async (): Promise<void> => undefined,
  } satisfies MapEngine["camera"];

  readonly layers = {
    readGeoJson: async (layerId: string): Promise<FeatureCollection | null> =>
      this.layersSnapshot.find((layer) => layer.id === layerId)?.geojson ?? null,
    readRasterSource: (layerId: string): Readonly<Record<string, unknown>> | null => {
      const layer = this.layersSnapshot.find((candidate) => candidate.id === layerId);
      return layer && (layer.type === "raster" || layer.type === "xyz") ? layer.source : null;
    },
    setRasterTiles: (layerId: string, tiles: readonly string[]): boolean => {
      const layer = this.layersSnapshot.find((candidate) => candidate.id === layerId);
      const template = tiles.find((tile) => tile.trim().length > 0);
      if (!layer || !template || (layer.type !== "raster" && layer.type !== "xyz")) return false;
      const nativeLayer = this.findNativeLayer(layerId);
      if (!nativeLayer) return false;
      nativeLayer.urlTemplate = template;
      return true;
    },
    queryInView: (layerId: string): readonly Feature[] =>
      this.layersSnapshot.find((layer) => layer.id === layerId)?.geojson?.features ?? [],
    listRenderTargets: (): readonly MapRenderTarget[] =>
      this.layersSnapshot
        .filter((layer) => this.supportsLayer(layer))
        .map((layer) => ({
          id: layer.id,
          scope: "content" as const,
          queryable: layer.type === "geojson",
        })),
    hasRenderTarget: (id: string): boolean =>
      this.layersSnapshot.some((layer) => layer.id === id && this.supportsLayer(layer)),
    queryAtLngLat: async (lngLat: LngLat, layerId?: string): Promise<readonly HitFeature[]> => {
      const point = this.viewport.project(lngLat);
      return point ? this.queryAtScreenPoint(point, layerId) : [];
    },
    setHighlight: (layer, featureIds, options): void =>
      this.setHighlight(layer, featureIds, options),
    clearHighlight: (): void => this.removeOverlay(HIGHLIGHT_OVERLAY_ID),
  } satisfies MapEngine["layers"];

  readonly viewport = {
    project: (lngLat: LngLat): ScreenPoint | null =>
      this.view?.toScreen({ longitude: lngLat[0], latitude: lngLat[1] }) ?? null,
    unproject: (point: ScreenPoint): LngLat | null => {
      const lngLat = this.view?.toMap(point);
      const longitude = lngLat?.longitude ?? lngLat?.x;
      const latitude = lngLat?.latitude ?? lngLat?.y;
      return typeof longitude === "number" && typeof latitude === "number"
        ? [longitude, latitude]
        : null;
    },
    getElement: (): HTMLElement | null => this.container,
    getRect: (): DOMRectReadOnly | null => this.container?.getBoundingClientRect() ?? null,
    capture: async (options): ReturnType<MapEngine["viewport"]["capture"]> =>
      this.captureViewport(options),
  } satisfies MapEngine["viewport"];

  readonly interactions = {
    pickPoint: async (options): Promise<LngLat | null> =>
      this.view ? pickArcGISPoint(this.view, options) : null,
    drawBounds: async (options): Promise<BBox | null> =>
      this.view ? drawArcGISBounds(this.view, options) : null,
    setDoubleClickZoomEnabled: (enabled: boolean): void => this.setDoubleClickZoomEnabled(enabled),
    suspendNavigation: (): Unsubscribe => this.suspendNavigation(),
    createMarker: (options: MapMarkerOptions): MapMarkerHandle => this.createMarker(options),
    upsertGeoJsonOverlay: (spec: GeoJsonOverlaySpec): void => this.upsertOverlay(spec),
    setOverlayVisible: (id: string, visible: boolean): void => this.setOverlayVisible(id, visible),
    removeOverlay: (id: string): void => this.removeOverlay(id),
    showPopup: (options): void => this.showPopup(options),
    closePopup: (id: string): void => this.closePopup(id),
  } satisfies MapEngine["interactions"];

  readonly controls = {
    getBuiltInState: (control: BuiltInMapControl): MapControlState =>
      this.arcgisControls.getBuiltInState(control),
    setBuiltInState: (control: BuiltInMapControl, state: Partial<MapControlState>): boolean =>
      this.arcgisControls.setBuiltInState(control, state),
    setLabels: (labels: Partial<Record<"compass" | "terrain" | "background", string>>): void =>
      this.arcgisControls.setLabels(labels),
    // ArcGIS Maps SDK has no public vertical-exaggeration equivalent for the
    // 2D MapView. Keep the neutral value rather than claiming a visual effect.
    getTerrainExaggeration: (): number => 1,
    setTerrainExaggeration: (_value: number): void => undefined,
  } satisfies MapEngine["controls"];

  constructor(dependencies: ArcGISMapEngineDependencies = {}) {
    this.options = {
      loadArcGIS: dependencies.loadArcGIS ?? loadArcGISModules,
      assetsPath: dependencies.assetsPath ?? localArcGISAssetsPath,
    };
  }

  async mount(container: HTMLElement, initialView: MapViewState): Promise<void> {
    if (this.destroyed) return;
    this.container = container;
    this.cachedView = initialView;
    this.lastAppliedView = initialView;
    try {
      const modules = await this.options.loadArcGIS();
      if (this.destroyed) return;
      modules.config.assetsPath = this.options.assetsPath();
      const basemapLayer = new modules.WebTileLayer({
        id: "geolibre-arcgis-basemap",
        title: "OpenStreetMap",
        urlTemplate: OPEN_STREET_MAP_TILES,
        copyright: "© OpenStreetMap contributors",
      });
      const map = new modules.Map({
        basemap: new modules.Basemap({ baseLayers: [basemapLayer] }),
      });
      const view = new modules.MapView({
        container,
        map,
        // GeoLibre owns click behavior through MapEngine events. Explicit
        // popups below remain available through the documented view API.
        popupEnabled: false,
        ...mapViewStateToArcGISView(initialView),
      });
      if (this.destroyed) {
        view.destroy();
        return;
      }
      this.modules = modules;
      this.map = map;
      this.view = view;
      this.basemapLayer = basemapLayer;
      this.bindViewEvents(view);
      await view.when();
      if (this.destroyed) return;
      this.arcgisControls.initialize(view, modules);
      this.reconcileLayers();
      this.emit("load", { reason: "mount" });
    } catch (error) {
      if (this.destroyed) return;
      this.emit("error", { message: errorMessage(error) });
      throw error;
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const handle of this.handles.splice(0)) handle.remove();
    this.doubleClickZoomHandle?.remove();
    this.doubleClickZoomHandle = null;
    this.arcgisControls.destroy();
    this.revokeObjectUrls();
    this.revokeOverlayObjectUrls();
    this.view?.destroy();
    this.view = null;
    this.map = null;
    this.modules = null;
    this.basemapLayer = null;
    this.nativeLayers.clear();
    this.transientLayers.clear();
    this.overlays.clear();
    for (const marker of this.markers) marker.remove();
    this.markers.clear();
    this.container = null;
    this.listeners.clear();
  }

  configure(options: Parameters<MapEngine["configure"]>[0]): void {
    if (typeof options.basemapVisible === "boolean" && this.basemapLayer) {
      this.basemapLayer.visible = options.basemapVisible;
    }
    if (typeof options.basemapOpacity === "number" && this.basemapLayer) {
      this.basemapLayer.opacity = options.basemapOpacity;
    }
  }

  applyView(view: MapViewState): void {
    this.cachedView = view;
    this.lastAppliedView = view;
    if (!this.view) return;
    void this.view.goTo(mapViewStateToArcGISView(view), { animate: false }).catch(() => undefined);
  }

  readView(): MapViewState {
    if (!this.view) return this.cachedView;
    return arcGISViewToMapViewState(this.view, this.cachedView);
  }

  syncLayers(layers: readonly GeoLibreLayer[]): void {
    this.layersSnapshot = layers;
    this.reconcileLayers();
  }

  supports(capability: MapEngineCapability): boolean {
    return (
      capability === "capture" ||
      capability === "controls" ||
      capability === "feature-query" ||
      capability === "interactions" ||
      capability === "markers" ||
      capability === "popups" ||
      capability === "transient-overlays"
    );
  }

  supportsLayer(layer: GeoLibreLayer): boolean {
    return supportedLayerTypes.has(layer.type);
  }

  async hitTest(point: ScreenPoint): Promise<readonly HitFeature[]> {
    return this.queryAtScreenPoint(point);
  }

  invoke<K extends keyof MapEngineExtensionMap>(
    command: K,
    _input: MapEngineExtensionMap[K]["input"],
  ): MapEngineExtensionMap[K]["output"] {
    switch (command) {
      case "viewport.resize":
        // MapView observes its container and resizes itself. Unlike MapLibre,
        // its documented public API has no imperative `resize()` method.
        return undefined as MapEngineExtensionMap[K]["output"];
      case "story.set-layer-opacity":
      case "story.restore-layer-styles":
      case "hosted-plugin.deactivate":
      case "hosted-plugin.get-state":
        return undefined as MapEngineExtensionMap[K]["output"];
      case "hosted-plugin.activate":
      case "hosted-plugin.set-position":
      case "hosted-plugin.apply-state":
      case "directions.remove-last":
      case "directions.clear":
      case "earth-engine.hide":
        return false as MapEngineExtensionMap[K]["output"];
      case "time-slider.query-pixel-series":
        return this.unsupported("feature-query") as MapEngineExtensionMap[K]["output"];
    }
  }

  on<K extends keyof MapEngineEventMap>(
    event: K,
    handler: (payload: MapEngineEventMap[K]) => void,
  ): Unsubscribe {
    const handlers = this.listeners.get(event) ?? new Set<(payload: never) => void>();
    handlers.add(handler as (payload: never) => void);
    this.listeners.set(event, handlers);
    return () => handlers.delete(handler as (payload: never) => void);
  }

  private bindViewEvents(view: ArcGISMapView): void {
    const markUserMove = (): void => {
      this.userMoved = true;
    };
    this.handles.push(
      view.on("drag", () => {
        markUserMove();
        this.refreshMarkers();
      }),
      view.on("mouse-wheel", () => {
        markUserMove();
        this.refreshMarkers();
      }),
      view.on("key-down", markUserMove),
      view.on("click", (event) => this.emitPointerEvent("click", event)),
      view.on("double-click", (event) => this.emitPointerEvent("dblclick", event)),
      view.on("pointer-move", (event) => this.emitPointerEvent("pointermove", event)),
      view.on("pointer-leave", () => this.emit("pointerleave", undefined)),
      view.on("pointer-down", (event) => {
        if (event.button === 2) this.emitPointerEvent("contextmenu", event);
      }),
      this.modules!.reactiveUtils.watch(
        () => view.stationary,
        (stationary) => {
          this.moving = !stationary;
          if (stationary) this.handleStationary();
        },
      ),
      this.modules!.reactiveUtils.watch(
        () => view.popup?.visible === true,
        (visible) => {
          if (!visible) this.notifyPopupClosed();
        },
      ),
    );
  }

  private handleStationary(): void {
    if (this.destroyed) return;
    const view = this.readView();
    if (this.lastAppliedView && isSameArcGISMapView(view, this.lastAppliedView)) {
      this.lastAppliedView = null;
      this.userMoved = false;
      return;
    }
    const userDriven = this.userMoved;
    this.userMoved = false;
    this.cachedView = view;
    this.lastAppliedView = view;
    this.refreshMarkers();
    this.emit("moveend", { view, userDriven });
    this.emit("idle", undefined);
  }

  private emitPointerEvent(
    event: "click" | "dblclick" | "contextmenu" | "pointermove",
    nativeEvent: ArcGISViewInputEvent,
  ): void {
    if (typeof nativeEvent.x !== "number" || typeof nativeEvent.y !== "number") return;
    const point = { x: nativeEvent.x, y: nativeEvent.y };
    const mapPoint = nativeEvent.mapPoint;
    const longitude = mapPoint?.longitude ?? mapPoint?.x;
    const latitude = mapPoint?.latitude ?? mapPoint?.y;
    const lngLat =
      typeof longitude === "number" && typeof latitude === "number"
        ? ([longitude, latitude] as LngLat)
        : this.viewport.unproject(point);
    if (!lngLat) return;
    this.emit(event, { point, lngLat });
  }

  private fitBounds(bounds: BBox): void {
    if (!this.view) return;
    this.lastAppliedView = null;
    void this.view
      .goTo(
        {
          target: {
            type: "extent",
            xmin: bounds[0],
            ymin: bounds[1],
            xmax: bounds[2],
            ymax: bounds[3],
            spatialReference: { wkid: 4326 },
          },
        },
        { animate: false },
      )
      .catch(() => undefined);
  }

  private readBounds(): BBox | null {
    const view = this.view;
    const rect = this.container?.getBoundingClientRect();
    if (!view || !rect || !(rect.width > 0) || !(rect.height > 0)) return null;
    const corners = [
      view.toMap({ x: 0, y: 0 }),
      view.toMap({ x: rect.width, y: 0 }),
      view.toMap({ x: rect.width, y: rect.height }),
      view.toMap({ x: 0, y: rect.height }),
    ];
    const lngLats = corners.map((point) => {
      const longitude = point?.longitude ?? point?.x;
      const latitude = point?.latitude ?? point?.y;
      return typeof longitude === "number" && typeof latitude === "number"
        ? ([longitude, latitude] as const)
        : null;
    });
    if (lngLats.some((point) => point === null)) return null;
    const points = lngLats as Array<readonly [number, number]>;
    return [
      Math.min(...points.map((point) => point[0])),
      Math.min(...points.map((point) => point[1])),
      Math.max(...points.map((point) => point[0])),
      Math.max(...points.map((point) => point[1])),
    ];
  }

  private reconcileLayers(): void {
    const map = this.map;
    const modules = this.modules;
    if (!map || !modules) return;
    this.revokeObjectUrls();
    map.layers.removeAll();
    this.nativeLayers.clear();
    this.revokeOverlayObjectUrls();
    this.transientLayers.clear();
    const nativeLayers: ArcGISLayer[] = [];
    for (const layer of this.layersSnapshot) {
      const nativeLayer = this.createLayer(layer, modules);
      if (!nativeLayer) continue;
      this.nativeLayers.set(layer.id, nativeLayer);
      nativeLayers.push(nativeLayer);
    }
    map.layers.addMany(nativeLayers);
    for (const spec of this.overlays.values()) this.mountOverlay(spec);
  }

  private createLayer(layer: GeoLibreLayer, modules: ArcGISMapEngineModules): ArcGISLayer | null {
    const properties: Record<string, unknown> = {
      id: toArcGISLayerId(layer.id),
      title: layer.name,
      visible: layer.visible,
      opacity: layer.opacity,
    };
    if (layer.type === "geojson" && layer.geojson) {
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(withArcGISFeatureIndices(layer.geojson))], { type: "application/geo+json" }),
      );
      this.objectUrls.add(url);
      return new modules.GeoJSONLayer({ ...properties, url });
    }

    if (layer.type === "wms") {
      const url = stringSourceValue(layer.source, "url");
      if (url) return new modules.WMSLayer({ ...properties, url });
    }
    if (layer.type === "wmts") {
      const url = stringSourceValue(layer.source, "url");
      if (url) return new modules.WMTSLayer({ ...properties, url });
    }
    if (layer.type === "vector-tiles") {
      const url = stringSourceValue(layer.source, "url");
      if (url) return new modules.VectorTileLayer({ ...properties, url });
    }
    if (layer.type === "image") {
      const image = stringSourceValue(layer.source, "url");
      const georeference = imageCorners(layer.source);
      if (image && georeference) {
        return new modules.MediaLayer({
          ...properties,
          source: { type: "image", image, georeference },
        });
      }
    }
    if (layer.type === "video") {
      const video = videoUrl(layer.source);
      const georeference = imageCorners(layer.source);
      if (video && georeference) {
        return new modules.MediaLayer({
          ...properties,
          source: { type: "video", video, georeference },
        });
      }
    }
    if (layer.type === "cog") {
      const url = cogUrl(layer.source);
      if (url) return new modules.ImageryTileLayer({ ...properties, url });
    }
    if (
      layer.type === "raster" ||
      layer.type === "xyz" ||
      layer.type === "wms" ||
      layer.type === "wmts"
    ) {
      const urlTemplate = tileTemplate(layer);
      if (urlTemplate) return new modules.WebTileLayer({ ...properties, urlTemplate });
    }
    return null;
  }

  private findNativeLayer(layerId: string): ArcGISLayer | null {
    return this.nativeLayers.get(layerId) ?? null;
  }

  private async queryAtScreenPoint(
    point: ScreenPoint,
    layerId?: string,
  ): Promise<readonly HitFeature[]> {
    if (!this.view) return [];
    const include = [...this.nativeLayers.entries()]
      .filter(([id]) => !layerId || id === layerId)
      .filter(([id]) => this.layersSnapshot.find((layer) => layer.id === id)?.type === "geojson")
      .map(([, layer]) => layer);
    if (include.length === 0) return [];
    const result = await this.view.hitTest(point, { include });
    return toArcGISHitFeatures(result, this.layersSnapshot, layerId);
  }

  private async captureViewport(
    options?: Parameters<MapEngine["viewport"]["capture"]>[0],
  ): ReturnType<MapEngine["viewport"]["capture"]> {
    const view = this.view;
    if (!view) throw new Error("ArcGIS MapView is not mounted.");
    const hidden = (options?.hideOverlayIds ?? [])
      .map((id) => this.transientLayers.get(id))
      .filter((layer): layer is ArcGISLayer => Boolean(layer))
      .map((layer) => ({ layer, visible: layer.visible }));
    for (const { layer } of hidden) layer.visible = false;
    try {
      return await captureArcGISViewport(view, {
        bounds: options?.bounds,
        bearing: this.readView().bearing,
      });
    } finally {
      for (const { layer, visible } of hidden) layer.visible = visible;
    }
  }

  private setDoubleClickZoomEnabled(enabled: boolean): void {
    if (enabled) {
      this.doubleClickZoomHandle?.remove();
      this.doubleClickZoomHandle = null;
      return;
    }
    if (!this.view || this.doubleClickZoomHandle) return;
    this.doubleClickZoomHandle = this.view.on("double-click", (event) => event.stopPropagation?.());
  }

  private createMarker(options: MapMarkerOptions): MapMarkerHandle {
    const view = this.view;
    if (!view) throw new Error("ArcGIS MapView is not mounted.");
    const marker = new ArcGISDomMarker(view, options);
    this.markers.add(marker);
    const remove = marker.remove.bind(marker);
    marker.remove = () => {
      remove();
      this.markers.delete(marker);
    };
    return marker;
  }

  private refreshMarkers(): void {
    for (const marker of this.markers) marker.refresh();
  }

  private suspendNavigation(): Unsubscribe {
    const navigation = this.view?.navigation;
    if (!navigation) return () => undefined;
    const actionMap = navigation.actionMap;
    const previous = {
      dragPrimary: actionMap.dragPrimary,
      dragSecondary: actionMap.dragSecondary,
      dragTertiary: actionMap.dragTertiary,
      mouseWheel: actionMap.mouseWheel,
      browserTouchPanEnabled: navigation.browserTouchPanEnabled,
      momentumEnabled: navigation.momentumEnabled,
      gamepadEnabled: navigation.gamepad?.enabled,
    };
    actionMap.dragPrimary = "none";
    actionMap.dragSecondary = "none";
    actionMap.dragTertiary = "none";
    actionMap.mouseWheel = "none";
    navigation.browserTouchPanEnabled = false;
    navigation.momentumEnabled = false;
    if (navigation.gamepad) navigation.gamepad.enabled = false;
    return () => {
      actionMap.dragPrimary = previous.dragPrimary;
      actionMap.dragSecondary = previous.dragSecondary;
      actionMap.dragTertiary = previous.dragTertiary;
      actionMap.mouseWheel = previous.mouseWheel;
      navigation.browserTouchPanEnabled = previous.browserTouchPanEnabled;
      navigation.momentumEnabled = previous.momentumEnabled;
      if (navigation.gamepad && previous.gamepadEnabled !== undefined) {
        navigation.gamepad.enabled = previous.gamepadEnabled;
      }
    };
  }

  private setHighlight(
    layer: GeoLibreLayer | undefined,
    featureIds: readonly string[],
    _options?: { readonly fit?: boolean },
  ): void {
    if (!layer?.geojson || featureIds.length === 0) {
      this.removeOverlay(HIGHLIGHT_OVERLAY_ID);
      return;
    }
    const selected = new Set(featureIds);
    const features = layer.geojson.features.filter((feature, index) =>
      selected.has(String(feature.id ?? index)),
    );
    if (features.length === 0) {
      this.removeOverlay(HIGHLIGHT_OVERLAY_ID);
      return;
    }
    this.upsertOverlay({
      id: HIGHLIGHT_OVERLAY_ID,
      data: { type: "FeatureCollection", features },
      visible: true,
      style: {
        fillColor: "#38bdf8",
        fillOpacity: 0.2,
        lineColor: "#0284c7",
        lineWidth: 3,
        pointColor: "#0284c7",
        pointRadius: 8,
      },
    });
  }

  private upsertOverlay(spec: GeoJsonOverlaySpec): void {
    this.overlays.set(spec.id, spec);
    const map = this.map;
    const existing = this.transientLayers.get(spec.id);
    if (map && existing) map.layers.remove(existing);
    this.revokeOverlayObjectUrl(spec.id);
    this.transientLayers.delete(spec.id);
    if (map) this.mountOverlay(spec);
  }

  private setOverlayVisible(id: string, visible: boolean): void {
    const spec = this.overlays.get(id);
    if (!spec) return;
    this.overlays.set(id, { ...spec, visible });
    const nativeLayer = this.transientLayers.get(id);
    if (nativeLayer) nativeLayer.visible = visible;
  }

  private removeOverlay(id: string): void {
    const nativeLayer = this.transientLayers.get(id);
    if (nativeLayer) this.map?.layers.remove(nativeLayer);
    this.transientLayers.delete(id);
    this.overlays.delete(id);
    this.revokeOverlayObjectUrl(id);
  }

  private mountOverlay(spec: GeoJsonOverlaySpec): void {
    const modules = this.modules;
    const map = this.map;
    if (!modules || !map) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(spec.data)], { type: "application/geo+json" }),
    );
    this.overlayObjectUrls.set(spec.id, url);
    const layer = new modules.GeoJSONLayer({
      id: `geolibre-overlay-${spec.id}`,
      title: spec.id,
      visible: spec.visible !== false,
      url,
    });
    this.transientLayers.set(spec.id, layer);
    map.layers.addMany([layer]);
  }

  private revokeOverlayObjectUrl(id: string): void {
    const url = this.overlayObjectUrls.get(id);
    if (url) URL.revokeObjectURL(url);
    this.overlayObjectUrls.delete(id);
  }

  private revokeOverlayObjectUrls(): void {
    for (const url of this.overlayObjectUrls.values()) URL.revokeObjectURL(url);
    this.overlayObjectUrls.clear();
  }

  private showPopup(options: {
    readonly id: string;
    readonly lngLat: LngLat;
    readonly content: HTMLElement;
    readonly closeOnClick?: boolean;
    readonly maxWidth?: string;
    readonly onClose?: () => void;
  }): void {
    if (!this.view) return;
    this.closeActivePopup();
    this.activePopup = { id: options.id, onClose: options.onClose };
    void this.view
      .openPopup({
        location: { longitude: options.lngLat[0], latitude: options.lngLat[1] },
        content: options.content,
      })
      .catch(() => this.notifyPopupClosed());
  }

  private closePopup(id: string): void {
    if (this.activePopup?.id !== id) return;
    this.closeActivePopup();
  }

  private closeActivePopup(): void {
    if (!this.activePopup) return;
    this.view?.closePopup();
    this.notifyPopupClosed();
  }

  private notifyPopupClosed(): void {
    const popup = this.activePopup;
    if (!popup) return;
    this.activePopup = null;
    popup.onClose?.();
  }

  private revokeObjectUrls(): void {
    for (const url of this.objectUrls) URL.revokeObjectURL(url);
    this.objectUrls.clear();
  }

  private emit<K extends keyof MapEngineEventMap>(event: K, payload: MapEngineEventMap[K]): void {
    const handlers = this.listeners.get(event);
    if (!handlers) return;
    for (const handler of handlers) handler(payload as never);
  }

  private unsupported(capability: MapEngineCapability): never {
    throw new MapEngineCapabilityError("arcgis", capability);
  }
}

export function createArcGISMapEngine(): ArcGISMapEngine {
  return new ArcGISMapEngine();
}
