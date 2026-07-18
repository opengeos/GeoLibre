import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  firstVectorSource,
  hasTilePlaceholders,
  resolveOgcVectorTiles,
  styleSourceLayers,
  tileJsonConfig,
  unionCollectionBounds,
} from "../apps/geolibre-desktop/src/lib/ogc-vector-tiles";

describe("hasTilePlaceholders", () => {
  it("recognizes a MapLibre {z}/{x}/{y} template", () => {
    assert.equal(hasTilePlaceholders("https://ex.com/tiles/{z}/{y}/{x}?f=mvt"), true);
    assert.equal(hasTilePlaceholders("https://ex.com/{Z}/{X}/{Y}.pbf"), true);
  });

  it("treats TileJSON and OGC matrix templates as non-templates", () => {
    assert.equal(hasTilePlaceholders("https://ex.com/tiles/WebMercatorQuad?f=tilejson"), false);
    assert.equal(hasTilePlaceholders("https://ex.com/{tileMatrix}/{tileRow}/{tileCol}"), false);
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
    assert.deepEqual(styleSourceLayers(style), ["roads", "buildings", "elsewhere"]);
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

  it("keeps only a finite [lng, lat(, zoom)] center", () => {
    assert.deepEqual(tileJsonConfig({ center: [5, 52, 8] }, "u").center, [5, 52, 8]);
    assert.equal(tileJsonConfig({ center: [5, Infinity] }, "u").center, undefined);
    assert.equal(tileJsonConfig({ center: [1, 2, 3, 4] }, "u").center, undefined);
  });
});

describe("unionCollectionBounds", () => {
  it("unions the lon/lat bboxes of an OGC collections list", () => {
    const collections = [
      { extent: { spatial: { bbox: [[-1.6, 48, 12.4, 56.1]], crs: "CRS84" } } },
      { extent: { spatial: { bbox: [[3, 50, 7, 53]] } } }, // crs omitted = CRS84
    ];
    assert.deepEqual(unionCollectionBounds(collections), [-1.6, 48, 12.4, 56.1]);
  });

  it("ignores collections with a non-lon/lat crs or no usable bbox", () => {
    assert.equal(
      unionCollectionBounds([
        { extent: { spatial: { bbox: [[0, 0, 1, 1]], crs: "EPSG:3857" } } },
        { extent: {} },
        {},
      ]),
      undefined,
    );
    assert.equal(unionCollectionBounds(undefined), undefined);
  });
});

// The `{z}/{x}/{y}` template path resolves without any network request, so it
// can be exercised directly.
describe("resolveOgcVectorTiles (template path)", () => {
  it("normalizes uppercase placeholders MapLibre would not substitute", async () => {
    const config = await resolveOgcVectorTiles({
      tilesUrl: "https://ex.com/{Z}/{Y}/{X}?f=mvt",
      sourceLayers: ["roads"],
    });
    assert.deepEqual(config.tiles, ["https://ex.com/{z}/{y}/{x}?f=mvt"]);
    assert.deepEqual(config.sourceLayers, ["roads"]);
  });

  it("always returns sourceLayers as an array", async () => {
    const config = await resolveOgcVectorTiles({
      tilesUrl: "https://ex.com/{z}/{x}/{y}",
    });
    assert.ok(Array.isArray(config.sourceLayers));
    assert.equal(config.sourceLayers.length, 0);
  });
});

// Exercises the full resolver against a stubbed OGC API: a TileJSON without
// bounds, then the collections extent used as the fallback.
describe("resolveOgcVectorTiles (bounds fallback)", () => {
  it("derives config.bounds from the /collections extent", async () => {
    const responses: Record<string, unknown> = {
      "https://ex.com/ogc/v1/tiles/WMQ?f=tilejson": {
        tilejson: "3.0.0",
        minzoom: 17,
        maxzoom: 17,
        vector_layers: [{ id: "roads" }],
      },
      "https://ex.com/ogc/v1/collections?f=json": {
        collections: [{ extent: { spatial: { bbox: [[3, 50, 7, 53]], crs: "CRS84" } } }],
      },
    };
    const original = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = ((input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      const body = responses[url];
      return Promise.resolve({
        ok: body !== undefined,
        status: body !== undefined ? 200 : 404,
        json: async () => body ?? {},
      } as Response);
    }) as typeof fetch;
    try {
      const config = await resolveOgcVectorTiles({
        tilesUrl: "https://ex.com/ogc/v1/tiles/WMQ?f=tilejson",
      });
      assert.deepEqual(config.bounds, [3, 50, 7, 53]);
      assert.deepEqual(config.sourceLayers, ["roads"]);
      assert.equal(config.minzoom, 17);
      assert.ok(calls.includes("https://ex.com/ogc/v1/collections?f=json"));
    } finally {
      globalThis.fetch = original;
    }
  });
});
