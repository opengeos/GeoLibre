import assert from "node:assert/strict";
import test from "node:test";
import type {
  GeoLibreLayer,
  MapProjection,
  MapViewState,
} from "../packages/core/src/index";
import type {
  MapEngine,
  MapEngineCapability,
  MapEngineEventMap,
  MapMarkerHandle,
  Unsubscribe,
} from "../packages/map/src/engine/types";

const initialView: MapViewState = {
  center: [8.55, 47.37],
  zoom: 8,
  bearing: 0,
  pitch: 0,
};

function createMarkerHandle(): MapMarkerHandle {
  return {
    setLngLat: () => undefined,
    getLngLat: () => [8.55, 47.37],
    setDraggable: () => undefined,
    on: () => () => undefined,
    remove: () => undefined,
  };
}

function createCompleteFake(): MapEngine {
  const listeners = new Map<keyof MapEngineEventMap, Set<(payload: unknown) => void>>();
  let view = initialView;

  const fake: MapEngine = {
    camera: {
      readView: () => view,
      applyView: (nextView) => {
        view = nextView;
      },
      flyToLocation: () => undefined,
      fitBounds: () => undefined,
      fitLayer: () => undefined,
      zoomIn: () => undefined,
      zoomOut: () => undefined,
      resetNorth: () => undefined,
      resetPitch: () => undefined,
      resetNorthPitch: () => undefined,
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
      setHighlight: () => undefined,
      clearHighlight: () => undefined,
    },
    viewport: {
      project: () => ({ x: 0, y: 0 }),
      unproject: () => [8.55, 47.37],
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
      upsertGeoJsonOverlay: () => undefined,
      setOverlayVisible: () => undefined,
      removeOverlay: () => undefined,
      showPopup: () => undefined,
      closePopup: () => undefined,
    },
    controls: {
      getBuiltInState: () => ({ visible: true, position: "top-right" }),
      setBuiltInState: () => true,
      setLabels: () => undefined,
      getTerrainExaggeration: () => 1,
      setTerrainExaggeration: () => undefined,
    },
    invoke: (command) => {
      switch (command) {
        case "viewport.resize":
          return undefined;
        case "hosted-plugin.activate":
        case "hosted-plugin.set-position":
        case "hosted-plugin.apply-state":
          return true;
        case "hosted-plugin.deactivate":
        case "hosted-plugin.get-state":
          return undefined;
      }
    },
    on: (event, handler): Unsubscribe => {
      const handlers = listeners.get(event) ?? new Set<(payload: unknown) => void>();
      handlers.add(handler as (payload: unknown) => void);
      listeners.set(event, handlers);
      return () => handlers.delete(handler as (payload: unknown) => void);
    },
    mount: async () => undefined,
    destroy: () => listeners.clear(),
    configure: () => undefined,
    applyView: (nextView) => {
      view = nextView;
    },
    readView: () => view,
    syncLayers: () => undefined,
    supports: (_capability: MapEngineCapability) => true,
    supportsLayer: (_layer: GeoLibreLayer) => true,
    hitTest: async () => [],
  };

  return fake;
}

test("a complete engine fake exposes every capability port", () => {
  const engine = createCompleteFake();

  assert.deepEqual(engine.camera.readView(), initialView);
  assert.deepEqual(engine.viewport.project([8.55, 47.37]), { x: 0, y: 0 });
  assert.deepEqual(engine.layers.listRenderTargets(), []);
  assert.equal(engine.controls.getBuiltInState("compass").visible, true);
  assert.equal(engine.interactions.createMarker({ lngLat: [8.55, 47.37] }).getLngLat()[0], 8.55);
});

test("typed event subscriptions return an unsubscribe function", () => {
  const engine = createCompleteFake();
  const unsubscribe = engine.on("moveend", (event) => {
    assert.equal(event.userDriven, true);
  });

  assert.equal(typeof unsubscribe, "function");
  assert.equal(unsubscribe(), true);
});

test("extension commands infer their declared result", async () => {
  const engine = createCompleteFake();
  const activated: boolean = await engine.invoke("hosted-plugin.activate", {
    pluginId: "example",
  });
  const state: unknown = engine.invoke("hosted-plugin.get-state", {
    pluginId: "example",
  });

  assert.equal(activated, true);
  assert.equal(state, undefined);
});
