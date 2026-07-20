import assert from "node:assert/strict";
import test from "node:test";
import type { GeoLibreLayer, MapViewState } from "../packages/core/src/index";
import {
  CesiumEngine,
  type CesiumEngineDependencies,
} from "../packages/map/src/engine/cesium-engine";
import { MapEngineCapabilityError } from "../packages/map/src/engine/types";

class FakeEvent<T extends unknown[] = []> {
  private readonly listeners = new Set<(...args: T) => void>();

  addEventListener(listener: (...args: T) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  raise(...args: T): void {
    for (const listener of this.listeners) listener(...args);
  }
}

class FakeCanvas {
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

  dispatch(event: string, payload: Event = {} as Event): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }
}

interface FakeViewerInstance {
  readonly canvas: FakeCanvas;
  readonly camera: {
    readonly moveStart: FakeEvent;
    readonly changed: FakeEvent;
    readonly moveEnd: FakeEvent;
    target: { lng: number; lat: number; range: number };
  };
}

function createCesiumFakes(): {
  readonly Cesium: typeof import("cesium");
  readonly viewers: FakeViewerInstance[];
} {
  const viewers: FakeViewerInstance[] = [];

  class FakeViewer {
    readonly canvas = new FakeCanvas();
    readonly camera = {
      moveStart: new FakeEvent(),
      changed: new FakeEvent(),
      moveEnd: new FakeEvent(),
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
    readonly scene = {
      canvas: this.canvas,
      globe: { ellipsoid: {} },
    };
    readonly screenSpaceEventHandler = {
      removeInputAction: (): void => undefined,
    };
    readonly imageryLayers = {
      get: (): { show: boolean; alpha: number } => ({ show: true, alpha: 1 }),
    };
    terrainProvider: unknown;
    private destroyed = false;

    constructor(_container: HTMLElement, _options: unknown) {
      viewers.push(this);
    }

    isDestroyed(): boolean {
      return this.destroyed;
    }

    destroy(): void {
      this.destroyed = true;
    }
  }

  const Cesium = {
    Viewer: FakeViewer,
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
      distance: (
        _position: unknown,
        target: { range: number },
      ): number => target.range,
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

  return { Cesium, viewers };
}

function layer(id: string, type: GeoLibreLayer["type"]): GeoLibreLayer {
  return {
    id,
    name: id,
    type,
    source: {},
    visible: true,
    opacity: 1,
    style: {},
    metadata: {},
  } as GeoLibreLayer;
}

function createEngineOptions(fakes: ReturnType<typeof createCesiumFakes>): {
  readonly dependencies: CesiumEngineDependencies;
  readonly syncedLayers: GeoLibreLayer[][];
  readonly destroyed: { value: boolean };
} {
  const syncedLayers: GeoLibreLayer[][] = [];
  const destroyed = { value: false };
  return {
    dependencies: {
      loadCesium: async () => fakes.Cesium,
      prepareEnvironment: () => undefined,
      createLayerSync: () => ({
        sync: (layers) => syncedLayers.push(layers),
        destroy: () => {
          destroyed.value = true;
        },
      }),
    },
    syncedLayers,
    destroyed,
  };
}

test("Cesium mounts lazily, round-trips camera state, and syncs supported layers", async () => {
  const fakes = createCesiumFakes();
  const { dependencies, syncedLayers } = createEngineOptions(fakes);
  let loadCalls = 0;
  const engine = new CesiumEngine({}, {
    ...dependencies,
    loadCesium: async () => {
      loadCalls += 1;
      return fakes.Cesium;
    },
  });
  const view: MapViewState = {
    center: [8.55, 47.37],
    zoom: 8,
    bearing: 15,
    pitch: 35,
  };
  engine.syncLayers([layer("geo", "geojson"), layer("vector", "vector-tiles")]);

  assert.equal(loadCalls, 0);
  await engine.mount({ getBoundingClientRect: () => ({}) } as HTMLElement, view);

  assert.equal(loadCalls, 1);
  const read = engine.readView();
  assert.ok(Math.abs(read.center[0] - view.center[0]) < 1e-9);
  assert.ok(Math.abs(read.center[1] - view.center[1]) < 1e-9);
  assert.ok(Math.abs(read.zoom - view.zoom) < 1e-9);
  assert.deepEqual(syncedLayers.at(-1)?.map(({ id }) => id), ["geo", "vector"]);
  assert.equal(engine.supportsLayer(layer("geo", "geojson")), true);
  assert.equal(engine.supportsLayer(layer("vector", "vector-tiles")), false);
});

test("Cesium suppresses camera echoes and emits a real user move once", async () => {
  const fakes = createCesiumFakes();
  const { dependencies } = createEngineOptions(fakes);
  const engine = new CesiumEngine({}, dependencies);
  const initial: MapViewState = {
    center: [8.55, 47.37],
    zoom: 8,
    bearing: 0,
    pitch: 0,
  };
  const moves: Array<{ userDriven: boolean; zoom: number }> = [];
  engine.on("moveend", ({ userDriven, view }) => moves.push({ userDriven, zoom: view.zoom }));
  await engine.mount({} as HTMLElement, initial);
  const viewer = fakes.viewers[0];
  assert.ok(viewer);

  viewer.camera.moveEnd.raise();
  assert.equal(moves.length, 0, "programmatic apply echo must be suppressed");

  engine.applyView({ ...initial, zoom: 10 });
  viewer.camera.moveEnd.raise();
  assert.equal(moves.length, 0, "a second programmatic echo must also be suppressed");

  viewer.canvas.dispatch("wheel");
  engine.applyView({ ...initial, zoom: 11 });
  // Move away from the last-applied view to model a user wheel after the seed.
  const target = viewer.camera as unknown as {
    target: { lng: number; lat: number; range: number };
  };
  target.target.range *= 2;
  viewer.camera.moveEnd.raise();
  assert.deepEqual(moves, [{ userDriven: true, zoom: 10 }]);
});

test("Cesium reports unsupported capability calls explicitly", async () => {
  const fakes = createCesiumFakes();
  const { dependencies } = createEngineOptions(fakes);
  const engine = new CesiumEngine({}, dependencies);
  await engine.mount({} as HTMLElement, {
    center: [0, 0],
    zoom: 2,
    bearing: 0,
    pitch: 0,
  });

  assert.equal(engine.supports("controls"), false);
  assert.throws(
    () => engine.controls.getBuiltInState("compass"),
    (error) =>
      error instanceof MapEngineCapabilityError &&
      error.engineId === "cesium" &&
      error.capability === "controls",
  );
  await assert.rejects(
    engine.hitTest({ x: 0, y: 0 }),
    (error) => error instanceof MapEngineCapabilityError,
  );
});

test("destroy during dynamic import prevents viewer creation", async () => {
  const fakes = createCesiumFakes();
  let resolve!: (Cesium: typeof import("cesium")) => void;
  const pending = new Promise<typeof import("cesium")>((next) => {
    resolve = next;
  });
  const engine = new CesiumEngine({}, {
    loadCesium: () => pending,
    prepareEnvironment: () => undefined,
  });
  const mounted = engine.mount({} as HTMLElement, {
    center: [0, 0],
    zoom: 2,
    bearing: 0,
    pitch: 0,
  });

  engine.destroy();
  resolve(fakes.Cesium);
  await mounted;
  assert.equal(fakes.viewers.length, 0);
});
