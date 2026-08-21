import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { syncLayer } from "../packages/map/src/layer-sync";
import {
  createPMTilesStoreLayer,
  type PMTilesStoreLayerOptions,
} from "../packages/map/src/pmtiles-layer";

/** A MapLibre layer definition as the sync passes it, read by key in the assertions below. */
type AddedLayer = Record<string, unknown> & { id: string };

/** Enough of a MapLibre map to record what a sync pass adds, starting from an empty style. */
function makeMapStub() {
  const addedSources: { id: string; source: Record<string, unknown> }[] = [];
  const addedLayers: AddedLayer[] = [];
  const sources = new Set<string>();
  const layers = new Set<string>();
  const map = {
    getStyle: () => ({ layers: [...layers].map((id) => ({ id, type: "fill" })) }),
    getLayer: (id: string) => (layers.has(id) ? { id, type: "fill" } : undefined),
    getSource: (id: string) => (sources.has(id) ? { id } : undefined),
    addSource: (id: string, source: Record<string, unknown>) => {
      sources.add(id);
      addedSources.push({ id, source });
    },
    addLayer: (layer: AddedLayer) => {
      layers.add(layer.id);
      addedLayers.push(layer);
    },
    removeLayer: () => {},
    removeSource: () => {},
    moveLayer: () => {},
    setLayoutProperty: () => {},
    setPaintProperty: () => {},
    setLayerZoomRange: () => {},
  };
  return { map, addedSources, addedLayers };
}

const archive: PMTilesStoreLayerOptions = {
  id: "layer-1",
  name: "Geologic units",
  url: "https://example.org/units.pmtiles",
  tileType: "vector",
  sourceLayers: ["units"],
};

describe("syncing a layer from createPMTilesStoreLayer", () => {
  it("adds the archive as a vector source and one MapLibre layer per declared id", () => {
    const layer = createPMTilesStoreLayer(archive);
    const { map, addedSources, addedLayers } = makeMapStub();

    syncLayer(map as never, layer);

    assert.deepEqual(addedSources[0], {
      id: "layer-1",
      source: { type: "vector", url: "pmtiles://https://example.org/units.pmtiles" },
    });
    // A layer whose nativeLayerIds name something else renders nothing while claiming it does.
    assert.deepEqual(
      addedLayers.map((added) => added.id),
      layer.metadata.nativeLayerIds,
    );
    for (const added of addedLayers) {
      assert.equal(added["source-layer"], "units");
      assert.equal(added.source, "layer-1");
    }
  });

  it("tells MapLibre when an archive holds MLT rather than MVT tiles", () => {
    const layer = createPMTilesStoreLayer({ ...archive, encoding: "mlt" });
    const { map, addedSources } = makeMapStub();

    syncLayer(map as never, layer);

    assert.deepEqual(addedSources[0]?.source, {
      type: "vector",
      url: "pmtiles://https://example.org/units.pmtiles",
      encoding: "mlt",
    });
  });

  it("leaves the encoding off a plain MVT archive, which is MapLibre's default", () => {
    const { map, addedSources } = makeMapStub();

    syncLayer(map as never, createPMTilesStoreLayer(archive));

    assert.deepEqual(Object.keys(addedSources[0]?.source ?? {}), ["type", "url"]);
  });

  it("adds a raster archive as a raster source and its single layer", () => {
    const layer = createPMTilesStoreLayer({ ...archive, tileType: "raster", sourceLayers: [] });
    const { map, addedSources, addedLayers } = makeMapStub();

    syncLayer(map as never, layer);

    assert.equal(addedSources[0]?.source.type, "raster");
    assert.deepEqual(
      addedLayers.map((added) => added.id),
      ["layer-1-raster"],
    );
  });

  it("renders a source layer whose name needs encoding in a layer id", () => {
    const layer = createPMTilesStoreLayer({ ...archive, sourceLayers: ["water lines"] });
    const { map, addedLayers } = makeMapStub();

    syncLayer(map as never, layer);

    assert.deepEqual(
      addedLayers.map((added) => added.id),
      layer.metadata.nativeLayerIds,
    );
    // The source-layer keeps the archive's own name; only the id is encoded.
    assert.equal(addedLayers[0]?.["source-layer"], "water lines");
    assert.deepEqual(layer.metadata.nativeLayerIds, [
      "layer-1-water_20lines-fill",
      "layer-1-water_20lines-line",
      "layer-1-water_20lines-circle",
    ]);
  });
});
