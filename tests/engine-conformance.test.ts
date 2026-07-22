import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { GeoLibreLayer, MapViewState } from "../packages/core/src/index";
import { ArcGISMapEngine } from "../packages/map/src/engine/arcgis-map-engine";
import { ArcGISSceneEngine } from "../packages/map/src/engine/arcgis-scene-engine";
import { ARC_GIS_FEATURE_INDEX } from "../packages/map/src/engine/arcgis-feature-query";
import {
  CesiumEngine,
  type CesiumEngineDependencies,
} from "../packages/map/src/engine/cesium-engine";
import { createMapEngineHandleForTesting } from "../packages/map/src/engine/handle";
import {
  MapLibreEngine,
  type MapControllerModule,
} from "../packages/map/src/engine/maplibre-engine";
import {
  MapEngineCapabilityError,
  type HitFeature,
  type MapEngine,
  type MapEngineCapability,
} from "../packages/map/src/engine/types";
import { createArcGISFakeRuntime, createArcGISSceneFakeRuntime } from "./arcgis-engine-fake";

interface EngineHarness {
  readonly engine: MapEngine;
  readonly syncedLayerOrders: string[][];
  readonly destroyed: { value: boolean };
  emitUserMove(): void;
}

interface ConformanceExpectations {
  readonly capabilities: Readonly<Record<MapEngineCapability, boolean>>;
  readonly supportsGeoJson: boolean;
  readonly supportsVectorTiles: boolean;
  readonly hitCount: number;
  readonly unsupportedHitCapability?: MapEngineCapability;
}

type EngineHarnessFactory = () => EngineHarness;

const initialView: MapViewState = {
  center: [8.55, 47.37],
  zoom: 8,
  bearing: 0,
  pitch: 0,
};

function layer(id: string, type: GeoLibreLayer["type"]): GeoLibreLayer {
  return {
    id,
    name: id,
    type,
    source: type === "xyz" ? { tiles: ["https://tiles.example.test/{z}/{x}/{y}.png"] } : {},
    visible: true,
    opacity: 1,
    style: {},
    metadata: {},
    ...(type === "geojson"
      ? {
          geojson: {
            type: "FeatureCollection" as const,
            features: [
              {
                type: "Feature" as const,
                id: "feature-1",
                properties: { name: "test" },
                geometry: { type: "Point" as const, coordinates: [8.55, 47.37] },
              },
            ],
          },
        }
      : {}),
  } as GeoLibreLayer;
}

class NativeEventBus {
  private readonly listeners = new Map<string, Set<(payload: Record<string, unknown>) => void>>();

  readonly map = {
    on: (event: string, handler: (payload: Record<string, unknown>) => void): void => {
      const handlers = this.listeners.get(event) ?? new Set();
      handlers.add(handler);
      this.listeners.set(event, handlers);
    },
    off: (event: string, handler: (payload: Record<string, unknown>) => void): void => {
      this.listeners.get(event)?.delete(handler);
    },
    once: (event: string, handler: (payload: Record<string, unknown>) => void): void => {
      const once = (payload: Record<string, unknown>): void => {
        this.listeners.get(event)?.delete(once);
        handler(payload);
      };
      const handlers = this.listeners.get(event) ?? new Set();
      handlers.add(once);
      this.listeners.set(event, handlers);
    },
    isMoving: (): boolean => false,
    unproject: ([x, y]: [number, number]) => ({ lng: x, lat: y }),
  };

  emit(event: string, payload: Record<string, unknown> = {}): void {
    for (const handler of [...(this.listeners.get(event) ?? [])]) handler(payload);
  }
}

function createMapLibreHarness(): EngineHarness {
  const native = new NativeEventBus();
  const syncedLayerOrders: string[][] = [];
  const destroyed = { value: false };
  let view = initialView;
  const hits: HitFeature[] = [
    {
      layerId: "geo",
      featureId: "feature-1",
      properties: { name: "test" },
      geometry: { type: "Point", coordinates: [8.55, 47.37] },
    },
  ];
  const controller = {
    init: () => native.map,
    getMap: () => native.map,
    destroy: () => {
      destroyed.value = true;
    },
    setStyle: () => undefined,
    setBasemapVisible: () => undefined,
    setBasemapOpacity: () => undefined,
    applyMapPreferences: () => undefined,
    applyView: (nextView: MapViewState) => {
      view = nextView;
    },
    easeToView: (nextView: MapViewState) => {
      view = nextView;
    },
    readView: () => view,
    waitAndSyncLayers: (layers: GeoLibreLayer[]) => {
      syncedLayerOrders.push(layers.map(({ id }) => id));
    },
    getLayerGeoJson: async () => null,
    getLayerRasterSource: () => null,
    getBasemapStyleLayerIds: () => [],
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
    highlightFeature: () => undefined,
    clearFeatureHighlight: () => undefined,
    setBuiltInControlVisible: () => true,
    getBuiltInControlPosition: () => "top-right",
    setBuiltInControlPosition: () => true,
    setCompassLabel: () => undefined,
    setTerrainLabel: () => undefined,
    setBackgroundLabel: () => undefined,
    getTerrainExaggeration: () => 1,
    setTerrainExaggeration: () => undefined,
  };
  const module = {
    createMapController: () => controller,
  } as unknown as MapControllerModule;
  const engine = new MapLibreEngine(async () => module);
  return {
    engine,
    syncedLayerOrders,
    destroyed,
    emitUserMove: () => {
      view = { ...view, zoom: view.zoom + 1 };
      native.emit("moveend", { originalEvent: {} });
    },
  };
}

class CesiumEvent {
  private readonly listeners = new Set<() => void>();

  addEventListener(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(): void {
    for (const listener of this.listeners) listener();
  }
}

class CesiumCanvasFake {
  readonly clientWidth = 800;
  readonly clientHeight = 600;
  readonly width = 800;
  readonly height = 600;
  private readonly listeners = new Map<string, Set<EventListener>>();

  addEventListener(event: string, listener: EventListener): void {
    const listeners = this.listeners.get(event) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  removeEventListener(event: string, listener: EventListener): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: string): void {
    for (const listener of this.listeners.get(event) ?? []) listener({} as Event);
  }
}

interface CesiumViewerFake {
  readonly canvas: CesiumCanvasFake;
  readonly camera: {
    readonly moveStart: CesiumEvent;
    readonly changed: CesiumEvent;
    readonly moveEnd: CesiumEvent;
    target: { lng: number; lat: number; range: number };
  };
  destroy(): void;
}

function createCesiumHarness(): EngineHarness {
  const syncedLayerOrders: string[][] = [];
  const destroyed = { value: false };
  const viewers: CesiumViewerFake[] = [];

  class ViewerFake {
    readonly canvas = new CesiumCanvasFake();
    readonly camera = {
      moveStart: new CesiumEvent(),
      changed: new CesiumEvent(),
      moveEnd: new CesiumEvent(),
      frustum: { fovy: Math.PI / 3 },
      heading: 0,
      pitch: -Math.PI / 2,
      positionWC: {},
      positionCartographic: { longitude: 0, latitude: 0, height: 1 },
      target: { lng: 0, lat: 0, range: 1 },
      lookAt: (
        target: { lng: number; lat: number },
        offset: { heading: number; pitch: number; range: number },
      ): void => {
        this.camera.target = { lng: target.lng, lat: target.lat, range: offset.range };
        this.camera.heading = offset.heading;
        this.camera.pitch = offset.pitch;
      },
      lookAtTransform: (): void => undefined,
      pickEllipsoid: (): { lng: number; lat: number; range: number } => this.camera.target,
      flyTo: (): void => undefined,
    };
    readonly scene = { canvas: this.canvas, globe: { ellipsoid: {} } };
    readonly screenSpaceEventHandler = { removeInputAction: (): void => undefined };
    readonly imageryLayers = { get: () => undefined };
    private isDead = false;

    constructor() {
      viewers.push(this);
    }

    isDestroyed(): boolean {
      return this.isDead;
    }

    destroy(): void {
      this.isDead = true;
      destroyed.value = true;
    }
  }

  const Cesium = {
    Viewer: ViewerFake,
    Ion: { defaultAccessToken: "" },
    ImageryLayer: { fromProviderAsync: () => ({}) },
    OpenStreetMapImageryProvider: class {},
    ScreenSpaceEventType: { LEFT_DOUBLE_CLICK: 1 },
    createWorldTerrainAsync: async () => ({}),
    Math: {
      toRadians: (degrees: number) => (degrees * Math.PI) / 180,
      toDegrees: (radians: number) => (radians * 180) / Math.PI,
    },
    Cartesian3: {
      fromDegrees: (lng: number, lat: number) => ({ lng, lat }),
      distance: (_position: unknown, target: { range: number }) => target.range,
    },
    HeadingPitchRange: class {
      constructor(
        readonly heading: number,
        readonly pitch: number,
        readonly range: number,
      ) {}
    },
    Matrix4: { IDENTITY: {} },
    Cartesian2: class {},
    Cartographic: {
      fromCartesian: (target: { lng: number; lat: number }) => ({
        longitude: (target.lng * Math.PI) / 180,
        latitude: (target.lat * Math.PI) / 180,
      }),
    },
    Ellipsoid: { WGS84: {} },
    Rectangle: { fromDegrees: (...bounds: number[]) => bounds },
  } as unknown as typeof import("cesium");
  const dependencies: CesiumEngineDependencies = {
    loadCesium: async () => Cesium,
    prepareEnvironment: () => undefined,
    createLayerSync: () => ({
      sync: (layers) => syncedLayerOrders.push(layers.map(({ id }) => id)),
      destroy: () => undefined,
    }),
  };
  const engine = new CesiumEngine({}, dependencies);
  return {
    engine,
    syncedLayerOrders,
    destroyed,
    emitUserMove: () => {
      const viewer = viewers[0];
      assert.ok(viewer);
      viewer.canvas.emit("wheel");
      viewer.camera.target.range *= 2;
      viewer.camera.moveEnd.emit();
    },
  };
}

function createArcGISHarness(): EngineHarness {
  const runtime = createArcGISFakeRuntime();
  const engine = new ArcGISMapEngine({ loadArcGIS: async () => runtime.modules });
  engine.syncLayers([layer("geo", "geojson")]);
  runtime.hitTestResults = [
    {
      type: "graphic",
      layer: { id: "geolibre-geo" },
      graphic: { attributes: { [ARC_GIS_FEATURE_INDEX]: 0 } },
    },
  ];
  return {
    engine,
    get syncedLayerOrders(): string[][] {
      return runtime.layerOrders.map((order) => order.map((id) => id.replace(/^geolibre-/, "")));
    },
    destroyed: runtime.destroyed,
    emitUserMove: () => {
      assert.ok(runtime.view);
      runtime.view.emitUserMove();
    },
  };
}

function createArcGISSceneHarness(): EngineHarness {
  const runtime = createArcGISSceneFakeRuntime();
  const engine = new ArcGISSceneEngine({ loadArcGIS: async () => runtime.modules });
  engine.syncLayers([layer("geo", "geojson")]);
  runtime.hitTestResults = [
    {
      type: "graphic",
      layer: { id: "geolibre-geo" },
      graphic: { attributes: { [ARC_GIS_FEATURE_INDEX]: 0 } },
    },
  ];
  return {
    engine,
    get syncedLayerOrders(): string[][] {
      return runtime.layerOrders.map((order) => order.map((id) => id.replace(/^geolibre-/, "")));
    },
    destroyed: runtime.destroyed,
    emitUserMove: () => {
      assert.ok(runtime.view);
      runtime.view.emitUserMove();
    },
  };
}

export function runEngineConformance(
  name: string,
  createHarness: EngineHarnessFactory,
  expectations: ConformanceExpectations,
): void {
  describe(`${name} MapEngine conformance`, () => {
    test("mounts, round-trips views, and destroys exactly its own runtime", async () => {
      const harness = createHarness();
      await harness.engine.mount({} as HTMLElement, initialView);
      const nextView = { ...initialView, zoom: 10, bearing: 20 };
      harness.engine.applyView(nextView);
      const actual = harness.engine.readView();

      assert.ok(Math.abs(actual.zoom - nextView.zoom) < 0.02);
      assert.ok(Math.abs(actual.bearing - nextView.bearing) < 0.1);
      harness.engine.destroy();
      assert.equal(harness.destroyed.value, true);
    });

    test("advertises the reviewed capability and layer matrices", () => {
      const harness = createHarness();
      for (const [capability, supported] of Object.entries(expectations.capabilities)) {
        assert.equal(harness.engine.supports(capability as MapEngineCapability), supported);
      }
      assert.equal(
        harness.engine.supportsLayer(layer("geo", "geojson")),
        expectations.supportsGeoJson,
      );
      assert.equal(
        harness.engine.supportsLayer(layer("vector", "vector-tiles")),
        expectations.supportsVectorTiles,
      );
    });

    test("preserves store layer add, remove, and reorder snapshots", async () => {
      const harness = createHarness();
      await harness.engine.mount({} as HTMLElement, initialView);
      const first = layer("first", "geojson");
      const second = layer("second", "xyz");
      harness.engine.syncLayers([first, second]);
      harness.engine.syncLayers([second, first]);
      harness.engine.syncLayers([second]);

      assert.deepEqual(harness.syncedLayerOrders.slice(-3), [
        ["first", "second"],
        ["second", "first"],
        ["second"],
      ]);
    });

    test("normalizes hits or throws the declared unsupported error", async () => {
      const harness = createHarness();
      await harness.engine.mount({} as HTMLElement, initialView);
      if (expectations.unsupportedHitCapability) {
        await assert.rejects(
          harness.engine.hitTest({ x: 1, y: 2 }),
          (error) =>
            error instanceof MapEngineCapabilityError &&
            error.capability === expectations.unsupportedHitCapability,
        );
      } else {
        const hits = await harness.engine.hitTest({ x: 1, y: 2 });
        assert.equal(hits.length, expectations.hitCount);
        assert.equal(hits[0]?.layerId, "geo");
      }
    });

    test("event unsubscribe detaches the consumer", async () => {
      const harness = createHarness();
      await harness.engine.mount({} as HTMLElement, initialView);
      let moves = 0;
      const unsubscribe = harness.engine.on("moveend", () => {
        moves += 1;
      });
      harness.emitUserMove();
      assert.equal(moves, 1);
      unsubscribe();
      harness.emitUserMove();
      assert.equal(moves, 1);
    });

    test("the stable handle queues pre-ready store mutations", async () => {
      const harness = createHarness();
      let resolve!: (engine: MapEngine) => void;
      const pending = new Promise<MapEngine>((next) => {
        resolve = next;
      });
      const engineId =
        name === "Cesium"
          ? "cesium"
          : name === "ArcGIS Scene"
            ? "arcgis-scene"
            : name === "ArcGIS"
              ? "arcgis"
              : "maplibre";
      const handle = createMapEngineHandleForTesting(engineId, () => pending);
      const mounted = handle.mount({} as HTMLElement, initialView);
      const queuedView = { ...initialView, zoom: 12 };
      handle.applyView(queuedView);
      handle.syncLayers([layer("queued", "geojson")]);
      resolve(harness.engine);
      await mounted;

      assert.equal(handle.readView().zoom, 12);
      assert.deepEqual(harness.syncedLayerOrders.at(-1), ["queued"]);
    });

    test("unsupported controls are explicit", async () => {
      const harness = createHarness();
      await harness.engine.mount({} as HTMLElement, initialView);
      if (expectations.capabilities.controls) {
        assert.equal(harness.engine.controls.getBuiltInState("compass").position, "top-right");
      } else {
        assert.throws(
          () => harness.engine.controls.getBuiltInState("compass"),
          (error) => error instanceof MapEngineCapabilityError,
        );
      }
    });
  });
}

const allCapabilities: Readonly<Record<MapEngineCapability, boolean>> = {
  capture: true,
  controls: true,
  "feature-query": true,
  interactions: true,
  markers: true,
  popups: true,
  "transient-overlays": true,
};

runEngineConformance("MapLibre", createMapLibreHarness, {
  capabilities: allCapabilities,
  supportsGeoJson: true,
  supportsVectorTiles: true,
  hitCount: 1,
});

runEngineConformance("Cesium", createCesiumHarness, {
  capabilities: Object.fromEntries(
    Object.keys(allCapabilities).map((capability) => [capability, false]),
  ) as unknown as Readonly<Record<MapEngineCapability, boolean>>,
  supportsGeoJson: true,
  supportsVectorTiles: false,
  hitCount: 0,
  unsupportedHitCapability: "feature-query",
});

runEngineConformance("ArcGIS", createArcGISHarness, {
  capabilities: Object.fromEntries(
    Object.keys(allCapabilities).map((capability) => [
      capability,
      capability === "capture" ||
      capability === "feature-query" ||
      capability === "popups" ||
      capability === "transient-overlays",
    ]),
  ) as unknown as Readonly<Record<MapEngineCapability, boolean>>,
  supportsGeoJson: true,
  supportsVectorTiles: false,
  hitCount: 1,
});

runEngineConformance("ArcGIS Scene", createArcGISSceneHarness, {
  capabilities: Object.fromEntries(
    Object.keys(allCapabilities).map((capability) => [
      capability,
      capability === "capture" ||
      capability === "feature-query" ||
      capability === "popups" ||
      capability === "transient-overlays",
    ]),
  ) as unknown as Readonly<Record<MapEngineCapability, boolean>>,
  supportsGeoJson: true,
  supportsVectorTiles: false,
  hitCount: 1,
});
