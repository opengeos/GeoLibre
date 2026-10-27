import { useAppStore, waitFor } from "./helpers/dom";
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import type { GeoLibreLayer } from "@geolibre/core";
import type {
  RasterControl,
  RasterLayerInfo,
  RasterLayerState,
  RenderEngine,
} from "maplibre-gl-raster";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";

// Load after the DOM harness installs Vite's asset/import.meta hooks.
const { DEFAULT_LAYER_STYLE } = await import("@geolibre/core");
const {
  closeRasterLayerPanel,
  openRasterLayerPanel,
  restoreRasterLayers,
  setLocalRasterFileReader,
} = await import("../packages/plugins/src/plugins/maplibre-raster");

const localPath = "C:\\projects\\COG\\Foerster17_26.tif";
const assetUrl = "http://asset.localhost/C%3A%5Cprojects%5CCOG%5CFoerster17_26.tif";

function savedLocalRaster(): GeoLibreLayer {
  return {
    id: "saved-local-raster",
    name: "Foerster17_26.tif",
    type: "cog",
    source: { type: "raster" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {
      sourceKind: "maplibre-gl-raster",
      externalNativeLayer: true,
      rasterSource: "file",
      localFilePath: localPath,
      panelCollapsed: true,
    },
  };
}

type ManagerEvent = { type: string; layerId?: string };

/**
 * Keep the real RasterControl and its event forwarding, replacing only the
 * GPU/GeoTIFF manager. Upstream emits an unscoped rasterchange both when an
 * engine changes and when the lazily initialized WASM engine calls onReady,
 * even if there are no rasters yet (maplibre-gl-raster 0.14.15).
 */
class TestLayerManager {
  engine: RenderEngine = "cog-tiler-wasm";
  engineChanges: RenderEngine[] = [];
  layers: RasterLayerInfo[] = [];
  // warmTauriWasmEngine need not wait for a GPU in this test.
  _device = {};
  private handlers = new Map<string, ((event: ManagerEvent) => void)[]>();

  on(type: string, handler: (event: ManagerEvent) => void): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]);
  }

  emit(event: ManagerEvent): void {
    for (const handler of this.handlers.get(event.type) ?? []) handler(event);
  }

  setEngine(engine: RenderEngine): void {
    if (this.engine === engine) return;
    this.engine = engine;
    this.engineChanges.push(engine);
    this.emit({ type: "rasterchange" });
  }

  getLayers(): RasterLayerInfo[] {
    return this.layers;
  }

  getLayer(id: string): RasterLayerInfo | undefined {
    return this.layers.find((layer) => layer.id === id);
  }

  async addRaster(source: File | string, options: Parameters<RasterControl["addRaster"]>[1]) {
    assert.equal(typeof source, "string", "the desktop reader returns an asset URL");
    assert.ok(options?.id);
    this.layers.push({
      id: options.id,
      name: options.name ?? "raster.tif",
      source: { kind: "url", url: source as string },
      memberUrls: null,
      attribution: null,
      bandCount: 3,
      bandNames: null,
      beforeId: null,
      bounds: null,
      loading: false,
      error: null,
      state: {
        mode: "rgb",
        bands: [1, 2, 3],
        rescale: null,
        colormap: "gray",
        reversed: false,
        nodata: "auto",
        opacity: 1,
        gamma: 1,
        stretch: "linear",
        visible: true,
        ...options.state,
      },
    });
    this.emit({ type: "rasteradd", layerId: options.id });
    return options.id;
  }

  removeRaster(id: string): void {
    this.layers = this.layers.filter((layer) => layer.id !== id);
    this.emit({ type: "rasterremove", layerId: id });
  }

  setState(id: string, patch: Partial<RasterLayerState>): void {
    const layer = this.getLayer(id);
    if (!layer) return;
    layer.state = { ...layer.state, ...patch };
    this.emit({ type: "rasterchange", layerId: id });
  }

  setVisible(id: string, visible: boolean): void {
    this.setState(id, { visible });
  }

  // Classification installs its render hook, but these tests never draw tiles.
  _renderTileFor() {
    return () => ({});
  }

  destroy(): void {
    this.handlers.clear();
  }
}

function makeApp() {
  const manager = new TestLayerManager();
  let control: RasterControl | undefined;
  const app = {
    addMapControl(added: RasterControl) {
      control = added;
      const internals = added as unknown as {
        _layerManager: TestLayerManager;
        _forwardLayerManagerEvents(manager: TestLayerManager): void;
      };
      internals._layerManager = manager;
      internals._forwardLayerManagerEvents(manager);
      return true;
    },
    removeMapControl(removed: RasterControl) {
      removed.onRemove();
    },
  } as unknown as GeoLibreAppAPI;
  return {
    app,
    manager,
    get control() {
      return control;
    },
  };
}

let activeApp: GeoLibreAppAPI | undefined;
afterEach(() => {
  if (activeApp) closeRasterLayerPanel(activeApp);
  activeApp = undefined;
  setLocalRasterFileReader(null);
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

function desktopApp() {
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  const harness = makeApp();
  activeApp = harness.app;
  return harness;
}

const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function mountedEmptyControl() {
  const harness = desktopApp();
  openRasterLayerPanel(harness.app);
  await waitFor(() => assert.equal(harness.manager.engineChanges.length, 2));
  // Let ensureRasterControl and the deferred panel expansion finish.
  await nextTask();
  await nextTask();
  assert.ok(harness.control);
  return harness;
}

it("restores a saved local raster on the first desktop control mount despite warm-up changes", async () => {
  const harness = desktopApp();
  const { app, manager } = harness;
  const layer = savedLocalRaster();
  useAppStore.setState({ layers: [layer] });
  const paths: string[] = [];
  setLocalRasterFileReader(async (path) => {
    paths.push(path);
    return assetUrl;
  });

  restoreRasterLayers(app);
  await waitFor(() => assert.ok(harness.control?.getRaster(layer.id)));

  assert.deepEqual(manager.engineChanges, ["maplibre-gl-raster", "cog-tiler-wasm"]);
  assert.deepEqual(
    paths,
    [localPath],
    "warm-up must preserve the saved layer until its path is read",
  );
  assert.equal(harness.control?.getRaster(layer.id)?.source.kind, "url");
  assert.equal(useAppStore.getState().layers[0]?.metadata.localFilePath, localPath);
});

it("preserves saved rasters when WASM onReady fires while the desktop reader is pending", async () => {
  // Mount before opening a project to isolate the asynchronous ready event
  // from the two synchronous engine-change events covered above.
  const harness = await mountedEmptyControl();
  const layer = savedLocalRaster();
  useAppStore.setState({ layers: [layer] });
  let reads = 0;
  let finishRead!: (url: string) => void;
  const pendingRead = new Promise<string>((resolve) => {
    finishRead = resolve;
  });
  setLocalRasterFileReader((path) => {
    assert.equal(path, localPath);
    reads++;
    return pendingRead;
  });

  restoreRasterLayers(harness.app);
  await waitFor(() => assert.equal(reads, 1));
  try {
    assert.equal(harness.control?.getRasters().length, 0);
    harness.manager.emit({ type: "rasterchange" }); // CogTilerEngine.onReady
    assert.deepEqual(
      useAppStore.getState().layers.map(({ id }) => id),
      [layer.id],
    );
  } finally {
    finishRead(assetUrl);
    await waitFor(() => assert.ok(harness.control?.getRaster(layer.id)));
  }
  assert.equal(harness.control?.getRaster(layer.id)?.source.kind, "url");
  assert.equal(useAppStore.getState().layers[0]?.metadata.localFilePath, localPath);
});

it("preserves saved rasters when the panel opens while the desktop reader is pending", async () => {
  const harness = await mountedEmptyControl();
  const layer = savedLocalRaster();
  useAppStore.setState({ layers: [layer] });
  let reads = 0;
  let finishRead!: (url: string) => void;
  const pendingRead = new Promise<string>((resolve) => {
    finishRead = resolve;
  });
  setLocalRasterFileReader(() => {
    reads++;
    return pendingRead;
  });

  restoreRasterLayers(harness.app);
  await waitFor(() => assert.equal(reads, 1));
  try {
    // The harness never mounts the panel DOM, so expand() skips its event;
    // emit the one a user opening the mounted panel fires.
    (harness.control as unknown as { _emit(event: string): void })._emit("expand");
    assert.deepEqual(
      useAppStore.getState().layers.map(({ id }) => id),
      [layer.id],
    );
  } finally {
    finishRead(assetUrl);
    await waitFor(() => assert.ok(harness.control?.getRaster(layer.id)));
  }
  assert.equal(useAppStore.getState().layers[0]?.metadata.localFilePath, localPath);
});

it("still syncs populated rasterchange and removes the last raster after restore", async () => {
  const harness = await mountedEmptyControl();
  const layer = savedLocalRaster();
  useAppStore.setState({ layers: [layer] });
  setLocalRasterFileReader(async () => assetUrl);
  restoreRasterLayers(harness.app);
  await waitFor(() => assert.ok(harness.control?.getRaster(layer.id)));
  await nextTask();

  harness.control?.setRasterState(layer.id, { opacity: 0.4 });
  assert.equal(useAppStore.getState().layers[0]?.opacity, 0.4);
  harness.control?.removeRaster(layer.id);
  assert.deepEqual(useAppStore.getState().layers, []);
});
