import assert from "node:assert/strict";
import test from "node:test";
import type { MapEngine } from "../packages/map/src/engine/types";
import { createMapEngineHandleForTesting } from "../packages/map/src/engine/handle";
import { resolvePrimaryEngineId } from "../packages/map/src/engine/registry";
import { createTestMapEngine } from "./engine-test-fakes";

function deferredEngine(): {
  readonly promise: Promise<MapEngine>;
  readonly resolve: (engine: MapEngine) => void;
} {
  let resolve!: (engine: MapEngine) => void;
  const promise = new Promise<MapEngine>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

test("the stable handle queues mutations in order while its adapter loads", async () => {
  const deferred = deferredEngine();
  const adapter = createTestMapEngine();
  const handle = createMapEngineHandleForTesting("maplibre", () => deferred.promise);
  const initialView = {
    center: [8.55, 47.37] as [number, number],
    zoom: 9,
    bearing: 12,
    pitch: 20,
  };

  const mounted = handle.mount({} as HTMLElement, initialView);
  handle.configure({ basemapVisible: false });
  handle.applyView({ ...initialView, zoom: 10 });
  handle.syncLayers([]);

  assert.deepEqual(handle.readView(), { ...initialView, zoom: 10 });
  assert.deepEqual(adapter.operations, []);

  deferred.resolve(adapter);
  await mounted;

  assert.deepEqual(adapter.operations, ["mount", "configure", "applyView", "syncLayers"]);
});

test("pre-ready subscriptions forward each adapter event once", async () => {
  const adapter = createTestMapEngine();
  const handle = createMapEngineHandleForTesting("maplibre", async () => adapter);
  let moves = 0;
  const unsubscribe = handle.on("move", ({ view }) => {
    moves += 1;
    assert.equal(view.zoom, 6);
  });

  await handle.mount({} as HTMLElement, {
    center: [0, 0],
    zoom: 2,
    bearing: 0,
    pitch: 0,
  });
  adapter.emit("move", {
    view: { center: [1, 2], zoom: 6, bearing: 0, pitch: 0 },
    userDriven: true,
  });

  assert.equal(moves, 1);
  assert.equal(handle.readView().zoom, 6);
  unsubscribe();
  adapter.emit("move", {
    view: { center: [1, 2], zoom: 6, bearing: 0, pitch: 0 },
    userDriven: true,
  });
  assert.equal(moves, 1);
});

test("destroy cancels queued work while the adapter factory is pending", async () => {
  const deferred = deferredEngine();
  const adapter = createTestMapEngine();
  const handle = createMapEngineHandleForTesting("maplibre", () => deferred.promise);
  const mounted = handle.mount({} as HTMLElement, {
    center: [0, 0],
    zoom: 2,
    bearing: 0,
    pitch: 0,
  });
  handle.configure({ basemapOpacity: 0.5 });

  handle.destroy();
  deferred.resolve(adapter);
  await mounted;

  assert.deepEqual(adapter.operations, ["destroy"]);
  assert.equal(adapter.state.mounted, false);
});

test("primary engine resolution accepts MapLibre and warns on unavailable values", () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message): void => {
    warnings.push(String(message));
  };
  try {
    assert.equal(resolvePrimaryEngineId("?engine=maplibre"), "maplibre");
    assert.equal(resolvePrimaryEngineId("?engine=cesium"), "maplibre");
    assert.equal(resolvePrimaryEngineId("?engine=unknown"), "maplibre");
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 2);
  assert.match(warnings[0] ?? "", /not available/);
  assert.match(warnings[1] ?? "", /Unknown map engine/);
});
