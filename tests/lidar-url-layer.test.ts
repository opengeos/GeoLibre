import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { useAppStore } from "@geolibre/core";
import {
  __setComponentsModuleLoaderForTests,
  addLidarLayerFromUrl,
  closeMaplibreComponentControls,
  LIDAR_SOURCE_KIND,
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
// When false the stub resolves without emitting `load`, as an upstream change
// to the event timing would.
let emitLoad = true;
let counter = 0;

class LidarControlStub {
  _options: { autoZoom: boolean };
  private handlers = new Map<string, Set<(event: unknown) => void>>();
  private pointClouds: { id: string }[] = [];

  constructor(options: { autoZoom?: boolean }) {
    this._options = { ...options, autoZoom: options.autoZoom ?? true };
  }

  on(event: string, handler: (event: unknown) => void) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
  }

  off(event: string, handler: (event: unknown) => void) {
    this.handlers.get(event)?.delete(handler);
  }

  async loadPointCloud(url: string) {
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
      source: url,
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

  collapse() {}
  expand() {}
  setState() {}
  onRemove() {}
}

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
  emitLoad = true;
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
