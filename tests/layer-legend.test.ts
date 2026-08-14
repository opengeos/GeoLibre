import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "../packages/core/src/index";
import { legendSwatchesForLayer } from "../apps/geolibre-desktop/src/lib/print-legend";
import { layerSwatchShape } from "../apps/geolibre-desktop/src/lib/layer-swatch";

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

  it("does not classify 3D/point-cloud/media layers as raster", () => {
    // These are neither vector nor imagery — they must not get the raster glyph.
    assert.notEqual(layerSwatchShape(layer({ type: "3d-tiles", metadata: {} })), "raster");
    assert.notEqual(layerSwatchShape(layer({ type: "lidar", metadata: {} })), "raster");
    assert.notEqual(layerSwatchShape(layer({ type: "video", metadata: {} })), "raster");
  });
});
