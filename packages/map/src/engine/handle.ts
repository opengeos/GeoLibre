import type { GeoLibreLayer, MapViewState } from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import type { MapEngineExtensionMap } from "./extensions";
import {
  loadRegisteredMapEngine,
  registeredEngineSupports,
  type MapEngineFactory,
} from "./registry";
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
  MapEngineEventMap,
  MapEngineId,
  MapMarkerEventMap,
  MapMarkerHandle,
  MapMarkerOptions,
  MapRenderTarget,
  ScreenPoint,
  Unsubscribe,
} from "./types";

const fallbackView: MapViewState = {
  center: [-100, 40],
  zoom: 2,
  bearing: 0,
  pitch: 0,
};

const defaultControlPositions: Readonly<Record<BuiltInMapControl, MapControlPosition>> = {
  navigation: "top-right",
  fullscreen: "top-right",
  compass: "top-right",
  geolocate: "top-right",
  globe: "top-right",
  terrain: "top-right",
  scale: "bottom-left",
  attribution: "bottom-right",
  logo: "bottom-left",
  "layer-control": "top-right",
};

const defaultVisibleControls = new Set<BuiltInMapControl>([
  "fullscreen",
  "compass",
  "globe",
  "scale",
  "attribution",
  "layer-control",
]);

type QueuedMutation = (engine: MapEngine) => void;

class StableMapEngineHandle implements MapEngine {
  private readonly listeners = new Map<keyof MapEngineEventMap, Set<(payload: never) => void>>();
  private readonly forwardingUnsubscribes: Unsubscribe[] = [];
  private readonly queuedMutations: QueuedMutation[] = [];
  private readonly controlStates = new Map<BuiltInMapControl, MapControlState>();
  private adapter: MapEngine | null = null;
  private loadingAdapter: MapEngine | null = null;
  private mountPromise: Promise<void> | null = null;
  private cachedView: MapViewState = fallbackView;
  private terrainExaggeration = 1;
  private destroyed = false;

  readonly camera = {
    readView: (): MapViewState => this.cachedView,
    readBounds: (): BBox | null => this.adapter?.camera.readBounds() ?? null,
    readZoomRange: (): { readonly min: number; readonly max: number } =>
      this.adapter?.camera.readZoomRange() ?? { min: 0, max: 24 },
    applyView: (
      view: MapViewState,
      options?: Parameters<MapEngine["camera"]["applyView"]>[1],
    ): void => {
      this.cachedView = view;
      this.enqueue((engine) => engine.camera.applyView(view, options));
    },
    flyToLocation: (location: Parameters<MapEngine["camera"]["flyToLocation"]>[0]): void => {
      this.enqueue((engine) => engine.camera.flyToLocation(location));
    },
    playStoryChapter: (
      location: Parameters<MapEngine["camera"]["playStoryChapter"]>[0],
      options: Parameters<MapEngine["camera"]["playStoryChapter"]>[1],
    ): void => {
      this.enqueue((engine) => engine.camera.playStoryChapter(location, options));
    },
    fitBounds: (bounds: BBox, options?: Parameters<MapEngine["camera"]["fitBounds"]>[1]): void => {
      this.enqueue((engine) => engine.camera.fitBounds(bounds, options));
    },
    fitLayer: (layer: GeoLibreLayer): void => {
      this.enqueue((engine) => engine.camera.fitLayer(layer));
    },
    zoomIn: (): void => this.enqueue((engine) => engine.camera.zoomIn()),
    zoomOut: (): void => this.enqueue((engine) => engine.camera.zoomOut()),
    resetNorth: (): void => this.enqueue((engine) => engine.camera.resetNorth()),
    resetPitch: (): void => this.enqueue((engine) => engine.camera.resetPitch()),
    resetNorthPitch: (): void => this.enqueue((engine) => engine.camera.resetNorthPitch()),
    readProjection: (): ReturnType<MapEngine["camera"]["readProjection"]> =>
      this.adapter?.camera.readProjection() ?? "mercator",
    isMoving: (): boolean => this.adapter?.camera.isMoving() ?? false,
    whenIdle: async (options?: Parameters<MapEngine["camera"]["whenIdle"]>[0]): Promise<void> => {
      const adapter = await this.whenReady();
      await adapter.camera.whenIdle(options);
    },
  } satisfies MapEngine["camera"];

  readonly layers = {
    readGeoJson: async (layerId: string): Promise<FeatureCollection | null> => {
      const adapter = await this.whenReady();
      return adapter.layers.readGeoJson(layerId);
    },
    readRasterSource: (layerId: string): Readonly<Record<string, unknown>> | null =>
      this.adapter?.layers.readRasterSource(layerId) ?? null,
    queryInView: (layerId: string): readonly import("geojson").Feature[] =>
      this.adapter?.layers.queryInView(layerId) ?? [],
    listRenderTargets: (): readonly MapRenderTarget[] =>
      this.adapter?.layers.listRenderTargets() ?? [],
    hasRenderTarget: (id: string): boolean => this.adapter?.layers.hasRenderTarget(id) ?? false,
    queryAtLngLat: async (lngLat: LngLat, layerId?: string): Promise<readonly HitFeature[]> => {
      const adapter = await this.whenReady();
      return adapter.layers.queryAtLngLat(lngLat, layerId);
    },
    setHighlight: (
      layer: GeoLibreLayer | undefined,
      featureIds: readonly string[],
      options?: { readonly fit?: boolean },
    ): void => {
      this.enqueue((engine) => engine.layers.setHighlight(layer, featureIds, options));
    },
    clearHighlight: (): void => this.enqueue((engine) => engine.layers.clearHighlight()),
  } satisfies MapEngine["layers"];

  readonly viewport = {
    project: (lngLat: LngLat): ScreenPoint | null => this.adapter?.viewport.project(lngLat) ?? null,
    unproject: (point: ScreenPoint): LngLat | null =>
      this.adapter?.viewport.unproject(point) ?? null,
    getElement: (): HTMLElement | null => this.adapter?.viewport.getElement() ?? null,
    getRect: (): DOMRectReadOnly | null => this.adapter?.viewport.getRect() ?? null,
    capture: async (
      options?: Parameters<MapEngine["viewport"]["capture"]>[0],
    ): ReturnType<MapEngine["viewport"]["capture"]> => {
      const adapter = await this.whenReady();
      return adapter.viewport.capture(options);
    },
  } satisfies MapEngine["viewport"];

  readonly interactions = {
    pickPoint: async (
      options?: Parameters<MapEngine["interactions"]["pickPoint"]>[0],
    ): Promise<LngLat | null> => {
      const adapter = await this.whenReady();
      return adapter.interactions.pickPoint(options);
    },
    drawBounds: async (
      options?: Parameters<MapEngine["interactions"]["drawBounds"]>[0],
    ): Promise<BBox | null> => {
      const adapter = await this.whenReady();
      return adapter.interactions.drawBounds(options);
    },
    setDoubleClickZoomEnabled: (enabled: boolean): void => {
      this.enqueue((engine) => engine.interactions.setDoubleClickZoomEnabled(enabled));
    },
    createMarker: (options: MapMarkerOptions): MapMarkerHandle =>
      this.createDeferredMarker(options),
    upsertGeoJsonOverlay: (spec: GeoJsonOverlaySpec): void => {
      this.enqueue((engine) => engine.interactions.upsertGeoJsonOverlay(spec));
    },
    setOverlayVisible: (id: string, visible: boolean): void => {
      this.enqueue((engine) => engine.interactions.setOverlayVisible(id, visible));
    },
    removeOverlay: (id: string): void => {
      this.enqueue((engine) => engine.interactions.removeOverlay(id));
    },
    showPopup: (options: Parameters<MapEngine["interactions"]["showPopup"]>[0]): void => {
      this.enqueue((engine) => engine.interactions.showPopup(options));
    },
    closePopup: (id: string): void => {
      this.enqueue((engine) => engine.interactions.closePopup(id));
    },
  } satisfies MapEngine["interactions"];

  readonly controls = {
    getBuiltInState: (control: BuiltInMapControl): MapControlState =>
      this.adapter?.controls.getBuiltInState(control) ?? this.readCachedControlState(control),
    setBuiltInState: (control: BuiltInMapControl, state: Partial<MapControlState>): boolean => {
      const current = this.readCachedControlState(control);
      this.controlStates.set(control, { ...current, ...state });
      if (this.adapter) return this.adapter.controls.setBuiltInState(control, state);
      this.enqueue((engine) => {
        engine.controls.setBuiltInState(control, state);
      });
      return true;
    },
    setLabels: (labels: Parameters<MapEngine["controls"]["setLabels"]>[0]): void => {
      this.enqueue((engine) => engine.controls.setLabels(labels));
    },
    getTerrainExaggeration: (): number =>
      this.adapter?.controls.getTerrainExaggeration() ?? this.terrainExaggeration,
    setTerrainExaggeration: (value: number): void => {
      this.terrainExaggeration = value;
      this.enqueue((engine) => engine.controls.setTerrainExaggeration(value));
    },
  } satisfies MapEngine["controls"];

  constructor(
    private readonly id: MapEngineId,
    private readonly factory: MapEngineFactory,
  ) {}

  async mount(container: HTMLElement, initialView: MapViewState): Promise<void> {
    if (this.destroyed) return;
    this.cachedView = initialView;
    if (this.mountPromise) return this.mountPromise;

    this.mountPromise = this.factory().then(async (adapter) => {
      if (this.destroyed) {
        adapter.destroy();
        return;
      }
      this.loadingAdapter = adapter;
      this.bindForwardingEvents(adapter);
      await adapter.mount(container, initialView);
      if (this.destroyed) {
        adapter.destroy();
        this.loadingAdapter = null;
        return;
      }
      this.adapter = adapter;
      this.loadingAdapter = null;
      for (const mutation of this.queuedMutations.splice(0)) mutation(adapter);
    });

    return this.mountPromise;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.queuedMutations.length = 0;
    for (const unsubscribe of this.forwardingUnsubscribes.splice(0)) unsubscribe();
    const adapter = this.adapter ?? this.loadingAdapter;
    this.adapter = null;
    this.loadingAdapter = null;
    adapter?.destroy();
    this.listeners.clear();
  }

  configure(options: Parameters<MapEngine["configure"]>[0]): void {
    this.enqueue((engine) => engine.configure(options));
  }

  applyView(view: MapViewState): void {
    this.cachedView = view;
    this.enqueue((engine) => engine.applyView(view));
  }

  readView(): MapViewState {
    return this.cachedView;
  }

  syncLayers(layers: readonly GeoLibreLayer[]): void {
    this.enqueue((engine) => engine.syncLayers(layers));
  }

  supports(capability: MapEngineCapability): boolean {
    return this.adapter?.supports(capability) ?? registeredEngineSupports(this.id, capability);
  }

  supportsLayer(layer: GeoLibreLayer): boolean {
    return this.adapter?.supportsLayer(layer) ?? this.id === "maplibre";
  }

  async hitTest(point: ScreenPoint): Promise<readonly HitFeature[]> {
    const adapter = await this.whenReady();
    return adapter.hitTest(point);
  }

  invoke<K extends keyof MapEngineExtensionMap>(
    command: K,
    input: MapEngineExtensionMap[K]["input"],
  ): MapEngineExtensionMap[K]["output"] {
    if (this.adapter) return this.adapter.invoke(command, input);
    if (
      command === "viewport.resize" ||
      command === "story.set-layer-opacity" ||
      command === "story.restore-layer-styles"
    ) {
      this.enqueue((engine) => {
        engine.invoke(command, input);
      });
      return undefined as MapEngineExtensionMap[K]["output"];
    }
    if (command === "hosted-plugin.activate") {
      return this.whenReady().then((adapter) =>
        adapter.invoke(command, input),
      ) as MapEngineExtensionMap[K]["output"];
    }
    if (
      command === "hosted-plugin.deactivate" ||
      command === "hosted-plugin.set-position" ||
      command === "hosted-plugin.apply-state"
    ) {
      this.enqueue((engine) => {
        engine.invoke(command, input);
      });
    }
    if (command === "hosted-plugin.set-position" || command === "hosted-plugin.apply-state") {
      return true as MapEngineExtensionMap[K]["output"];
    }
    return undefined as MapEngineExtensionMap[K]["output"];
  }

  on<K extends keyof MapEngineEventMap>(
    event: K,
    handler: (payload: MapEngineEventMap[K]) => void,
  ): Unsubscribe {
    if (this.destroyed) return () => undefined;
    const handlers = this.listeners.get(event) ?? new Set<(payload: never) => void>();
    handlers.add(handler as (payload: never) => void);
    this.listeners.set(event, handlers);
    return () => handlers.delete(handler as (payload: never) => void);
  }

  private enqueue(mutation: QueuedMutation): void {
    if (this.destroyed) return;
    if (this.adapter) {
      mutation(this.adapter);
      return;
    }
    this.queuedMutations.push(mutation);
  }

  private async whenReady(): Promise<MapEngine> {
    if (this.destroyed) throw new Error("Map engine handle has been destroyed.");
    if (this.adapter) return this.adapter;
    if (!this.mountPromise) throw new Error("Map engine has not been mounted.");
    await this.mountPromise;
    if (!this.adapter) throw new Error("Map engine was destroyed before it became ready.");
    return this.adapter;
  }

  private bindForwardingEvents(adapter: MapEngine): void {
    const events = Object.keys({
      load: true,
      idle: true,
      movestart: true,
      move: true,
      moveend: true,
      click: true,
      dblclick: true,
      contextmenu: true,
      pointermove: true,
      pointerleave: true,
      dragstart: true,
      resize: true,
      error: true,
    }) as Array<keyof MapEngineEventMap>;

    for (const event of events) {
      this.forwardingUnsubscribes.push(
        adapter.on(event, (payload) => {
          if (event === "move" || event === "moveend") {
            this.cachedView = (payload as MapEngineEventMap["move"]).view;
          }
          const handlers = this.listeners.get(event);
          if (!handlers) return;
          for (const handler of handlers) handler(payload as never);
        }),
      );
    }
  }

  private readCachedControlState(control: BuiltInMapControl): MapControlState {
    return (
      this.controlStates.get(control) ?? {
        visible: defaultVisibleControls.has(control),
        position: defaultControlPositions[control],
      }
    );
  }

  private createDeferredMarker(options: MapMarkerOptions): MapMarkerHandle {
    let lngLat = options.lngLat;
    let draggable = options.draggable ?? false;
    let rotation = 0;
    let nativeMarker: MapMarkerHandle | null = null;
    let removed = false;
    const listeners = new Map<keyof MapMarkerEventMap, Set<(payload: never) => void>>();
    const nativeUnsubscribes = new Map<keyof MapMarkerEventMap, Unsubscribe>();

    const bindNativeEvent = <K extends keyof MapMarkerEventMap>(event: K): void => {
      const handlers = listeners.get(event);
      if (!nativeMarker || !handlers?.size || nativeUnsubscribes.has(event)) return;
      nativeUnsubscribes.set(
        event,
        nativeMarker.on(event, (payload) => {
          lngLat = payload.lngLat;
          for (const handler of handlers) handler(payload as never);
        }),
      );
    };

    this.enqueue((engine) => {
      nativeMarker = engine.interactions.createMarker({
        ...options,
        lngLat,
        draggable,
      });
      for (const event of listeners.keys()) bindNativeEvent(event);
      if (removed) nativeMarker.remove();
      else if (rotation !== 0) nativeMarker.setRotation(rotation);
    });

    return {
      setLngLat: (nextLngLat): void => {
        lngLat = nextLngLat;
        nativeMarker?.setLngLat(nextLngLat);
      },
      getLngLat: (): LngLat => nativeMarker?.getLngLat() ?? lngLat,
      setDraggable: (nextDraggable): void => {
        draggable = nextDraggable;
        nativeMarker?.setDraggable(nextDraggable);
      },
      setRotation: (nextRotation): void => {
        rotation = nextRotation;
        nativeMarker?.setRotation(nextRotation);
      },
      on: (event, handler): Unsubscribe => {
        const handlers = listeners.get(event) ?? new Set<(payload: never) => void>();
        handlers.add(handler as (payload: never) => void);
        listeners.set(event, handlers);
        bindNativeEvent(event);
        return () => {
          handlers.delete(handler as (payload: never) => void);
          if (handlers.size > 0) return;
          nativeUnsubscribes.get(event)?.();
          nativeUnsubscribes.delete(event);
        };
      },
      remove: (): void => {
        removed = true;
        for (const unsubscribe of nativeUnsubscribes.values()) unsubscribe();
        nativeUnsubscribes.clear();
        nativeMarker?.remove();
      },
    };
  }
}

export function createMapEngineHandle(id: MapEngineId): MapEngine {
  return new StableMapEngineHandle(id, () => loadRegisteredMapEngine(id));
}

/** Package-private configured factory seam used by engine hosts. */
export function createMapEngineHandleWithFactory(
  id: MapEngineId,
  factory: MapEngineFactory,
): MapEngine {
  return new StableMapEngineHandle(id, factory);
}

/** Package-private test seam; intentionally not exported from `@geolibre/map`. */
export function createMapEngineHandleForTesting(
  id: MapEngineId,
  factory: MapEngineFactory,
): MapEngine {
  return createMapEngineHandleWithFactory(id, factory);
}
