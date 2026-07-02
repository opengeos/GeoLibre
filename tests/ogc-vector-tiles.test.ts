import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  firstVectorSource,
  hasTilePlaceholders,
  styleSourceLayers,
  tileJsonConfig,
} from "../apps/geolibre-desktop/src/lib/ogc-vector-tiles";

describe("hasTilePlaceholders", () => {
  it("recognizes a MapLibre {z}/{x}/{y} template", () => {
    assert.equal(
      hasTilePlaceholders("https://ex.com/tiles/{z}/{y}/{x}?f=mvt"),
      true,
    );
    assert.equal(hasTilePlaceholders("https://ex.com/{Z}/{X}/{Y}.pbf"), true);
  });

  it("treats TileJSON and OGC matrix templates as non-templates", () => {
    assert.equal(
      hasTilePlaceholders("https://ex.com/tiles/WebMercatorQuad?f=tilejson"),
      false,
    );
    assert.equal(
      hasTilePlaceholders("https://ex.com/{tileMatrix}/{tileRow}/{tileCol}"),
      false,
    );
  });
});

describe("firstVectorSource", () => {
  it("returns the first vector source with its id", () => {
    const style = {
      sources: {
        basemap: { type: "raster", tiles: ["https://ex.com/{z}/{x}/{y}.png"] },
        bgt: { type: "vector", tiles: ["https://ex.com/{z}/{y}/{x}?f=mvt"] },
      },
      layers: [],
    };
    const result = firstVectorSource(style);
    assert.equal(result?.id, "bgt");
    assert.equal(result?.source.type, "vector");
  });

  it("returns null when there is no vector source", () => {
    assert.equal(firstVectorSource({ sources: {}, layers: [] }), null);
    assert.equal(firstVectorSource({}), null);
  });
});

describe("styleSourceLayers", () => {
  const style = {
    sources: { bgt: { type: "vector" } },
    layers: [
      { id: "a", source: "bgt", "source-layer": "roads" },
      { id: "b", source: "bgt", "source-layer": "roads" },
      { id: "c", source: "bgt", "source-layer": "buildings" },
      { id: "d", source: "other", "source-layer": "elsewhere" },
      { id: "e", source: "bgt" },
    ],
  };

  it("collects distinct source-layer names in first-seen order", () => {
    assert.deepEqual(styleSourceLayers(style), [
      "roads",
      "buildings",
      "elsewhere",
    ]);
  });

  it("filters to a single source when an id is given", () => {
    assert.deepEqual(styleSourceLayers(style, "bgt"), ["roads", "buildings"]);
  });
});

describe("tileJsonConfig", () => {
  it("hands MapLibre the TileJSON URL and reads zoom/bounds/layers", () => {
    const config = tileJsonConfig(
      {
        name: "Example",
        minzoom: 5,
        maxzoom: 14,
        bounds: [-180, -85, 180, 85],
        vector_layers: [{ id: "roads" }, { id: "water" }, { bad: true }],
      },
      "https://ex.com/tiles?f=tilejson",
    );
    assert.equal(config.url, "https://ex.com/tiles?f=tilejson");
    assert.equal(config.name, "Example");
    assert.equal(config.minzoom, 5);
    assert.equal(config.maxzoom, 14);
    assert.deepEqual(config.bounds, [-180, -85, 180, 85]);
    assert.deepEqual(config.sourceLayers, ["roads", "water"]);
  });

  it("omits source layers when the TileJSON advertises none", () => {
    const config = tileJsonConfig({}, "https://ex.com/tiles?f=tilejson");
    assert.equal(config.url, "https://ex.com/tiles?f=tilejson");
    assert.equal(config.sourceLayers, undefined);
  });
});
