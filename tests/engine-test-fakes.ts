import type { GeoLibreLayer, MapProjection, MapViewState } from "../packages/core/src/index";
import type { MapEngineExtensionMap } from "../packages/map/src/engine/extensions";
import type {
  MapEngine,
  MapEngineCapability,
  MapEngineEventMap,
  MapMarkerHandle,
  Unsubscribe,
} from "../packages/map/src/engine/types";

export interface TestMapEngine extends MapEngine {
  readonly operations: string[];
  readonly state: {
    mounted: boolean;
    destroyed: boolean;
  };
  emit<K extends keyof MapEngineEventMap>(event: K, payload: MapEngineEventMap[K]): void;
}

function createMarkerHandle(): MapMarkerHandle {
  let lngLat: [number, number] = [0, 0];
  return {
    setLngLat: (nextLngLat): void => {
      lngLat = nextLngLat;
    },
    getLngLat: () => lngLat,
    setDraggable: () => undefined,
    on: () => () => undefined,
    remove: () => undefined,
  };
}

export function createTestMapEngine(
  initialView: MapViewState = {
    center: [0, 0],
    zoom: 2,
    bearing: 0,
    pitch: 0,
  },
): TestMapEngine {
  let view = initialView;
  const operations: string[] = [];
  const state = { mounted: false, destroyed: false };
  const listeners = new Map<keyof MapEngineEventMap, Set<(payload: never) => void>>();

  const engine: TestMapEngine = {
    operations,
    state,
    camera: {
      readView: () => view,
      applyView: (nextView) => {
        operations.push("camera.applyView");
        view = nextView;
      },
      flyToLocation: () => operations.push("camera.flyToLocation"),
      playStoryChapter: () => operations.push("camera.playStoryChapter"),
      fitBounds: () => operations.push("camera.fitBounds"),
      fitLayer: () => operations.push("camera.fitLayer"),
      zoomIn: () => operations.push("camera.zoomIn"),
      zoomOut: () => operations.push("camera.zoomOut"),
      resetNorth: () => operations.push("camera.resetNorth"),
      resetPitch: () => operations.push("camera.resetPitch"),
      resetNorthPitch: () => operations.push("camera.resetNorthPitch"),
      readProjection: (): MapProjection => "mercator",
      isMoving: () => false,
      whenIdle: async () => undefined,
    },
    layers: {
      readGeoJson: async () => null,
      readRasterSource: () => null,
      queryInView: () => [],
      listRenderTargets: () => [],
      queryAtLngLat: async () => [],
      setHighlight: () => operations.push("layers.setHighlight"),
      clearHighlight: () => operations.push("layers.clearHighlight"),
    },
    viewport: {
      project: () => ({ x: 0, y: 0 }),
      unproject: () => [0, 0],
      getElement: () => null,
      getRect: () => null,
      capture: async () => ({
        canvas: {} as HTMLCanvasElement,
        width: 1,
        height: 1,
        metersPerPixel: 1,
        bearing: 0,
      }),
    },
    interactions: {
      pickPoint: async () => null,
      drawBounds: async () => null,
      createMarker: createMarkerHandle,
      upsertGeoJsonOverlay: () => operations.push("interactions.upsertGeoJsonOverlay"),
      setOverlayVisible: () => operations.push("interactions.setOverlayVisible"),
      removeOverlay: () => operations.push("interactions.removeOverlay"),
      showPopup: () => operations.push("interactions.showPopup"),
      closePopup: () => operations.push("interactions.closePopup"),
    },
    controls: {
      getBuiltInState: () => ({ visible: true, position: "top-right" }),
      setBuiltInState: () => {
        operations.push("controls.setBuiltInState");
        return true;
      },
      setLabels: () => operations.push("controls.setLabels"),
      getTerrainExaggeration: () => 1,
      setTerrainExaggeration: () => operations.push("controls.setTerrainExaggeration"),
    },
    invoke: <K extends keyof MapEngineExtensionMap>(
      command: K,
      _input: MapEngineExtensionMap[K]["input"],
    ): MapEngineExtensionMap[K]["output"] => {
      operations.push(`invoke:${command}`);
      if (command === "viewport.resize") {
        return undefined as MapEngineExtensionMap[K]["output"];
      }
      if (
        command === "hosted-plugin.activate" ||
        command === "hosted-plugin.set-position" ||
        command === "hosted-plugin.apply-state"
      ) {
        return true as MapEngineExtensionMap[K]["output"];
      }
      return undefined as MapEngineExtensionMap[K]["output"];
    },
    on: (event, handler): Unsubscribe => {
      const handlers = listeners.get(event) ?? new Set<(payload: never) => void>();
      handlers.add(handler as (payload: never) => void);
      listeners.set(event, handlers);
      return () => handlers.delete(handler as (payload: never) => void);
    },
    mount: async () => {
      operations.push("mount");
      state.mounted = true;
    },
    destroy: () => {
      operations.push("destroy");
      state.destroyed = true;
    },
    configure: () => operations.push("configure"),
    applyView: (nextView) => {
      operations.push("applyView");
      view = nextView;
    },
    readView: () => view,
    syncLayers: (_layers: readonly GeoLibreLayer[]) => operations.push("syncLayers"),
    supports: (_capability: MapEngineCapability) => true,
    supportsLayer: (_layer: GeoLibreLayer) => true,
    hitTest: async () => [],
    emit: (event, payload) => {
      const handlers = listeners.get(event);
      if (!handlers) return;
      for (const handler of handlers) handler(payload as never);
    },
  };

  return engine;
}
