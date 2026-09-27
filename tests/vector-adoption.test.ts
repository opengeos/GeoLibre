import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  DEFAULT_LAYER_STYLE,
  projectFromStore,
  useAppStore,
  type GeoLibreLayer,
} from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import { getHistoryCoalesceMs, setHistoryCoalesceMs } from "../packages/core/src/history";
import type { VectorLayerInfo, VectorLayerStyle } from "maplibre-gl-vector";
import { isControlPaintedVectorLayer } from "../apps/geolibre-desktop/src/components/panels/style-panel/layer-capabilities";
import {
  isVectorControlRefreshLayer,
  supportsRefreshFailurePolicy,
} from "../apps/geolibre-desktop/src/lib/layer-refresh";
import {
  ADOPTED_VECTOR_SOURCE_KIND,
  adoptVectorControlLayers,
  isAdoptableVectorInfo,
  isAdoptedVectorLayer,
  isVectorControlStoreLayer,
  needsAdoptedVectorReplay,
  resetVectorStoreSyncSuspension,
  syncVectorLayersToStore,
  unwireVectorStoreSync,
  VECTOR_ADOPTION_MAX_FEATURES,
  type VectorAdoptionControl,
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
    name: "cities",
    source: { kind: "url", url: "https://example.com/cities.geojson" },
    format: "geojson",
    renderMode: "geojson",
    geometryType: "point",
    featureCount: 2,
    fields: ["name"],
    bbox: [0, 0, 1, 1],
    visible: true,
    opacity: 1,
    picker: false,
    ingestMode: "table",
    style: vectorStyle(),
    sourceId: "vector-1-source",
    layerIds: ["vector-1-circle"],
    ...patch,
  };
}

function points(count = 2, properties: Record<string, unknown> = {}): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: Array.from({ length: count }, (_, index) => ({
      type: "Feature" as const,
      properties: { name: `city ${index}`, ...properties },
      geometry: { type: "Point" as const, coordinates: [index, index] },
    })),
  };
}

/**
 * A vector control fake that serves features per layer id and records what
 * adoption does to it. `removeLayer` really drops the layer, as the control does.
 */
function fakeControl(infos: VectorLayerInfo[], data: Record<string, FeatureCollection | null>) {
  const layers = [...infos];
  const reads: string[] = [];
  const removed: string[] = [];
  const control: VectorAdoptionControl & {
    setLayerOpacity: () => void;
    setLayerVisibility: () => void;
    setLayerStyle: () => void;
  } = {
    getLayers: () => layers,
    removeLayer: (id) => {
      removed.push(id);
      const index = layers.findIndex((info) => info.id === id);
      if (index >= 0) layers.splice(index, 1);
    },
    getLayerGeoJSON: async (id) => {
      reads.push(id);
      return data[id] ?? null;
    },
    setLayerOpacity: () => {},
    setLayerVisibility: () => {},
    setLayerStyle: () => {},
  };
  return { control, layers, reads, removed };
}

function storeLayer(id: string): GeoLibreLayer {
  const layer = useAppStore.getState().layers.find((candidate) => candidate.id === id);
  assert.ok(layer, `no store layer ${id}`);
  return layer;
}

describe("isAdoptableVectorInfo", () => {
  it("accepts a GeoJSON-mode table layer within the limit", () => {
    assert.equal(isAdoptableVectorInfo(vectorInfo()), true);
    assert.equal(
      isAdoptableVectorInfo(vectorInfo({ featureCount: VECTOR_ADOPTION_MAX_FEATURES })),
      true,
    );
  });

  it("leaves tiled, streamed and oversize layers with the control", () => {
    assert.equal(isAdoptableVectorInfo(vectorInfo({ renderMode: "tiles" })), false);
    assert.equal(isAdoptableVectorInfo(vectorInfo({ ingestMode: "stream" })), false);
    assert.equal(
      isAdoptableVectorInfo(vectorInfo({ featureCount: VECTOR_ADOPTION_MAX_FEATURES + 1 })),
      false,
    );
  });
});

describe("adoptVectorControlLayers", () => {
  beforeEach(() => {
    useAppStore.setState({ layers: [], layerGroups: [], isDirty: false });
    useAppStore.temporal.getState().clear();
  });

  afterEach(() => {
    unwireVectorStoreSync();
    resetVectorStoreSyncSuspension();
  });

  it("moves the features into the store and drops the control's copy", async () => {
    const info = vectorInfo({
      source: { kind: "file", fileName: "cities.geojson", path: "/data/cities.geojson" },
    });
    const { control, removed } = fakeControl([info], { "vector-1": points() });
    syncVectorLayersToStore(control as never);
    // User edits made while the control still drew the layer must survive.
    useAppStore.getState().updateLayer("vector-1", {
      name: "My cities",
      popup: { titleField: "name" },
      style: { ...storeLayer("vector-1").style, fillColor: "#ff0000" },
    });

    const adopted = await adoptVectorControlLayers(control);

    assert.deepEqual(adopted, ["vector-1"]);
    assert.deepEqual(removed, ["vector-1"]);
    const layer = storeLayer("vector-1");
    assert.equal(isAdoptedVectorLayer(layer), true);
    assert.equal(isVectorControlStoreLayer(layer), false);
    assert.equal(isControlPaintedVectorLayer(layer), false);
    assert.equal(layer.type, "geojson");
    assert.equal(layer.source.type, "geojson");
    assert.equal(layer.geojson?.features.length, 2);
    for (const key of [
      "controlOwnsPaint",
      "customLayerType",
      "externalNativeLayer",
      "nativeLayerIds",
      "sourceIds",
    ]) {
      assert.equal(key in layer.metadata, false, `${key} should be dropped`);
    }
    // The load state stays, so a saved project can replay it.
    assert.equal(layer.sourcePath, "/data/cities.geojson");
    assert.equal(layer.metadata.localFileReloadable, true);
    assert.equal((layer.metadata.vectorState as { renderMode: string }).renderMode, "geojson");
    assert.equal(layer.metadata.featureCount, 2);
    assert.equal(layer.name, "My cities");
    assert.equal(layer.style.fillColor, "#ff0000");
    assert.ok(layer.popup);
  });

  it("keeps the swap out of the undo history and the dirty flag", async () => {
    // No coalescing, so an unpaused write would record its own undo step.
    const coalesceMs = getHistoryCoalesceMs();
    setHistoryCoalesceMs(0);
    try {
      const { control } = fakeControl([vectorInfo()], { "vector-1": points() });
      syncVectorLayersToStore(control as never);
      useAppStore.setState({ isDirty: false });
      const pastBefore = useAppStore.temporal.getState().pastStates.length;

      await adoptVectorControlLayers(control);

      assert.equal(isAdoptedVectorLayer(storeLayer("vector-1")), true);
      assert.equal(useAppStore.temporal.getState().pastStates.length, pastBefore);
      assert.equal(useAppStore.getState().isDirty, false);
      // Undoing the add removes the layer outright, rather than restoring a
      // control record whose control copy is gone.
      useAppStore.temporal.getState().undo();
      assert.equal(useAppStore.getState().layers.length, 0);
    } finally {
      setHistoryCoalesceMs(coalesceMs);
    }
  });

  it("leaves tiled layers with the control without reading them", async () => {
    const info = vectorInfo({ renderMode: "tiles" });
    const { control, reads, removed } = fakeControl([info], { "vector-1": points() });
    syncVectorLayersToStore(control as never);

    assert.deepEqual(await adoptVectorControlLayers(control), []);
    assert.deepEqual(reads, []);
    assert.deepEqual(removed, []);
    assert.equal(isControlPaintedVectorLayer(storeLayer("vector-1")), true);
  });

  it("keeps KML icon layers with the control and does not re-read them", async () => {
    const { control, reads, removed } = fakeControl([vectorInfo()], {
      "vector-1": points(2, { __geolibre_kml_icon_url: "icon.png" }),
    });
    syncVectorLayersToStore(control as never);

    assert.deepEqual(await adoptVectorControlLayers(control), []);
    assert.deepEqual(await adoptVectorControlLayers(control), []);
    assert.deepEqual(reads, ["vector-1"]);
    assert.deepEqual(removed, []);
  });

  it("skips layers the caller marks as still loading", async () => {
    const { control, reads } = fakeControl([vectorInfo()], { "vector-1": points() });
    syncVectorLayersToStore(control as never);

    assert.deepEqual(await adoptVectorControlLayers(control, { skip: () => true }), []);
    assert.deepEqual(reads, []);
  });

  it("discards a read that a reload overtook", async () => {
    const { control, layers, removed } = fakeControl([vectorInfo()], {});
    syncVectorLayersToStore(control as never);
    control.getLayerGeoJSON = async () => {
      // The control swaps in a new source revision while the read is pending.
      layers[0] = { ...layers[0], sourceId: "vector-1-source-2" };
      return points();
    };

    assert.deepEqual(await adoptVectorControlLayers(control), []);
    assert.deepEqual(removed, []);
    assert.equal(isVectorControlStoreLayer(storeLayer("vector-1")), true);
  });
});

describe("syncVectorLayersToStore with adopted layers", () => {
  beforeEach(() => {
    useAppStore.setState({ layers: [], layerGroups: [] });
  });

  afterEach(() => {
    unwireVectorStoreSync();
    resetVectorStoreSyncSuspension();
  });

  async function adoptedLayer(): Promise<ReturnType<typeof fakeControl>> {
    const fake = fakeControl([vectorInfo()], { "vector-1": points() });
    syncVectorLayersToStore(fake.control as never);
    await adoptVectorControlLayers(fake.control);
    return fake;
  }

  it("does not prune an adopted layer the control no longer holds", async () => {
    const { control } = await adoptedLayer();
    syncVectorLayersToStore(control as never);
    assert.equal(isAdoptedVectorLayer(storeLayer("vector-1")), true);
  });

  it("leaves a replayed adopted layer for adoption to refill", async () => {
    const { control, layers } = await adoptedLayer();
    // A refresh or restore replays the layer into the control under its id.
    layers.push(vectorInfo({ sourceId: "vector-1-source-2" }));
    syncVectorLayersToStore(control as never);
    const layer = storeLayer("vector-1");
    assert.equal(isAdoptedVectorLayer(layer), true);
    assert.equal(layer.geojson?.features.length, 2);
  });

  it("hands a replay that outgrew the limit back to the control", async () => {
    const { control, layers } = await adoptedLayer();
    layers.push(
      vectorInfo({ sourceId: "vector-1-source-2", featureCount: VECTOR_ADOPTION_MAX_FEATURES + 1 }),
    );
    syncVectorLayersToStore(control as never);
    const layer = storeLayer("vector-1");
    assert.equal(isVectorControlStoreLayer(layer), true);
    assert.equal(layer.geojson, undefined);
  });
});

describe("saving adopted layers", () => {
  function adopted(patch: Partial<GeoLibreLayer> = {}): GeoLibreLayer {
    return {
      id: "adopted",
      name: "cities",
      type: "geojson",
      source: { type: "geojson" },
      visible: true,
      opacity: 1,
      style: { ...DEFAULT_LAYER_STYLE },
      metadata: { sourceKind: ADOPTED_VECTOR_SOURCE_KIND },
      geojson: points(),
      ...patch,
    };
  }

  function savedLayer(layer: GeoLibreLayer): GeoLibreLayer {
    useAppStore.setState({ layers: [layer] });
    return projectFromStore(useAppStore.getState()).layers[0];
  }

  beforeEach(() => {
    useAppStore.setState({ layers: [] });
  });

  it("saves a URL-backed layer by URL, for the control to re-read", () => {
    const layer = savedLayer(
      adopted({ source: { type: "geojson", url: "https://example.com/cities.parquet" } }),
    );
    assert.equal(layer.geojson, undefined);
    assert.equal(needsAdoptedVectorReplay(layer), true);
  });

  it("saves a desktop file layer by path", () => {
    const layer = savedLayer(
      adopted({
        sourcePath: "/data/cities.geojson",
        metadata: { sourceKind: ADOPTED_VECTOR_SOURCE_KIND, localFileReloadable: true },
      }),
    );
    assert.equal(layer.geojson, undefined);
  });

  it("embeds a browser-picked file's features, like a drag-and-drop layer", () => {
    const layer = savedLayer(adopted());
    assert.equal(layer.geojson?.features.length, 2);
    assert.equal(needsAdoptedVectorReplay(layer), false);
  });
});

describe("refreshing adopted layers", () => {
  it("routes a URL-backed adopted layer through the vector control", () => {
    const layer: GeoLibreLayer = {
      id: "adopted",
      name: "cities",
      type: "geojson",
      source: { type: "geojson", url: "https://example.com/cities.parquet" },
      visible: true,
      opacity: 1,
      style: { ...DEFAULT_LAYER_STYLE },
      metadata: { sourceKind: ADOPTED_VECTOR_SOURCE_KIND },
      geojson: points(),
    };
    assert.equal(isVectorControlRefreshLayer(layer), true);
    // Its features live in the store, so a "clear on failure" policy works.
    assert.equal(supportsRefreshFailurePolicy(layer), true);
  });
});
