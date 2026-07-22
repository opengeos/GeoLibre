import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "../packages/core/src/index";
import { legendSwatchesForLayer } from "../apps/geolibre-desktop/src/lib/print-legend";
import { autoLegendItems, layerSwatchShape } from "../apps/geolibre-desktop/src/lib/layer-swatch";

function layer(over: Partial<GeoLibreLayer>): GeoLibreLayer {
  return {
    id: "l",
    name: "Layer",
    type: "vector-tiles",
    source: { type: "vector" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
    ...over,
  } as GeoLibreLayer;
}

describe("legendSwatchesForLayer", () => {
  it("gives a single fill swatch for a single-symbol vector layer", () => {
    const s = legendSwatchesForLayer(
      layer({ style: { ...DEFAULT_LAYER_STYLE, fillColor: "#ff0000" } }),
    );
    assert.equal(s.length, 1);
    assert.equal(s[0].color, "#ff0000");
  });

  it("gives a neutral swatch for a raster layer", () => {
    const s = legendSwatchesForLayer(layer({ type: "xyz", source: { type: "raster" } }));
    assert.equal(s.length, 1);
    assert.equal(s[0].color, "#94a3b8");
  });

  it("returns no swatches for a non-legend type (3d-tiles)", () => {
    assert.deepEqual(legendSwatchesForLayer(layer({ type: "3d-tiles" })), []);
  });
});

describe("layerSwatchShape", () => {
  it("uses metadata.geometryType when present", () => {
    assert.equal(layerSwatchShape(layer({ metadata: { geometryType: "point" } })), "circle");
    assert.equal(layerSwatchShape(layer({ metadata: { geometryType: "line" } })), "line");
    assert.equal(layerSwatchShape(layer({ metadata: { geometryType: "polygon" } })), "square");
  });

  it("falls back to sampling local GeoJSON geometry", () => {
    const geojson = {
      type: "FeatureCollection" as const,
      features: [
        {
          type: "Feature" as const,
          properties: {},
          geometry: { type: "MultiLineString" as const, coordinates: [] },
        },
      ],
    };
    assert.equal(layerSwatchShape(layer({ type: "geojson", metadata: {}, geojson })), "line");
  });

  it("classifies raster/imagery layers as raster", () => {
    assert.equal(layerSwatchShape(layer({ type: "cog", metadata: {} })), "raster");
    assert.equal(layerSwatchShape(layer({ type: "xyz", metadata: {} })), "raster");
  });
});

describe("autoLegendItems", () => {
  it("excludes hidden layers and lists visible ones top-first", () => {
    const layers = [
      layer({ id: "a", name: "A", visible: true, metadata: { geometryType: "point" } }),
      layer({ id: "b", name: "B", visible: false }),
      layer({ id: "c", name: "C", visible: true, metadata: { geometryType: "line" } }),
    ];
    const items = autoLegendItems(layers);
    // Store is bottom-first; legend is top-first → C then A; B hidden.
    assert.deepEqual(
      items.map((i) => i.label),
      ["C", "A"],
    );
    assert.equal(items[0].shape, "line");
    assert.equal(items[1].shape, "circle");
  });

  it("expands a categorized layer into a name row plus one row per class", () => {
    const styled = layer({
      id: "cat",
      name: "Era",
      metadata: { geometryType: "polygon" },
      style: {
        ...DEFAULT_LAYER_STYLE,
        vectorStyleMode: "categorized",
        vectorStyleStops: [
          { value: "old", color: "#8c2d04" },
          { value: "new", color: "#08306b" },
        ],
      },
    });
    const items = autoLegendItems([styled]);
    assert.equal(items[0].label, "Era"); // name row
    assert.ok(items.some((i) => i.label === "old" && i.color === "#8c2d04"));
    assert.ok(items.some((i) => i.label === "new" && i.color === "#08306b"));
  });
});
