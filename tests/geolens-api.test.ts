import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyFeatureEdits,
  authHeaders,
  bboxFromGeometry,
  bboxParam,
  captureFeatureBaseline,
  createFeature,
  datasetPageUrl,
  deleteFeature,
  diffFeatures,
  editPlanSize,
  featureGid,
  fetchCapabilities,
  fetchDatasetFeatures,
  isEditPlanEmpty,
  updateFeature,
  fetchDatasetFields,
  GEOLENS_PAGE_LIMIT,
  geometryKind,
  itemsUrl,
  mintTileToken,
  normalizeBaseUrl,
  parseDataset,
  rasterTemplatesForServer,
  rasterTileAuthHeaders,
  resolveRasterTiles,
  searchDatasets,
  stacCatalogUrl,
  stacCollectionsUrl,
  tileUrlPrefix,
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

describe("bboxParam", () => {
  it("serializes minx,miny,maxx,maxy and clamps to valid ranges", () => {
    assert.equal(bboxParam([-115.5, 36.1, -115.1, 36.3]), "-115.5,36.1,-115.1,36.3");
    // A globe view can report coordinates past the valid range.
    assert.equal(bboxParam([-200, -95, 200, 95]), "-180,-90,180,90");
  });
});

describe("itemsUrl / stac URLs", () => {
  it("builds OGC Features and STAC URLs", () => {
    const opts = { baseUrl: "http://localhost:8080" };
    assert.equal(
      itemsUrl(opts, "abc def", 100),
      "http://localhost:8080/api/collections/abc%20def/items?limit=100",
    );
    assert.equal(
      itemsUrl(opts, "abc", 100, [-1, -2, 3, 4]),
      "http://localhost:8080/api/collections/abc/items?limit=100&bbox=-1%2C-2%2C3%2C4",
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

  it("loads everything in one request when the server accepts the full limit", async () => {
    const calls: string[] = [];
    const fetchImpl: GeoLensFetch = async (url) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          type: "FeatureCollection",
          features: Array.from({ length: 500 }, (_, i) => ({
            type: "Feature",
            geometry: null,
            properties: { id: i },
          })),
          links: [],
        }),
      };
    };
    const result = await fetchDatasetFeatures({ baseUrl: "http://h" }, "d", 10_000, fetchImpl);
    assert.equal(result.features.length, 500);
    assert.deepEqual(calls, ["http://h/api/collections/d/items?limit=10000"]);
  });

  it("falls back down the page-size ladder when the server rejects the limit", async () => {
    // GeoLens rejects (HTTP 400) a `limit` query param above its per-page cap
    // instead of clamping. A 25,000-feature request should try 25000, then
    // 10000, then the conservative floor — stopping at the first accepted size.
    const calls: string[] = [];
    const fetchImpl: GeoLensFetch = async (url) => {
      calls.push(url);
      const rejected = /limit=(25000|10000)/.test(url);
      if (rejected) return { ok: false, status: 400, json: async () => ({}) };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          type: "FeatureCollection",
          features: [{ type: "Feature", geometry: null, properties: { id: 1 } }],
          links: [],
        }),
      };
    };
    const result = await fetchDatasetFeatures({ baseUrl: "http://h" }, "d", 25_000, fetchImpl);
    assert.equal(result.features.length, 1);
    assert.deepEqual(calls, [
      "http://h/api/collections/d/items?limit=25000",
      "http://h/api/collections/d/items?limit=10000",
      `http://h/api/collections/d/items?limit=${GEOLENS_PAGE_LIMIT}`,
    ]);
  });

  it("surfaces a mid-pagination 400 instead of silently restarting", async () => {
    const fetchImpl: GeoLensFetch = async (url) => {
      if (url.includes("page=2")) return { ok: false, status: 400, json: async () => ({}) };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          type: "FeatureCollection",
          features: [{ type: "Feature", geometry: null, properties: { id: 1 } }],
          links: [{ rel: "next", href: "?page=2" }],
        }),
      };
    };
    await assert.rejects(
      () => fetchDatasetFeatures({ baseUrl: "http://h" }, "d", 10_000, fetchImpl),
      /HTTP 400/,
    );
  });

  it("rebases a next link advertising an internal origin onto the base URL", async () => {
    // datasets.geolibre.app sits behind a reverse proxy and returns
    // `http://localhost:8080/...` next hrefs; the path + query must be
    // followed on the public origin the user connected to.
    const calls: string[] = [];
    const fetchImpl: GeoLensFetch = async (url) => {
      calls.push(url);
      const second = url.includes("after_gid=1");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          type: "FeatureCollection",
          features: [{ type: "Feature", geometry: null, properties: { id: second ? 2 : 1 } }],
          links: second
            ? []
            : [{ rel: "next", href: "http://localhost:8080/api/collections/d/items?after_gid=1" }],
        }),
      };
    };
    const result = await fetchDatasetFeatures(
      { baseUrl: "https://public.example" },
      "d",
      2,
      fetchImpl,
    );
    assert.equal(result.features.length, 2);
    assert.equal(calls[1], "https://public.example/api/collections/d/items?after_gid=1");
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

describe("tileUrlPrefix", () => {
  it("keeps everything before the first placeholder", () => {
    assert.equal(
      tileUrlPrefix("https://demo.example.com/raster-tiles/abc/tiles/{z}/{x}/{y}.png"),
      "https://demo.example.com/raster-tiles/abc/tiles/",
    );
  });

  it("returns a template without placeholders unchanged", () => {
    assert.equal(tileUrlPrefix("https://h/tiles.png"), "https://h/tiles.png");
  });
});

describe("rasterTileAuthHeaders", () => {
  const keys = new Map([
    ["https://demo.example.com/raster-tiles/abc/tiles/", "key-abc"],
    ["https://other.example.com/raster-tiles/xyz/tiles/", "key-xyz"],
  ]);

  it("attaches the key registered for that tile endpoint", () => {
    assert.deepEqual(
      rasterTileAuthHeaders("https://demo.example.com/raster-tiles/abc/tiles/3/2/1.png", keys),
      { "X-Api-Key": "key-abc" },
    );
  });

  it("picks the matching server when several are registered", () => {
    assert.deepEqual(
      rasterTileAuthHeaders("https://other.example.com/raster-tiles/xyz/tiles/0/0/0.png", keys),
      { "X-Api-Key": "key-xyz" },
    );
  });

  it("does not leak the key to a basemap or another host", () => {
    assert.equal(rasterTileAuthHeaders("https://tiles.openfreemap.org/1/2/3.pbf", keys), null);
    assert.equal(rasterTileAuthHeaders("https://demo.example.com.evil.test/x", keys), null);
  });

  it("does not attach a key to a different dataset on the same server", () => {
    assert.equal(
      rasterTileAuthHeaders("https://demo.example.com/raster-tiles/zzz/tiles/1/1/1.png", keys),
      null,
    );
  });

  it("returns null when nothing is registered", () => {
    assert.equal(rasterTileAuthHeaders("https://demo.example.com/x", new Map()), null);
  });
});

describe("rasterTemplatesForServer", () => {
  const base = "https://demo.example.com";
  const layers = [
    {
      metadata: {
        sourceKind: "geolens-raster-tiles",
        geolensBaseUrl: base,
        geolensDatasetId: "abc",
      },
      source: { tiles: [`${base}/raster-tiles/abc/tiles/{z}/{x}/{y}.png`] },
    },
    {
      metadata: { sourceKind: "geolens-raster-tiles", geolensBaseUrl: "https://other.example.com" },
      source: { tiles: ["https://other.example.com/raster-tiles/xyz/tiles/{z}/{x}/{y}.png"] },
    },
    {
      metadata: { sourceKind: "geolens-vector-tiles", geolensBaseUrl: base },
      source: { tiles: [`${base}/api/tiles/t/{z}/{x}/{y}.pbf?sig=s`] },
    },
    { metadata: null, source: { tiles: [`${base}/raster-tiles/zzz/tiles/{z}/{x}/{y}.png`] } },
    {
      metadata: { sourceKind: "geolens-raster-tiles", geolensBaseUrl: base },
      source: { tiles: [] },
    },
    { metadata: { sourceKind: "geolens-raster-tiles", geolensBaseUrl: base }, source: null },
  ];

  it("returns only this server's raster templates", () => {
    assert.deepEqual(rasterTemplatesForServer(layers, base), [
      `${base}/raster-tiles/abc/tiles/{z}/{x}/{y}.png`,
    ]);
  });

  it("returns the other server's template for its own base URL", () => {
    assert.deepEqual(rasterTemplatesForServer(layers, "https://other.example.com"), [
      "https://other.example.com/raster-tiles/xyz/tiles/{z}/{x}/{y}.png",
    ]);
  });

  it("returns nothing when no GeoLens raster layers are present", () => {
    assert.deepEqual(rasterTemplatesForServer([], base), []);
  });
});

// ---------------------------------------------------------------------------
// Feature editing (write-back).
// ---------------------------------------------------------------------------

const CLIENT = { baseUrl: "https://demo.example.com", apiKey: "k" };

/** A fetch stub that records every write and answers from a per-URL script. */
function stubWrites(responses: Array<{ ok?: boolean; status?: number; body?: unknown }> = []): {
  fetchImpl: GeoLensFetch;
  calls: Array<{ url: string; method?: string; body?: unknown; headers?: Record<string, string> }>;
} {
  const calls: Array<{
    url: string;
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  }> = [];
  let index = 0;
  const fetchImpl: GeoLensFetch = (url, init) => {
    calls.push({
      url,
      method: init?.method,
      body: init?.body === undefined ? undefined : JSON.parse(init.body),
      headers: init?.headers,
    });
    const scripted = responses[index++] ?? {};
    return Promise.resolve({
      ok: scripted.ok ?? true,
      status: scripted.status ?? 200,
      json: async () => scripted.body ?? {},
    });
  };
  return { fetchImpl, calls };
}

function point(x: number, y: number) {
  return { type: "Point" as const, coordinates: [x, y] };
}

function collection(features: unknown[]) {
  return { type: "FeatureCollection", features } as import("geojson").FeatureCollection;
}

describe("fetchCapabilities", () => {
  it("reads the server's dataset-editing flag", async () => {
    const { fetchImpl, calls } = stubFetch({
      enable_dataset_editing: true,
      require_metadata_for_publish: false,
    });
    assert.deepEqual(await fetchCapabilities(CLIENT, fetchImpl), { datasetEditing: true });
    assert.equal(calls[0].url, "https://demo.example.com/api/settings/feature-flags/");
  });

  it("reports no editing when the flag is off", async () => {
    const { fetchImpl } = stubFetch({ enable_dataset_editing: false });
    assert.deepEqual(await fetchCapabilities(CLIENT, fetchImpl), { datasetEditing: false });
  });

  it("reports no editing when the endpoint is missing, rather than throwing", async () => {
    const { fetchImpl } = stubFetch({ detail: "Not Found" }, false, 404);
    assert.deepEqual(await fetchCapabilities(CLIENT, fetchImpl), { datasetEditing: false });
  });
});

describe("featureGid", () => {
  it("accepts the integer row id GeoLens returns, in either JSON form", () => {
    assert.equal(featureGid({ id: 7 }), 7);
    assert.equal(featureGid({ id: "7" }), 7);
  });

  it("rejects ids that are not a row id", () => {
    assert.equal(featureGid({}), null);
    assert.equal(featureGid({ id: "" }), null);
    assert.equal(featureGid({ id: "abc" }), null);
    assert.equal(featureGid({ id: 1.5 }), null);
  });
});

describe("diffFeatures", () => {
  const loaded = collection([
    { type: "Feature", id: 1, geometry: point(0, 0), properties: { name: "a" } },
    { type: "Feature", id: 2, geometry: point(1, 1), properties: { name: "b" } },
  ]);

  it("reports nothing for an untouched collection", () => {
    const plan = diffFeatures(loaded, captureFeatureBaseline(loaded));
    assert.equal(isEditPlanEmpty(plan), true);
    assert.equal(editPlanSize(plan), 0);
  });

  it("patches a moved feature and replaces one whose attributes changed", () => {
    const baseline = captureFeatureBaseline(loaded);
    const plan = diffFeatures(
      collection([
        { type: "Feature", id: 1, geometry: point(5, 5), properties: { name: "a" } },
        { type: "Feature", id: 2, geometry: point(1, 1), properties: { name: "B" } },
      ]),
      baseline,
    );
    assert.deepEqual(
      plan.updates.map((u) => [u.gid, u.mode]),
      [
        [1, "patch"],
        [2, "replace"],
      ],
    );
    assert.deepEqual(plan.creates, []);
    assert.deepEqual(plan.deletes, []);
  });

  it("treats a feature with no gid as a create and a missing gid as a delete", () => {
    const plan = diffFeatures(
      collection([
        { type: "Feature", id: 1, geometry: point(0, 0), properties: { name: "a" } },
        { type: "Feature", geometry: point(9, 9), properties: { name: "new" } },
      ]),
      captureFeatureBaseline(loaded),
    );
    assert.deepEqual(plan.deletes, [2]);
    assert.equal(plan.creates.length, 1);
    assert.deepEqual(plan.creates[0], {
      index: 1,
      geometry: point(9, 9),
      properties: { name: "new" },
    });
    assert.deepEqual(plan.updates, []);
  });

  it("never sends editor-internal properties to the server", () => {
    const plan = diffFeatures(
      collection([
        {
          type: "Feature",
          id: 1,
          geometry: point(0, 0),
          properties: { name: "a", __geolibre_fid: "1", __gm_shape: "circle_marker" },
        },
        {
          type: "Feature",
          geometry: point(3, 3),
          properties: { __gm_shape: "circle_marker", note: "drawn" },
        },
      ]),
      captureFeatureBaseline(loaded),
    );
    // Feature 1 only gained editor tags, so it is not a change at all.
    assert.deepEqual(plan.updates, []);
    assert.deepEqual(plan.creates[0].properties, { note: "drawn" });
  });

  it("updates a duplicated gid once and inserts the copy", () => {
    const plan = diffFeatures(
      collection([
        { type: "Feature", id: 1, geometry: point(4, 4), properties: { name: "a" } },
        { type: "Feature", id: 1, geometry: point(6, 6), properties: { name: "a" } },
      ]),
      captureFeatureBaseline(loaded),
    );
    assert.deepEqual(
      plan.updates.map((u) => u.gid),
      [1],
    );
    assert.equal(plan.creates.length, 1);
    assert.equal(plan.creates[0].index, 1);
  });

  it("ignores a feature that has no geometry to insert", () => {
    const plan = diffFeatures(
      collection([{ type: "Feature", geometry: null, properties: { name: "empty" } }]),
      new Map(),
    );
    assert.equal(isEditPlanEmpty(plan), true);
  });
});

describe("createFeature / updateFeature / deleteFeature", () => {
  it("posts a new feature and returns the gid GeoLens assigned", async () => {
    const { fetchImpl, calls } = stubWrites([{ status: 201, body: { id: 42 } }]);
    const gid = await createFeature(
      CLIENT,
      "ds-1",
      { geometry: point(1, 2), properties: { name: "x" } },
      fetchImpl,
    );
    assert.equal(gid, 42);
    assert.equal(calls[0].url, "https://demo.example.com/api/datasets/ds-1/features/");
    assert.equal(calls[0].method, "POST");
    assert.deepEqual(calls[0].body, { geometry: point(1, 2), properties: { name: "x" } });
    assert.equal(calls[0].headers?.["X-Api-Key"], "k");
    assert.equal(calls[0].headers?.["Content-Type"], "application/json");
  });

  it("PATCHes a geometry-only change and PUTs a full replacement", async () => {
    const { fetchImpl, calls } = stubWrites();
    await updateFeature(
      CLIENT,
      "ds-1",
      { gid: 3, mode: "patch", geometry: point(0, 1), properties: {} },
      fetchImpl,
    );
    await updateFeature(
      CLIENT,
      "ds-1",
      { gid: 4, mode: "replace", geometry: point(2, 3), properties: { a: 1 } },
      fetchImpl,
    );
    assert.equal(calls[0].method, "PATCH");
    assert.equal(calls[0].url, "https://demo.example.com/api/datasets/ds-1/features/3");
    assert.deepEqual(calls[0].body, { geometry: point(0, 1) });
    assert.equal(calls[1].method, "PUT");
    assert.deepEqual(calls[1].body, { geometry: point(2, 3), properties: { a: 1 } });
  });

  it("PATCHes properties alone when the feature has no geometry", async () => {
    // diffFeatures falls back to this shape for a geometry-less feature whose
    // attributes changed — GeoLens rejects a PUT without geometry.
    const { fetchImpl, calls } = stubWrites();
    await updateFeature(
      CLIENT,
      "ds-1",
      { gid: 5, mode: "patch", geometry: null, properties: { a: 1 } },
      fetchImpl,
    );
    assert.equal(calls[0].method, "PATCH");
    assert.equal(calls[0].url, "https://demo.example.com/api/datasets/ds-1/features/5");
    assert.deepEqual(calls[0].body, { properties: { a: 1 } });
  });

  it("deletes by gid without a body", async () => {
    const { fetchImpl, calls } = stubWrites([{ status: 204 }]);
    await deleteFeature(CLIENT, "ds-1", 9, fetchImpl);
    assert.equal(calls[0].method, "DELETE");
    assert.equal(calls[0].url, "https://demo.example.com/api/datasets/ds-1/features/9");
    assert.equal(calls[0].body, undefined);
    assert.equal(calls[0].headers?.["Content-Type"], undefined);
  });

  it("surfaces the server's problem detail, not just the status", async () => {
    const { fetchImpl } = stubWrites([
      { ok: false, status: 403, body: { detail: "Dataset editing is disabled" } },
    ]);
    await assert.rejects(
      () => createFeature(CLIENT, "ds-1", { geometry: point(0, 0), properties: {} }, fetchImpl),
      /Could not create feature: Dataset editing is disabled/,
    );
  });

  it("falls back to the status when the error body is not JSON", async () => {
    const fetchImpl: GeoLensFetch = () =>
      Promise.resolve({
        ok: false,
        status: 502,
        json: async () => {
          throw new Error("not json");
        },
      });
    await assert.rejects(
      () => deleteFeature(CLIENT, "ds-1", 5, fetchImpl),
      /Could not delete feature 5 \(HTTP 502\)/,
    );
  });
});

describe("applyFeatureEdits", () => {
  const plan = {
    creates: [{ index: 2, geometry: point(9, 9), properties: { name: "new" } }],
    updates: [{ gid: 1, mode: "patch" as const, geometry: point(5, 5), properties: {} }],
    deletes: [2],
  };

  it("writes every change and reports what landed", async () => {
    const { fetchImpl, calls } = stubWrites([
      {},
      { status: 201, body: { id: 77 } },
      { status: 204 },
    ]);
    const progress: Array<[number, number]> = [];
    const result = await applyFeatureEdits(CLIENT, "ds-1", plan, fetchImpl, (done, total) =>
      progress.push([done, total]),
    );
    assert.deepEqual(
      calls.map((c) => c.method),
      ["PATCH", "POST", "DELETE"],
    );
    assert.deepEqual(result.updated, [1]);
    assert.deepEqual(result.created, [{ index: 2, gid: 77 }]);
    assert.deepEqual(result.deleted, [2]);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(progress, [
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it("keeps going after a rejected write and reports it", async () => {
    const { fetchImpl } = stubWrites([
      { ok: false, status: 422, body: { detail: "bad geometry" } },
      { status: 201, body: { id: 78 } },
      { status: 204 },
    ]);
    const result = await applyFeatureEdits(CLIENT, "ds-1", plan, fetchImpl);
    assert.deepEqual(result.updated, []);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /bad geometry/);
    // The create and the delete still ran.
    assert.deepEqual(result.created, [{ index: 2, gid: 78 }]);
    assert.deepEqual(result.deleted, [2]);
  });

  it("stops issuing writes once aborted", async () => {
    const controller = new AbortController();
    const { fetchImpl, calls } = stubWrites();
    controller.abort();
    const result = await applyFeatureEdits(
      CLIENT,
      "ds-1",
      plan,
      fetchImpl,
      undefined,
      controller.signal,
    );
    assert.deepEqual(calls, []);
    assert.equal(result.errors.length, 0);
  });
});

describe("diffFeatures — null vs absent attributes", () => {
  // A GeoLens row exposes every column, so an empty feature loads as
  // {"id": null, ...}; a GeoEditor round trip returns it as {}. Treating that
  // as an edit made every feature in the layer look changed (540 no-op writes
  // on the Las Vegas Buildings demo dataset).
  const loaded = collection([
    { type: "Feature", id: 1, geometry: point(0, 0), properties: { id: null, height: null } },
    { type: "Feature", id: 2, geometry: point(1, 1), properties: { id: null, height: 12 } },
  ]);

  it("does not treat a dropped null-valued key as a change", () => {
    const plan = diffFeatures(
      collection([
        { type: "Feature", id: 1, geometry: point(0, 0), properties: {} },
        { type: "Feature", id: 2, geometry: point(1, 1), properties: { height: 12 } },
      ]),
      captureFeatureBaseline(loaded),
    );
    assert.equal(isEditPlanEmpty(plan), true);
  });

  it("patches geometry only when such a feature is actually moved", () => {
    const plan = diffFeatures(
      collection([
        { type: "Feature", id: 1, geometry: point(9, 9), properties: {} },
        { type: "Feature", id: 2, geometry: point(1, 1), properties: { height: 12 } },
      ]),
      captureFeatureBaseline(loaded),
    );
    // "patch" matters: a "replace" would PUT `{}` over the row's attributes.
    assert.deepEqual(
      plan.updates.map((u) => [u.gid, u.mode]),
      [[1, "patch"]],
    );
  });

  it("still reports a real attribute change on such a feature", () => {
    const plan = diffFeatures(
      collection([
        { type: "Feature", id: 1, geometry: point(0, 0), properties: { height: 3 } },
        { type: "Feature", id: 2, geometry: point(1, 1), properties: { height: 12 } },
      ]),
      captureFeatureBaseline(loaded),
    );
    assert.deepEqual(
      plan.updates.map((u) => [u.gid, u.mode]),
      [[1, "replace"]],
    );
  });

  it("still reports a value that disappeared, which is genuine data loss", () => {
    const plan = diffFeatures(
      collection([
        { type: "Feature", id: 1, geometry: point(0, 0), properties: {} },
        { type: "Feature", id: 2, geometry: point(1, 1), properties: {} },
      ]),
      captureFeatureBaseline(loaded),
    );
    assert.deepEqual(
      plan.updates.map((u) => u.gid),
      [2],
    );
  });
});

describe("diffFeatures — a feature with no geometry", () => {
  it("patches attributes only, since GeoLens requires geometry on a PUT", () => {
    const loaded = collection([
      { type: "Feature", id: 1, geometry: null, properties: { name: "a" } },
    ]);
    const plan = diffFeatures(
      collection([{ type: "Feature", id: 1, geometry: null, properties: { name: "b" } }]),
      captureFeatureBaseline(loaded),
    );
    assert.deepEqual(
      plan.updates.map((u) => [u.gid, u.mode]),
      [[1, "patch"]],
    );
    assert.deepEqual(plan.updates[0].properties, { name: "b" });
  });
});

describe("fetchDatasetFeatures — bbox", () => {
  it("passes the extent to the server and keeps it across pagination", async () => {
    const calls: string[] = [];
    const fetchImpl: GeoLensFetch = async (url) => {
      calls.push(url);
      const second = url.includes("offset=1");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          type: "FeatureCollection",
          features: [{ type: "Feature", geometry: null, properties: {} }],
          links: second ? [] : [{ rel: "next", href: "?limit=2&offset=1&bbox=-1%2C-2%2C3%2C4" }],
        }),
      };
    };
    await fetchDatasetFeatures(
      { baseUrl: "http://h" },
      "d",
      2,
      fetchImpl,
      undefined,
      [-1, -2, 3, 4],
    );
    assert.equal(calls[0], "http://h/api/collections/d/items?limit=2&bbox=-1%2C-2%2C3%2C4");
    // The server's own `next` link carries the filter forward.
    assert.ok(calls[1].includes("bbox=-1%2C-2%2C3%2C4"));
  });

  it("omits the parameter entirely when no extent is given", async () => {
    const calls: string[] = [];
    const fetchImpl: GeoLensFetch = async (url) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ type: "FeatureCollection", features: [], links: [] }),
      };
    };
    await fetchDatasetFeatures({ baseUrl: "http://h" }, "d", 5, fetchImpl);
    assert.equal(calls[0], "http://h/api/collections/d/items?limit=5");
  });
});
