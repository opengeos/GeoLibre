import type {
  GeoLibreLayer,
  MapProjection,
  MapViewState,
  StoryChapterLocation,
} from "@geolibre/core";
import type { Feature, FeatureCollection } from "geojson";
import type { Viewer } from "cesium";
import { applyMapViewToCamera, isSameView, readMapViewFromCamera } from "../cesium-camera";
import { CesiumLayerSync, isCesiumSupportedLayerType } from "../cesium-layer-sync";
import { getLayerBounds } from "../geojson-loader";
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

type CesiumNamespace = typeof import("cesium");

interface CesiumLayerSynchronizer {
  sync(layers: GeoLibreLayer[]): void;
  destroy(): void;
}

export interface CesiumEngineOptions {
  readonly ionToken?: string;
}

/** Package-private dependency seam used by adapter tests. */
export interface CesiumEngineDependencies {
  readonly loadCesium?: () => Promise<CesiumNamespace>;
  readonly createLayerSync?: (Cesium: CesiumNamespace, viewer: Viewer) => CesiumLayerSynchronizer;
  readonly prepareEnvironment?: () => void;
}

const APP_BASE_URL =
  (import.meta as ImportMeta & { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/";
const CESIUM_BASE_URL = `${APP_BASE_URL}cesium`;
const CESIUM_CSS_LINK_ID = "cesium-widgets-css";

export function prepareCesiumEnvironment(): void {
  const globalWindow = window as typeof window & { CESIUM_BASE_URL?: string };
  globalWindow.CESIUM_BASE_URL ??= CESIUM_BASE_URL;
  if (document.getElementById(CESIUM_CSS_LINK_ID)) return;
  const link = document.createElement("link");
  link.id = CESIUM_CSS_LINK_ID;
  link.rel = "stylesheet";
  link.href = `${CESIUM_BASE_URL}/Widgets/widgets.css`;
  document.head.appendChild(link);
}

export class CesiumEngine implements MapEngine {
  private readonly listeners = new Map<keyof MapEngineEventMap, Set<(payload: never) => void>>();
  private readonly removeCesiumListeners: Array<() => void> = [];
  private readonly removeInputListeners: Array<() => void> = [];
  private readonly options: Required<CesiumEngineDependencies> &
    Pick<CesiumEngineOptions, "ionToken">;
  private Cesium: CesiumNamespace | null = null;
  private viewer: Viewer | null = null;
  private layerSync: CesiumLayerSynchronizer | null = null;
  private container: HTMLElement | null = null;
  private layersSnapshot: readonly GeoLibreLayer[] = [];
  private cachedView: MapViewState = {
    center: [-100, 40],
    zoom: 2,
    bearing: 0,
    pitch: 0,
  };
  private lastAppliedView: MapViewState | null = null;
  private userMoved = false;
  private moving = false;
  private destroyed = false;
  private pendingTag: string | undefined;

  readonly camera = {
    readView: (): MapViewState => this.readView(),
    readBounds: (): BBox | null => null,
    readZoomRange: (): { readonly min: number; readonly max: number } => ({ min: 0, max: 24 }),
    applyView: (view: MapViewState, options?: { readonly tag?: string }): void => {
      this.pendingTag = options?.tag;
      this.applyView(view);
    },
    flyToLocation: (location: StoryChapterLocation): void => this.applyView(location),
    playStoryChapter: (
      location: StoryChapterLocation,
      _options: Parameters<MapEngine["camera"]["playStoryChapter"]>[1],
    ): void => {
      this.pendingTag = "story-camera";
      this.applyView(location);
    },
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
    readProjection: (): MapProjection => "globe",
    isMoving: (): boolean => this.moving,
    whenIdle: async (options?: {
      readonly timeoutMs?: number;
      readonly signal?: AbortSignal;
    }): Promise<void> => this.whenIdle(options),
  } satisfies MapEngine["camera"];

  readonly layers = {
    readGeoJson: async (layerId: string): Promise<FeatureCollection | null> =>
      this.layersSnapshot.find((layer) => layer.id === layerId)?.geojson ?? null,
    readRasterSource: (): Readonly<Record<string, unknown>> | null => null,
    setRasterTiles: (): boolean => false,
    queryInView: (_layerId: string): readonly Feature[] => this.unsupported("feature-query"),
    listRenderTargets: (): readonly MapRenderTarget[] =>
      this.layersSnapshot
        .filter(isCesiumSupportedLayerType)
        .map((layer) => ({ id: layer.id, scope: "content" as const })),
    hasRenderTarget: (id: string): boolean => this.layersSnapshot.some((layer) => layer.id === id),
    queryAtLngLat: async (_lngLat: LngLat, _layerId?: string): Promise<readonly HitFeature[]> =>
      this.unsupported("feature-query"),
    setHighlight: (): void => this.unsupported("transient-overlays"),
    clearHighlight: (): void => this.unsupported("transient-overlays"),
  } satisfies MapEngine["layers"];

  readonly viewport = {
    project: (_lngLat: LngLat): ScreenPoint | null => null,
    unproject: (_point: ScreenPoint): LngLat | null => null,
    getElement: (): HTMLElement | null => this.container,
    getRect: (): DOMRectReadOnly | null => this.container?.getBoundingClientRect() ?? null,
    capture: async (): ReturnType<MapEngine["viewport"]["capture"]> => this.unsupported("capture"),
  } satisfies MapEngine["viewport"];

  readonly interactions = {
    pickPoint: async (): Promise<LngLat | null> => this.unsupported("interactions"),
    drawBounds: async (): Promise<BBox | null> => this.unsupported("interactions"),
    setDoubleClickZoomEnabled: (): void => this.unsupported("interactions"),
    suspendNavigation: (): Unsubscribe => this.unsupported("interactions"),
    createMarker: (_options: MapMarkerOptions): MapMarkerHandle => this.unsupported("markers"),
    upsertGeoJsonOverlay: (_spec: GeoJsonOverlaySpec): void =>
      this.unsupported("transient-overlays"),
    setOverlayVisible: (): void => this.unsupported("transient-overlays"),
    removeOverlay: (): void => this.unsupported("transient-overlays"),
    showPopup: (): void => this.unsupported("popups"),
    closePopup: (): void => this.unsupported("popups"),
  } satisfies MapEngine["interactions"];

  readonly controls = {
    getBuiltInState: (_control: BuiltInMapControl): MapControlState => this.unsupported("controls"),
    setBuiltInState: (): boolean => this.unsupported("controls"),
    setLabels: (): void => this.unsupported("controls"),
    getTerrainExaggeration: (): number => this.unsupported("controls"),
    setTerrainExaggeration: (): void => this.unsupported("controls"),
  } satisfies MapEngine["controls"];

  constructor(options: CesiumEngineOptions = {}, dependencies: CesiumEngineDependencies = {}) {
    this.options = {
      ionToken: options.ionToken,
      loadCesium: dependencies.loadCesium ?? (async () => import("cesium")),
      createLayerSync:
        dependencies.createLayerSync ?? ((Cesium, viewer) => new CesiumLayerSync(Cesium, viewer)),
      prepareEnvironment: dependencies.prepareEnvironment ?? prepareCesiumEnvironment,
    };
  }

  async mount(container: HTMLElement, initialView: MapViewState): Promise<void> {
    if (this.destroyed) return;
    this.container = container;
    this.cachedView = initialView;
    this.options.prepareEnvironment();
    try {
      const Cesium = await this.options.loadCesium();
      if (this.destroyed) return;
      const token = this.options.ionToken?.trim();
      if (token) Cesium.Ion.defaultAccessToken = token;
      const viewer = new Cesium.Viewer(container, {
        baseLayerPicker: false,
        geocoder: false,
        homeButton: false,
        sceneModePicker: false,
        navigationHelpButton: false,
        timeline: false,
        animation: false,
        fullscreenButton: false,
        infoBox: false,
        selectionIndicator: false,
        baseLayer: token
          ? undefined
          : Cesium.ImageryLayer.fromProviderAsync(
              Promise.resolve(
                new Cesium.OpenStreetMapImageryProvider({
                  url: "https://tile.openstreetmap.org/",
                }),
              ),
              {},
            ),
      });
      if (this.destroyed) {
        viewer.destroy();
        return;
      }
      this.Cesium = Cesium;
      this.viewer = viewer;
      this.layerSync = this.options.createLayerSync(Cesium, viewer);
      viewer.screenSpaceEventHandler.removeInputAction(
        Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK,
      );
      this.bindInputEvents(viewer.canvas);
      this.bindCameraEvents(Cesium, viewer);
      this.applyView(initialView);
      this.layerSync.sync([...this.layersSnapshot]);
      if (token) {
        try {
          const terrain = await Cesium.createWorldTerrainAsync();
          if (!this.destroyed && !viewer.isDestroyed()) viewer.terrainProvider = terrain;
        } catch {
          // Terrain is an optional enhancement; the ellipsoid globe remains usable.
        }
      }
      if (this.destroyed || viewer.isDestroyed()) return;
      this.emit("load", { reason: "mount" });
    } catch (error) {
      if (this.destroyed) return;
      this.emit("error", {
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof Error && error.stack ? { detail: error.stack } : {}),
      });
      throw error;
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const remove of this.removeCesiumListeners.splice(0)) remove();
    for (const remove of this.removeInputListeners.splice(0)) remove();
    this.layerSync?.destroy();
    this.layerSync = null;
    if (this.viewer && !this.viewer.isDestroyed()) this.viewer.destroy();
    this.viewer = null;
    this.Cesium = null;
    this.container = null;
    this.listeners.clear();
  }

  configure(options: Parameters<MapEngine["configure"]>[0]): void {
    const baseLayer = this.viewer?.imageryLayers.get(0);
    if (!baseLayer) return;
    if (typeof options.basemapVisible === "boolean") baseLayer.show = options.basemapVisible;
    if (typeof options.basemapOpacity === "number") baseLayer.alpha = options.basemapOpacity;
  }

  applyView(view: MapViewState): void {
    this.cachedView = view;
    this.lastAppliedView = view;
    if (!this.Cesium || !this.viewer || this.viewer.isDestroyed()) return;
    applyMapViewToCamera(this.Cesium, this.viewer, view);
  }

  readView(): MapViewState {
    if (!this.Cesium || !this.viewer || this.viewer.isDestroyed()) return this.cachedView;
    return readMapViewFromCamera(this.Cesium, this.viewer);
  }

  syncLayers(layers: readonly GeoLibreLayer[]): void {
    this.layersSnapshot = layers;
    this.layerSync?.sync([...layers]);
  }

  supports(_capability: MapEngineCapability): boolean {
    return false;
  }

  supportsLayer(layer: GeoLibreLayer): boolean {
    return isCesiumSupportedLayerType(layer);
  }

  async hitTest(_point: ScreenPoint): Promise<readonly HitFeature[]> {
    return this.unsupported("feature-query");
  }

  invoke<K extends keyof MapEngineExtensionMap>(
    command: K,
    _input: MapEngineExtensionMap[K]["input"],
  ): MapEngineExtensionMap[K]["output"] {
    switch (command) {
      case "viewport.resize":
        this.viewer?.resize();
        return undefined as MapEngineExtensionMap[K]["output"];
      case "story.set-layer-opacity":
      case "story.restore-layer-styles":
        return undefined as MapEngineExtensionMap[K]["output"];
      case "hosted-plugin.activate":
      case "hosted-plugin.set-position":
      case "hosted-plugin.apply-state":
        return false as MapEngineExtensionMap[K]["output"];
      case "hosted-plugin.deactivate":
      case "hosted-plugin.get-state":
        return undefined as MapEngineExtensionMap[K]["output"];
      case "time-slider.query-pixel-series":
        return this.unsupported("feature-query") as MapEngineExtensionMap[K]["output"];
      case "directions.remove-last":
      case "directions.clear":
      case "earth-engine.hide":
        return false as MapEngineExtensionMap[K]["output"];
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

  private emit<K extends keyof MapEngineEventMap>(event: K, payload: MapEngineEventMap[K]): void {
    const handlers = this.listeners.get(event);
    if (!handlers) return;
    for (const handler of handlers) handler(payload as never);
  }

  private unsupported(capability: MapEngineCapability): never {
    throw new MapEngineCapabilityError("cesium", capability);
  }

  private fitBounds(bounds: BBox): void {
    if (!this.Cesium || !this.viewer || this.viewer.isDestroyed()) return;
    this.lastAppliedView = null;
    this.viewer.camera.flyTo({
      destination: this.Cesium.Rectangle.fromDegrees(...bounds),
    });
  }

  private bindInputEvents(canvas: HTMLCanvasElement): void {
    const markUserMove = (): void => {
      this.userMoved = true;
    };
    const markUserDrag = (event: PointerEvent): void => {
      if (event.buttons !== 0) this.userMoved = true;
    };
    const options: AddEventListenerOptions = { passive: true };
    for (const [event, handler] of [
      ["pointermove", markUserDrag],
      ["wheel", markUserMove],
      ["touchmove", markUserMove],
    ] as const) {
      canvas.addEventListener(event, handler as EventListener, options);
      this.removeInputListeners.push(() =>
        canvas.removeEventListener(event, handler as EventListener, options),
      );
    }
  }

  private bindCameraEvents(Cesium: CesiumNamespace, viewer: Viewer): void {
    this.removeCesiumListeners.push(
      viewer.camera.moveStart.addEventListener(() => {
        this.moving = true;
        this.emit("movestart", { userDriven: this.userMoved });
      }),
      viewer.camera.changed.addEventListener(() => {
        if (viewer.isDestroyed()) return;
        this.emit("move", {
          view: readMapViewFromCamera(Cesium, viewer),
          userDriven: this.userMoved,
        });
      }),
      viewer.camera.moveEnd.addEventListener(() => {
        this.moving = false;
        if (viewer.isDestroyed()) return;
        const view = readMapViewFromCamera(Cesium, viewer);
        if (this.lastAppliedView && isSameView(view, this.lastAppliedView)) {
          this.pendingTag = undefined;
          this.userMoved = false;
          return;
        }
        this.cachedView = view;
        this.lastAppliedView = view;
        const userDriven = this.userMoved;
        this.userMoved = false;
        this.emit("moveend", {
          view,
          userDriven,
          ...(this.pendingTag ? { tag: this.pendingTag } : {}),
        });
        this.pendingTag = undefined;
        this.emit("idle", undefined);
      }),
    );
  }

  private async whenIdle(options?: {
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
  }): Promise<void> {
    if (!this.moving) return;
    await new Promise<void>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const finish = (): void => {
        if (timeout) clearTimeout(timeout);
        options?.signal?.removeEventListener("abort", abort);
        unsubscribe();
        resolve();
      };
      const abort = (): void => {
        if (timeout) clearTimeout(timeout);
        unsubscribe();
        reject(options?.signal?.reason ?? new DOMException("Aborted", "AbortError"));
      };
      const unsubscribe = this.on("idle", finish);
      options?.signal?.addEventListener("abort", abort, { once: true });
      if (options?.timeoutMs) timeout = setTimeout(finish, options.timeoutMs);
    });
  }
}

export function createCesiumEngine(options?: CesiumEngineOptions): MapEngine {
  return new CesiumEngine(options);
}
