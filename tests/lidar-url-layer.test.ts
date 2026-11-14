import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { useAppStore } from "@geolibre/core";
import {
  __setComponentsModuleLoaderForTests,
  addLidarLayerFromBytes,
  addLidarLayerFromUrl,
  closeMaplibreComponentControls,
  LIDAR_SOURCE_KIND,
  restoreLidarLayers,
  type ComponentsModules,
} from "../packages/plugins/src/plugins/maplibre-components.ts";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";

// `addLidarLayerFromUrl` backs the `?data=` LiDAR deep link. It relies on
// maplibre-gl-lidar emitting `load` (which adds the store layer) before
// `loadPointCloud` resolves, and on the control's private `_options.autoZoom`
// to keep a batch from flying to each cloud. These tests drive the real code
// path with a stand-in for the LiDAR control that honours both.

interface LoadCall {
  url: string;
  autoZoom: boolean;
}

const loadCalls: LoadCall[] = [];
// Options each control was constructed with, newest last.
const constructorOptions: Record<string, unknown>[] = [];
// When false the stub resolves without emitting `load`, as an upstream change
// to the event timing would.
let emitLoad = true;
let counter = 0;

class LidarControlStub {
  _options: { autoZoom: boolean };
  private handlers = new Map<string, Set<(event: unknown) => void>>();
  private pointClouds: { id: string }[] = [];

  constructor(options: { autoZoom?: boolean }) {
    constructorOptions.push({ ...options });
    this._options = { ...options, autoZoom: options.autoZoom ?? true };
    lastControl = this;
  }

  on(event: string, handler: (event: unknown) => void) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
  }

  off(event: string, handler: (event: unknown) => void) {
    this.handlers.get(event)?.delete(handler);
  }

  async loadPointCloud(source: string | File) {
    // maplibre-gl-lidar reports a File's source only as "file".
    const url = typeof source === "string" ? source : source.name;
    loadCalls.push({ url, autoZoom: this._options.autoZoom });
    counter += 1;
    const info = {
      id: `pc-${counter}`,
      name: url.split("/").pop() ?? "cloud",
      pointCount: 10,
      bounds: { minX: -123.08, minY: 44.05, maxX: -123.06, maxY: 44.06, minZ: 0, maxZ: 1 },
      hasRGB: false,
      hasIntensity: true,
      hasClassification: true,
      source: typeof source === "string" ? source : "file",
    };
    this.pointClouds.push({ id: info.id });
    if (emitLoad) {
      for (const handler of this.handlers.get("load") ?? []) handler({ pointCloud: info });
    }
    return info;
  }

  getPointClouds() {
    return this.pointClouds;
  }

  getContainer() {
    return null;
  }

  getDeckOverlay() {
    return undefined;
  }

  // Panel display state, mutated through the same setters the real control
  // exposes, so a test can change Color By and check what opening a project
  // puts back.
  state = {
    pointSize: 2,
    colorScheme: "elevation" as unknown,
    colormap: "viridis",
    colorRange: { mode: "percentile", percentileLow: 2, percentileHigh: 98 } as unknown,
    usePercentile: true,
    pickable: false,
    elevationRange: null as [number, number] | null,
    hiddenClassifications: new Set<number>(),
  };

  getState() {
    return { ...this.state };
  }

  setPointSize(size: number) {
    this.state.pointSize = size;
  }

  setColorScheme(scheme: unknown) {
    this.state.colorScheme = scheme;
  }

  setColormap(colormap: string) {
    this.state.colormap = colormap;
  }

  setColorRange(range: unknown) {
    this.state.colorRange = range;
  }

  setUsePercentile(usePercentile: boolean) {
    this.state.usePercentile = usePercentile;
  }

  setElevationRange(min: number, max: number) {
    this.state.elevationRange = [min, max];
  }

  clearElevationRange() {
    this.state.elevationRange = null;
  }

  setClassificationVisibility(code: number, visible: boolean) {
    if (visible) this.state.hiddenClassifications.delete(code);
    else this.state.hiddenClassifications.add(code);
  }

  showAllClassifications() {
    this.state.hiddenClassifications.clear();
  }

  setPickable(pickable: boolean) {
    this.state.pickable = pickable;
  }

  collapse() {}
  expand() {}
  setState() {}
  onRemove() {}
}

let lastControl: LidarControlStub | null = null;

class LidarLayerAdapterStub {
  destroy() {}
  removeLayer() {}
  setVisibility() {}
  setOpacity() {}
}

const fakeComponentsModule = {
  LidarControl: LidarControlStub,
  LidarLayerAdapter: LidarLayerAdapterStub,
} as unknown as NonNullable<ComponentsModules[0]>;

const app = {
  addMapControl: () => true,
  removeMapControl: () => {},
  getMap: () => null,
  translate: (_key: string, defaultValue: string) => defaultValue,
} as unknown as GeoLibreAppAPI;

function installStubModule(): void {
  __setComponentsModuleLoaderForTests(
    (): Promise<ComponentsModules> => Promise.resolve([fakeComponentsModule, null]),
  );
}

afterEach(() => {
  closeMaplibreComponentControls(app);
  __setComponentsModuleLoaderForTests(null);
  useAppStore.setState({ layers: [] });
  loadCalls.length = 0;
  constructorOptions.length = 0;
  emitLoad = true;
});

describe("LiDAR control options", () => {
  it("never restores its own share state from the web address", async () => {
    // GeoLibre keeps `lat`/`lon`/`zoom` in the address. maplibre-gl-lidar's
    // default `restoreFromUrl` reads those as a flat share link with pitch 0,
    // bearing 0 and terrain off, which flattened a reopened 3D project.
    installStubModule();
    await addLidarLayerFromUrl(app, "https://example.com/a.copc.laz");

    assert.equal(constructorOptions.length, 1);
    assert.equal(constructorOptions[0]!.restoreFromUrl, false);
    assert.equal(constructorOptions[0]!.shareUrl, false);
  });
});

describe("restoreLidarLayers", () => {
  function addSavedLidarLayer(id: string, url: string): void {
    useAppStore.getState().addLayer({
      id,
      name: "saved.copc.laz",
      type: "lidar",
      source: { type: "lidar", sourceId: id, url },
      visible: true,
      opacity: 1,
      style: {},
      metadata: { externalNativeLayer: true, sourceKind: LIDAR_SOURCE_KIND, identifiable: false },
      sourcePath: url,
    } as never);
  }

  it("keeps the saved camera when reopening a project", async () => {
    // Flying to the cloud on reopen threw away the project's saved view
    // (fitBounds resets the bearing and moves the zoom).
    installStubModule();
    const url = "https://example.com/saved.copc.laz";
    addSavedLidarLayer("saved-lidar", url);
    await restoreLidarLayers(app, { keepCamera: true });

    assert.deepEqual(loadCalls, [{ url, autoZoom: false }]);
    // Auto-zoom comes back on for layers the user adds afterwards.
    await addLidarLayerFromUrl(app, "https://example.com/new.copc.laz");
    assert.equal(loadCalls[1]!.autoZoom, true);
  });

  it("resets Color By and picking when another project opens", async () => {
    // Color By and picking belong to the one shared control and are not saved
    // with a project, so they leaked into the next one: its restored cloud
    // drew by Classification and the old cloud's Point Info card stayed up.
    installStubModule();
    await addLidarLayerFromUrl(app, "https://example.com/a.copc.laz");
    const control = lastControl!;
    control.setColorScheme("classification");
    control.setColormap("plasma");
    control.setPointSize(5);
    control.setElevationRange(10, 20);
    control.setClassificationVisibility(2, false);
    control.setPickable(true);

    // An unrelated store change leaves the user's choices alone.
    useAppStore.getState().setProjectName("Renamed");
    assert.equal(control.state.colorScheme, "classification");
    // Nor does a collaboration session's bare generation bump, which re-runs
    // plugin restore after a peer snapshot without opening a project.
    useAppStore.setState((s) => ({ projectGeneration: s.projectGeneration + 1 }));
    assert.equal(control.state.colorScheme, "classification");
    assert.equal(control.state.pickable, true);

    useAppStore.getState().newProject();

    assert.equal(control.state.colorScheme, "elevation");
    assert.equal(control.state.colormap, "viridis");
    assert.equal(control.state.pointSize, 2);
    assert.equal(control.state.elevationRange, null);
    assert.equal(control.state.hiddenClassifications.size, 0);
    assert.equal(control.state.pickable, false);
  });

  it("does not mount the control for a project without LiDAR", async () => {
    installStubModule();
    await restoreLidarLayers(app, { keepCamera: true });
    assert.equal(constructorOptions.length, 0);
  });
});

describe("addLidarLayerFromUrl", () => {
  it("returns the id of the store layer the control's load event added", async () => {
    installStubModule();
    const url = "https://example.com/autzen.copc.laz?token=abc";
    const id = await addLidarLayerFromUrl(app, url);

    const layer = useAppStore.getState().layers.find((item) => item.id === id);
    assert.ok(layer, "the returned id names a store layer");
    assert.equal(layer.type, "lidar");
    assert.equal(layer.metadata.sourceKind, LIDAR_SOURCE_KIND);
    assert.equal(layer.sourcePath, url, "the token stays on the recorded source");
    assert.deepEqual(loadCalls, [{ url, autoZoom: true }]);
  });

  it("keeps the camera still for a batch and restores auto-zoom afterwards", async () => {
    installStubModule();
    await addLidarLayerFromUrl(app, "https://example.com/a.copc.laz", { fit: false });
    await addLidarLayerFromUrl(app, "https://example.com/b.copc.laz");

    assert.deepEqual(
      loadCalls.map((call) => call.autoZoom),
      [false, true],
    );
  });

  it("rejects a non-web URL before mounting the control", async () => {
    installStubModule();
    for (const url of ["file:///tmp/cloud.laz", "not a url"]) {
      await assert.rejects(addLidarLayerFromUrl(app, url), /valid HTTP or HTTPS LiDAR URL/);
    }
    assert.equal(loadCalls.length, 0);
  });

  it("fails loudly when the control resolves without adding a store layer", async () => {
    installStubModule();
    emitLoad = false;
    await assert.rejects(
      addLidarLayerFromUrl(app, "https://example.com/a.copc.laz"),
      /did not create a layer/,
    );
  });
});

describe("addLidarLayerFromBytes", () => {
  it("loads a tool output under its display name and keeps its bytes", async () => {
    installStubModule();
    const bytes = new Uint8Array([0x4c, 0x41, 0x53, 0x46, 1, 2, 3]);
    const id = await addLidarLayerFromBytes(app, bytes, {
      name: "LiDAR Grid Thin Output",
      fileName: "lidar_grid_thin_output.copc.laz",
    });

    const layer = useAppStore.getState().layers.find((item) => item.id === id);
    assert.ok(layer, "the returned id names a store layer");
    assert.equal(layer.name, "LiDAR Grid Thin Output");
    assert.equal(layer.metadata.sourceKind, LIDAR_SOURCE_KIND);
    // The loader sees the file name, whose extension picks streaming for COPC.
    assert.deepEqual(loadCalls, [{ url: "lidar_grid_thin_output.copc.laz", autoZoom: true }]);
    const localBytesUrl = layer.metadata.localBytesUrl;
    assert.ok(typeof localBytesUrl === "string" && localBytesUrl.startsWith("blob:"));
    const retained = new Uint8Array(await (await fetch(localBytesUrl)).arrayBuffer());
    assert.deepEqual(retained, bytes, "the blob URL serves the loaded bytes");
  });

  it("keeps the retained bytes after removal, so an undone removal can still export", async () => {
    installStubModule();
    const id = await addLidarLayerFromBytes(app, new Uint8Array([0x4c, 0x41, 0x53, 0x46]), {
      name: "Output",
      fileName: "output.las",
    });
    const url = useAppStore.getState().layers.find((item) => item.id === id)?.metadata
      .localBytesUrl as string;
    assert.ok((await fetch(url)).ok, "readable while the layer exists");
    useAppStore.getState().removeLayer(id!);
    assert.ok((await fetch(url)).ok, "still readable after the layer is removed");
  });

  it("keeps the camera still when asked", async () => {
    installStubModule();
    await addLidarLayerFromBytes(app, new Uint8Array([0x4c, 0x41, 0x53, 0x46]), {
      name: "Output",
      fileName: "output.las",
      fit: false,
    });
    assert.deepEqual(
      loadCalls.map((call) => call.autoZoom),
      [false],
    );
  });
});
