import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import { createLayerSync } from "../packages/map/src/headless";
import { arcgisOpacity } from "../packages/map/src/arcgis-vector-style";

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
  it("scales ArcGIS camera opacity without invalidating the top-level zoom expression", () => {
    assert.deepEqual(arcgisOpacity(["interpolate", ["linear"], ["zoom"], 0, 0.2, 18, 1], 0.5), [
      "interpolate",
      ["linear"],
      ["zoom"],
      0,
      0.1,
      18,
      0.5,
    ]);
    assert.deepEqual(arcgisOpacity(["step", ["zoom"], 0.2, 10, 0.8], 0.5), [
      "step",
      ["zoom"],
      0.1,
      10,
      0.4,
    ]);
    // `coalesce` arguments and a `let` result are the only other places
    // MapLibre lets a zoom curve live; descend so it stays a direct input.
    assert.deepEqual(
      arcgisOpacity(["coalesce", ["step", ["zoom"], 0.2, 10, 0.8], ["get", "alpha"], 1], 0.5),
      ["coalesce", ["step", ["zoom"], 0.1, 10, 0.4], ["*", ["get", "alpha"], 0.5], 0.5],
    );
    assert.deepEqual(
      arcgisOpacity(
        ["let", "base", 0.2, ["interpolate", ["linear"], ["zoom"], 0, 0.2, 18, 1]],
        0.5,
      ),
      ["let", "base", 0.2, ["interpolate", ["linear"], ["zoom"], 0, 0.1, 18, 0.5]],
    );
    // A `case`/`match` cannot legally hold a zoom curve, so wrapping it is safe.
    assert.deepEqual(arcgisOpacity(["case", ["get", "hidden"], 0, 1], 0.5), [
      "*",
      ["case", ["get", "hidden"], 0, 1],
      0.5,
    ]);
    assert.deepEqual(
      arcgisOpacity(
        {
          stops: [
            [0, 0.2],
            [18, 1],
          ],
        },
        0.5,
      ),
      {
        stops: [
          [0, 0.1],
          [18, 0.5],
        ],
      },
    );
  });
  it("rebuilds persisted ArcGIS layers on each map and removes their sources", () => {
    const layer: GeoLibreLayer = {
      ...tileLayer("arcgis"),
      type: "arcgis",
      source: {
        arcgisSources: {
          parcels: { type: "vector", tiles: ["https://example.com/{z}/{x}/{y}.pbf"] },
        },
        arcgisLayers: [
          {
            id: "parcels-fill",
            type: "fill",
            source: "parcels",
            "source-layer": "parcels",
            paint: { "fill-opacity": 0.8 },
          },
        ],
      },
      metadata: {
        externalNativeLayer: true,
        nativeLayerIds: ["parcels-fill"],
        sourceIds: ["parcels"],
      },
      opacity: 0.5,
    };
    for (let renderer = 0; renderer < 2; renderer++) {
      const { map, order } = makeMapStub();
      const paints: unknown[][] = [];
      Object.assign(map, {
        getPaintProperty: () => undefined,
        getLayoutProperty: () => undefined,
        getFilter: () => undefined,
        setFilter: () => {},
        setPaintProperty: (...args: unknown[]) => paints.push(args),
      });
      const sync = createLayerSync(map as never);
      sync.sync([structuredClone(layer)]);
      assert.deepEqual(order(), ["parcels-fill"]);
      assert.ok(map.getSource("parcels"));
      assert.ok(paints.some((args) => args[1] === "fill-opacity" && args[2] === 0.4));
      sync.sync([{ ...layer, opacity: 0 }]);
      assert.ok(paints.some((args) => args[1] === "fill-opacity" && args[2] === 0));
      sync.dispose();
      assert.deepEqual(order(), []);
      assert.equal(map.getSource("parcels"), undefined);
    }
  });
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
