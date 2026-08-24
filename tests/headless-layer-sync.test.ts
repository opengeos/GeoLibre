import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import { createLayerSync } from "../packages/map/src/headless";

/**
 * Stateful maplibre stub that keeps a real style-layer order, so a test can
 * assert the stack `createLayerSync` leaves behind rather than the calls it
 * made getting there.
 */
function makeMapStub() {
  const layers: { id: string; source?: string }[] = [];
  const sources = new Set<string>();
  const map = {
    getStyle: () => ({ layers: [...layers] }),
    getLayersOrder: () => layers.map(({ id }) => id),
    getLayer: (id: string) => layers.find((layer) => layer.id === id),
    getSource: (id: string) => (sources.has(id) ? { id } : undefined),
    addSource: (id: string) => {
      sources.add(id);
    },
    addLayer: (spec: { id: string; source?: string }, beforeId?: string) => {
      const index = beforeId ? layers.findIndex((layer) => layer.id === beforeId) : -1;
      if (index >= 0) layers.splice(index, 0, spec);
      else layers.push(spec);
    },
    removeLayer: (id: string) => {
      const index = layers.findIndex((layer) => layer.id === id);
      if (index >= 0) layers.splice(index, 1);
    },
    removeSource: (id: string) => {
      sources.delete(id);
    },
    moveLayer: () => {},
    setLayoutProperty: () => {},
    setPaintProperty: () => {},
    setLayerZoomRange: () => {},
  };
  return { map, order: () => layers.map(({ id }) => id) };
}

function tileLayer(id: string): GeoLibreLayer {
  return {
    id,
    name: id,
    type: "xyz",
    source: {
      type: "raster",
      tiles: [`https://tiles.example.com/${id}/{z}/{x}/{y}.png`],
      tileSize: 256,
    },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
  };
}

describe("createLayerSync", () => {
  it("stacks the first sync bottom-to-top in input order", () => {
    const { map, order } = makeMapStub();
    const sync = createLayerSync(map as never);

    sync.sync([tileLayer("a"), tileLayer("b"), tileLayer("c")]);

    assert.deepEqual(order(), ["layer-a-raster", "layer-b-raster", "layer-c-raster"]);
  });

  it("restores the requested order when a layer moves", () => {
    const { map, order } = makeMapStub();
    const sync = createLayerSync(map as never);

    sync.sync([tileLayer("a"), tileLayer("b"), tileLayer("c")]);
    // "c" is moved to the bottom of the stack.
    sync.sync([tileLayer("c"), tileLayer("a"), tileLayer("b")]);

    assert.deepEqual(order(), ["layer-c-raster", "layer-a-raster", "layer-b-raster"]);
  });

  it("puts a layer inserted in the middle below the layers above it", () => {
    const { map, order } = makeMapStub();
    const sync = createLayerSync(map as never);

    sync.sync([tileLayer("a"), tileLayer("c")]);
    sync.sync([tileLayer("a"), tileLayer("b"), tileLayer("c")]);

    assert.deepEqual(order(), ["layer-a-raster", "layer-b-raster", "layer-c-raster"]);
  });

  it("removes a layer dropped from the input", () => {
    const { map, order } = makeMapStub();
    const sync = createLayerSync(map as never);

    sync.sync([tileLayer("a"), tileLayer("b")]);
    sync.sync([tileLayer("b")]);

    assert.deepEqual(order(), ["layer-b-raster"]);
  });

  it("removes every layer it added on dispose", () => {
    const { map, order } = makeMapStub();
    const sync = createLayerSync(map as never);

    sync.sync([tileLayer("a"), tileLayer("b")]);
    sync.dispose();

    assert.deepEqual(order(), []);
  });
});
