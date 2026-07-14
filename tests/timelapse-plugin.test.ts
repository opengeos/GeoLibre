import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { useAppStore } from "@geolibre/core";
import type { Map as MapLibreMap } from "maplibre-gl";
import {
  getActiveTimelapseControl,
  maplibreTimelapsePlugin as plugin,
  TIMELAPSE_PLUGIN_ID,
  TIMELAPSE_SOURCE_KIND,
  timelapseStoreLayerId,
} from "../packages/plugins/src/plugins/maplibre-timelapse";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";

/** A recording fake of the MapLibre surface the plugin touches. */
function fakeMap() {
  const sources = new Map<string, unknown>();
  const layers = new Map<string, unknown>();
  const paintWrites: Array<{ layerId: string; name: string; value: unknown }> =
    [];
  const layoutWrites: Array<{ layerId: string; name: string; value: unknown }> =
    [];
  return {
    sources,
    layers,
    paintWrites,
    layoutWrites,
    addSource: (id: string, spec: unknown) => {
      sources.set(id, spec);
    },
    getSource: (id: string) => sources.get(id),
    removeSource: (id: string) => {
      sources.delete(id);
    },
    addLayer: (spec: { id: string }) => {
      layers.set(spec.id, spec);
    },
    getLayer: (id: string) => layers.get(id),
    removeLayer: (id: string) => {
      layers.delete(id);
    },
    setPaintProperty: (layerId: string, name: string, value: unknown) => {
      paintWrites.push({ layerId, name, value });
    },
    setLayoutProperty: (layerId: string, name: string, value: unknown) => {
      layoutWrites.push({ layerId, name, value });
    },
    isSourceLoaded: () => true,
    isStyleLoaded: () => true,
    once: () => {},
    on: () => {},
    off: () => {},
  };
}

type FakeMap = ReturnType<typeof fakeMap>;

function fakeApp(
  map: FakeMap,
  options: { addControlSucceeds?: boolean } = {},
): GeoLibreAppAPI & { removed: unknown[]; basemapCallbacks: Array<() => void> } {
  const removed: unknown[] = [];
  const basemapCallbacks: Array<() => void> = [];
  return {
    removed,
    basemapCallbacks,
    getMap: () => map as unknown as MapLibreMap,
    addMapControl: () => options.addControlSucceeds ?? true,
    removeMapControl: (control: unknown) => {
      removed.push(control);
    },
    getActiveBasemap: () => "https://tiles.openfreemap.org/styles/liberty",
    onBasemapChange: (callback: () => void) => {
      basemapCallbacks.push(callback);
      return () => {};
    },
  } as unknown as GeoLibreAppAPI & {
    removed: unknown[];
    basemapCallbacks: Array<() => void>;
  };
}

const STORE_LAYER_ID = timelapseStoreLayerId("eox-s2cloudless");

function storeLayer() {
  return useAppStore
    .getState()
    .layers.find((layer) => layer.id === STORE_LAYER_ID);
}

describe("maplibreTimelapsePlugin", () => {
  beforeEach(() => {
    useAppStore.setState({ layers: [] });
    // Clear any saved module state a previous test left behind.
    plugin.applyProjectState?.(fakeApp(fakeMap()), null);
  });

  afterEach(() => {
    if (getActiveTimelapseControl()) plugin.deactivate(fakeApp(fakeMap()));
    useAppStore.setState({ layers: [] });
  });

  it("has the exported id", () => {
    assert.equal(plugin.id, TIMELAPSE_PLUGIN_ID);
  });

  it("builds the full pre-warmed frame stack and one store layer", () => {
    const map = fakeMap();
    plugin.activate(fakeApp(map));

    // Ten sources and ten raster layers, all visible.
    assert.equal(map.sources.size, 10);
    assert.equal(map.layers.size, 10);
    for (const spec of map.layers.values()) {
      const layer = spec as {
        layout: { visibility: string };
        paint: Record<string, unknown>;
      };
      assert.equal(layer.layout.visibility, "visible");
      assert.equal(layer.paint["raster-fade-duration"], 0);
    }
    // Exactly one frame (the active year) starts opaque.
    const opacities = [...map.layers.values()].map(
      (spec) =>
        (spec as { paint: Record<string, unknown> }).paint["raster-opacity"],
    );
    assert.equal(opacities.filter((value) => value === 1).length, 1);
    assert.equal(opacities.filter((value) => value === 0).length, 9);

    // The 2016 source uses the unsuffixed EOX layer identifier.
    const source2016 = map.sources.get(
      "timelapse-source-s2cloudless-2016",
    ) as { tiles: string[] };
    assert.ok(source2016.tiles[0].includes("/s2cloudless_3857/"));

    // One tidy store layer mirrors the whole stack.
    const layer = storeLayer();
    assert.ok(layer, "store layer exists");
    assert.equal(layer.metadata.sourceKind, TIMELAPSE_SOURCE_KIND);
    assert.equal(layer.metadata.customLayerType, "timelapse-frames");
    assert.equal(layer.metadata.externalNativeLayer, true);
    assert.equal((layer.metadata.nativeLayerIds as string[]).length, 10);
    assert.equal((layer.metadata.sourceIds as string[]).length, 10);
    assert.equal(
      useAppStore
        .getState()
        .layers.filter(
          (item) => item.metadata.sourceKind === TIMELAPSE_SOURCE_KIND,
        ).length,
      1,
    );
  });

  it("swaps a year with exactly two raster-opacity writes", () => {
    const map = fakeMap();
    plugin.activate(fakeApp(map));
    const control = getActiveTimelapseControl();
    assert.ok(control);

    map.paintWrites.length = 0;
    control.setFrameIndex(3);

    const opacityWrites = map.paintWrites.filter(
      (write) => write.name === "raster-opacity",
    );
    assert.equal(opacityWrites.length, 2);
    assert.deepEqual(opacityWrites[0], {
      layerId: "timelapse-layer-s2cloudless-2016",
      name: "raster-opacity",
      value: 0,
    });
    assert.deepEqual(opacityWrites[1], {
      layerId: "timelapse-layer-s2cloudless-2019",
      name: "raster-opacity",
      value: 1,
    });
    assert.equal(control.getFrameIndex(), 3);
  });

  it("jumping to the current frame writes nothing", () => {
    const map = fakeMap();
    plugin.activate(fakeApp(map));
    const control = getActiveTimelapseControl();
    assert.ok(control);

    map.paintWrites.length = 0;
    control.setFrameIndex(control.getFrameIndex());
    assert.equal(map.paintWrites.length, 0);
  });

  it("applies Layers-panel visibility to every native layer and pauses", () => {
    const map = fakeMap();
    plugin.activate(fakeApp(map));
    const control = getActiveTimelapseControl();
    assert.ok(control);
    control.play();
    assert.equal(control.isPlaying(), true);

    map.layoutWrites.length = 0;
    useAppStore.getState().updateLayer(STORE_LAYER_ID, { visible: false });

    const visibilityWrites = map.layoutWrites.filter(
      (write) => write.name === "visibility",
    );
    assert.equal(visibilityWrites.length, 10);
    assert.ok(visibilityWrites.every((write) => write.value === "none"));
    assert.equal(control.isPlaying(), false);

    map.layoutWrites.length = 0;
    useAppStore.getState().updateLayer(STORE_LAYER_ID, { visible: true });
    assert.equal(
      map.layoutWrites.filter(
        (write) => write.name === "visibility" && write.value === "visible",
      ).length,
      10,
    );
  });

  it("applies Layers-panel opacity to the active frame", () => {
    const map = fakeMap();
    plugin.activate(fakeApp(map));

    map.paintWrites.length = 0;
    useAppStore.getState().updateLayer(STORE_LAYER_ID, { opacity: 0.5 });

    const writes = map.paintWrites.filter(
      (write) => write.name === "raster-opacity",
    );
    assert.equal(writes.length, 1);
    assert.equal(writes[0].layerId, "timelapse-layer-s2cloudless-2016");
    assert.equal(writes[0].value, 0.5);
  });

  it("stops playback and drops the stack when the panel entry is deleted", () => {
    const map = fakeMap();
    plugin.activate(fakeApp(map));
    const control = getActiveTimelapseControl();
    assert.ok(control);
    control.play();

    useAppStore.getState().removeLayer(STORE_LAYER_ID);

    assert.equal(control.isPlaying(), false);
    assert.equal(map.layers.size, 0);
    assert.equal(map.sources.size, 0);

    // Interacting again (Play) re-creates the stack and the store layer.
    control.play();
    assert.equal(map.layers.size, 10);
    assert.ok(storeLayer());
    control.pause();
  });

  it("rolls back when the control cannot be added", () => {
    const map = fakeMap();
    const result = plugin.activate(
      fakeApp(map, { addControlSucceeds: false }),
    );
    assert.equal(result, false);
    assert.equal(getActiveTimelapseControl(), null);
    assert.equal(storeLayer(), undefined);
    assert.equal(map.sources.size, 0);
  });

  it("rebuilds the native stack after a basemap change", () => {
    const map = fakeMap();
    const app = fakeApp(map);
    plugin.activate(app);

    // A basemap style reload wipes the plugin's sources and layers.
    map.sources.clear();
    map.layers.clear();
    for (const callback of app.basemapCallbacks) callback();

    assert.equal(map.sources.size, 10);
    assert.equal(map.layers.size, 10);
  });

  it("deactivate removes the control, native stack, and store layer", () => {
    const map = fakeMap();
    const app = fakeApp(map);
    plugin.activate(app);
    const control = getActiveTimelapseControl();
    assert.ok(control);

    plugin.deactivate(app);

    assert.equal(getActiveTimelapseControl(), null);
    assert.equal(app.removed.length, 1);
    assert.equal(app.removed[0], control);
    assert.equal(map.layers.size, 0);
    assert.equal(map.sources.size, 0);
    assert.equal(storeLayer(), undefined);
  });

  it("persists year, speed, and loop through a JSON round-trip", () => {
    const map = fakeMap();
    const app = fakeApp(map);
    plugin.activate(app);
    const control = getActiveTimelapseControl();
    assert.ok(control);
    control.setFrameIndex(5); // 2021
    control.setSecondsPerYear(2);
    control.setLoop(false);

    const persisted = JSON.parse(
      JSON.stringify(plugin.getProjectState?.()),
    ) as unknown;
    plugin.deactivate(app);

    plugin.applyProjectState?.(app, persisted);
    plugin.activate(app);
    const restored = getActiveTimelapseControl();
    assert.ok(restored);
    const state = restored.getState();
    assert.equal(state.year, 2021);
    assert.equal(state.secondsPerYear, 2);
    assert.equal(state.loop, false);
    assert.equal(restored.getFrameIndex(), 5);
  });

  it("clamps a hand-edited project year into the provider range", () => {
    const map = fakeMap();
    const app = fakeApp(map);
    plugin.applyProjectState?.(app, {
      providerId: "eox-s2cloudless",
      year: 2099,
      secondsPerYear: 0.01,
      loop: "yes",
      playing: true,
    });
    plugin.activate(app);
    const control = getActiveTimelapseControl();
    assert.ok(control);
    const state = control.getState();
    assert.equal(state.year, 2025);
    assert.equal(state.secondsPerYear, 0.25);
    assert.equal(state.loop, true);
    assert.equal(control.isPlaying(), false);
  });
});
