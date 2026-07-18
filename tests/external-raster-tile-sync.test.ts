import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import { syncLayer } from "../packages/map/src/layer-sync";

// Records the maplibre operations a sync performs so a test can assert that a
// generic external raster registration actually builds a source and layer.
interface MapCall {
  method: string;
  args: unknown[];
}

// A fake map where no source/layer exists yet, so syncLayer must create them.
function makeEmptyMapStub() {
  const calls: MapCall[] = [];
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
    };
  const map = {
    getStyle: () => ({ layers: [] }),
    getLayer: () => undefined,
    getSource: () => undefined,
    setLayoutProperty: record("setLayoutProperty"),
    setPaintProperty: record("setPaintProperty"),
    setLayerZoomRange: record("setLayerZoomRange"),
    moveLayer: record("moveLayer"),
    removeLayer: record("removeLayer"),
    removeSource: record("removeSource"),
    addLayer: record("addLayer"),
    addSource: record("addSource"),
  };
  return { map, calls };
}

// A fake map where the source and layer already exist (the second sync pass,
// e.g. after a paint/visibility change), so syncLayer must update the existing
// layer in place rather than recreating the source.
function makePopulatedMapStub(layerId: string) {
  const calls: MapCall[] = [];
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
    };
  const map = {
    getStyle: () => ({ layers: [{ id: layerId }] }),
    getLayer: (id: string) =>
      id === layerId ? { id, type: "raster", minzoom: 0, maxzoom: 22 } : undefined,
    getSource: () => ({ type: "raster" }),
    getFilter: () => undefined,
    setLayoutProperty: record("setLayoutProperty"),
    setPaintProperty: record("setPaintProperty"),
    setLayerZoomRange: record("setLayerZoomRange"),
    moveLayer: record("moveLayer"),
    removeLayer: record("removeLayer"),
    removeSource: record("removeSource"),
    addLayer: record("addLayer"),
    addSource: record("addSource"),
  };
  return { map, calls };
}

// The store layer GeoLibre derives (via createExternalNativeStoreLayer) from a
// third-party plugin's generic raster registration — e.g. the GeoLibre D2S
// plugin handing the host titiler XYZ tiles. It carries no GeoLibre-internal
// sourceKind, which is exactly the case that previously rendered nothing.
function d2sRasterStoreLayer(patch: Partial<GeoLibreLayer> = {}): GeoLibreLayer {
  const id = "d2s-raster-1";
  return {
    id,
    name: "Ortho (RGB)",
    type: "raster",
    source: {
      type: "raster",
      tiles: ["https://titiler.example.com/tiles/{z}/{x}/{y}.png?url=cog"],
      tileSize: 256,
      bounds: [-90, 30, -89, 31],
      minzoom: 0,
      maxzoom: 22,
    },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {
      externalNativeLayer: true,
      nativeLayerIds: [`${id}-layer`],
      sourceIds: [`${id}-source`],
      sourceId: `${id}-source`,
    },
    ...patch,
  };
}

describe("generic external raster tile layers", () => {
  it("builds a raster source and layer from the registration's own tiles", () => {
    const { map, calls } = makeEmptyMapStub();

    syncLayer(map as never, d2sRasterStoreLayer());

    const addSource = calls.find((c) => c.method === "addSource");
    assert.ok(addSource, "expected a raster source to be created");
    assert.equal(addSource.args[0], "d2s-raster-1-source");
    const sourceSpec = addSource.args[1] as Record<string, unknown>;
    assert.equal(sourceSpec.type, "raster");
    assert.deepEqual(sourceSpec.tiles, [
      "https://titiler.example.com/tiles/{z}/{x}/{y}.png?url=cog",
    ]);
    assert.equal(sourceSpec.tileSize, 256);
    assert.deepEqual(sourceSpec.bounds, [-90, 30, -89, 31]);
    assert.equal(sourceSpec.minzoom, 0);
    assert.equal(sourceSpec.maxzoom, 22);

    const addLayer = calls.find((c) => c.method === "addLayer");
    assert.ok(addLayer, "expected a raster layer to be created");
    const layerSpec = addLayer.args[0] as Record<string, unknown>;
    assert.equal(layerSpec.id, "d2s-raster-1-layer");
    assert.equal(layerSpec.type, "raster");
    assert.equal(layerSpec.source, "d2s-raster-1-source");
  });

  it("honors visibility from the store layer", () => {
    const { map, calls } = makeEmptyMapStub();

    syncLayer(map as never, d2sRasterStoreLayer({ visible: false }));

    const addLayer = calls.find((c) => c.method === "addLayer");
    assert.ok(addLayer, "expected a raster layer to be created");
    const layerSpec = addLayer.args[0] as {
      layout?: { visibility?: string };
    };
    assert.equal(layerSpec.layout?.visibility, "none");
  });

  it("forwards attribution from the registration's source", () => {
    const { map, calls } = makeEmptyMapStub();
    const layer = d2sRasterStoreLayer();
    layer.source.attribution = "© Example Imagery";

    syncLayer(map as never, layer);

    const addSource = calls.find((c) => c.method === "addSource");
    assert.ok(addSource, "expected a raster source to be created");
    const sourceSpec = addSource.args[1] as Record<string, unknown>;
    assert.equal(sourceSpec.attribution, "© Example Imagery");
  });

  it("forwards the tms scheme from the registration's source", () => {
    const { map, calls } = makeEmptyMapStub();
    const layer = d2sRasterStoreLayer();
    layer.source.scheme = "tms";

    syncLayer(map as never, layer);

    const addSource = calls.find((c) => c.method === "addSource");
    assert.ok(addSource, "expected a raster source to be created");
    const sourceSpec = addSource.args[1] as Record<string, unknown>;
    assert.equal(sourceSpec.scheme, "tms");
  });

  // The source is built once and frozen: a re-sync updates the layer (paint,
  // visibility, ordering) in place but does not rebuild the source, so tile
  // URLs registered on the first sync stay fixed for the source's lifetime.
  it("updates the existing layer without recreating the source on re-sync", () => {
    const { map, calls } = makePopulatedMapStub("d2s-raster-1-layer");

    syncLayer(map as never, d2sRasterStoreLayer({ visible: false }));

    assert.equal(
      calls.find((c) => c.method === "addSource"),
      undefined,
      "should not recreate an already-present source",
    );
    assert.equal(
      calls.find((c) => c.method === "addLayer"),
      undefined,
      "should not recreate an already-present layer",
    );
    const setVisibility = calls.find(
      (c) => c.method === "setLayoutProperty" && c.args[1] === "visibility",
    );
    assert.ok(setVisibility, "expected visibility to be updated in place");
    assert.equal(setVisibility.args[2], "none");
  });
});
