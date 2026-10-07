/// <reference path="../packages/plugins/src/maplibre-gl-usgs-lidar.d.ts" />
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { type GeoLibreLayer, useAppStore } from "@geolibre/core";
import type {
  LoadedItemInfo,
  UsgsLidarControl,
  UsgsLidarLayerAdapter,
} from "maplibre-gl-usgs-lidar";
import { layerPath } from "../apps/geolibre-desktop/src/lib/whitebox-layer-inputs";
import { isMapboxPluginLayer } from "../packages/map/src/mapbox-layers";
import {
  USGS_LIDAR_SOURCE_KIND,
  bindUsgsLidarLayerSync,
  usgsLidarLayerId,
} from "../packages/plugins/src/plugins/usgs-lidar-layer-sync";

// The USGS LiDAR plugin streams COPC/EPT point clouds through its own internal
// LidarControl, which never touched the store, so loaded clouds were missing
// from the Layers panel. These drive the sync against a fake control and
// adapter that mirror the upstream event contract (`add`/`remove` keyed by
// item id, per-item visibility and opacity).

function pointCloud(id: string, name: string): LoadedItemInfo {
  return {
    id,
    name,
    pointCount: 1234,
    bounds: { minX: -122.5, minY: 37.7, maxX: -122.4, maxY: 37.8, minZ: 0, maxZ: 100 },
    hasRGB: false,
    hasIntensity: true,
    hasClassification: true,
    source: "https://example.com/tile.copc.laz?sig=abc",
  } as LoadedItemInfo;
}

function fakeUsgs() {
  const loadedItems = new Map<string, LoadedItemInfo>();
  const callbacks = new Set<(event: "add" | "remove", itemId: string) => void>();
  const visibility: Array<[string, boolean]> = [];
  const opacity: Array<[string, number]> = [];
  let destroyed = false;
  const emit = (event: "add" | "remove", itemId: string) => {
    for (const callback of [...callbacks]) callback(event, itemId);
  };
  const control = {
    getState: () => ({ loadedItems }),
    unloadItem: (itemId: string) => {
      if (!loadedItems.delete(itemId)) return;
      emit("remove", itemId);
    },
  } as unknown as UsgsLidarControl;
  const adapter = {
    getLayerIds: () => [...loadedItems.keys()],
    setVisibility: (itemId: string, visible: boolean) => visibility.push([itemId, visible]),
    setOpacity: (itemId: string, value: number) => opacity.push([itemId, value]),
    onLayerChange: (callback: (event: "add" | "remove", itemId: string) => void) => {
      callbacks.add(callback);
      return () => callbacks.delete(callback);
    },
    destroy: () => {
      destroyed = true;
    },
  } as unknown as UsgsLidarLayerAdapter;
  return {
    control,
    adapter,
    visibility,
    opacity,
    isDestroyed: () => destroyed,
    listenerCount: () => callbacks.size,
    /** Simulate the panel loading an item: state first, then the event. */
    load(itemId: string, info: LoadedItemInfo) {
      loadedItems.set(itemId, info);
      emit("add", itemId);
    },
    has: (itemId: string) => loadedItems.has(itemId),
  };
}

function storeLayer(id: string): GeoLibreLayer | undefined {
  return useAppStore.getState().layers.find((layer) => layer.id === id);
}

describe("USGS LiDAR layer sync", () => {
  beforeEach(() => useAppStore.setState({ layers: [] }));
  afterEach(() => useAppStore.setState({ layers: [] }));

  it("adds a Layers panel row when the panel loads a point cloud", () => {
    const usgs = fakeUsgs();
    const stop = bindUsgsLidarLayerSync(usgs.control, usgs.adapter);
    usgs.load("USGS_LPC_CA_tile1", pointCloud("pc-1", "CA tile 1"));

    const layer = storeLayer(usgsLidarLayerId("USGS_LPC_CA_tile1"));
    assert.ok(layer, "the loaded cloud is listed");
    assert.equal(layer.name, "CA tile 1");
    assert.equal(layer.type, "lidar");
    assert.deepEqual(layer.source.bounds, [-122.5, 37.7, -122.4, 37.8]);
    assert.equal(layer.metadata.sourceKind, USGS_LIDAR_SOURCE_KIND);
    assert.equal(layer.metadata.externalNativeLayer, true);
    // Never saved: the control is gone once the panel closes and the signed
    // COPC URL expires.
    assert.equal(layer.metadata.sessionOnly, true);
    // The streamed URL is kept for the session so Whitebox can fetch the
    // cloud as a tool input; `sessionOnly` keeps it out of saved projects.
    assert.equal(layer.source.url, "https://example.com/tile.copc.laz?sig=abc");
    // The id avoids the prefixes layer lists hide as internal helpers.
    assert.doesNotMatch(layer.id, /^(usgs-)?lidar-/);
    stop();
  });

  it("adds rows for clouds loaded before the sync started", () => {
    const usgs = fakeUsgs();
    usgs.load("early", pointCloud("pc-early", "Early"));
    const stop = bindUsgsLidarLayerSync(usgs.control, usgs.adapter);
    assert.ok(storeLayer(usgsLidarLayerId("early")), "the already-loaded cloud is listed");
    stop();
  });

  it("removes the row when the panel unloads the cloud", () => {
    const usgs = fakeUsgs();
    const stop = bindUsgsLidarLayerSync(usgs.control, usgs.adapter);
    usgs.load("item-a", pointCloud("pc-a", "A"));
    usgs.control.unloadItem("item-a");
    assert.equal(storeLayer(usgsLidarLayerId("item-a")), undefined);
    stop();
  });

  it("forwards visibility and opacity changes from the Layers panel", () => {
    const usgs = fakeUsgs();
    const stop = bindUsgsLidarLayerSync(usgs.control, usgs.adapter);
    usgs.load("item-a", pointCloud("pc-a", "A"));
    const id = usgsLidarLayerId("item-a");

    useAppStore.getState().updateLayer(id, { visible: false });
    useAppStore.getState().updateLayer(id, { opacity: 0.4 });

    assert.deepEqual(usgs.visibility, [["item-a", false]]);
    assert.deepEqual(usgs.opacity, [["item-a", 0.4]]);
    stop();
  });

  it("unloads the cloud when its row is removed from the Layers panel", () => {
    const usgs = fakeUsgs();
    const stop = bindUsgsLidarLayerSync(usgs.control, usgs.adapter);
    usgs.load("item-a", pointCloud("pc-a", "A"));

    useAppStore.getState().removeLayer(usgsLidarLayerId("item-a"));

    assert.equal(usgs.has("item-a"), false, "the cloud is unloaded");
    stop();
  });

  it("drops a row that comes back without its cloud", () => {
    const usgs = fakeUsgs();
    const stop = bindUsgsLidarLayerSync(usgs.control, usgs.adapter);
    usgs.load("item-a", pointCloud("pc-a", "A"));
    const row = storeLayer(usgsLidarLayerId("item-a"));
    assert.ok(row);
    useAppStore.getState().removeLayer(row.id);

    // Undo puts the row back, but the removal already unloaded the cloud.
    useAppStore.setState({ layers: [row] });

    assert.equal(storeLayer(row.id), undefined);
    stop();
  });

  it("removes every row and stops listening when disposed", () => {
    const usgs = fakeUsgs();
    const stop = bindUsgsLidarLayerSync(usgs.control, usgs.adapter);
    usgs.load("item-a", pointCloud("pc-a", "A"));
    usgs.load("item-b", pointCloud("pc-b", "B"));

    stop();

    assert.equal(useAppStore.getState().layers.length, 0);
    assert.equal(usgs.listenerCount(), 0);
    assert.equal(usgs.isDestroyed(), true);
    // Removing the rows on dispose must not unload clouds: the control is being
    // torn down with the panel and owns that.
    assert.equal(usgs.has("item-a"), true);
  });

  it("hands Whitebox the streamed URL as the row's input path", () => {
    const usgs = fakeUsgs();
    const stop = bindUsgsLidarLayerSync(usgs.control, usgs.adapter);
    usgs.load("item-a", pointCloud("pc-a", "A"));
    const layer = storeLayer(usgsLidarLayerId("item-a"));
    assert.ok(layer);
    // The in-browser runner fetches this; without it the tool reported the
    // input as "only available via the sidecar".
    assert.equal(layerPath(layer), "https://example.com/tile.copc.laz?sig=abc");
    stop();
  });

  it("is drawn by the plugin, not compiled, on Mapbox", () => {
    const usgs = fakeUsgs();
    const stop = bindUsgsLidarLayerSync(usgs.control, usgs.adapter);
    usgs.load("item-a", pointCloud("pc-a", "A"));
    const layer = storeLayer(usgsLidarLayerId("item-a"));
    assert.ok(layer);
    assert.equal(isMapboxPluginLayer(layer), true);
    stop();
  });
});
