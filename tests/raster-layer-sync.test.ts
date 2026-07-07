import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  DEFAULT_LAYER_STYLE,
  type GeoLibreLayer,
  useAppStore,
} from "@geolibre/core";
import type { RasterLayerInfo, RasterLayerState } from "maplibre-gl-raster";
import {
  createRasterStoreLayer,
  isRasterControlStoreLayer,
  removeRasterStoreLayers,
  runWithRasterStoreSyncSuspended,
  savedRasterState,
  syncRasterLayersToStore,
  syncRasterLayersToStoreWithOptions,
  unwireRasterStoreSync,
  wireRasterStoreSync,
  type RasterSyncableControl,
} from "../packages/plugins/src/plugins/raster-layer-sync";

function rasterState(patch: Partial<RasterLayerState> = {}): RasterLayerState {
  return {
    mode: "rgb",
    bands: [1, 2, 3],
    rescale: null,
    colormap: "gray",
    nodata: "auto",
    opacity: 1,
    gamma: 1,
    stretch: "linear",
    visible: true,
    ...patch,
  };
}

function rasterInfo(patch: Partial<RasterLayerInfo> = {}): RasterLayerInfo {
  return {
    id: "raster-1",
    name: "dem.tif",
    source: { kind: "url", url: "https://example.com/dem.tif" },
    bandCount: 3,
    bandNames: null,
    beforeId: null,
    bounds: null,
    loading: false,
    error: null,
    state: rasterState(),
    ...patch,
  };
}

/**
 * Recorder fake standing in for RasterControl in store->control tests.
 * getState is a static snapshot of options.collapsed: tests exercising
 * event-driven expand/collapse transitions need a stateful fake instead.
 */
function fakeControl(
  infos: RasterLayerInfo[] = [],
  options: { collapsed?: boolean } = {},
) {
  const calls: { method: string; args: unknown[] }[] = [];
  const control: RasterSyncableControl = {
    getState: () => ({ collapsed: options.collapsed ?? true }),
    getRasters: () => infos,
    removeRaster: (id) => calls.push({ method: "removeRaster", args: [id] }),
    setRasterState: (id, patch) =>
      calls.push({ method: "setRasterState", args: [id, patch] }),
    setVisible: (id, visible) =>
      calls.push({ method: "setVisible", args: [id, visible] }),
  };
  return { control, calls };
}

function otherStoreLayer(id = "unrelated"): GeoLibreLayer {
  return {
    id,
    name: "Unrelated",
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
  };
}

describe("createRasterStoreLayer", () => {
  it("mirrors a URL raster as an external custom cog layer", () => {
    const layer = createRasterStoreLayer(
      rasterInfo({
        bounds: { west: -10, south: -5, east: 10, north: 5 },
        state: rasterState({ opacity: 0.5, visible: false }),
      }),
    );

    assert.equal(layer.id, "raster-1");
    assert.equal(layer.name, "dem.tif");
    assert.equal(layer.type, "cog");
    assert.equal(layer.visible, false);
    assert.equal(layer.opacity, 0.5);
    assert.equal(layer.source.url, "https://example.com/dem.tif");
    assert.equal(layer.sourcePath, "https://example.com/dem.tif");
    assert.equal(layer.metadata.externalNativeLayer, true);
    assert.equal(layer.metadata.externalDeckLayer, true);
    assert.equal(layer.metadata.customLayerType, "raster");
    assert.equal(layer.metadata.identifiable, false);
    assert.equal(layer.metadata.panelCollapsed, true);
    assert.equal(layer.metadata.rasterOverlayMode, "interleaved");
    assert.equal(layer.metadata.sourceKind, "maplibre-gl-raster");
    assert.deepEqual(layer.metadata.nativeLayerIds, ["raster-1"]);
    // fitLayer falls back to metadata.bounds for zoom-to-layer.
    assert.deepEqual(layer.metadata.bounds, [-10, -5, 10, 5]);
    // A URL raster is fetchable directly, so no retained-bytes blob is set.
    assert.equal("localBytesUrl" in layer.metadata, false);
    assert.ok(isRasterControlStoreLayer(layer));
  });

  it("uses the file name for local files and omits bounds until known", () => {
    const layer = createRasterStoreLayer(
      rasterInfo({
        source: { kind: "file", fileName: "local.tif", objectUrl: "blob:x" },
      }),
    );

    assert.equal(layer.source.url, undefined);
    assert.equal(layer.sourcePath, "local.tif");
    assert.equal(layer.metadata.rasterSource, "file");
    assert.equal("bounds" in layer.metadata, false);
    // The control's retained-bytes blob URL is surfaced so in-browser tools
    // (the WASM Whitebox runner) can read a locally loaded raster back.
    assert.equal(layer.metadata.localBytesUrl, "blob:x");
  });

  it("persists the visualization state and surfaces load errors", () => {
    const layer = createRasterStoreLayer(
      rasterInfo({
        error: new Error("CORS blocked"),
        state: rasterState({
          mode: "single",
          bands: [2],
          rescale: [[0, 4000]],
          colormap: "viridis",
          nodata: 0,
          stretch: "sqrt",
        }),
      }),
    );

    assert.equal(layer.metadata.error, "CORS blocked");
    // visible and opacity live on the top-level layer fields, not here.
    assert.deepEqual(layer.metadata.rasterState, {
      mode: "single",
      bands: [2],
      rescale: [[0, 4000]],
      colormap: "viridis",
      nodata: 0,
      gamma: 1,
      stretch: "sqrt",
    });
  });

  it("persists the raster panel collapsed state", () => {
    const layer = createRasterStoreLayer(rasterInfo(), false);

    assert.equal(layer.metadata.panelCollapsed, false);
  });

  it("marks overlaid deck rasters without MapLibre native layer ids", () => {
    const layer = createRasterStoreLayer(rasterInfo(), true, {
      interleaved: false,
    });

    assert.equal(layer.metadata.externalDeckLayer, true);
    assert.equal(layer.metadata.rasterOverlayMode, "overlaid");
    assert.deepEqual(layer.metadata.nativeLayerIds, []);
  });

  it("persists band count and serializes band names to pairs", () => {
    const layer = createRasterStoreLayer(
      rasterInfo({
        bandCount: 2,
        bandNames: new Map([
          [1, "Red"],
          [2, "NIR"],
        ]),
      }),
    );

    assert.equal(layer.metadata.bandCount, 2);
    assert.deepEqual(layer.metadata.bandNames, [
      [1, "Red"],
      [2, "NIR"],
    ]);
  });

  it("stores a null band count and band names before the header loads", () => {
    const layer = createRasterStoreLayer(
      rasterInfo({ bandCount: null, bandNames: null }),
    );

    assert.equal(layer.metadata.bandCount, null);
    assert.equal(layer.metadata.bandNames, null);
  });
});

describe("syncRasterLayersToStore", () => {
  beforeEach(() => {
    useAppStore.setState({ layers: [] });
  });

  it("adds store layers for control rasters, leaving others alone", () => {
    useAppStore.getState().addLayer(otherStoreLayer());
    const { control } = fakeControl([
      rasterInfo(),
      rasterInfo({ id: "raster-2", name: "landcover.tif" }),
    ]);

    syncRasterLayersToStore(control);

    const layers = useAppStore.getState().layers;
    assert.equal(layers.length, 3);
    assert.ok(layers.some((layer) => layer.id === "raster-1"));
    assert.ok(layers.some((layer) => layer.id === "raster-2"));
    assert.ok(layers.some((layer) => layer.id === "unrelated"));
  });

  it("can sync non-interleaved rasters without native layer ids", () => {
    syncRasterLayersToStoreWithOptions(fakeControl([rasterInfo()]).control, {
      interleaved: false,
    });

    const layer = useAppStore.getState().layers[0];
    assert.equal(layer.metadata.rasterOverlayMode, "overlaid");
    assert.deepEqual(layer.metadata.nativeLayerIds, []);
  });

  it("removes store layers whose rasters are gone", () => {
    const { control } = fakeControl([rasterInfo()]);
    syncRasterLayersToStore(control);
    assert.equal(useAppStore.getState().layers.length, 1);

    syncRasterLayersToStore(fakeControl([]).control);
    assert.equal(useAppStore.getState().layers.length, 0);
  });

  it("refreshes changed fields but preserves panel renames", () => {
    const { control } = fakeControl([rasterInfo()]);
    syncRasterLayersToStore(control);
    useAppStore.getState().updateLayer("raster-1", { name: "My DEM" });

    syncRasterLayersToStore(
      fakeControl([
        rasterInfo({
          bounds: { west: 0, south: 0, east: 1, north: 1 },
          state: rasterState({ opacity: 0.4 }),
        }),
      ]).control,
    );

    const layer = useAppStore.getState().layers[0];
    assert.equal(layer.name, "My DEM");
    assert.equal(layer.opacity, 0.4);
    assert.deepEqual(layer.metadata.bounds, [0, 0, 1, 1]);
  });

  it("preserves GeoLibre-owned symbology across a control resync", () => {
    const { control } = fakeControl([rasterInfo()]);
    syncRasterLayersToStore(control);

    const symbology = {
      classified: true,
      ramp: "viridis",
      reversed: false,
      method: "equal-interval",
      classCount: 2,
      breaks: [0, 50, 100],
    };
    const layer = useAppStore.getState().layers[0];
    useAppStore.getState().updateLayer("raster-1", {
      metadata: { ...layer.metadata, rasterSymbology: symbology },
    });

    // A control event (e.g. bounds arriving) rebuilds the store layer's
    // metadata wholesale; the symbology must survive since it is not on the
    // control's RasterLayerInfo.
    syncRasterLayersToStore(
      fakeControl([
        rasterInfo({ bounds: { west: 0, south: 0, east: 1, north: 1 } }),
      ]).control,
    );

    assert.deepEqual(
      useAppStore.getState().layers[0].metadata.rasterSymbology,
      symbology,
    );
  });

  it("refreshes the saved panel collapsed state", () => {
    const { control } = fakeControl([rasterInfo()]);
    syncRasterLayersToStore(control);
    assert.equal(
      useAppStore.getState().layers[0].metadata.panelCollapsed,
      true,
    );

    syncRasterLayersToStore(
      fakeControl([rasterInfo()], { collapsed: false }).control,
    );

    assert.equal(
      useAppStore.getState().layers[0].metadata.panelCollapsed,
      false,
    );
  });

  it("flips panelCollapsed on store layers when an expand event syncs", () => {
    // Stateful stand-in for the production expand/collapse wiring: the
    // handler mirrors panelStateSyncHandler in maplibre-raster.ts, and
    // expand() flips the state before notifying, matching the verified
    // maplibre-gl-raster event ordering.
    let collapsed = true;
    const handlers: Array<() => void> = [];
    const control: RasterSyncableControl = {
      getState: () => ({ collapsed }),
      getRasters: () => [rasterInfo()],
      removeRaster: () => {},
      setRasterState: () => {},
      setVisible: () => {},
    };
    handlers.push(() => syncRasterLayersToStore(control));
    const expand = () => {
      collapsed = false;
      for (const handler of handlers) handler();
    };

    syncRasterLayersToStore(control);
    assert.equal(
      useAppStore.getState().layers[0].metadata.panelCollapsed,
      true,
    );

    expand();

    assert.equal(
      useAppStore.getState().layers[0].metadata.panelCollapsed,
      false,
    );
  });

  it("does not touch an existing layer when nothing changed", () => {
    const { control } = fakeControl([rasterInfo()]);
    syncRasterLayersToStore(control);
    const before = useAppStore.getState().layers[0];

    // A second sync with an identical snapshot builds fresh source/metadata
    // objects; the deep comparison must not report them as changed.
    syncRasterLayersToStore(fakeControl([rasterInfo()]).control);

    assert.equal(useAppStore.getState().layers[0], before);
  });

  it("does nothing while sync is suspended", () => {
    const { control } = fakeControl([rasterInfo()]);
    runWithRasterStoreSyncSuspended(() => {
      syncRasterLayersToStore(control);
    });
    assert.equal(useAppStore.getState().layers.length, 0);
  });
});

describe("wireRasterStoreSync", () => {
  beforeEach(() => {
    useAppStore.setState({ layers: [] });
  });

  afterEach(() => {
    unwireRasterStoreSync();
  });

  it("applies panel visibility and opacity changes through the control", () => {
    const { control, calls } = fakeControl([rasterInfo()]);
    syncRasterLayersToStore(control);
    wireRasterStoreSync(control);

    useAppStore.getState().updateLayer("raster-1", { visible: false });
    useAppStore.getState().updateLayer("raster-1", { opacity: 0.25 });

    assert.deepEqual(calls, [
      { method: "setVisible", args: ["raster-1", false] },
      { method: "setRasterState", args: ["raster-1", { opacity: 0.25 }] },
    ]);
  });

  it("drops the control raster when the panel removes the layer", () => {
    const { control, calls } = fakeControl([rasterInfo()]);
    syncRasterLayersToStore(control);
    wireRasterStoreSync(control);

    useAppStore.getState().removeLayer("raster-1");

    assert.deepEqual(calls, [
      { method: "removeRaster", args: ["raster-1"] },
    ]);
  });

  it("does not echo control-driven syncs back at the control", () => {
    const { control, calls } = fakeControl([rasterInfo()]);
    syncRasterLayersToStore(control);
    wireRasterStoreSync(control);

    // A raster removed in the control's own panel: the event-driven sync
    // removes the store layer, which must not bounce a removeRaster back.
    syncRasterLayersToStore(fakeControl([]).control);

    assert.equal(useAppStore.getState().layers.length, 0);
    assert.deepEqual(calls, []);
  });

  it("ignores store changes that touch no raster layers", () => {
    const { control, calls } = fakeControl([rasterInfo()]);
    syncRasterLayersToStore(control);
    wireRasterStoreSync(control);

    useAppStore.getState().addLayer(otherStoreLayer());
    useAppStore.getState().updateLayer("unrelated", { opacity: 0.5 });

    assert.deepEqual(calls, []);
  });

  it("pushes edited rasterState fields through setRasterState", () => {
    const { control, calls } = fakeControl([rasterInfo()]);
    syncRasterLayersToStore(control);
    wireRasterStoreSync(control);

    const layer = useAppStore.getState().layers[0];
    useAppStore.getState().updateLayer("raster-1", {
      metadata: {
        ...layer.metadata,
        rasterState: {
          ...(layer.metadata.rasterState as Record<string, unknown>),
          mode: "single",
          bands: [2],
          colormap: "viridis",
          rescale: [[0, 4000]],
          nodata: 0,
          stretch: "sqrt",
          gamma: 2,
        },
      },
    });

    assert.deepEqual(calls, [
      {
        method: "setRasterState",
        args: [
          "raster-1",
          {
            mode: "single",
            bands: [2],
            colormap: "viridis",
            rescale: [[0, 4000]],
            nodata: 0,
            stretch: "sqrt",
            gamma: 2,
          },
        ],
      },
    ]);
  });

  it("does not push rasterState when only the symbology metadata changes", () => {
    const { control, calls } = fakeControl([rasterInfo()]);
    syncRasterLayersToStore(control);
    wireRasterStoreSync(control);

    const layer = useAppStore.getState().layers[0];
    useAppStore.getState().updateLayer("raster-1", {
      metadata: {
        ...layer.metadata,
        rasterSymbology: {
          classified: true,
          ramp: "viridis",
          reversed: false,
          method: "equal-interval",
          classCount: 2,
          breaks: [0, 50, 100],
        },
      },
    });

    assert.deepEqual(calls, []);
  });
});

describe("removeRasterStoreLayers", () => {
  beforeEach(() => {
    useAppStore.setState({ layers: [] });
  });

  afterEach(() => {
    unwireRasterStoreSync();
  });

  it("prunes raster layers without echoing removals at the control", () => {
    const { control, calls } = fakeControl([rasterInfo()]);
    syncRasterLayersToStore(control);
    useAppStore.getState().addLayer(otherStoreLayer());
    wireRasterStoreSync(control);

    removeRasterStoreLayers();

    const layers = useAppStore.getState().layers;
    assert.equal(layers.length, 1);
    assert.equal(layers[0].id, "unrelated");
    assert.deepEqual(calls, []);
  });
});

describe("savedRasterState", () => {
  it("round-trips the state persisted by createRasterStoreLayer", () => {
    const state = rasterState({
      mode: "single",
      bands: [4],
      rescale: [[100, 2000]],
      colormap: "terrain",
      nodata: "off",
      gamma: 1.4,
      stretch: "log",
    });
    const layer = createRasterStoreLayer(rasterInfo({ state }));

    assert.deepEqual(savedRasterState(layer), {
      mode: "single",
      bands: [4],
      rescale: [[100, 2000]],
      colormap: "terrain",
      nodata: "off",
      gamma: 1.4,
      stretch: "log",
    });
  });

  it("round-trips the auto-rescale (null) state explicitly", () => {
    const layer = createRasterStoreLayer(
      rasterInfo({ state: rasterState({ rescale: null }) }),
    );

    assert.equal(savedRasterState(layer).rescale, null);
  });

  it("round-trips index mode and the preset id", () => {
    const state = rasterState({
      mode: "index",
      bands: [4, 3],
      index: "ndvi",
      colormap: "rdylgn",
      rescale: [[-1, 1]],
    });
    const layer = createRasterStoreLayer(rasterInfo({ state }));

    const saved = savedRasterState(layer);
    assert.equal(saved.mode, "index");
    assert.equal(saved.index, "ndvi");
    assert.deepEqual(saved.bands, [4, 3]);
    assert.equal(saved.colormap, "rdylgn");
  });

  it("drops malformed fields from hand-edited project files", () => {
    const layer = createRasterStoreLayer(rasterInfo());
    layer.metadata.rasterState = {
      mode: "sepia",
      bands: [0, -1],
      rescale: [],
      colormap: 42,
      nodata: "sometimes",
      gamma: 0,
      stretch: "cubic",
    };

    assert.deepEqual(savedRasterState(layer), {});
  });

  it("returns no overrides when the metadata is missing", () => {
    const layer = createRasterStoreLayer(rasterInfo());
    delete layer.metadata.rasterState;
    assert.deepEqual(savedRasterState(layer), {});
  });
});
