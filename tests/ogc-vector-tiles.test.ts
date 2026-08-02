import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  firstVectorSource,
  hasTilePlaceholders,
  resolveDocumentUrl,
  resolveOgcVectorTiles,
  styleSourceLayers,
  tileJsonConfig,
  unionCollectionBounds,
} from "../apps/geolibre-desktop/src/lib/ogc-vector-tiles";

/**
 * Installs a `globalThis.fetch` stub answering from a URL → document map, and
 * returns the URLs requested plus a restore function.
 */
function stubFetch(responses: Record<string, unknown>) {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const body = responses[url];
    return Promise.resolve({
      ok: body !== undefined,
      status: body !== undefined ? 200 : 404,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => body ?? {},
    } as Response);
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = original) };
}

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

describe("resolveDocumentUrl", () => {
  const style =
    "https://tiles.arcgis.com/tiles/org/arcgis/rest/services/Svc/VectorTileServer/resources/styles/root.json";

  it("resolves an Esri style's relative source url against the style URL", () => {
    assert.equal(
      resolveDocumentUrl("../../", style),
      "https://tiles.arcgis.com/tiles/org/arcgis/rest/services/Svc/VectorTileServer/",
    );
  });

  it("keeps {z}/{y}/{x} braces unescaped so MapLibre can substitute them", () => {
    assert.equal(
      resolveDocumentUrl(
        "tile/{z}/{y}/{x}.pbf",
        "https://tiles.arcgis.com/tiles/org/arcgis/rest/services/Svc/VectorTileServer/",
      ),
      "https://tiles.arcgis.com/tiles/org/arcgis/rest/services/Svc/VectorTileServer/tile/{z}/{y}/{x}.pbf",
    );
  });

  it("leaves an absolute URL and passes through when there is no base", () => {
    assert.equal(resolveDocumentUrl("https://ex.com/a.json", style), "https://ex.com/a.json");
    assert.equal(resolveDocumentUrl("../../", undefined), "../../");
  });
});

// An Esri `VectorTileServer` document is not conforming TileJSON: its `tiles`
// are relative to the service. MapLibre would resolve them against the app
// origin, so the resolver must emit absolute templates instead (GeoLibre#1639).
describe("tileJsonConfig (relative tiles)", () => {
  const serviceUrl =
    "https://tiles.arcgis.com/tiles/org/arcgis/rest/services/Svc/VectorTileServer/";

  it("emits absolute tiles and drops the document url", () => {
    const config = tileJsonConfig(
      { name: "Svc", maxzoom: 22, tiles: ["tile/{z}/{y}/{x}.pbf"] },
      serviceUrl,
    );
    assert.deepEqual(config.tiles, [`${serviceUrl}tile/{z}/{y}/{x}.pbf`]);
    assert.equal(config.url, undefined);
    assert.equal(config.maxzoom, 22);
  });

  it("leaves a conforming TileJSON to be loaded by MapLibre itself", () => {
    const config = tileJsonConfig(
      { tilejson: "3.0.0", tiles: ["https://ex.com/{z}/{x}/{y}.pbf"] },
      "https://ex.com/tiles.json",
    );
    assert.equal(config.url, "https://ex.com/tiles.json");
    assert.equal(config.tiles, undefined);
  });
});

// The reported failure: an Esri vector tile service added by its style URL was
// handed MapLibre the style's verbatim relative `"url": "../../"`, which
// resolves against the app origin — the layer was added and rendered nothing.
describe("resolveOgcVectorTiles (Esri style URL)", () => {
  const styleUrl =
    "https://tiles.arcgis.com/tiles/org/arcgis/rest/services/Svc/VectorTileServer/resources/styles/root.json";
  const serviceUrl =
    "https://tiles.arcgis.com/tiles/org/arcgis/rest/services/Svc/VectorTileServer/";

  it("resolves the relative source url and reads the service's tiles", async () => {
    const { calls, restore } = stubFetch({
      [styleUrl]: {
        name: "Svc",
        sources: { esri: { type: "vector", url: "../../" } },
        layers: [{ id: "a", source: "esri", "source-layer": "Boundaries" }],
      },
      [serviceUrl]: { name: "Service", maxzoom: 16, tiles: ["tile/{z}/{y}/{x}.pbf"] },
    });
    try {
      const config = await resolveOgcVectorTiles({ tilesUrl: "", styleUrl });
      assert.deepEqual(config.tiles, [`${serviceUrl}tile/{z}/{y}/{x}.pbf`]);
      // A vector source with both `url` and `tiles` is invalid in MapLibre.
      assert.equal(config.url, undefined);
      assert.deepEqual(config.sourceLayers, ["Boundaries"]);
      assert.equal(config.maxzoom, 16);
      // The style's own name wins over the service's (manual > style > TileJSON).
      assert.equal(config.name, "Svc");
      assert.ok(calls.includes(serviceUrl));
    } finally {
      restore();
    }
  });

  it("still adds the layer when the tileset document cannot be read", async () => {
    const { restore } = stubFetch({
      [styleUrl]: {
        sources: { esri: { type: "vector", url: "../../" } },
        layers: [{ id: "a", source: "esri", "source-layer": "Boundaries" }],
      },
    });
    try {
      const config = await resolveOgcVectorTiles({ tilesUrl: "", styleUrl });
      // Falls back to the resolved absolute service URL rather than "../../".
      assert.equal(config.url, serviceUrl);
      assert.deepEqual(config.sourceLayers, ["Boundaries"]);
    } finally {
      restore();
    }
  });

  it("surfaces an Esri HTTP 200 error body instead of a bare 'no layers'", async () => {
    const { restore } = stubFetch({
      [styleUrl]: { error: { code: 404, message: "Requested Service not available." } },
    });
    try {
      await assert.rejects(
        resolveOgcVectorTiles({ tilesUrl: "", styleUrl }),
        /Requested Service not available/,
      );
    } finally {
      restore();
    }
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
