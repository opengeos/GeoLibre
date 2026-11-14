import assert from "node:assert/strict";
import test from "node:test";
import {
  buildStacSearchQuery,
  STACClient,
  type STACCollection,
} from "maplibre-gl-planetary-computer";
import {
  loadBundledPlanetaryComputerCollections,
  PLANETARY_COMPUTER_STAC_URL,
  planetaryComputerStacClientOptions,
} from "../packages/plugins/src/plugins/planetary-computer-stac";

// GeoLibre builds every Planetary Computer STAC client from
// planetaryComputerStacClientOptions(). These tests run the real library
// client with those options, so they fail if the library stops honoring them.

const BASE = PLANETARY_COMPUTER_STAC_URL;

type FetchCall = { url: string; init?: RequestInit };

async function withFetch<T>(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  run: (calls: FetchCall[]) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

/** A client configured the way the plugin configures its own. */
function createClient(
  overrides: Parameters<typeof planetaryComputerStacClientOptions>[0] = {},
): STACClient {
  return new STACClient(BASE, planetaryComputerStacClientOptions(overrides));
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

test("search params encode as a STAC GET item search", () => {
  const query = new URLSearchParams(
    buildStacSearchQuery({
      collections: ["sentinel-2-l2a"],
      bbox: [-100, 40, -99, 41],
      datetime: "2024-06-01T00:00:00Z/2024-07-01T00:00:00Z",
      limit: 25,
      query: { "eo:cloud_cover": { lt: 10 } },
      sortby: [{ field: "datetime", direction: "desc" }],
    }),
  );
  assert.equal(query.get("collections"), "sentinel-2-l2a");
  assert.equal(query.get("bbox"), "-100,40,-99,41");
  assert.equal(query.get("datetime"), "2024-06-01T00:00:00Z/2024-07-01T00:00:00Z");
  assert.equal(query.get("limit"), "25");
  assert.deepEqual(JSON.parse(query.get("query") ?? ""), { "eo:cloud_cover": { lt: 10 } });
  assert.equal(query.get("sortby"), "-datetime");
});

test("ascending sort, ids, intersects and a CQL2 filter keep their GET forms", () => {
  const geometry = { type: "Point" as const, coordinates: [1, 2] };
  const query = new URLSearchParams(
    buildStacSearchQuery({
      ids: ["a", "b"],
      intersects: geometry,
      sortby: [{ field: "datetime", direction: "asc" }],
      filter: { op: "=", args: [{ property: "platform" }, "landsat-8"] },
    }),
  );
  assert.equal(query.get("ids"), "a,b");
  assert.deepEqual(JSON.parse(query.get("intersects") ?? ""), geometry);
  assert.equal(query.get("sortby"), "+datetime");
  assert.equal(query.get("filter-lang"), "cql2-json");
  assert.equal(query.has("query"), false);
});

test("search is sent as a preflight-free GET", async () => {
  const client = createClient();
  const features = await withFetch(
    () => json({ type: "FeatureCollection", features: [{ id: "item-1" }] }),
    async (calls) => {
      const result = await client.search({ collections: ["naip"], limit: 5 });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, `${BASE}/search?collections=naip&limit=5`);
      // No method/body/Content-Type: a simple request needs no CORS preflight.
      assert.equal(calls[0].init?.method, undefined);
      assert.equal(calls[0].init?.body, undefined);
      assert.equal(calls[0].init?.headers, undefined);
      return result;
    },
  );
  assert.deepEqual(
    features.map((feature) => feature.id),
    ["item-1"],
  );
});

test("a new search cancels the one still in flight", async () => {
  const client = createClient();
  await withFetch(
    (_url, init) =>
      new Promise<Response>((resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return resolve(json({ type: "FeatureCollection", features: [] }));
        signal.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
        setTimeout(() => resolve(json({ type: "FeatureCollection", features: [] })), 20);
      }),
    async () => {
      const first = client.search({ collections: ["naip"] });
      const second = client.search({ collections: ["naip"] });
      await assert.rejects(first, /Request was cancelled/);
      assert.deepEqual(await second, []);
    },
  );
});

test("a live collection list is used when the API allows it", async () => {
  let fellBack = false;
  const client = createClient({
    fallbackCollections: async () => {
      fellBack = true;
      return [];
    },
  });
  const collections = await withFetch(
    () => json({ collections: [{ id: "live" }] }),
    () => client.getCollections(),
  );
  assert.deepEqual(
    collections.map((collection) => collection.id),
    ["live"],
  );
  assert.equal(fellBack, false);
});

test("a CORS-blocked collection list falls back to the bundled one", async () => {
  const errors: unknown[] = [];
  const bundled = [{ id: "bundled" }] as STACCollection[];
  const client = createClient({
    fallbackCollections: async () => bundled,
    onCollectionsFallback: (error) => errors.push(error),
  });
  const collections = await withFetch(
    () => Promise.reject(new TypeError("Failed to fetch")),
    () => client.getCollections(),
  );
  assert.equal(collections, bundled);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /Failed to fetch/);
});

test("the default fallback is the bundled collection list", async () => {
  const original = console.warn;
  console.warn = () => {};
  try {
    const collections = await withFetch(
      () => Promise.reject(new TypeError("Failed to fetch")),
      () => createClient().getCollections(),
    );
    assert.ok(collections.some((collection) => collection.id === "sentinel-2-l2a"));
  } finally {
    console.warn = original;
  }
});

test("the bundled collection list carries what the panel reads", async () => {
  const collections = await loadBundledPlanetaryComputerCollections();
  assert.ok(collections.length > 100, `only ${collections.length} bundled collections`);
  const ids = new Set(collections.map((collection) => collection.id));
  for (const id of ["sentinel-2-l2a", "landsat-c2-l2", "naip", "cop-dem-glo-30"]) {
    assert.ok(ids.has(id), `missing ${id}`);
  }
  const sentinel = collections.find((collection) => collection.id === "sentinel-2-l2a");
  assert.ok(sentinel?.title);
  assert.ok(sentinel?.item_assets?.visual);
  assert.equal(sentinel?.extent.spatial.bbox[0].length, 4);
});
