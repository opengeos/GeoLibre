import assert from "node:assert/strict";
import test from "node:test";
import type { GeoLibreLayer, MapPreferences, MapViewState } from "../packages/core/src/index";
import {
  MapLibreEngine,
  type MapControllerModule,
} from "../packages/map/src/engine/maplibre-engine";
import type { HitFeature } from "../packages/map/src/engine/types";

interface NavigationHandler {
  isEnabled(): boolean;
  enable(): void;
  disable(): void;
}

interface FakeNativeMap {
  readonly map: unknown;
  readonly navigation: readonly NavigationHandler[];
  emit(event: string, payload?: Record<string, unknown>): void;
}

function createNativeMap(): FakeNativeMap {
  const listeners = new Map<string, Set<(payload: Record<string, unknown>) => void>>();
  const container = {
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 800, height: 600 }),
  };
  const createNavigationHandler = (): NavigationHandler => {
    let enabled = true;
    return {
      isEnabled: () => enabled,
      enable: () => {
        enabled = true;
      },
      disable: () => {
        enabled = false;
      },
    };
  };
  const navigation = Array.from({ length: 8 }, createNavigationHandler);
  const map = {
    on: (event: string, handler: (payload: Record<string, unknown>) => void) => {
      const handlers = listeners.get(event) ?? new Set();
      handlers.add(handler);
      listeners.set(event, handlers);
    },
    off: (event: string, handler: (payload: Record<string, unknown>) => void) => {
      listeners.get(event)?.delete(handler);
    },
    once: (event: string, handler: (payload: Record<string, unknown>) => void) => {
      const once = (payload: Record<string, unknown>): void => {
        listeners.get(event)?.delete(once);
        handler(payload);
      };
      const handlers = listeners.get(event) ?? new Set();
      handlers.add(once);
      listeners.set(event, handlers);
    },
    isMoving: () => false,
    project: ([lng, lat]: [number, number]) => ({ x: lng * 10, y: lat * -10 }),
    unproject: ([x, y]: [number, number]) => ({ lng: x / 10, lat: y / -10 }),
    getContainer: () => container,
    dragPan: navigation[0],
    scrollZoom: navigation[1],
    boxZoom: navigation[2],
    dragRotate: navigation[3],
    keyboard: navigation[4],
    doubleClickZoom: navigation[5],
    touchZoomRotate: navigation[6],
    touchPitch: navigation[7],
  };
  return {
    map,
    navigation,
    emit: (event, payload = {}) => {
      for (const handler of [...(listeners.get(event) ?? [])]) handler(payload);
    },
  };
}

function createControllerModule(native: FakeNativeMap): {
  readonly module: MapControllerModule;
  readonly calls: string[];
  readonly hits: HitFeature[];
} {
  const calls: string[] = [];
  const hits: HitFeature[] = [
    {
      layerId: "cities",
      featureId: "zurich",
      properties: { name: "Zurich" },
      geometry: { type: "Point", coordinates: [8.55, 47.37] },
    },
  ];
  const liveFeatures = [
    {
      type: "Feature" as const,
      id: "zurich",
      properties: { name: "Zurich" },
      geometry: { type: "Point" as const, coordinates: [8.55, 47.37] },
    },
  ];
  const view: MapViewState = {
    center: [8.55, 47.37],
    zoom: 8,
    bearing: 0,
    pitch: 0,
  };
  const controller = {
    init: () => {
      calls.push("init");
      return native.map;
    },
    getMap: () => native.map,
    destroy: () => calls.push("destroy"),
    setStyle: () => calls.push("setStyle"),
    setBasemapVisible: () => calls.push("setBasemapVisible"),
    setBasemapOpacity: () => calls.push("setBasemapOpacity"),
    applyMapPreferences: (_preferences: MapPreferences) => calls.push("applyMapPreferences"),
    applyView: () => calls.push("applyView"),
    easeToView: () => calls.push("easeToView"),
    readView: () => view,
    waitAndSyncLayers: (_layers: GeoLibreLayer[]) => calls.push("waitAndSyncLayers"),
    getLayerGeoJson: async () => ({ type: "FeatureCollection" as const, features: liveFeatures }),
    getLayerRasterSource: () => ({ type: "raster", url: "https://example.com/tiles.json" }),
    getBasemapStyleLayerIds: () => ["water"],
    getContentRenderTargets: () => [{ id: "cities", queryable: true }],
    queryLayerFeaturesInView: () => liveFeatures,
    fitLayer: () => undefined,
    fitBounds: () => undefined,
    flyToView: () => undefined,
    flyTo: () => undefined,
    zoomIn: () => undefined,
    zoomOut: () => undefined,
    resetNorth: () => undefined,
    resetPitch: () => undefined,
    resetNorthPitch: () => undefined,
    readProjection: () => "mercator",
    identifyFeatures: () => hits,
    highlightFeature: () => calls.push("highlightFeature"),
    clearFeatureHighlight: () => calls.push("clearFeatureHighlight"),
    setBuiltInControlVisible: () => true,
    getBuiltInControlPosition: () => "top-right",
    setBuiltInControlPosition: () => true,
    setCompassLabel: () => undefined,
    setTerrainLabel: () => undefined,
    setBackgroundLabel: () => undefined,
    getTerrainExaggeration: () => 1,
    setTerrainExaggeration: () => undefined,
    setStoryLayerOpacity: () => undefined,
    restoreLayerStyles: () => undefined,
  };
  return {
    module: {
      createMapController: () => controller,
    } as unknown as MapControllerModule,
    calls,
    hits,
  };
}

test("MapLibre loads its controller lazily and translates load events", async () => {
  const native = createNativeMap();
  const controller = createControllerModule(native);
  let loaderCalls = 0;
  const engine = new MapLibreEngine(async () => {
    loaderCalls += 1;
    return controller.module;
  });
  const loadReasons: string[] = [];
  engine.on("load", ({ reason }) => loadReasons.push(reason));

  assert.equal(loaderCalls, 0);
  await engine.mount({} as HTMLElement, {
    center: [8.55, 47.37],
    zoom: 8,
    bearing: 0,
    pitch: 0,
  });
  assert.equal(loaderCalls, 1);
  assert.deepEqual(controller.calls, ["init"]);

  native.emit("style.load");
  native.emit("load");
  native.emit("load");
  native.emit("style.load");
  assert.deepEqual(loadReasons, ["mount", "style"]);
});

test("MapLibre delegates layer sync and normalizes hits through the controller", async () => {
  const native = createNativeMap();
  const controller = createControllerModule(native);
  const engine = new MapLibreEngine(async () => controller.module);
  await engine.mount({} as HTMLElement, {
    center: [0, 0],
    zoom: 2,
    bearing: 0,
    pitch: 0,
  });

  engine.syncLayers([]);
  const hits = await engine.hitTest({ x: 10, y: 20 });

  assert.equal(controller.calls.at(-1), "waitAndSyncLayers");
  assert.deepEqual(hits, controller.hits);
});

test("MapLibre exposes live layer snapshots and feature operations only through its port", async () => {
  const native = createNativeMap();
  const controller = createControllerModule(native);
  const engine = new MapLibreEngine(async () => controller.module);
  await engine.mount({} as HTMLElement, {
    center: [0, 0],
    zoom: 2,
    bearing: 0,
    pitch: 0,
  });

  const snapshot = await engine.layers.readGeoJson("cities");
  assert.equal(snapshot?.features[0].id, "zurich");
  assert.equal(engine.layers.readRasterSource("imagery")?.type, "raster");
  assert.deepEqual(
    engine.layers.queryInView("cities").map((feature) => feature.id),
    ["zurich"],
  );
  assert.deepEqual(engine.layers.listRenderTargets(), [
    { id: "water", scope: "basemap", queryable: false },
    { id: "cities", scope: "content", queryable: true },
  ]);

  engine.layers.setHighlight(undefined, ["zurich"]);
  engine.layers.clearHighlight();
  assert.deepEqual(controller.calls.slice(-2), ["highlightFeature", "clearFeatureHighlight"]);
});

test("MapLibre projection ports round-trip coordinates without exposing the native map", async () => {
  const native = createNativeMap();
  const controller = createControllerModule(native);
  const engine = new MapLibreEngine(async () => controller.module);
  await engine.mount({} as HTMLElement, {
    center: [0, 0],
    zoom: 2,
    bearing: 0,
    pitch: 0,
  });

  const coordinate: [number, number] = [8.55, 47.37];
  const point = engine.viewport.project(coordinate);
  assert.deepEqual(point, { x: 85.5, y: -473.7 });
  assert.deepEqual(point ? engine.viewport.unproject(point) : null, coordinate);
  assert.equal(engine.viewport.getRect()?.width, 800);
});

test("MapLibre temporarily suspends and restores navigation through its interaction port", async () => {
  const native = createNativeMap();
  const controller = createControllerModule(native);
  const engine = new MapLibreEngine(async () => controller.module);
  await engine.mount({} as HTMLElement, {
    center: [0, 0],
    zoom: 2,
    bearing: 0,
    pitch: 0,
  });

  native.navigation[1].disable();
  const restore = engine.interactions.suspendNavigation();
  assert.equal(
    native.navigation.every((handler) => !handler.isEnabled()),
    true,
  );

  restore();
  assert.equal(native.navigation[0].isEnabled(), true);
  assert.equal(native.navigation[1].isEnabled(), false);
});

test("MapLibre converts native errors into engine-neutral diagnostics", async () => {
  const native = createNativeMap();
  const controller = createControllerModule(native);
  const engine = new MapLibreEngine(async () => controller.module);
  const errors: Array<{ message: string; status?: number }> = [];
  engine.on("error", (error) => errors.push(error));
  await engine.mount({} as HTMLElement, {
    center: [0, 0],
    zoom: 2,
    bearing: 0,
    pitch: 0,
  });

  native.emit("error", { error: { message: "tile failed", status: 503 } });
  assert.deepEqual(errors, [{ message: "tile failed", status: 503 }]);
});
