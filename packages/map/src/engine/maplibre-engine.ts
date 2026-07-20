import type {
  GeoLibreLayer,
  MapPreferences,
  MapProjection,
  MapViewState,
  StoryChapterAnimation,
  StoryChapterLocation,
} from "@geolibre/core";
import type { Feature, FeatureCollection } from "geojson";
import maplibregl from "maplibre-gl";
import type { MapEngineExtensionMap } from "./extensions";
import { drawMapLibreBounds } from "./draw-bounds";
import { createMapLibreMarker } from "./markers";
import { pickMapLibrePoint } from "./pick-point";
import { MapLibreTransientOverlays } from "./transient-overlays";
import type {
  BBox,
  BuiltInMapControl,
  GeoJsonOverlaySpec,
  HitFeature,
  LngLat,
  MapControlPosition,
  MapControlState,
  MapEngine,
  MapEngineCapability,
  MapEngineClient,
  MapEngineEventMap,
  MapMarkerHandle,
  MapMarkerOptions,
  MapRenderTarget,
  ScreenPoint,
  Unsubscribe,
} from "./types";

interface MapControllerContract {
  init(
    container: HTMLElement,
    options: {
      readonly styleUrl?: string;
      readonly mapView?: MapViewState;
      readonly mapPreferences?: MapPreferences;
    },
  ): maplibregl.Map;
  getMap(): maplibregl.Map | null;
  destroy(): void;
  setStyle(url: string): void;
  setBasemapVisible(visible: boolean): void;
  setBasemapOpacity(opacity: number): void;
  applyMapPreferences(preferences: MapPreferences): void;
  applyView(view: MapViewState): void;
  easeToView(view: MapViewState): void;
  readView(): MapViewState;
  waitAndSyncLayers(layers: GeoLibreLayer[]): void;
  getLayerGeoJson(layerId: string): Promise<FeatureCollection | null>;
  getLayerRasterSource(layerId: string): Record<string, unknown> | null;
  getBasemapStyleLayerIds(): string[];
  getContentRenderTargets?(): Array<{ id: string; queryable: boolean }>;
  queryLayerFeaturesInView?(layerId: string): Feature[];
  fitLayer(layer: GeoLibreLayer): void;
  fitBounds(bounds: BBox): void;
  flyToView(location: StoryChapterLocation): void;
  applyStoryChapterCamera(
    location: StoryChapterLocation,
    animation: StoryChapterAnimation,
    rotate: boolean,
  ): void;
  flyTo(camera: {
    readonly center?: LngLat;
    readonly zoom?: number;
    readonly bearing?: number;
    readonly pitch?: number;
    readonly duration?: number;
  }): void;
  zoomIn(): void;
  zoomOut(): void;
  resetNorth(): void;
  resetPitch(): void;
  resetNorthPitch(): void;
  readProjection(): MapProjection;
  identifyFeatures(lngLat: LngLat, layerId?: string): HitFeature[];
  highlightFeature(
    layer: GeoLibreLayer | undefined,
    featureId: string | string[] | null,
    options?: { readonly fit?: boolean },
  ): void;
  clearFeatureHighlight(): void;
  setBuiltInControlVisible(control: BuiltInMapControl, visible: boolean): boolean;
  getBuiltInControlPosition(control: BuiltInMapControl): MapControlPosition;
  setBuiltInControlPosition(control: BuiltInMapControl, position: MapControlPosition): boolean;
  setCompassLabel(label: string): void;
  setTerrainLabel(label: string): void;
  setBackgroundLabel(label: string): void;
  getTerrainExaggeration(): number;
  setTerrainExaggeration(value: number): void;
}

export interface MapControllerModule {
  createMapController(): MapControllerContract;
}

export type MapControllerLoader = () => Promise<MapControllerModule>;

interface MapLibreNativeEvent {
  readonly originalEvent?: Event;
  readonly point?: { readonly x: number; readonly y: number };
  readonly lngLat?: { readonly lng: number; readonly lat: number };
  readonly error?: unknown;
  readonly geolibreTag?: string;
  readonly storyCameraToken?: number;
}

interface PendingConfiguration {
  preferences?: MapPreferences;
  basemapStyleUrl?: string;
  basemapVisible?: boolean;
  basemapOpacity?: number;
}

const capabilities = new Set<MapEngineCapability>([
  "capture",
  "controls",
  "feature-query",
  "interactions",
  "markers",
  "popups",
  "transient-overlays",
]);

const defaultControlVisibility: Readonly<Record<BuiltInMapControl, boolean>> = {
  navigation: false,
  fullscreen: true,
  compass: true,
  geolocate: false,
  globe: true,
  terrain: false,
  scale: true,
  attribution: true,
  logo: false,
  "layer-control": true,
};

function normalizeLngLat(value: { readonly lng: number; readonly lat: number }): LngLat {
  return [value.lng, value.lat];
}

function normalizeError(error: unknown): MapEngineEventMap["error"] {
  if (error instanceof Error) {
    return { message: error.message, detail: error.stack };
  }
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    return {
      message: typeof record.message === "string" ? record.message : "MapLibre error",
      ...(typeof record.detail === "string" ? { detail: record.detail } : {}),
      ...(typeof record.source === "string" ? { source: record.source } : {}),
      ...(typeof record.status === "number" ? { status: record.status } : {}),
      ...(typeof record.url === "string" ? { url: record.url } : {}),
    };
  }
  return { message: typeof error === "string" ? error : "MapLibre error" };
}

export class MapLibreEngine implements MapEngine {
  private readonly listeners = new Map<keyof MapEngineEventMap, Set<(payload: never) => void>>();
  private readonly nativeListeners: Array<{
    readonly event: string;
    readonly handler: (event: MapLibreNativeEvent) => void;
  }> = [];
  private readonly popups = new Map<string, maplibregl.Popup>();
  private readonly controlVisibility: Record<BuiltInMapControl, boolean> = {
    ...defaultControlVisibility,
  };
  private overlays: MapLibreTransientOverlays | null = null;
  private controller: MapControllerContract | null = null;
  private map: maplibregl.Map | null = null;
  private pendingConfiguration: PendingConfiguration = {};
  private syncedLayers: readonly GeoLibreLayer[] = [];
  private destroyed = false;
  private loadEmitted = false;
  private sawInitialStyle = false;

  readonly camera = {
    readView: (): MapViewState => this.readView(),
    applyView: (
      view: MapViewState,
      options?: {
        readonly mode?: "jump" | "ease" | "fly";
        readonly durationMs?: number;
        readonly tag?: string;
      },
    ): void => {
      if (!this.map || !this.controller) return;
      const camera = {
        center: view.center,
        zoom: view.zoom,
        bearing: view.bearing,
        pitch: view.pitch,
        ...(typeof options?.durationMs === "number" ? { duration: options.durationMs } : {}),
      };
      const eventData = options?.tag ? { geolibreTag: options.tag } : undefined;
      if (options?.mode === "fly") this.map.flyTo(camera, eventData);
      else if (options?.mode === "ease") this.map.easeTo(camera, eventData);
      else this.map.jumpTo(camera, eventData);
    },
    flyToLocation: (location: StoryChapterLocation): void => {
      this.controller?.flyToView(location);
    },
    playStoryChapter: (
      location: StoryChapterLocation,
      options: {
        readonly animation: StoryChapterAnimation;
        readonly rotate: boolean;
      },
    ): void => {
      this.controller?.applyStoryChapterCamera(location, options.animation, options.rotate);
    },
    fitBounds: (
      bounds: BBox,
      options?: { readonly padding?: number; readonly animate?: boolean },
    ): void => {
      if (!this.map || !options) {
        this.controller?.fitBounds(bounds);
        return;
      }
      this.map.fitBounds(
        [
          [bounds[0], bounds[1]],
          [bounds[2], bounds[3]],
        ],
        {
          padding: options.padding ?? 40,
          duration: options.animate === false ? 0 : 800,
        },
      );
    },
    fitLayer: (layer: GeoLibreLayer): void => this.controller?.fitLayer(layer),
    zoomIn: (): void => this.controller?.zoomIn(),
    zoomOut: (): void => this.controller?.zoomOut(),
    resetNorth: (): void => this.controller?.resetNorth(),
    resetPitch: (): void => this.controller?.resetPitch(),
    resetNorthPitch: (): void => this.controller?.resetNorthPitch(),
    readProjection: (): MapProjection => this.controller?.readProjection() ?? "mercator",
    isMoving: (): boolean => this.map?.isMoving() ?? false,
    whenIdle: async (options?: {
      readonly timeoutMs?: number;
      readonly signal?: AbortSignal;
    }): Promise<void> => this.whenIdle(options),
  } satisfies MapEngine["camera"];

  readonly layers = {
    readGeoJson: async (layerId: string): Promise<FeatureCollection | null> =>
      this.controller?.getLayerGeoJson(layerId) ?? null,
    readRasterSource: (layerId: string): Readonly<Record<string, unknown>> | null =>
      this.controller?.getLayerRasterSource(layerId) ?? null,
    queryInView: (layerId: string): readonly Feature[] =>
      this.controller?.queryLayerFeaturesInView?.(layerId) ?? [],
    listRenderTargets: (): readonly MapRenderTarget[] => {
      const basemapTargets =
        this.controller?.getBasemapStyleLayerIds().map((id) => ({
          id,
          scope: "basemap" as const,
          queryable: false,
        })) ?? [];
      const controllerTargets = this.controller?.getContentRenderTargets?.();
      const contentTargets = (controllerTargets ?? this.syncedLayers).map((target) => ({
        id: target.id,
        scope: "content" as const,
        queryable: "queryable" in target ? target.queryable : false,
      }));
      const overlayTargets = (this.overlays?.ids() ?? []).map((id) => ({
        id,
        scope: "overlay" as const,
        queryable: false,
      }));
      return [...basemapTargets, ...contentTargets, ...overlayTargets];
    },
    queryAtLngLat: async (lngLat: LngLat, layerId?: string): Promise<readonly HitFeature[]> =>
      this.controller?.identifyFeatures(lngLat, layerId) ?? [],
    setHighlight: (
      layer: GeoLibreLayer | undefined,
      featureIds: readonly string[],
      options?: { readonly fit?: boolean },
    ): void => {
      this.controller?.highlightFeature(layer, [...featureIds], options);
    },
    clearHighlight: (): void => this.controller?.clearFeatureHighlight(),
  } satisfies MapEngine["layers"];

  readonly viewport = {
    project: (lngLat: LngLat): ScreenPoint | null => {
      if (!this.map) return null;
      const point = this.map.project(lngLat);
      return { x: point.x, y: point.y };
    },
    unproject: (point: ScreenPoint): LngLat | null => {
      if (!this.map) return null;
      return normalizeLngLat(this.map.unproject([point.x, point.y]));
    },
    getElement: (): HTMLElement | null => this.map?.getContainer() ?? null,
    getRect: (): DOMRectReadOnly | null => this.map?.getContainer().getBoundingClientRect() ?? null,
    capture: async (): ReturnType<MapEngine["viewport"]["capture"]> => {
      if (!this.map) throw new Error("MapLibre engine is not mounted.");
      const canvas = this.map.getCanvas();
      const view = this.controller?.readView();
      const latitude = view?.center[1] ?? 0;
      const zoom = view?.zoom ?? 0;
      const metersPerPixel =
        (Math.cos((latitude * Math.PI) / 180) * 2 * Math.PI * 6378137) / (512 * 2 ** zoom);
      return {
        canvas,
        width: canvas.width,
        height: canvas.height,
        metersPerPixel,
        bearing: view?.bearing ?? 0,
      };
    },
  } satisfies MapEngine["viewport"];

  readonly interactions = {
    pickPoint: async (options?: { readonly signal?: AbortSignal }): Promise<LngLat | null> =>
      this.map ? pickMapLibrePoint(this.map, options) : null,
    drawBounds: async (options?: {
      readonly aspectRatio?: number;
      readonly signal?: AbortSignal;
      readonly onPreview?: (bounds: BBox | null) => void;
    }): Promise<BBox | null> => (this.map ? drawMapLibreBounds(this.map, options) : null),
    setDoubleClickZoomEnabled: (enabled: boolean): void => {
      if (enabled) this.map?.doubleClickZoom.enable();
      else this.map?.doubleClickZoom.disable();
    },
    createMarker: (options: MapMarkerOptions): MapMarkerHandle => {
      if (!this.map) throw new Error("MapLibre engine is not mounted.");
      return createMapLibreMarker(this.map, options);
    },
    upsertGeoJsonOverlay: (spec: GeoJsonOverlaySpec): void => this.overlays?.upsert(spec),
    setOverlayVisible: (id: string, visible: boolean): void => {
      this.overlays?.setVisible(id, visible);
    },
    removeOverlay: (id: string): void => this.overlays?.remove(id),
    showPopup: (options: {
      readonly id: string;
      readonly lngLat: LngLat;
      readonly content: HTMLElement;
      readonly closeOnClick?: boolean;
      readonly maxWidth?: string;
    }): void => this.showPopup(options),
    closePopup: (id: string): void => this.closePopup(id),
  } satisfies MapEngine["interactions"];

  readonly controls = {
    getBuiltInState: (control: BuiltInMapControl): MapControlState => ({
      visible: this.controlVisibility[control],
      position: this.controller?.getBuiltInControlPosition(control) ?? "top-right",
    }),
    setBuiltInState: (control: BuiltInMapControl, state: Partial<MapControlState>): boolean => {
      let applied = true;
      if (typeof state.visible === "boolean") {
        this.controlVisibility[control] = state.visible;
        applied = this.controller?.setBuiltInControlVisible(control, state.visible) ?? false;
      }
      if (state.position) {
        applied =
          (this.controller?.setBuiltInControlPosition(control, state.position) ?? false) && applied;
      }
      return applied;
    },
    setLabels: (labels: Partial<Record<"compass" | "terrain" | "background", string>>): void => {
      if (labels.compass) this.controller?.setCompassLabel(labels.compass);
      if (labels.terrain) this.controller?.setTerrainLabel(labels.terrain);
      if (labels.background) this.controller?.setBackgroundLabel(labels.background);
    },
    getTerrainExaggeration: (): number => this.controller?.getTerrainExaggeration() ?? 1,
    setTerrainExaggeration: (value: number): void => {
      this.controller?.setTerrainExaggeration(value);
    },
  } satisfies MapEngine["controls"];

  constructor(
    private readonly loadController: MapControllerLoader = async () => import("../map-controller"),
  ) {}

  async mount(container: HTMLElement, initialView: MapViewState): Promise<void> {
    if (this.destroyed) return;
    const module = await this.loadController();
    if (this.destroyed) return;
    const controller = module.createMapController();
    const map = controller.init(container, {
      styleUrl: this.pendingConfiguration.basemapStyleUrl,
      mapView: initialView,
      mapPreferences: this.pendingConfiguration.preferences,
    });
    if (this.destroyed) {
      controller.destroy();
      return;
    }
    this.controller = controller;
    this.map = map;
    this.overlays = new MapLibreTransientOverlays(map);
    this.bindNativeEvents();
    if (typeof this.pendingConfiguration.basemapVisible === "boolean") {
      controller.setBasemapVisible(this.pendingConfiguration.basemapVisible);
    }
    if (typeof this.pendingConfiguration.basemapOpacity === "number") {
      controller.setBasemapOpacity(this.pendingConfiguration.basemapOpacity);
    }
  }

  /** Attach the adapter ports to the controller owned by legacy `MapCanvas`. */
  attachExistingController(controller: MapControllerContract): void {
    const map = controller.getMap();
    if (!map) throw new Error("Cannot attach MapEngine ports before MapController is mounted.");
    this.controller = controller;
    this.map = map;
    this.overlays = new MapLibreTransientOverlays(map);
    this.bindNativeEvents();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.map) {
      for (const { event, handler } of this.nativeListeners.splice(0)) {
        this.map.off(event as keyof maplibregl.MapEventType, handler as never);
      }
    }
    for (const popup of this.popups.values()) popup.remove();
    this.popups.clear();
    this.overlays?.destroy();
    this.overlays = null;
    this.controller?.destroy();
    this.controller = null;
    this.map = null;
    this.listeners.clear();
  }

  configure(options: Parameters<MapEngine["configure"]>[0]): void {
    this.pendingConfiguration = { ...this.pendingConfiguration, ...options };
    if (!this.controller) return;
    if (options.preferences) this.controller.applyMapPreferences(options.preferences);
    if (options.basemapStyleUrl) this.controller.setStyle(options.basemapStyleUrl);
    if (typeof options.basemapVisible === "boolean") {
      this.controller.setBasemapVisible(options.basemapVisible);
    }
    if (typeof options.basemapOpacity === "number") {
      this.controller.setBasemapOpacity(options.basemapOpacity);
    }
  }

  applyView(view: MapViewState): void {
    this.controller?.applyView(view);
  }

  readView(): MapViewState {
    return (
      this.controller?.readView() ?? {
        center: [-100, 40],
        zoom: 2,
        bearing: 0,
        pitch: 0,
      }
    );
  }

  syncLayers(layers: readonly GeoLibreLayer[]): void {
    this.syncedLayers = layers;
    this.controller?.waitAndSyncLayers([...layers]);
  }

  supports(capability: MapEngineCapability): boolean {
    return capabilities.has(capability);
  }

  supportsLayer(_layer: GeoLibreLayer): boolean {
    return true;
  }

  async hitTest(point: ScreenPoint): Promise<readonly HitFeature[]> {
    const lngLat = this.viewport.unproject(point);
    if (!lngLat) return [];
    return this.layers.queryAtLngLat(lngLat);
  }

  invoke<K extends keyof MapEngineExtensionMap>(
    command: K,
    _input: MapEngineExtensionMap[K]["input"],
  ): MapEngineExtensionMap[K]["output"] {
    switch (command) {
      case "viewport.resize":
        this.map?.resize();
        return undefined as MapEngineExtensionMap[K]["output"];
      case "hosted-plugin.activate":
      case "hosted-plugin.set-position":
      case "hosted-plugin.apply-state":
        return false as MapEngineExtensionMap[K]["output"];
      case "hosted-plugin.deactivate":
      case "hosted-plugin.get-state":
        return undefined as MapEngineExtensionMap[K]["output"];
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

  private listen(event: string, handler: (event: MapLibreNativeEvent) => void): void {
    if (!this.map) return;
    this.nativeListeners.push({ event, handler });
    this.map.on(event as keyof maplibregl.MapEventType, handler as never);
  }

  private bindNativeEvents(): void {
    this.listen("load", () => {
      if (this.loadEmitted) return;
      this.loadEmitted = true;
      this.emit("load", { reason: "mount" });
    });
    this.listen("style.load", () => {
      this.overlays?.restore();
      if (!this.loadEmitted || !this.sawInitialStyle) {
        this.sawInitialStyle = true;
        return;
      }
      this.emit("load", { reason: "style" });
    });
    this.listen("idle", () => this.emit("idle", undefined));
    this.listen("movestart", (event) => {
      this.emit("movestart", { userDriven: Boolean(event.originalEvent) });
    });
    this.listen("move", (event) => {
      this.emit("move", {
        view: this.readView(),
        userDriven: Boolean(event.originalEvent),
      });
    });
    this.listen("moveend", (event) => {
      this.emit("moveend", {
        view: this.readView(),
        userDriven: Boolean(event.originalEvent),
        tag:
          event.geolibreTag ?? (event.storyCameraToken === undefined ? undefined : "story-camera"),
      });
    });
    for (const [nativeEvent, engineEvent] of [
      ["click", "click"],
      ["dblclick", "dblclick"],
      ["contextmenu", "contextmenu"],
      ["mousemove", "pointermove"],
    ] as const) {
      this.listen(nativeEvent, (event) => {
        if (!event.point || !event.lngLat) return;
        this.emit(engineEvent, {
          point: { x: event.point.x, y: event.point.y },
          lngLat: normalizeLngLat(event.lngLat),
        });
      });
    }
    this.listen("mouseout", () => this.emit("pointerleave", undefined));
    this.listen("dragstart", () => this.emit("dragstart", undefined));
    this.listen("resize", () => this.emit("resize", undefined));
    this.listen("error", (event) => this.emit("error", normalizeError(event.error)));
  }

  private async whenIdle(options?: {
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
  }): Promise<void> {
    const map = this.map;
    if (!map || !map.isMoving()) return;
    await new Promise<void>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const finish = (): void => {
        if (timeout) clearTimeout(timeout);
        options?.signal?.removeEventListener("abort", abort);
        map.off("idle", finish);
        resolve();
      };
      const abort = (): void => {
        if (timeout) clearTimeout(timeout);
        map.off("idle", finish);
        reject(options?.signal?.reason ?? new DOMException("Aborted", "AbortError"));
      };
      map.once("idle", finish);
      options?.signal?.addEventListener("abort", abort, { once: true });
      if (options?.timeoutMs) timeout = setTimeout(finish, options.timeoutMs);
    });
  }

  private showPopup(options: {
    readonly id: string;
    readonly lngLat: LngLat;
    readonly content: HTMLElement;
    readonly closeOnClick?: boolean;
    readonly maxWidth?: string;
  }): void {
    if (!this.map) return;
    this.closePopup(options.id);
    const popup = new maplibregl.Popup({
      closeOnClick: options.closeOnClick,
      maxWidth: options.maxWidth,
    })
      .setLngLat(options.lngLat)
      .setDOMContent(options.content)
      .addTo(this.map);
    this.popups.set(options.id, popup);
  }

  private closePopup(id: string): void {
    this.popups.get(id)?.remove();
    this.popups.delete(id);
  }
}

export function createMapLibreEngine(): MapEngine {
  return new MapLibreEngine();
}

const mapEngineClientKeys = new Set<PropertyKey>([
  "camera",
  "layers",
  "viewport",
  "interactions",
  "controls",
  "invoke",
  "on",
]);

/**
 * Transitional package-private bridge for the primary legacy host. The public
 * type is strictly `MapEngineClient`; unknown legacy properties are forwarded
 * only so unmigrated in-repo consumers keep working until their dedicated
 * consumer slices land.
 */
export function createMapEngineClientForController(
  controller: MapControllerContract,
): MapEngineClient {
  const engine = new MapLibreEngine();
  engine.attachExistingController(controller);
  return new Proxy({} as MapEngineClient, {
    get: (_target, property) => {
      const owner = mapEngineClientKeys.has(property) ? engine : controller;
      const value = Reflect.get(owner, property, owner);
      return typeof value === "function" ? value.bind(owner) : value;
    },
  });
}
