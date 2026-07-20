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
  MapMarkerEventMap,
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
  private readonly overlayIds = new Set<string>();
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
      const overlayTargets = [...this.overlayIds].map((id) => ({
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
      this.pickPoint(options),
    drawBounds: async (options?: {
      readonly aspectRatio?: number;
      readonly signal?: AbortSignal;
      readonly onPreview?: (bounds: BBox | null) => void;
    }): Promise<BBox | null> => this.drawBounds(options),
    createMarker: (options: MapMarkerOptions): MapMarkerHandle => this.createMarker(options),
    upsertGeoJsonOverlay: (spec: GeoJsonOverlaySpec): void => this.upsertOverlay(spec),
    setOverlayVisible: (id: string, visible: boolean): void => {
      this.setOverlayVisibility(id, visible);
    },
    removeOverlay: (id: string): void => this.removeOverlay(id),
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
    this.overlayIds.clear();
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

  private async pickPoint(options?: { readonly signal?: AbortSignal }): Promise<LngLat | null> {
    const map = this.map;
    if (!map) return null;
    return new Promise<LngLat | null>((resolve, reject) => {
      const finish = (event: maplibregl.MapMouseEvent): void => {
        options?.signal?.removeEventListener("abort", abort);
        resolve([event.lngLat.lng, event.lngLat.lat]);
      };
      const abort = (): void => {
        map.off("click", finish);
        reject(options?.signal?.reason ?? new DOMException("Aborted", "AbortError"));
      };
      map.once("click", finish);
      options?.signal?.addEventListener("abort", abort, { once: true });
    });
  }

  private async drawBounds(options?: {
    readonly aspectRatio?: number;
    readonly signal?: AbortSignal;
    readonly onPreview?: (bounds: BBox | null) => void;
  }): Promise<BBox | null> {
    const first = await this.pickPoint({ signal: options?.signal });
    if (!first) return null;
    const second = await this.pickPoint({ signal: options?.signal });
    if (!second) return null;
    let west = Math.min(first[0], second[0]);
    let east = Math.max(first[0], second[0]);
    let south = Math.min(first[1], second[1]);
    let north = Math.max(first[1], second[1]);
    if (options?.aspectRatio && options.aspectRatio > 0 && east > west && north > south) {
      const width = east - west;
      const height = north - south;
      if (width / height > options.aspectRatio) {
        const targetHeight = width / options.aspectRatio;
        const center = (north + south) / 2;
        south = center - targetHeight / 2;
        north = center + targetHeight / 2;
      } else {
        const targetWidth = height * options.aspectRatio;
        const center = (east + west) / 2;
        west = center - targetWidth / 2;
        east = center + targetWidth / 2;
      }
    }
    const bounds: BBox = [west, south, east, north];
    options?.onPreview?.(bounds);
    return bounds;
  }

  private createMarker(options: MapMarkerOptions): MapMarkerHandle {
    if (!this.map) throw new Error("MapLibre engine is not mounted.");
    const marker = new maplibregl.Marker({
      element: options.element,
      color: options.color,
      draggable: options.draggable,
      anchor: options.anchor,
      offset: options.offset ? [options.offset.x, options.offset.y] : undefined,
    })
      .setLngLat(options.lngLat)
      .addTo(this.map);
    return {
      setLngLat: (lngLat): void => {
        marker.setLngLat(lngLat);
      },
      getLngLat: (): LngLat => normalizeLngLat(marker.getLngLat()),
      setDraggable: (draggable): void => {
        marker.setDraggable(draggable);
      },
      on: <K extends keyof MapMarkerEventMap>(
        event: K,
        handler: (payload: MapMarkerEventMap[K]) => void,
      ): Unsubscribe => {
        const listener = (): void => handler({ lngLat: normalizeLngLat(marker.getLngLat()) });
        marker.on(event, listener);
        return () => marker.off(event, listener);
      },
      remove: (): void => {
        marker.remove();
      },
    };
  }

  private overlaySourceId(id: string): string {
    return `geolibre-engine-overlay-${id}`;
  }

  private overlayLayerIds(id: string): readonly string[] {
    const sourceId = this.overlaySourceId(id);
    return [`${sourceId}-fill`, `${sourceId}-line`, `${sourceId}-point`];
  }

  private upsertOverlay(spec: GeoJsonOverlaySpec): void {
    if (!this.map) return;
    const sourceId = this.overlaySourceId(spec.id);
    const existing = this.map.getSource(sourceId) as maplibregl.GeoJSONSource | undefined;
    if (existing) existing.setData(spec.data);
    else this.map.addSource(sourceId, { type: "geojson", data: spec.data });
    const visibility = spec.visible === false ? "none" : "visible";
    const definitions: maplibregl.LayerSpecification[] = [
      {
        id: `${sourceId}-fill`,
        type: "fill",
        source: sourceId,
        filter: ["==", ["geometry-type"], "Polygon"],
        layout: { visibility },
        paint: {
          "fill-color": spec.style?.fillColor ?? "#2563eb",
          "fill-opacity": spec.style?.fillOpacity ?? 0.2,
        },
      },
      {
        id: `${sourceId}-line`,
        type: "line",
        source: sourceId,
        layout: { visibility },
        paint: {
          "line-color": spec.style?.lineColor ?? "#2563eb",
          "line-opacity": spec.style?.lineOpacity ?? 1,
          "line-width": spec.style?.lineWidth ?? 2,
        },
      },
      {
        id: `${sourceId}-point`,
        type: "circle",
        source: sourceId,
        filter: ["==", ["geometry-type"], "Point"],
        layout: { visibility },
        paint: {
          "circle-color": spec.style?.pointColor ?? "#2563eb",
          "circle-opacity": spec.style?.pointOpacity ?? 1,
          "circle-radius": spec.style?.pointRadius ?? 5,
        },
      },
    ];
    for (const definition of definitions) {
      if (!this.map.getLayer(definition.id)) this.map.addLayer(definition);
    }
    this.overlayIds.add(spec.id);
  }

  private setOverlayVisibility(id: string, visible: boolean): void {
    if (!this.map) return;
    for (const layerId of this.overlayLayerIds(id)) {
      if (this.map.getLayer(layerId)) {
        this.map.setLayoutProperty(layerId, "visibility", visible ? "visible" : "none");
      }
    }
  }

  private removeOverlay(id: string): void {
    if (!this.map) return;
    for (const layerId of this.overlayLayerIds(id)) {
      if (this.map.getLayer(layerId)) this.map.removeLayer(layerId);
    }
    const sourceId = this.overlaySourceId(id);
    if (this.map.getSource(sourceId)) this.map.removeSource(sourceId);
    this.overlayIds.delete(id);
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
