import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer, type LayerStyle } from "@geolibre/core";
import { syncLayer } from "../packages/map/src/layer-sync";

// Stateful fake MapLibre map, mirroring tests/point-renderer-sync.test.ts: it
// tracks sources and layers across sync passes so a test can assert which
// companion layers/sources the symbology pack produces and removes.
function makeMap() {
  const sources = new Map<string, Record<string, unknown>>();
  const layers = new Map<string, Record<string, unknown>>();
  const calls: { method: string; args: unknown[] }[] = [];
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
    };
  const map = {
    getSource: (id: string) => (sources.has(id) ? { setData: record("setData") } : undefined),
    addSource: (id: string, spec: Record<string, unknown>) => {
      sources.set(id, spec);
      calls.push({ method: "addSource", args: [id, spec] });
    },
    removeSource: (id: string) => {
      sources.delete(id);
      calls.push({ method: "removeSource", args: [id] });
    },
    getLayer: (id: string) => (layers.has(id) ? { id, ...layers.get(id) } : undefined),
    addLayer: (spec: Record<string, unknown>, beforeId?: string) => {
      layers.set(spec.id as string, spec);
      calls.push({ method: "addLayer", args: [spec, beforeId] });
    },
    removeLayer: (id: string) => {
      layers.delete(id);
      calls.push({ method: "removeLayer", args: [id] });
    },
    getFilter: (id: string) => layers.get(id)?.filter,
    setFilter: record("setFilter"),
    setPaintProperty: record("setPaintProperty"),
    setLayoutProperty: record("setLayoutProperty"),
    setLayerZoomRange: record("setLayerZoomRange"),
    moveLayer: record("moveLayer"),
    getStyle: () => ({
      layers: [...layers.values()],
      sources: Object.fromEntries(sources),
    }),
    once: () => {},
  };
  return { map, sources, layers, calls };
}

function polygonLayer(style: Partial<LayerStyle> = {}): GeoLibreLayer {
  return {
    id: "poly",
    name: "Polygons",
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE, ...style },
    metadata: {},
    geojson: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { name: "a" },
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [0, 0],
                [10, 0],
                [10, 10],
                [0, 10],
                [0, 0],
              ],
            ],
          },
        },
      ],
    },
  };
}

function lineLayer(style: Partial<LayerStyle> = {}): GeoLibreLayer {
  return {
    id: "lines",
    name: "Lines",
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE, ...style },
    metadata: {},
    geojson: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: {
            type: "LineString",
            coordinates: [
              [0, 0],
              [10, 10],
            ],
          },
        },
      ],
    },
  };
}

describe("inverted fill sync", () => {
  it("swaps the fill layer for a mask fill on its own source", () => {
    const { map, layers, sources } = makeMap();
    syncLayer(map as never, polygonLayer());
    assert.ok(layers.has("layer-poly-fill"));

    syncLayer(map as never, polygonLayer({ invertedFillEnabled: true }));
    assert.ok(!layers.has("layer-poly-fill"));
    const inverted = layers.get("layer-poly-inverted-fill") as {
      type: string;
      source: string;
      metadata: Record<string, unknown>;
    };
    assert.equal(inverted.type, "fill");
    assert.equal(inverted.source, "source-poly-inverted");
    // Internal chrome: hidden from the layer control.
    assert.equal(inverted.metadata["geolibre:internal"], true);
    const maskData = sources.get("source-poly-inverted")?.data as
      | GeoJSON.FeatureCollection
      | undefined;
    assert.equal(maskData?.features.length, 1);
  });

  it("falls back to the normal filtered fill while a time filter is active", () => {
    const { map, layers } = makeMap();
    const layer = polygonLayer({ invertedFillEnabled: true });
    (layer as { timeFilter?: unknown[] }).timeFilter = [">=", ["get", "t"], 0];
    syncLayer(map as never, layer);
    // The mask derives from raw features and cannot honor the filter, so the
    // normal (filtered) fill renders instead.
    assert.ok(layers.has("layer-poly-fill"));
    assert.ok(!layers.has("layer-poly-inverted-fill"));
  });

  it("restores the normal fill and drops the mask when disabled", () => {
    const { map, layers, sources } = makeMap();
    syncLayer(map as never, polygonLayer({ invertedFillEnabled: true }));
    assert.ok(layers.has("layer-poly-inverted-fill"));

    syncLayer(map as never, polygonLayer());
    assert.ok(layers.has("layer-poly-fill"));
    assert.ok(!layers.has("layer-poly-inverted-fill"));
    assert.ok(!sources.has("source-poly-inverted"));
  });
});

describe("line decoration sync", () => {
  it("adds a line-placed symbol layer with the decoration icon", () => {
    const { map, layers } = makeMap();
    syncLayer(map as never, lineLayer({ lineDecoration: "arrow", lineDecorationSpacing: 120 }));
    const decoration = layers.get("layer-lines-line-decoration") as {
      type: string;
      layout: Record<string, unknown>;
      metadata: Record<string, unknown>;
    };
    assert.equal(decoration.type, "symbol");
    assert.equal(decoration.layout["symbol-placement"], "line");
    assert.equal(decoration.layout["symbol-spacing"], 120);
    assert.match(String(decoration.layout["icon-image"]), /^geolibre-line-decoration-arrow-/);
    assert.equal(decoration.metadata["geolibre:internal"], true);
  });

  it("removes the decoration layer when switched off", () => {
    const { map, layers } = makeMap();
    syncLayer(map as never, lineLayer({ lineDecoration: "circle" }));
    assert.ok(layers.has("layer-lines-line-decoration"));

    syncLayer(map as never, lineLayer());
    assert.ok(!layers.has("layer-lines-line-decoration"));
  });
});

describe("geometry generator sync", () => {
  it("renders centroids through a companion source and circle layer", () => {
    const { map, layers, sources } = makeMap();
    syncLayer(map as never, polygonLayer({ geometryGenerator: "centroid" }));

    const derived = sources.get("source-poly-generator")?.data as
      | GeoJSON.FeatureCollection
      | undefined;
    assert.equal(derived?.features.length, 1);
    assert.equal(derived?.features[0].geometry.type, "Point");
    const circle = layers.get("layer-poly-generator-circle") as {
      type: string;
      metadata: Record<string, unknown>;
    };
    assert.equal(circle.type, "circle");
    assert.equal(circle.metadata["geolibre:internal"], true);
    assert.ok(!layers.has("layer-poly-generator-fill"));
  });

  it("renders buffers as fill + line companion layers", () => {
    const { map, layers } = makeMap();
    syncLayer(
      map as never,
      polygonLayer({
        geometryGenerator: "buffer",
        geometryGeneratorBufferDistance: 5000,
      }),
    );
    assert.equal((layers.get("layer-poly-generator-fill") as { type: string }).type, "fill");
    assert.equal((layers.get("layer-poly-generator-line") as { type: string }).type, "line");
    assert.ok(!layers.has("layer-poly-generator-circle"));
  });

  it("suppresses generator layers while a time filter is active", () => {
    const { map, layers, sources } = makeMap();
    syncLayer(map as never, polygonLayer({ geometryGenerator: "centroid" }));
    assert.ok(layers.has("layer-poly-generator-circle"));

    const filtered = polygonLayer({ geometryGenerator: "centroid" });
    (filtered as { timeFilter?: unknown[] }).timeFilter = [">=", ["get", "t"], 0];
    syncLayer(map as never, filtered);
    // Derived features cannot honor the filter, so they are suppressed
    // rather than rendering hidden features.
    assert.ok(!layers.has("layer-poly-generator-circle"));
    assert.ok(!sources.has("source-poly-generator"));
  });

  it("suppresses generator layers while the layer renders as an extrusion", () => {
    const { map, layers, sources } = makeMap();
    syncLayer(map as never, polygonLayer({ geometryGenerator: "centroid" }));
    assert.ok(layers.has("layer-poly-generator-circle"));

    // Turning on extrusion must tear the flat companion symbology down even
    // though geometryGenerator is still set (the Style Panel hides the
    // controls without resetting the value).
    syncLayer(
      map as never,
      polygonLayer({ geometryGenerator: "centroid", extrusionEnabled: true }),
    );
    assert.ok(layers.has("layer-poly-extrusion"));
    assert.ok(!layers.has("layer-poly-generator-circle"));
    assert.ok(!sources.has("source-poly-generator"));
  });

  it("tears companion layers and source down when set back to none", () => {
    const { map, layers, sources } = makeMap();
    syncLayer(map as never, polygonLayer({ geometryGenerator: "centroid" }));
    assert.ok(layers.has("layer-poly-generator-circle"));

    syncLayer(map as never, polygonLayer());
    assert.ok(!layers.has("layer-poly-generator-circle"));
    assert.ok(!layers.has("layer-poly-generator-fill"));
    assert.ok(!layers.has("layer-poly-generator-line"));
    assert.ok(!sources.has("source-poly-generator"));
  });
});
