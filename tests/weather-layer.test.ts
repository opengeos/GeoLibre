import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { useAppStore } from "../packages/core/src/store";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";
import {
  createWeatherLayer,
  type WeatherFrame,
  type WeatherLayerConfig,
} from "../packages/plugins/src/plugins/weather-layer";

const FLAG = "weatherLayerTestFlag";

const frame: WeatherFrame = {
  tileUrl: "https://example.test/{z}/{x}/{y}.png",
  label: "frame-1",
  metadata: { title: "Test" },
};

// A map-less app: getMap() → null makes the engine skip all MapLibre work
// (setTiles, the error listener), leaving the store-driven logic under test.
const app = { getMap: () => null } as unknown as GeoLibreAppAPI;

function makeConfig(over: Partial<WeatherLayerConfig> = {}): WeatherLayerConfig {
  return {
    layerName: "TestWeather",
    layerFlag: FLAG,
    attribution: "",
    serviceUrl: "https://example.test/",
    maxzoom: 6,
    tileSize: 512,
    opacity: 0.8,
    frameMs: 1000,
    loadFrames: async () => [frame],
    ...over,
  };
}

const ownedLayers = () => useAppStore.getState().layers.filter((l) => l.metadata?.[FLAG] === true);

beforeEach(() => {
  useAppStore.setState({ layers: [], layerGroups: [], selectedLayerId: null });
});

describe("createWeatherLayer", () => {
  it("plays a map-less renderer's frames through the store without dirtying or undo entries", async () => {
    const frames: WeatherFrame[] = [
      { tileUrl: "https://example.test/a/{z}/{x}/{y}.png", label: "a", metadata: { title: "A" } },
      { tileUrl: "https://example.test/b/{z}/{x}/{y}.png", label: "b", metadata: { title: "B" } },
    ];
    const c = createWeatherLayer(makeConfig({ frameMs: 5, loadFrames: async () => frames }));
    assert.equal(await c.activate(app), true);
    // Let the activation's history window close, so the stop is its own entry.
    await new Promise((resolve) => setTimeout(resolve, 500));
    useAppStore.setState({ isDirty: false });
    useAppStore.temporal.getState().clear();
    const tile = () => ownedLayers()[0]?.source.tiles?.[0];
    const before = tile();
    c.togglePlaying();
    await new Promise((resolve) => setTimeout(resolve, 30));
    // The ticks moved the layer without an edit to show for it.
    assert.equal(useAppStore.getState().isDirty, false);
    assert.equal(useAppStore.temporal.getState().pastStates.length, 0);
    c.togglePlaying();
    const resting = tile();
    // Stopping records the resting frame as one edit, undoable to the start.
    if (resting !== before) {
      assert.equal(useAppStore.getState().isDirty, true);
      assert.equal(useAppStore.temporal.getState().pastStates.length, 1);
      useAppStore.temporal.getState().undo();
      assert.equal(tile(), before);
    } else {
      assert.equal(useAppStore.getState().isDirty, false);
    }
    c.deactivate();
  });

  it("adds one store layer on activate and removes it on deactivate", async () => {
    const c = createWeatherLayer(makeConfig());
    assert.equal(await c.activate(app), true);
    assert.equal(ownedLayers().length, 1);
    c.deactivate();
    assert.equal(ownedLayers().length, 0);
  });

  it("does NOT resurrect the layer when deactivate() races an in-flight activate()", async () => {
    let release: (() => void) | undefined;
    const c = createWeatherLayer(
      makeConfig({
        loadFrames: () =>
          new Promise<WeatherFrame[]>((resolve) => {
            release = () => resolve([frame]);
          }),
      }),
    );
    const activating = c.activate(app); // suspends at the await
    c.deactivate(); // user toggled off before the fetch resolved
    release?.(); // fetch now resolves
    assert.equal(await activating, false); // superseded → bailed
    assert.equal(ownedLayers().length, 0); // no orphaned layer added
  });

  it("fails (rolls back) when loadFrames() is empty and nothing to adopt", async () => {
    const c = createWeatherLayer(makeConfig({ loadFrames: async () => [] }));
    assert.equal(await c.activate(app), false);
    assert.equal(ownedLayers().length, 0);
  });

  it("adopts a restored layer (keeping it) when loadFrames() is empty on restore", async () => {
    // Simulate a project restore: the tagged layer is already in the store.
    useAppStore.getState().addTileLayer("TestWeather", {
      type: "xyz",
      tiles: ["https://example.test/old/{z}/{x}/{y}.png"],
      metadata: { [FLAG]: true },
    });
    assert.equal(ownedLayers().length, 1);

    const c = createWeatherLayer(makeConfig({ loadFrames: async () => [] }));
    assert.equal(await c.activate(app), true); // adopted despite no fresh frames
    assert.equal(ownedLayers().length, 1); // not duplicated, not removed
    c.deactivate();
    assert.equal(ownedLayers().length, 0); // deactivate removes the adopted layer
  });

  it("does NOT mark the project dirty when adopting an already-current layer", async () => {
    // A project saved on the current frame: tiles + metadata already match.
    useAppStore.getState().addTileLayer("TestWeather", {
      type: "xyz",
      tiles: [frame.tileUrl],
      metadata: { ...frame.metadata, [FLAG]: true },
    });
    useAppStore.setState({ isDirty: false }); // freshly-opened = clean

    const c = createWeatherLayer(makeConfig()); // loadFrames → same frame
    assert.equal(await c.activate(app), true);
    assert.equal(useAppStore.getState().isDirty, false); // no-op adopt stays clean
  });

  it("treats metadata equality as key-order-independent (no spurious dirty)", async () => {
    // Same content as the engine builds ({ title, [FLAG] }) but reversed order,
    // as a JSON round-trip or a future builder tweak could produce.
    useAppStore.getState().addTileLayer("TestWeather", {
      type: "xyz",
      tiles: [frame.tileUrl],
      metadata: { [FLAG]: true, title: "Test" },
    });
    useAppStore.setState({ isDirty: false });

    const c = createWeatherLayer(makeConfig());
    assert.equal(await c.activate(app), true);
    assert.equal(useAppStore.getState().isDirty, false); // order-independent → clean
  });

  it("refreshes (marking dirty) when the adopted layer's saved tile is stale", async () => {
    useAppStore.getState().addTileLayer("TestWeather", {
      type: "xyz",
      tiles: ["https://example.test/STALE/{z}/{x}/{y}.png"],
      metadata: { ...frame.metadata, [FLAG]: true },
    });
    useAppStore.setState({ isDirty: false });

    const c = createWeatherLayer(makeConfig()); // fresh frame differs
    assert.equal(await c.activate(app), true);
    assert.equal(useAppStore.getState().isDirty, true);
  });

  it("adopts (not duplicates) a restored layer when fresh frames are available", async () => {
    useAppStore.getState().addTileLayer("TestWeather", {
      type: "xyz",
      tiles: ["https://example.test/old/{z}/{x}/{y}.png"],
      metadata: { [FLAG]: true },
    });
    const c = createWeatherLayer(makeConfig());
    assert.equal(await c.activate(app), true);
    assert.equal(ownedLayers().length, 1); // exactly one — adopted, no duplicate
  });

  it("auto-pauses playback after a burst of tile errors from its own source", async () => {
    // A fake map that captures the "error" listener the engine attaches.
    let onError: ((e: unknown) => void) | undefined;
    const fakeMap = {
      on: (event: string, cb: (e: unknown) => void) => {
        if (event === "error") onError = cb;
      },
      off: () => {},
      getSource: () => undefined, // setTiles is a no-op
    };
    const appWithMap = {
      getMap: () => fakeMap,
    } as unknown as GeoLibreAppAPI;

    const secondFrame: WeatherFrame = {
      ...frame,
      tileUrl: "https://example.test/2/{z}/{x}/{y}.png",
    };
    const c = createWeatherLayer(
      makeConfig({ loadFrames: async () => [frame, secondFrame], frameMs: 60_000 }),
    );
    await c.activate(appWithMap);
    const layerId = ownedLayers()[0].id;

    c.togglePlaying();
    assert.equal(c.getState().playing, true);
    assert.ok(onError, "error listener was attached");

    // A burst of tile-load failures for THIS layer's source trips the breaker.
    for (let i = 0; i < 5; i += 1) onError?.({ sourceId: `source-${layerId}` });
    assert.equal(c.getState().playing, false);

    c.deactivate();
  });

  it("ignores tile errors from other sources (no false auto-pause)", async () => {
    let onError: ((e: unknown) => void) | undefined;
    const fakeMap = {
      on: (event: string, cb: (e: unknown) => void) => {
        if (event === "error") onError = cb;
      },
      off: () => {},
      getSource: () => undefined,
    };
    const appWithMap = { getMap: () => fakeMap } as unknown as GeoLibreAppAPI;
    const secondFrame: WeatherFrame = {
      ...frame,
      tileUrl: "https://example.test/2/{z}/{x}/{y}.png",
    };
    const c = createWeatherLayer(
      makeConfig({ loadFrames: async () => [frame, secondFrame], frameMs: 60_000 }),
    );
    await c.activate(appWithMap);
    c.togglePlaying();
    for (let i = 0; i < 20; i += 1) onError?.({ sourceId: "source-some-other-layer" });
    assert.equal(c.getState().playing, true); // unaffected by unrelated errors
    c.deactivate();
  });
});
