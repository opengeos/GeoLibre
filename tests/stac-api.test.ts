import assert from "node:assert/strict";
import test from "node:test";
import {
  connectStac,
  isVisualizableAsset,
  itemBbox,
  searchStacApi,
  searchStaticStac,
} from "../packages/plugins/src/plugins/stac-api";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("connectStac discovers relative API links and collections", async () => {
  const calls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/collections")) {
      return jsonResponse({ collections: [{ id: "landsat", title: "Landsat" }] });
    }
    return jsonResponse({
      id: "demo",
      title: "Demo STAC",
      conformsTo: ["https://api.stacspec.org/v1.0.0/item-search"],
      links: [
        { rel: "search", href: "./search" },
        { rel: "data", href: "./collections" },
      ],
    });
  }) as typeof fetch;

  const connection = await connectStac("https://example.com/stac/", fetcher);
  assert.equal(connection.isApi, true);
  assert.equal(connection.searchUrl, "https://example.com/stac/search");
  assert.deepEqual(
    connection.collections.map((collection) => collection.id),
    ["landsat"],
  );
  assert.deepEqual(calls, ["https://example.com/stac/", "https://example.com/stac/collections"]);
});

test("searchStacApi sends spatial, temporal, and collection filters and follows next", async () => {
  let body: Record<string, unknown> | undefined;
  const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return jsonResponse({
      type: "FeatureCollection",
      numberMatched: 4,
      features: [
        {
          type: "Feature",
          id: "one",
          bbox: [-1, -2, 3, 4],
          geometry: null,
          properties: { datetime: "2024-01-01T00:00:00Z" },
          assets: {
            data: { href: "https://example.com/one.tif", type: "image/tiff; application=geotiff" },
          },
        },
      ],
      links: [{ rel: "next", href: "?token=next", method: "POST", body: { token: "next" } }],
    });
  }) as typeof fetch;
  const connection = {
    url: "https://example.com/stac/",
    title: "Demo",
    isApi: true,
    searchUrl: "https://example.com/stac/search",
    collections: [],
    root: {},
  };
  const result = await searchStacApi(
    connection,
    {
      bbox: [-10, -5, 10, 5],
      datetime: "2024-01-01/2024-02-01",
      collections: ["demo"],
      limit: 10,
    },
    fetcher,
  );
  assert.deepEqual(body, {
    limit: 10,
    bbox: [-10, -5, 10, 5],
    datetime: "2024-01-01/2024-02-01",
    collections: ["demo"],
  });
  assert.equal(result.items[0].id, "one");
  assert.equal(result.matched, 4);
  assert.deepEqual(result.next, {
    href: "https://example.com/stac/search?token=next",
    method: "POST",
    body: { token: "next" },
  });
});

test("searchStaticStac traverses child and item links and applies filters", async () => {
  const docs: Record<string, unknown> = {
    "https://example.com/collection.json": {
      type: "Collection",
      links: [
        { rel: "item", href: "inside.json" },
        { rel: "item", href: "outside.json" },
      ],
    },
    "https://example.com/inside.json": {
      type: "Feature",
      id: "inside",
      collection: "demo",
      bbox: [0, 0, 2, 2],
      geometry: null,
      properties: { datetime: "2024-05-01T00:00:00Z" },
      assets: {},
    },
    "https://example.com/outside.json": {
      type: "Feature",
      id: "outside",
      collection: "demo",
      bbox: [50, 50, 60, 60],
      geometry: null,
      properties: { datetime: "2024-05-01T00:00:00Z" },
      assets: {},
    },
  };
  const fetcher = (async (input: RequestInfo | URL) =>
    jsonResponse(docs[String(input)])) as typeof fetch;
  const result = await searchStaticStac(
    {
      url: "https://example.com/collection.json",
      title: "Static",
      isApi: false,
      collections: [],
      root: docs["https://example.com/collection.json"] as Record<string, unknown>,
    },
    { bbox: [-1, -1, 3, 3], datetime: "2024-01-01/2024-12-31", limit: 20 },
    fetcher,
  );
  assert.deepEqual(
    result.items.map((item) => item.id),
    ["inside"],
  );
});

test("asset and bbox helpers recognize common STAC data", () => {
  assert.equal(isVisualizableAsset({ href: "https://example.com/a.TIF?download=1" }), true);
  assert.equal(isVisualizableAsset({ href: "https://example.com/data.bin" }), false);
  assert.deepEqual(
    itemBbox({
      type: "Feature",
      id: "3d",
      bbox: [1, 2, 10, 3, 4, 20],
      geometry: null,
      properties: {},
      assets: {},
    }),
    [1, 2, 3, 4],
  );
});
