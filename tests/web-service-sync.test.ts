import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer, useAppStore } from "@geolibre/core";
import {
  createStoreLayer,
  createWebServiceStoreSync,
  layerTypeForTiles,
  readNativeRasterSource,
  stringMetadata,
  type WebServiceAdapter,
  type WebServiceLayerEntry,
  type WebServiceStoreSync,
} from "../packages/plugins/src/plugins/web-service-sync";

const KIND = "test-service";

function makeEntry(patch: Partial<WebServiceLayerEntry> = {}): WebServiceLayerEntry {
  return {
    id: "svc-layer-1",
    name: "Service Layer 1",
    sourceId: "svc-layer-1",
    tiles: ["https://example.com/{z}/{x}/{y}.png"],
    opacity: 1,
    visible: true,
    layerType: "raster",
    ...patch,
  };
}

interface FakeControl {
  entries: WebServiceLayerEntry[];
  listener: (() => void) | null;
  fire: () => void;
}

function makeFakeControl(entries: WebServiceLayerEntry[] = []): FakeControl {
  const control: FakeControl = {
    entries,
    listener: null,
    fire: () => control.listener?.(),
  };
  return control;
}

function makeAdapter(): {
  adapter: WebServiceAdapter<FakeControl>;
  calls: { method: string; args: unknown[] }[];
} {
  const calls: { method: string; args: unknown[] }[] = [];
  const adapter: WebServiceAdapter<FakeControl> = {
    sourceKind: KIND,
    attachEvents: (control, listener) => {
      control.listener = listener;
    },
    detachEvents: (control) => {
      control.listener = null;
    },
    listActive: (control) => control.entries.map((entry) => ({ ...entry })),
    removeFromControl: (control, entry) => {
      calls.push({ method: "removeFromControl", args: [entry.id] });
      control.entries = control.entries.filter((candidate) => candidate.id !== entry.id);
    },
    setControlOpacity: (control, entry, opacity) => {
      calls.push({ method: "setControlOpacity", args: [entry.id, opacity] });
      const target = control.entries.find((candidate) => candidate.id === entry.id);
      if (target) target.opacity = opacity;
    },
    setControlVisibility: (control, entry, visible) => {
      calls.push({ method: "setControlVisibility", args: [entry.id, visible] });
      const target = control.entries.find((candidate) => candidate.id === entry.id);
      if (target) target.visible = visible;
    },
    adopt: (control, layers) => {
      calls.push({ method: "adopt", args: [layers.map((layer) => layer.id)] });
      for (const layer of layers) {
        const tileUrl = stringMetadata(layer.metadata.tileUrl);
        control.entries.push(
          makeEntry({
            id: layer.id,
            name: layer.name,
            sourceId: layer.id,
            tiles: tileUrl ? [tileUrl] : [],
            opacity: layer.opacity,
            visible: layer.visible,
          }),
        );
      }
      // A real control emits its change events once registration completes.
      control.fire();
    },
  };
  return { adapter, calls };
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

function storeLayerIds(): string[] {
  return useAppStore.getState().layers.map((layer) => layer.id);
}

function storeLayer(id: string): GeoLibreLayer | undefined {
  return useAppStore.getState().layers.find((layer) => layer.id === id);
}

describe("createStoreLayer", () => {
  it("mirrors a web service entry as an external native raster layer", () => {
    const layer = createStoreLayer(
      KIND,
      makeEntry({
        opacity: 0.5,
        visible: false,
        layerType: "wms",
        source: { tileSize: 512, attribution: "Test" },
        metadata: { extra: "value" },
      }),
    );

    assert.equal(layer.id, "svc-layer-1");
    assert.equal(layer.name, "Service Layer 1");
    assert.equal(layer.type, "wms");
    assert.equal(layer.visible, false);
    assert.equal(layer.opacity, 0.5);
    assert.deepEqual(layer.source.tiles, ["https://example.com/{z}/{x}/{y}.png"]);
    assert.equal(layer.source.tileSize, 512);
    assert.equal(layer.source.attribution, "Test");
    assert.equal(layer.metadata.externalNativeLayer, true);
    assert.equal(layer.metadata.identifiable, false);
    assert.deepEqual(layer.metadata.nativeLayerIds, ["svc-layer-1"]);
    assert.deepEqual(layer.metadata.sourceIds, ["svc-layer-1"]);
    assert.equal(layer.metadata.sourceKind, KIND);
    assert.equal(layer.metadata.tileUrl, "https://example.com/{z}/{x}/{y}.png");
    assert.equal(layer.metadata.extra, "value");
    assert.equal(layer.sourcePath, "https://example.com/{z}/{x}/{y}.png");
  });
});

describe("layerTypeForTiles", () => {
  it("flags bbox templates as wms and xyz templates as raster", () => {
    assert.equal(layerTypeForTiles(["https://example.com/wms?bbox={bbox-epsg-3857}"]), "wms");
    assert.equal(layerTypeForTiles(["https://example.com/{z}/{x}/{y}.png"]), "raster");
  });
});

describe("readNativeRasterSource", () => {
  it("reads tiles and source properties from the live style", () => {
    const map = {
      getStyle: () => ({
        sources: {
          "svc-layer-1": {
            type: "raster",
            tiles: ["https://example.com/native/{z}/{x}/{y}.png"],
            tileSize: 256,
            maxzoom: 9,
            attribution: "Native",
          },
        },
      }),
    };

    const native = readNativeRasterSource(map, "svc-layer-1");
    assert.ok(native);
    assert.deepEqual(native.tiles, ["https://example.com/native/{z}/{x}/{y}.png"]);
    assert.deepEqual(native.source, {
      tileSize: 256,
      maxzoom: 9,
      attribution: "Native",
    });
  });

  it("unwraps dev-proxied WMS tile templates before they are persisted", () => {
    const original = "https://example.com/wms?service=WMS&bbox={bbox-epsg-3857}";
    // Mimic the real dev proxy: encode the URL but keep the bbox placeholder
    // literal so MapLibre can substitute it per tile.
    const proxied = `/__geolibre_wms_proxy?url=${encodeURIComponent(original).replaceAll(
      "%7Bbbox-epsg-3857%7D",
      "{bbox-epsg-3857}",
    )}`;
    const map = {
      getStyle: () => ({
        sources: {
          "svc-layer-1": { type: "raster", tiles: [proxied], tileSize: 256 },
        },
      }),
    };

    const native = readNativeRasterSource(map, "svc-layer-1");
    assert.ok(native);
    assert.deepEqual(native.tiles, [original]);
  });

  it("returns null for missing or non-raster sources", () => {
    const map = {
      getStyle: () => ({
        sources: { vec: { type: "vector", url: "https://example.com" } },
      }),
    };
    assert.equal(readNativeRasterSource(map, "vec"), null);
    assert.equal(readNativeRasterSource(map, "missing"), null);
    assert.equal(readNativeRasterSource(undefined, "svc-layer-1"), null);
  });
});

describe("createWebServiceStoreSync", () => {
  let sync: WebServiceStoreSync<FakeControl> | null = null;

  beforeEach(() => {
    useAppStore.setState({ layers: [] });
  });

  afterEach(() => {
    sync?.detach();
    sync = null;
    useAppStore.setState({ layers: [] });
  });

  it("mirrors control layers into the store and removes them on control removal", () => {
    const { adapter } = makeAdapter();
    const control = makeFakeControl();
    sync = createWebServiceStoreSync(adapter);
    sync.attach(control);

    control.entries.push(makeEntry());
    control.fire();

    const mirrored = storeLayer("svc-layer-1");
    assert.ok(mirrored);
    assert.equal(mirrored.metadata.sourceKind, KIND);

    control.entries = [];
    control.fire();
    assert.equal(storeLayer("svc-layer-1"), undefined);
  });

  it("leaves unrelated store layers alone", () => {
    const { adapter } = makeAdapter();
    const control = makeFakeControl([makeEntry()]);
    useAppStore.getState().addLayer(otherStoreLayer());
    sync = createWebServiceStoreSync(adapter);
    sync.attach(control);

    control.entries = [];
    control.fire();

    assert.deepEqual(storeLayerIds(), ["unrelated"]);
  });

  it("adopts restored store layers instead of removing them", () => {
    const { adapter, calls } = makeAdapter();
    const control = makeFakeControl();
    const restored = createStoreLayer(KIND, makeEntry({ opacity: 0.4 }));
    useAppStore.getState().addLayer(restored);

    sync = createWebServiceStoreSync(adapter);
    sync.attach(control);

    const adoptCalls = calls.filter((call) => call.method === "adopt");
    assert.equal(adoptCalls.length, 1);
    assert.deepEqual(adoptCalls[0].args, [["svc-layer-1"]]);
    // The control registered the layer and the store entry survived.
    assert.equal(control.entries.length, 1);
    assert.equal(control.entries[0].opacity, 0.4);
    assert.ok(storeLayer("svc-layer-1"));
  });

  it("does not adopt the same restored layer twice", () => {
    const { adapter, calls } = makeAdapter();
    const control = makeFakeControl();
    useAppStore.getState().addLayer(createStoreLayer(KIND, makeEntry()));

    sync = createWebServiceStoreSync(adapter);
    sync.attach(control);
    control.fire();
    useAppStore.getState().addLayer(otherStoreLayer());

    assert.equal(calls.filter((call) => call.method === "adopt").length, 1);
  });

  it("removes a layer from the control when its store layer is deleted", () => {
    const { adapter, calls } = makeAdapter();
    const control = makeFakeControl([makeEntry()]);
    sync = createWebServiceStoreSync(adapter);
    sync.attach(control);
    assert.ok(storeLayer("svc-layer-1"));

    useAppStore.getState().removeLayer("svc-layer-1");

    assert.equal(calls.filter((call) => call.method === "removeFromControl").length, 1);
    assert.equal(control.entries.length, 0);
    assert.equal(storeLayer("svc-layer-1"), undefined);
  });

  it("pushes control opacity changes into the store", () => {
    const { adapter } = makeAdapter();
    const control = makeFakeControl([makeEntry()]);
    sync = createWebServiceStoreSync(adapter);
    sync.attach(control);

    control.entries[0].opacity = 0.3;
    control.fire();

    assert.equal(storeLayer("svc-layer-1")?.opacity, 0.3);
  });

  it("pushes store opacity changes into the control without reverting them", () => {
    const { adapter, calls } = makeAdapter();
    const control = makeFakeControl([makeEntry()]);
    sync = createWebServiceStoreSync(adapter);
    sync.attach(control);

    useAppStore.getState().updateLayer("svc-layer-1", { opacity: 0.7 });

    assert.deepEqual(calls.filter((call) => call.method === "setControlOpacity").pop()?.args, [
      "svc-layer-1",
      0.7,
    ]);
    assert.equal(control.entries[0].opacity, 0.7);

    // An unrelated control event must not revert the panel-set value.
    control.fire();
    assert.equal(storeLayer("svc-layer-1")?.opacity, 0.7);
  });

  it("pushes store visibility changes into the control", () => {
    const { adapter, calls } = makeAdapter();
    const control = makeFakeControl([makeEntry()]);
    sync = createWebServiceStoreSync(adapter);
    sync.attach(control);

    useAppStore.getState().updateLayer("svc-layer-1", { visible: false });

    assert.deepEqual(calls.filter((call) => call.method === "setControlVisibility").pop()?.args, [
      "svc-layer-1",
      false,
    ]);
    assert.equal(control.entries[0].visible, false);
    control.fire();
    assert.equal(storeLayer("svc-layer-1")?.visible, false);
  });

  it("stops syncing after detach but keeps store layers", () => {
    const { adapter, calls } = makeAdapter();
    const control = makeFakeControl([makeEntry()]);
    sync = createWebServiceStoreSync(adapter);
    sync.attach(control);
    assert.ok(storeLayer("svc-layer-1"));

    sync.detach();
    sync = null;
    assert.equal(control.listener, null);
    assert.ok(storeLayer("svc-layer-1"));

    const before = calls.length;
    useAppStore.getState().updateLayer("svc-layer-1", { opacity: 0.1 });
    assert.equal(calls.length, before);
  });
});
