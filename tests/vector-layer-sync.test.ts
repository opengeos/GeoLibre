import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  DEFAULT_LAYER_STYLE,
  type GeoLibreLayer,
  useAppStore,
} from "@geolibre/core";
import type { VectorLayerInfo, VectorLayerStyle } from "maplibre-gl-vector";
import {
  createVectorStoreLayer,
  isVectorControlStoreLayer,
  removeVectorStoreLayers,
  resetVectorStoreSyncSuspension,
  resumeVectorStoreSync,
  runWithVectorStoreSyncSuspended,
  savedVectorState,
  suspendVectorStoreSync,
  syncVectorLayersToStore,
  unwireVectorStoreSync,
  wireVectorStoreSync,
  type VectorSyncableControl,
} from "../packages/plugins/src/plugins/vector-layer-sync";

function vectorStyle(patch: Partial<VectorLayerStyle> = {}): VectorLayerStyle {
  return {
    fillColor: "#3388ff",
    fillOpacity: 0.4,
    lineColor: "#3388ff",
    lineWidth: 2,
    circleColor: "#3388ff",
    circleRadius: 5,
    circleOpacity: 0.85,
    ...patch,
  };
}

function vectorInfo(patch: Partial<VectorLayerInfo> = {}): VectorLayerInfo {
  return {
    id: "vector-1",
    name: "countries",
    source: { kind: "url", url: "https://example.com/countries.geojson" },
    format: "geojson",
    renderMode: "geojson",
    geometryType: "polygon",
    featureCount: 258,
    bbox: [-180, -90, 180, 90],
    visible: true,
    opacity: 1,
    picker: true,
    ingestMode: "table",
    style: vectorStyle(),
    sourceId: "vector-1-source",
    layerIds: ["vector-1-fill", "vector-1-outline"],
    ...patch,
  };
}

/**
 * Recorder fake standing in for VectorControl in store->control tests.
 * getState is a static snapshot of options.collapsed: tests exercising
 * event-driven expand/collapse transitions need a stateful fake instead.
 */
function fakeControl(
  infos: VectorLayerInfo[] = [],
  options: { collapsed?: boolean } = {},
) {
  const calls: { method: string; args: unknown[] }[] = [];
  const control: VectorSyncableControl = {
    getState: () => ({ collapsed: options.collapsed ?? true }),
    getLayers: () => infos,
    removeLayer: (id) => calls.push({ method: "removeLayer", args: [id] }),
    setLayerOpacity: (id, opacity) =>
      calls.push({ method: "setLayerOpacity", args: [id, opacity] }),
    setLayerVisibility: (id, visible) =>
      calls.push({ method: "setLayerVisibility", args: [id, visible] }),
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

describe("createVectorStoreLayer", () => {
  it("mirrors a URL layer as an external custom layer", () => {
    const layer = createVectorStoreLayer(
      vectorInfo({ opacity: 0.5, visible: false }),
    );

    assert.equal(layer.id, "vector-1");
    assert.equal(layer.name, "countries");
    assert.equal(layer.type, "geojson");
    assert.equal(layer.visible, false);
    assert.equal(layer.opacity, 0.5);
    assert.equal(layer.source.url, "https://example.com/countries.geojson");
    assert.equal(layer.sourcePath, "https://example.com/countries.geojson");
    assert.equal(layer.metadata.externalNativeLayer, true);
    assert.equal(layer.metadata.customLayerType, "fill");
    assert.equal(layer.metadata.identifiable, false);
    assert.equal(layer.metadata.panelCollapsed, true);
    assert.equal(layer.metadata.sourceKind, "maplibre-gl-vector");
    assert.equal(layer.metadata.vectorSource, "url");
    assert.equal(layer.metadata.featureCount, 258);
    // layer-sync orders these real MapLibre style layers directly.
    assert.deepEqual(layer.metadata.nativeLayerIds, [
      "vector-1-fill",
      "vector-1-outline",
    ]);
    assert.deepEqual(layer.metadata.sourceIds, ["vector-1-source"]);
    // fitLayer falls back to metadata.bounds for zoom-to-layer.
    assert.deepEqual(layer.metadata.bounds, [-180, -90, 180, 90]);
    assert.ok(isVectorControlStoreLayer(layer));
  });

  it("maps geometry categories onto custom layer types", () => {
    const typeFor = (
      geometryType: VectorLayerInfo["geometryType"],
    ): unknown =>
      createVectorStoreLayer(vectorInfo({ geometryType })).metadata
        .customLayerType;

    assert.equal(typeFor("point"), "circle");
    assert.equal(typeFor("line"), "line");
    assert.equal(typeFor("polygon"), "fill");
    assert.equal(typeFor("mixed"), "custom");
    assert.equal(typeFor("unknown"), "custom");
  });

  it("uses the file name for local files and omits bounds until known", () => {
    const layer = createVectorStoreLayer(
      vectorInfo({
        source: { kind: "file", fileName: "local.gpkg" },
        bbox: undefined,
        featureCount: undefined,
      }),
    );

    assert.equal(layer.source.url, undefined);
    assert.equal(layer.sourcePath, "local.gpkg");
    assert.equal(layer.metadata.vectorSource, "file");
    assert.equal("bounds" in layer.metadata, false);
    assert.equal("featureCount" in layer.metadata, false);
  });

  it("marks tile-rendered layers as vector-tiles", () => {
    const layer = createVectorStoreLayer(vectorInfo({ renderMode: "tiles" }));

    assert.equal(layer.type, "vector-tiles");
    assert.equal(layer.source.type, "vector");
  });

  it("persists the load and style state", () => {
    const layer = createVectorStoreLayer(
      vectorInfo({
        renderMode: "tiles",
        ingestMode: "stream",
        picker: false,
        sourceLayer: "roads",
        format: "geopackage",
        style: vectorStyle({ fillColor: "#ff0000", lineWidth: 3 }),
      }),
    );

    // visible and opacity live on the top-level layer fields, not here.
    assert.deepEqual(layer.metadata.vectorState, {
      format: "geopackage",
      ingestMode: "stream",
      picker: false,
      renderMode: "tiles",
      sourceLayer: "roads",
      style: vectorStyle({ fillColor: "#ff0000", lineWidth: 3 }),
    });
  });

  it("persists the vector panel collapsed state", () => {
    const layer = createVectorStoreLayer(vectorInfo(), false);

    assert.equal(layer.metadata.panelCollapsed, false);
  });
});

describe("syncVectorLayersToStore", () => {
  beforeEach(() => {
    useAppStore.setState({ layers: [] });
  });

  // The suspension counter is module state; a test failing mid-suspension
  // must not leave later tests silently syncing nothing.
  afterEach(() => {
    resetVectorStoreSyncSuspension();
  });

  it("adds store layers for control layers, leaving others alone", () => {
    useAppStore.getState().addLayer(otherStoreLayer());
    const { control } = fakeControl([
      vectorInfo(),
      vectorInfo({ id: "vector-2", name: "cities" }),
    ]);

    syncVectorLayersToStore(control);

    const layers = useAppStore.getState().layers;
    assert.equal(layers.length, 3);
    assert.ok(layers.some((layer) => layer.id === "vector-1"));
    assert.ok(layers.some((layer) => layer.id === "vector-2"));
    assert.ok(layers.some((layer) => layer.id === "unrelated"));
  });

  it("removes store layers whose vector layers are gone", () => {
    const { control } = fakeControl([vectorInfo()]);
    syncVectorLayersToStore(control);
    assert.equal(useAppStore.getState().layers.length, 1);

    syncVectorLayersToStore(fakeControl([]).control);
    assert.equal(useAppStore.getState().layers.length, 0);
  });

  it("refreshes changed fields but preserves panel renames", () => {
    const { control } = fakeControl([vectorInfo()]);
    syncVectorLayersToStore(control);
    useAppStore.getState().updateLayer("vector-1", { name: "My Countries" });

    syncVectorLayersToStore(
      fakeControl([
        vectorInfo({
          bbox: [0, 0, 1, 1],
          opacity: 0.4,
          // A render-mode switch recreates the map layers.
          renderMode: "tiles",
          layerIds: ["vector-1-fill", "vector-1-outline"],
        }),
      ]).control,
    );

    const layer = useAppStore.getState().layers[0];
    assert.equal(layer.name, "My Countries");
    assert.equal(layer.opacity, 0.4);
    assert.deepEqual(layer.metadata.bounds, [0, 0, 1, 1]);
    assert.equal(layer.source.type, "vector");
    assert.equal(layer.type, "vector-tiles");
  });

  it("refreshes the saved panel collapsed state", () => {
    const { control } = fakeControl([vectorInfo()]);
    syncVectorLayersToStore(control);
    assert.equal(
      useAppStore.getState().layers[0].metadata.panelCollapsed,
      true,
    );

    syncVectorLayersToStore(
      fakeControl([vectorInfo()], { collapsed: false }).control,
    );

    assert.equal(
      useAppStore.getState().layers[0].metadata.panelCollapsed,
      false,
    );
  });

  it("flips panelCollapsed on store layers when an expand event syncs", () => {
    // Stateful stand-in for the production expand/collapse wiring: the
    // handler mirrors panelStateSyncHandler in maplibre-vector.ts, and
    // expand() flips the state before notifying, matching the verified
    // maplibre-gl-vector event ordering.
    let collapsed = true;
    const handlers: Array<() => void> = [];
    const control: VectorSyncableControl = {
      getState: () => ({ collapsed }),
      getLayers: () => [vectorInfo()],
      removeLayer: () => {},
      setLayerOpacity: () => {},
      setLayerVisibility: () => {},
    };
    handlers.push(() => syncVectorLayersToStore(control));
    const expand = () => {
      collapsed = false;
      for (const handler of handlers) handler();
    };

    syncVectorLayersToStore(control);
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
    const { control } = fakeControl([vectorInfo()]);
    syncVectorLayersToStore(control);
    const before = useAppStore.getState().layers[0];

    // A second sync with an identical snapshot builds fresh source/metadata
    // objects; the deep comparison must not report them as changed.
    syncVectorLayersToStore(fakeControl([vectorInfo()]).control);

    assert.equal(useAppStore.getState().layers[0], before);
  });

  it("does nothing while sync is suspended", () => {
    const { control } = fakeControl([vectorInfo()]);
    runWithVectorStoreSyncSuspended(() => {
      syncVectorLayersToStore(control);
    });
    assert.equal(useAppStore.getState().layers.length, 0);
  });

  it("stays suspended across an async window until resumed", () => {
    // restoreVectorLayers holds the suspension across addData's async
    // loads (the control only lists a layer once its data has loaded), so
    // the pair must compose without a synchronous wrapper.
    const { control } = fakeControl([vectorInfo()]);
    suspendVectorStoreSync();
    syncVectorLayersToStore(control);
    assert.equal(useAppStore.getState().layers.length, 0);

    resumeVectorStoreSync();
    syncVectorLayersToStore(control);
    assert.equal(useAppStore.getState().layers.length, 1);

    // A resume racing a teardown reset must not underflow the counter
    // into a sticky suspension.
    resetVectorStoreSyncSuspension();
    resumeVectorStoreSync();
    syncVectorLayersToStore(fakeControl([]).control);
    assert.equal(useAppStore.getState().layers.length, 0);
  });
});

describe("wireVectorStoreSync", () => {
  beforeEach(() => {
    useAppStore.setState({ layers: [] });
  });

  afterEach(() => {
    unwireVectorStoreSync();
    resetVectorStoreSyncSuspension();
  });

  it("applies panel visibility and opacity changes through the control", () => {
    const { control, calls } = fakeControl([vectorInfo()]);
    syncVectorLayersToStore(control);
    wireVectorStoreSync(control);

    useAppStore.getState().updateLayer("vector-1", { visible: false });
    useAppStore.getState().updateLayer("vector-1", { opacity: 0.25 });

    assert.deepEqual(calls, [
      { method: "setLayerVisibility", args: ["vector-1", false] },
      { method: "setLayerOpacity", args: ["vector-1", 0.25] },
    ]);
  });

  it("drops the control layer when the panel removes the layer", () => {
    const { control, calls } = fakeControl([vectorInfo()]);
    syncVectorLayersToStore(control);
    wireVectorStoreSync(control);

    useAppStore.getState().removeLayer("vector-1");

    assert.deepEqual(calls, [{ method: "removeLayer", args: ["vector-1"] }]);
  });

  it("does not echo control-driven syncs back at the control", () => {
    const { control, calls } = fakeControl([vectorInfo()]);
    syncVectorLayersToStore(control);
    wireVectorStoreSync(control);

    // A layer removed in the control's own panel: the event-driven sync
    // removes the store layer, which must not bounce a removeLayer back.
    syncVectorLayersToStore(fakeControl([]).control);

    assert.equal(useAppStore.getState().layers.length, 0);
    assert.deepEqual(calls, []);
  });

  it("ignores store changes that touch no vector layers", () => {
    const { control, calls } = fakeControl([vectorInfo()]);
    syncVectorLayersToStore(control);
    wireVectorStoreSync(control);

    useAppStore.getState().addLayer(otherStoreLayer());
    useAppStore.getState().updateLayer("unrelated", { opacity: 0.5 });

    assert.deepEqual(calls, []);
  });
});

describe("removeVectorStoreLayers", () => {
  beforeEach(() => {
    useAppStore.setState({ layers: [] });
  });

  afterEach(() => {
    unwireVectorStoreSync();
    resetVectorStoreSyncSuspension();
  });

  it("prunes vector layers without echoing removals at the control", () => {
    const { control, calls } = fakeControl([vectorInfo()]);
    syncVectorLayersToStore(control);
    useAppStore.getState().addLayer(otherStoreLayer());
    wireVectorStoreSync(control);

    removeVectorStoreLayers();

    const layers = useAppStore.getState().layers;
    assert.equal(layers.length, 1);
    assert.equal(layers[0].id, "unrelated");
    assert.deepEqual(calls, []);
  });
});

describe("savedVectorState", () => {
  it("round-trips the state persisted by createVectorStoreLayer", () => {
    const layer = createVectorStoreLayer(
      vectorInfo({
        renderMode: "tiles",
        ingestMode: "stream",
        picker: false,
        sourceLayer: "roads",
        format: "geopackage",
        style: vectorStyle({ circleRadius: 8, circleOpacity: 0.5 }),
      }),
    );

    assert.deepEqual(savedVectorState(layer), {
      format: "geopackage",
      ingestMode: "stream",
      picker: false,
      renderMode: "tiles",
      sourceLayer: "roads",
      style: vectorStyle({ circleRadius: 8, circleOpacity: 0.5 }),
    });
  });

  it("drops malformed fields from hand-edited project files", () => {
    const layer = createVectorStoreLayer(vectorInfo());
    layer.metadata.vectorState = {
      renderMode: "hologram",
      ingestMode: "teleport",
      picker: "yes",
      // Length-capped like colors: legitimate names are short.
      sourceLayer: "x".repeat(201),
      format: "y".repeat(51),
      style: {
        fillColor: 7,
        fillOpacity: 2,
        // Colors are length-capped so a hand-edited project file cannot
        // smuggle arbitrary blobs into paint properties.
        lineColor: `#${"f".repeat(200)}`,
        lineWidth: -1,
        circleRadius: Number.NaN,
      },
    };

    assert.deepEqual(savedVectorState(layer), {});
  });

  it("keeps the well-formed subset of a partially valid style", () => {
    const layer = createVectorStoreLayer(vectorInfo());
    layer.metadata.vectorState = {
      renderMode: "geojson",
      style: { fillColor: "#123456", fillOpacity: 5 },
    };

    assert.deepEqual(savedVectorState(layer), {
      renderMode: "geojson",
      style: { fillColor: "#123456" },
    });
  });

  it("returns no overrides when the metadata is missing", () => {
    const layer = createVectorStoreLayer(vectorInfo());
    delete layer.metadata.vectorState;
    assert.deepEqual(savedVectorState(layer), {});
  });
});
