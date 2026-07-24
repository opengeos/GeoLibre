import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  authHeaders,
  bboxFromGeometry,
  datasetPageUrl,
  fetchDatasetFeatures,
  fetchDatasetFields,
  geometryKind,
  itemsUrl,
  mintTileToken,
  normalizeBaseUrl,
  parseDataset,
  resolveRasterTiles,
  searchDatasets,
  stacCatalogUrl,
  stacCollectionsUrl,
  vectorTileTemplate,
  type GeoLensFetch,
  type GeoLensHttpResponse,
} from "../packages/plugins/src/plugins/geolens-api";

/** A fetch stub that returns a fixed JSON body and records the calls. */
function stubFetch(body: unknown, ok = true, status = 200) {
  const calls: { url: string; headers?: Record<string, string> }[] = [];
  const fetchImpl: GeoLensFetch = (url, init) => {
    calls.push({ url, headers: init?.headers });
    const res: GeoLensHttpResponse = { ok, status, json: async () => body };
    return Promise.resolve(res);
  };
  return { fetchImpl, calls };
}

describe("normalizeBaseUrl", () => {
  it("trims, defaults to https, and strips trailing slashes", () => {
    assert.equal(normalizeBaseUrl("  demo.getgeolens.com/  "), "https://demo.getgeolens.com");
    assert.equal(normalizeBaseUrl("http://localhost:8080///"), "http://localhost:8080");
    assert.equal(normalizeBaseUrl("https://x.example"), "https://x.example");
    assert.equal(normalizeBaseUrl(""), "");
  });
});

describe("authHeaders", () => {
  it("sends X-Api-Key only when a key is present", () => {
    assert.deepEqual(authHeaders({ baseUrl: "x" }), {});
    assert.deepEqual(authHeaders({ baseUrl: "x", apiKey: " k " }), { "X-Api-Key": "k" });
  });
});

describe("bboxFromGeometry", () => {
  it("computes the extent of a polygon", () => {
    const geom = {
      type: "Polygon",
      coordinates: [
        [
          [-180, -85],
          [-180, 83],
          [180, 83],
          [180, -85],
          [-180, -85],
        ],
      ],
    };
    assert.deepEqual(bboxFromGeometry(geom), [-180, -85, 180, 83]);
  });

  it("returns null for empty or non-geometry input", () => {
    assert.equal(bboxFromGeometry(null), null);
    assert.equal(bboxFromGeometry({ type: "Polygon", coordinates: [] }), null);
  });
});

describe("parseDataset", () => {
  it("normalizes a vector dataset feature", () => {
    const ds = parseDataset({
      id: "abc",
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [0, 1],
            [1, 1],
            [1, 0],
            [0, 0],
          ],
        ],
      },
      properties: {
        title: "Roads",
        description: "A road network",
        keywords: ["transport", 42],
        record_type: "vector_dataset",
        geometry_type: "MULTILINESTRING",
        band_count: null,
        feature_count: 1234,
        license: "CC-BY",
      },
    });
    assert.ok(ds);
    assert.equal(ds.title, "Roads");
    assert.equal(ds.isVector, true);
    assert.equal(ds.isRaster, false);
    assert.deepEqual(ds.keywords, ["transport"]); // non-strings dropped
    assert.equal(ds.featureCount, 1234);
    assert.deepEqual(ds.bbox, [0, 0, 1, 1]);
  });

  it("classifies a raster dataset by band_count", () => {
    const ds = parseDataset({
      id: "r1",
      properties: { title: "DEM", record_type: "raster_dataset", band_count: 1 },
    });
    assert.ok(ds);
    assert.equal(ds.isRaster, true);
    assert.equal(ds.isVector, false);
  });

  it("rejects a feature without an id", () => {
    assert.equal(parseDataset({ properties: { title: "x" } }), null);
  });
});

describe("vectorTileTemplate", () => {
  it("builds a signed {z}/{x}/{y} template with a data.-prefixed source-layer", () => {
    const out = vectorTileTemplate(
      { baseUrl: "http://localhost:8080" },
      { kind: "vector", sig: "abc123", exp: 1784668500, scope: "world_countries", expiresIn: 465 },
    );
    assert.equal(out.sourceLayer, "data.world_countries");
    assert.ok(
      out.tiles.startsWith("http://localhost:8080/api/tiles/data.world_countries/{z}/{x}/{y}.pbf?"),
    );
    // Placeholders survive intact (not URL-encoded).
    assert.ok(out.tiles.includes("/{z}/{x}/{y}.pbf"));
    assert.ok(out.tiles.includes("sig=abc123"));
    assert.ok(out.tiles.includes("exp=1784668500"));
    assert.ok(out.tiles.includes("scope=world_countries"));
  });
});

describe("itemsUrl / stac URLs", () => {
  it("builds OGC Features and STAC URLs", () => {
    const opts = { baseUrl: "http://localhost:8080" };
    assert.equal(
      itemsUrl(opts, "abc def", 100),
      "http://localhost:8080/api/collections/abc%20def/items?limit=100",
    );
    assert.equal(stacCatalogUrl(opts), "http://localhost:8080/api/stac");
    assert.equal(stacCollectionsUrl(opts), "http://localhost:8080/api/stac/collections");
  });
});

describe("fetchDatasetFeatures", () => {
  it("follows pagination and stops at the requested feature limit", async () => {
    const calls: string[] = [];
    const fetchImpl: GeoLensFetch = async (url) => {
      calls.push(url);
      const second = url.includes("offset=2");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          type: "FeatureCollection",
          features: second
            ? [{ type: "Feature", geometry: null, properties: { id: 3 } }]
            : [
                { type: "Feature", geometry: null, properties: { id: 1 } },
                { type: "Feature", geometry: null, properties: { id: 2 } },
              ],
          links: second ? [] : [{ rel: "next", href: "?limit=3&offset=2" }],
        }),
      };
    };
    const result = await fetchDatasetFeatures({ baseUrl: "http://h" }, "d", 3, fetchImpl);
    assert.equal(result.features.length, 3);
    assert.equal(calls.length, 2);
    assert.equal(calls[1], "http://h/api/collections/d/items?limit=3&offset=2");
  });

  it("truncates an oversized response to the requested limit", async () => {
    const { fetchImpl } = stubFetch({
      type: "FeatureCollection",
      features: [
        { type: "Feature", geometry: null, properties: { id: 1 } },
        { type: "Feature", geometry: null, properties: { id: 2 } },
      ],
    });
    const result = await fetchDatasetFeatures({ baseUrl: "http://h" }, "d", 1, fetchImpl);
    assert.equal(result.features.length, 1);
  });
});

describe("fetchDatasetFields", () => {
  it("returns the property keys of a sample item (limit=1)", async () => {
    const { fetchImpl, calls } = stubFetch({
      type: "FeatureCollection",
      features: [{ properties: { height_roof: 40, construction_year: 1930, name: "x" } }],
    });
    const fields = await fetchDatasetFields({ baseUrl: "http://h", apiKey: "k" }, "d1", fetchImpl);
    assert.deepEqual(fields, ["height_roof", "construction_year", "name"]);
    assert.match(calls[0].url, /\/api\/collections\/d1\/items\?limit=1$/);
    assert.deepEqual(calls[0].headers, { "X-Api-Key": "k" });
  });

  it("returns [] when there are no features", async () => {
    const { fetchImpl } = stubFetch({ type: "FeatureCollection", features: [] });
    assert.deepEqual(await fetchDatasetFields({ baseUrl: "http://h" }, "d", fetchImpl), []);
  });

  it("throws on a non-ok response", async () => {
    const { fetchImpl } = stubFetch({}, false, 404);
    await assert.rejects(
      () => fetchDatasetFields({ baseUrl: "http://h" }, "d", fetchImpl),
      /HTTP 404/,
    );
  });
});

describe("geometryKind", () => {
  it("maps GeoLens geometry types to the host's point/line/polygon", () => {
    assert.equal(geometryKind("MULTIPOINT"), "point");
    assert.equal(geometryKind("Point"), "point");
    assert.equal(geometryKind("MULTILINESTRING"), "line");
    assert.equal(geometryKind("LineString"), "line");
    assert.equal(geometryKind("MULTIPOLYGON"), "polygon");
    assert.equal(geometryKind("Polygon"), "polygon");
    assert.equal(geometryKind(null), null);
    assert.equal(geometryKind("GeometryCollection"), null);
  });
});

describe("datasetPageUrl", () => {
  it("builds the GeoLens dataset detail page URL", () => {
    assert.equal(
      datasetPageUrl({ baseUrl: "http://localhost:8080" }, "abc-123"),
      "http://localhost:8080/datasets/abc-123",
    );
  });
});

describe("searchDatasets", () => {
  it("requests the search endpoint and returns parsed datasets", async () => {
    const { fetchImpl, calls } = stubFetch({
      type: "FeatureCollection",
      features: [
        { id: "a", properties: { title: "A", record_type: "vector_dataset" } },
        { id: "b", properties: { title: "B", record_type: "vector_dataset" } },
        { properties: { title: "no-id" } }, // dropped
      ],
    });
    const out = await searchDatasets({ baseUrl: "http://h", apiKey: "k" }, "roads", 50, fetchImpl);
    assert.equal(out.length, 2);
    assert.equal(out[0].id, "a");
    assert.match(calls[0].url, /\/api\/search\/datasets\/\?q=roads&limit=50$/);
    assert.deepEqual(calls[0].headers, { "X-Api-Key": "k" });
  });

  it("throws on a non-ok response", async () => {
    const { fetchImpl } = stubFetch({}, false, 500);
    await assert.rejects(
      () => searchDatasets({ baseUrl: "http://h" }, "", 10, fetchImpl),
      /HTTP 500/,
    );
  });
});

describe("mintTileToken", () => {
  it("parses a token response", async () => {
    const { fetchImpl, calls } = stubFetch({
      kind: "vector",
      sig: "s",
      exp: 123,
      scope: "tbl",
      expires_in: 150,
    });
    const token = await mintTileToken({ baseUrl: "http://h" }, "id1", fetchImpl);
    assert.equal(token.scope, "tbl");
    assert.equal(token.expiresIn, 150);
    assert.match(calls[0].url, /\/api\/tiles\/token\/id1\/$/);
  });

  it("throws when the token is malformed", async () => {
    const { fetchImpl } = stubFetch({ sig: "s" }); // no scope/exp
    await assert.rejects(
      () => mintTileToken({ baseUrl: "http://h" }, "id", fetchImpl),
      /malformed/,
    );
  });
});

describe("resolveRasterTiles", () => {
  it("joins the relative tile_url onto the base and parses bounds/zoom", async () => {
    const { fetchImpl, calls } = stubFetch({
      kind: "raster",
      tile_url: "/raster-tiles/abc/tiles/{z}/{x}/{y}.png",
      bounds: [-74, 40, -73, 41],
      minzoom: 0,
      maxzoom: 16,
      tile_size: 256,
    });
    const out = await resolveRasterTiles({ baseUrl: "http://localhost:8080" }, "abc", fetchImpl);
    assert.equal(out.tiles, "http://localhost:8080/raster-tiles/abc/tiles/{z}/{x}/{y}.png");
    assert.deepEqual(out.bounds, [-74, 40, -73, 41]);
    assert.equal(out.maxzoom, 16);
    assert.equal(out.tileSize, 256);
    assert.match(calls[0].url, /\/api\/tiles\/token\/abc\/$/);
  });

  it("rejects a vector token as not a raster source", async () => {
    const { fetchImpl } = stubFetch({ kind: "vector", sig: "s", exp: 1, scope: "t" });
    await assert.rejects(
      () => resolveRasterTiles({ baseUrl: "http://h" }, "id", fetchImpl),
      /not a raster/,
    );
  });
});
