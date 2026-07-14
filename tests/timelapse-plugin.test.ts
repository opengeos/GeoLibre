import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { useAppStore } from "@geolibre/core";
import type { Map as MapLibreMap } from "maplibre-gl";
import {
  getActiveTimelapseControl,
  maplibreTimelapsePlugin as plugin,
  TIMELAPSE_PANEL_ID,
  TIMELAPSE_PLUGIN_ID,
  TIMELAPSE_SOURCE_KIND,
  timelapseStoreLayerId,
} from "../packages/plugins/src/plugins/maplibre-timelapse";
import {
  NASA_GIBS_WELD_PROVIDER_ID,
  registerTimelapseProvider,
} from "../packages/plugins/src/plugins/timelapse-providers";
import type {
  GeoLibreAppAPI,
  GeoLibreFloatingPanelRegistration,
} from "../packages/plugins/src/types";

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

function fakeApp(map: FakeMap): GeoLibreAppAPI & {
  registered: GeoLibreFloatingPanelRegistration[];
  opened: string[];
  unregistered: number;
  basemapCallbacks: Array<() => void>;
} {
  const registered: GeoLibreFloatingPanelRegistration[] = [];
  const opened: string[] = [];
  const basemapCallbacks: Array<() => void> = [];
  const self = {
    registered,
    opened,
    unregistered: 0,
    basemapCallbacks,
    getMap: () => map as unknown as MapLibreMap,
    registerFloatingPanel: (panel: GeoLibreFloatingPanelRegistration) => {
      registered.push(panel);
      return () => {
        self.unregistered += 1;
      };
    },
    openFloatingPanel: (id: string) => {
      opened.push(id);
      return true;
    },
    closeFloatingPanel: () => {},
    getActiveBasemap: () => "https://tiles.openfreemap.org/styles/liberty",
    onBasemapChange: (callback: () => void) => {
      basemapCallbacks.push(callback);
      return () => {};
    },
  };
  return self as unknown as GeoLibreAppAPI & typeof self;
}

const STORE_LAYER_ID = timelapseStoreLayerId("eox-s2cloudless");
const FRAME_COUNT = 8; // 2018–2025

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

    // Eight sources and eight raster layers (2018–2025), all visible.
    assert.equal(map.sources.size, FRAME_COUNT);
    assert.equal(map.layers.size, FRAME_COUNT);
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
    assert.equal(
      opacities.filter((value) => value === 0).length,
      FRAME_COUNT - 1,
    );

    // Every source uses the year-suffixed EOX layer identifier.
    const source2018 = map.sources.get(
      "timelapse-source-s2cloudless-2018",
    ) as { tiles: string[] };
    assert.ok(source2018.tiles[0].includes("/s2cloudless-2018_3857/"));

    // One tidy store layer mirrors the whole stack.
    const layer = storeLayer();
    assert.ok(layer, "store layer exists");
    assert.equal(layer.metadata.sourceKind, TIMELAPSE_SOURCE_KIND);
    assert.equal(layer.metadata.customLayerType, "timelapse-frames");
    assert.equal(layer.metadata.externalNativeLayer, true);
    assert.equal(
      (layer.metadata.nativeLayerIds as string[]).length,
      FRAME_COUNT,
    );
    assert.equal((layer.metadata.sourceIds as string[]).length, FRAME_COUNT);
    assert.equal(
      useAppStore
        .getState()
        .layers.filter(
          (item) => item.metadata.sourceKind === TIMELAPSE_SOURCE_KIND,
        ).length,
      1,
    );
  });

  it("registers and opens the floating panel", () => {
    const map = fakeMap();
    const app = fakeApp(map);
    plugin.activate(app);

    assert.equal(app.registered.length, 1);
    assert.equal(app.registered[0].id, TIMELAPSE_PANEL_ID);
    assert.ok(app.registered[0].title.length > 0);
    assert.equal(typeof app.registered[0].render, "function");
    assert.deepEqual(app.opened, [TIMELAPSE_PANEL_ID]);
  });

  it("re-registers the panel when its opening corner changes", () => {
    const map = fakeMap();
    const app = fakeApp(map);
    plugin.activate(app);

    plugin.setMapControlPosition?.(app, "top-right");

    assert.equal(plugin.getMapControlPosition?.(), "top-right");
    assert.equal(app.registered.length, 2);
    assert.equal(app.registered[1].position, "top-right");
    // The stack and store layer are untouched by a reposition.
    assert.equal(map.layers.size, FRAME_COUNT);
    assert.ok(storeLayer());
  });

  it("switchProvider rebuilds the stack and store layer for the new provider", async () => {
    const map = fakeMap();
    plugin.activate(fakeApp(map));
    const control = getActiveTimelapseControl();
    assert.ok(control);
    assert.equal(control.provider.id, "eox-s2cloudless");

    await control.switchProvider("nasa-gibs-landsat-weld");

    // The EOX stack is gone and the nine-year GIBS stack replaced it.
    assert.equal(control.provider.id, "nasa-gibs-landsat-weld");
    assert.equal(control.frames.length, 9);
    assert.equal(map.sources.size, 9);
    assert.equal(map.layers.size, 9);
    assert.ok(map.sources.has("timelapse-source-gibs-weld-1983"));
    assert.ok(!map.sources.has("timelapse-source-s2cloudless-2018"));
    const gibsSource = map.sources.get("timelapse-source-gibs-weld-1983") as {
      tiles: string[];
    };
    assert.ok(gibsSource.tiles[0].includes("/1983-12-01/"));

    // Exactly one mirroring store layer, now keyed to the GIBS provider, and
    // the switch resets playback to the oldest year (index 0 → 1983).
    const layers = useAppStore
      .getState()
      .layers.filter(
        (item) => item.metadata.sourceKind === TIMELAPSE_SOURCE_KIND,
      );
    assert.equal(layers.length, 1);
    assert.equal(
      layers[0].id,
      timelapseStoreLayerId(NASA_GIBS_WELD_PROVIDER_ID),
    );
    assert.equal(control.getFrameIndex(), 0);
    assert.equal(control.getState().year, 1983);
  });

  it("switchProvider is a no-op when the id resolves to the active provider", async () => {
    const map = fakeMap();
    plugin.activate(fakeApp(map));
    const control = getActiveTimelapseControl();
    assert.ok(control);

    await control.switchProvider("eox-s2cloudless");
    await control.switchProvider("no-such-provider");

    assert.equal(control.provider.id, "eox-s2cloudless");
    assert.equal(map.sources.size, FRAME_COUNT);
  });

  it("switchProvider ignores a superseded async resolution", async () => {
    const map = fakeMap();
    plugin.activate(fakeApp(map));
    const control = getActiveTimelapseControl();
    assert.ok(control);

    // A slow async provider whose frames we resolve by hand, and a fast one.
    let resolveSlow: (frames: unknown[]) => void = () => {};
    registerTimelapseProvider({
      id: "slow-a",
      name: "Slow A",
      attribution: "a",
      listFrames: () =>
        new Promise((resolve) => {
          resolveSlow = resolve as (frames: unknown[]) => void;
        }) as never,
    });
    registerTimelapseProvider({
      id: "fast-b",
      name: "Fast B",
      attribution: "b",
      listFrames: () => [
        {
          id: "b-2100",
          label: "2100",
          year: 2100,
          tileUrlTemplate: "https://example.test/b/{z}/{y}/{x}.png",
          attribution: "b",
        },
      ],
    });

    // Pick the slow provider (suspends), then the fast one (applies now).
    const slowSwitch = control.switchProvider("slow-a");
    await control.switchProvider("fast-b");
    assert.equal(control.provider.id, "fast-b");

    // The stale slow resolution lands last but must not clobber the newer pick.
    resolveSlow([
      {
        id: "a-1900",
        label: "1900",
        year: 1900,
        tileUrlTemplate: "https://example.test/a/{z}/{y}/{x}.png",
        attribution: "a",
      },
    ]);
    await slowSwitch;
    assert.equal(control.provider.id, "fast-b");
  });

  it("switchProvider bails if a recording starts while an async switch is pending", async () => {
    const map = fakeMap();
    plugin.activate(fakeApp(map));
    const control = getActiveTimelapseControl();
    assert.ok(control);

    let resolveSlow: (frames: unknown[]) => void = () => {};
    registerTimelapseProvider({
      id: "slow-rec",
      name: "Slow Rec",
      attribution: "s",
      listFrames: () =>
        new Promise((resolve) => {
          resolveSlow = resolve as (frames: unknown[]) => void;
        }) as never,
    });

    const pending = control.switchProvider("slow-rec");
    // A recording begins while the async listFrames() is still in flight.
    (control as unknown as { recording: boolean }).recording = true;
    resolveSlow([
      {
        id: "slow-2100",
        label: "2100",
        year: 2100,
        tileUrlTemplate: "https://example.test/s/{z}/{y}/{x}.png",
        attribution: "s",
      },
    ]);
    await pending;

    // The switch must not tear down the stack the recorder is drawing from.
    assert.equal(control.provider.id, "eox-s2cloudless");
    assert.equal(map.sources.size, FRAME_COUNT);
  });

  it("re-selecting the active provider cancels a pending async switch", async () => {
    const map = fakeMap();
    plugin.activate(fakeApp(map));
    const control = getActiveTimelapseControl();
    assert.ok(control);

    let resolveSlow: (frames: unknown[]) => void = () => {};
    registerTimelapseProvider({
      id: "slow-cancel",
      name: "Slow Cancel",
      attribution: "s",
      listFrames: () =>
        new Promise((resolve) => {
          resolveSlow = resolve as (frames: unknown[]) => void;
        }) as never,
    });

    const pending = control.switchProvider("slow-cancel");
    // Re-picking the still-active provider must cancel the pending switch.
    await control.switchProvider("eox-s2cloudless");
    resolveSlow([
      {
        id: "slow-2100",
        label: "2100",
        year: 2100,
        tileUrlTemplate: "https://example.test/s/{z}/{y}/{x}.png",
        attribution: "s",
      },
    ]);
    await pending;

    assert.equal(control.provider.id, "eox-s2cloudless");
    assert.equal(map.sources.size, FRAME_COUNT);
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
      layerId: "timelapse-layer-s2cloudless-2018",
      name: "raster-opacity",
      value: 0,
    });
    assert.deepEqual(opacityWrites[1], {
      layerId: "timelapse-layer-s2cloudless-2021",
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
    assert.equal(visibilityWrites.length, FRAME_COUNT);
    assert.ok(visibilityWrites.every((write) => write.value === "none"));
    assert.equal(control.isPlaying(), false);

    map.layoutWrites.length = 0;
    useAppStore.getState().updateLayer(STORE_LAYER_ID, { visible: true });
    assert.equal(
      map.layoutWrites.filter(
        (write) => write.name === "visibility" && write.value === "visible",
      ).length,
      FRAME_COUNT,
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
    assert.equal(writes[0].layerId, "timelapse-layer-s2cloudless-2018");
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
    assert.equal(map.layers.size, FRAME_COUNT);
    assert.ok(storeLayer());
    control.pause();
  });

  it("rebuilds the native stack after a basemap change", () => {
    const map = fakeMap();
    const app = fakeApp(map);
    plugin.activate(app);

    // A basemap style reload wipes the plugin's sources and layers.
    map.sources.clear();
    map.layers.clear();
    for (const callback of app.basemapCallbacks) callback();

    assert.equal(map.sources.size, FRAME_COUNT);
    assert.equal(map.layers.size, FRAME_COUNT);
  });

  it("deactivate removes the panel, native stack, and store layer", () => {
    const map = fakeMap();
    const app = fakeApp(map);
    plugin.activate(app);
    assert.ok(getActiveTimelapseControl());

    plugin.deactivate(app);

    assert.equal(getActiveTimelapseControl(), null);
    assert.equal(app.unregistered, 1);
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
    control.setFrameIndex(3); // 2021
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
    assert.equal(restored.getFrameIndex(), 3);
  });

  it("resets a live control to defaults when the project state is cleared", () => {
    const map = fakeMap();
    const app = fakeApp(map);
    plugin.activate(app);
    const control = getActiveTimelapseControl();
    assert.ok(control);
    control.setFrameIndex(3);
    control.setSecondsPerYear(2);
    control.setLoop(false);
    control.play();

    // A New Project reset applies a null/invalid state while still active.
    plugin.applyProjectState?.(app, null);

    assert.equal(control.isPlaying(), false);
    const state = control.getState();
    assert.equal(state.year, 2018);
    assert.equal(state.secondsPerYear, 1);
    assert.equal(state.loop, true);
    // The next save reports the defaults, not the previous project's state.
    assert.deepEqual(plugin.getProjectState?.(), state);
  });

  it("does not wire up an async provider that resolves after deactivate", async () => {
    let release: (() => void) | null = null;
    registerTimelapseProvider({
      id: "slow-async",
      name: "Slow Async",
      attribution: "test",
      listFrames: () =>
        new Promise((resolve) => {
          release = () =>
            resolve([
              {
                id: "slow-2020",
                label: "2020",
                year: 2020,
                tileUrlTemplate: "https://example.com/{z}/{x}/{y}.png",
                attribution: "test",
              },
            ]);
        }),
    });
    const map = fakeMap();
    const app = fakeApp(map);
    // Select the async provider via a saved state, then activate + deactivate
    // before its catalog resolves.
    plugin.applyProjectState?.(app, { providerId: "slow-async", year: 2020 });
    const activation = plugin.activate(app);
    plugin.deactivate(app);
    release?.();
    assert.equal(await activation, false);
    assert.equal(getActiveTimelapseControl(), null);
    assert.equal(map.sources.size, 0);
    assert.equal(storeLayer(), undefined);
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
