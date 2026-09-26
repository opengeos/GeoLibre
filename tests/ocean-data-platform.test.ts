import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  ODP_FEATURES_MAX_LIMIT,
  type OdpDataset,
  fetchOdpCatalog,
  isOdpDatasetId,
  odpBboxesIntersect,
  odpFeaturesUrl,
  odpGeometryKind,
  odpTileUrlTemplate,
  odpTimeRange,
  parseOdpBbox,
  parseOdpCollections,
  parseOdpItems,
  searchOdpDatasets,
} from "../packages/plugins/src/plugins/ocean-data-platform-api";
import { tilesWorker } from "../workers/tiles/src/index";
import { odpUpstream } from "../workers/tiles/src/odp";

const CORAL_COLLECTION = "188c9a15-b199-4a19-a02d-fa019ce5367e";
const CORAL_DATASET = "837dc357-bfc2-46f4-a91a-a88de377c9f8";
const SEAMOUNT_DATASET = "8de642cc-03d9-4538-a6d4-8260e49df597";

const collectionsJson = {
  collections: [
    {
      id: CORAL_COLLECTION,
      title: "Allen Coral Atlas",
      description: "Global coral reef habitat maps.",
      keywords: ["coral reefs", "remote sensing", 7],
    },
    { title: "missing id" },
  ],
};

const itemsJson = {
  type: "FeatureCollection",
  features: [
    {
      id: CORAL_DATASET,
      collection: CORAL_COLLECTION,
      bbox: [-180, -31.8, 180, 32.7],
      properties: {
        title: "Allen Coral Atlas - Benthic Habitats - Consolidated",
        description: "Bottom types: coral/algae, sand, rubble, rock, seagrass.",
        license: "cc-by-4.0",
        datetime: "2026-02-06T13:42:45Z",
        start_datetime: null,
        end_datetime: null,
      },
    },
    {
      id: SEAMOUNT_DATASET,
      collection: "not-a-known-collection",
      bbox: null,
      properties: {
        title: "Published — List of Seamount Bases in the World Oceans",
        description: "Seamount base polygons.",
        license: null,
        start_datetime: "2011-01-01T00:00:00Z",
        end_datetime: "2011-12-31T23:59:59Z",
      },
    },
    { id: "not-a-uuid", properties: { title: "skipped" } },
  ],
  links: [],
};

describe("Ocean Data Platform catalog", () => {
  const collections = parseOdpCollections(collectionsJson);
  const datasets = parseOdpItems(itemsJson, new Map(collections.map((c) => [c.id, c])));

  it("parses collections, skipping malformed entries and non-string keywords", () => {
    assert.deepEqual(collections, [
      {
        id: CORAL_COLLECTION,
        title: "Allen Coral Atlas",
        description: "Global coral reef habitat maps.",
        keywords: ["coral reefs", "remote sensing"],
      },
    ]);
  });

  it("parses items into datasets keyed on the dataset UUID", () => {
    assert.equal(datasets.length, 2);
    const [coral, seamount] = datasets;
    assert.equal(coral.id, CORAL_DATASET);
    assert.equal(coral.collectionTitle, "Allen Coral Atlas");
    assert.deepEqual(coral.keywords, ["coral reefs", "remote sensing"]);
    assert.deepEqual(coral.bbox, [-180, -31.8, 180, 32.7]);
    assert.equal(coral.license, "cc-by-4.0");
    // `datetime` stands in for a missing start.
    assert.equal(coral.start, "2026-02-06T13:42:45Z");
    assert.equal(coral.catalogUrl, `https://app.hubocean.earth/catalog/dataset/${CORAL_DATASET}`);
    // The "Published — " status prefix is dropped; unknown collections leave
    // the title empty rather than failing.
    assert.equal(seamount.title, "List of Seamount Bases in the World Oceans");
    assert.equal(seamount.collectionTitle, "");
    assert.equal(seamount.bbox, null);
    assert.equal(seamount.license, null);
  });

  it("reads 2D and 3D bboxes and rejects out-of-range ones", () => {
    assert.deepEqual(parseOdpBbox([1, 2, 3, 4]), [1, 2, 3, 4]);
    assert.deepEqual(parseOdpBbox([1, 2, -100, 3, 4, 0]), [1, 2, 3, 4]);
    assert.equal(parseOdpBbox([1, 5, 3, 4]), null);
    assert.equal(parseOdpBbox([1, 2, 3, 91]), null);
    assert.equal(parseOdpBbox([1, 2, 3]), null);
    assert.equal(parseOdpBbox(null), null);
  });

  it("searches every term across fields and ranks title matches first", () => {
    const all = { query: "", bbox: null, collectionId: null };
    assert.equal(searchOdpDatasets(datasets, all).length, 2);
    // "coral" is in the coral title; "seamount" only in the seamount one.
    assert.deepEqual(
      searchOdpDatasets(datasets, { ...all, query: "Seamount" }).map((d) => d.id),
      [SEAMOUNT_DATASET],
    );
    // A keyword from the collection matches, and all terms must match.
    assert.deepEqual(
      searchOdpDatasets(datasets, { ...all, query: "remote sensing" }).map((d) => d.id),
      [CORAL_DATASET],
    );
    assert.deepEqual(searchOdpDatasets(datasets, { ...all, query: "coral seamount" }), []);
    // A title match outranks a description-only match, whatever the input order.
    const described: OdpDataset = {
      ...datasets[1],
      id: "00000000-0000-0000-0000-000000000001",
      title: "Other",
      description: "polygons",
    };
    const titled: OdpDataset = { ...datasets[1], title: "Polygons of things" };
    assert.deepEqual(
      searchOdpDatasets([described, titled], { ...all, query: "polygons" }).map((d) => d.title),
      ["Polygons of things", "Other"],
    );
  });

  it("filters by collection and by map view", () => {
    const all = { query: "", bbox: null, collectionId: null };
    assert.deepEqual(
      searchOdpDatasets(datasets, { ...all, collectionId: CORAL_COLLECTION }).map((d) => d.id),
      [CORAL_DATASET],
    );
    // A dataset with no catalog extent never matches a view filter.
    assert.deepEqual(
      searchOdpDatasets(datasets, { ...all, bbox: [140, -20, 150, -10] }).map((d) => d.id),
      [CORAL_DATASET],
    );
    assert.deepEqual(searchOdpDatasets(datasets, { ...all, bbox: [0, 60, 10, 70] }), []);
  });

  it("intersects boxes across the antimeridian", () => {
    assert.equal(odpBboxesIntersect([170, -10, -170, 10], [175, 0, 179, 5]), true);
    assert.equal(odpBboxesIntersect([170, -10, -170, 10], [-175, 0, -171, 5]), true);
    assert.equal(odpBboxesIntersect([170, -10, -170, 10], [0, 0, 10, 5]), false);
    assert.equal(odpBboxesIntersect([0, 0, 10, 10], [5, 11, 6, 12]), false);
  });

  it("walks every catalog page and sorts by title", async () => {
    const requested: string[] = [];
    const pages: Record<string, unknown> = {
      "https://api.hubocean.earth/api/stac/collections": collectionsJson,
      "https://api.hubocean.earth/api/stac/search?limit=1000": {
        features: [itemsJson.features[0]],
        links: [{ rel: "next", href: "https://api.hubocean.earth/api/stac/search?offset=1" }],
      },
      "https://api.hubocean.earth/api/stac/search?offset=1": {
        features: [itemsJson.features[1], itemsJson.features[0]],
        // An off-site next link is never followed.
        links: [{ rel: "next", href: "https://example.com/steal" }],
      },
    };
    const fetchImpl = async (url: string) => {
      requested.push(url);
      const body = pages[url];
      return body
        ? new Response(JSON.stringify(body), { status: 200 })
        : new Response("", { status: 404 });
    };
    const catalog = await fetchOdpCatalog(fetchImpl);
    assert.equal(requested.length, 3);
    assert.deepEqual(
      catalog.datasets.map((d) => d.title),
      [
        "Allen Coral Atlas - Benthic Habitats - Consolidated",
        "List of Seamount Bases in the World Oceans",
      ],
    );
  });

  it("reports a failed catalog request", async () => {
    await assert.rejects(
      fetchOdpCatalog(async () => new Response("", { status: 503 })),
      /HTTP 503/,
    );
  });
});

describe("Ocean Data Platform URLs", () => {
  it("routes tiles through the Worker", () => {
    assert.equal(
      odpTileUrlTemplate(SEAMOUNT_DATASET),
      `https://tiles.geolibre.app/odp/tiles/${SEAMOUNT_DATASET}/{z}/{x}/{y}.pbf`,
    );
    assert.equal(
      odpTileUrlTemplate(SEAMOUNT_DATASET, "http://localhost:8787/odp/"),
      `http://localhost:8787/odp/tiles/${SEAMOUNT_DATASET}/{z}/{x}/{y}.pbf`,
    );
  });

  it("builds proxy and direct features URLs with a clamped limit and bbox", () => {
    assert.equal(
      odpFeaturesUrl(CORAL_DATASET, { bbox: [145, -20, 150, -15], limit: 50, via: "proxy" }),
      `https://tiles.geolibre.app/odp/features/${CORAL_DATASET}/items?limit=50&bbox=145%2C-20%2C150%2C-15`,
    );
    const direct = new URL(
      odpFeaturesUrl(CORAL_DATASET, { bbox: null, limit: 1e9, via: "direct" }),
    );
    assert.equal(
      direct.origin + direct.pathname,
      `https://api.hubocean.earth/api/features/collections/${CORAL_DATASET}/items`,
    );
    assert.equal(direct.searchParams.get("f"), "json");
    assert.equal(direct.searchParams.get("limit"), String(ODP_FEATURES_MAX_LIMIT));
    assert.equal(direct.searchParams.get("bbox"), null);
    // A view across the antimeridian widens to every longitude.
    const wrapped = new URL(
      odpFeaturesUrl(CORAL_DATASET, { bbox: [170, -95, -170, 10], limit: 1, via: "proxy" }),
    );
    assert.equal(wrapped.searchParams.get("bbox"), "-180,-90,180,10");
  });

  it("recognizes dataset ids, geometry kinds and time ranges", () => {
    assert.equal(isOdpDatasetId(CORAL_DATASET), true);
    assert.equal(isOdpDatasetId(`${CORAL_DATASET}::Polygon`), false);
    assert.equal(odpGeometryKind("MultiPolygon"), "polygon");
    assert.equal(odpGeometryKind("LineString"), "line");
    assert.equal(odpGeometryKind("Point"), "point");
    assert.equal(odpGeometryKind(undefined), null);
    assert.equal(
      odpTimeRange({ start: "2011-01-01T00:00:00Z", end: "2011-12-31T23:59:59Z" }),
      "2011-01-01 – 2011-12-31",
    );
    assert.equal(odpTimeRange({ start: "2020-05-01T00:00:00Z", end: null }), "2020-05-01");
    assert.equal(odpTimeRange({ start: null, end: null }), "");
  });
});

describe("tiles Worker /odp route", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function route(path: string) {
    return odpUpstream(new URL(`https://tiles.geolibre.app${path}`));
  }

  it("maps a tile path onto ODP's tile endpoint", () => {
    assert.deepEqual(route(`/odp/tiles/${SEAMOUNT_DATASET}/3/7/2.pbf`), {
      upstream: `https://api.hubocean.earth/api/table/v2/tile/${SEAMOUNT_DATASET}?z=3&x=7&y=2`,
      cacheSeconds: 21_600,
    });
    assert.ok(route(`/odp/tiles/${SEAMOUNT_DATASET}/3/7/2`));
  });

  it("refuses out-of-range tiles and malformed ids", () => {
    assert.equal(route(`/odp/tiles/${SEAMOUNT_DATASET}/3/8/2.pbf`), null);
    assert.equal(route(`/odp/tiles/${SEAMOUNT_DATASET}/23/0/0.pbf`), null);
    assert.equal(route("/odp/tiles/not-a-uuid/0/0/0.pbf"), null);
    assert.equal(route(`/odp/tiles/${SEAMOUNT_DATASET}/0/0/0.pbf/../../x`), null);
    assert.equal(route(`/odp/other/${SEAMOUNT_DATASET}`), null);
  });

  it("forwards only a validated bbox and limit to OGC API Features", () => {
    const features = route(
      `/odp/features/${CORAL_DATASET}/items?limit=10&bbox=145,-20,150,-15&filter=evil`,
    );
    assert.equal(
      features?.upstream,
      `https://api.hubocean.earth/api/features/collections/${CORAL_DATASET}/items?f=json&limit=10&bbox=145%2C-20%2C150%2C-15`,
    );
    // Mixed-geometry datasets are split into `::<Type>` collections.
    assert.ok(route(`/odp/features/${CORAL_DATASET}::MultiPoint/items`));
    assert.equal(route(`/odp/features/${CORAL_DATASET}/items?limit=0`), null);
    assert.equal(route(`/odp/features/${CORAL_DATASET}/items?limit=10001`), null);
    assert.equal(route(`/odp/features/${CORAL_DATASET}/items?bbox=1,2,3`), null);
    assert.equal(route(`/odp/features/${CORAL_DATASET}/items?bbox=0,10,5,5`), null);
    assert.equal(route(`/odp/features/${CORAL_DATASET}`), null);
  });

  it("proxies a tile with CORS and edge caching, without credentials", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "application/vnd.mapbox-vector-tile" },
      });
    }) as typeof fetch;
    const response = await tilesWorker.fetch(
      new Request(`https://tiles.geolibre.app/odp/tiles/${SEAMOUNT_DATASET}/0/0/0.pbf`, {
        headers: { origin: "tauri://localhost", authorization: "ApiKey secret" },
      }),
      {},
      {} as ExecutionContext,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.equal(response.headers.get("content-type"), "application/vnd.mapbox-vector-tile");
    assert.equal(response.headers.get("cache-control"), "public, max-age=21600");
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([1, 2, 3]));
    assert.equal(
      calls[0].url,
      `https://api.hubocean.earth/api/table/v2/tile/${SEAMOUNT_DATASET}?z=0&x=0&y=0`,
    );
    assert.equal(new Headers(calls[0].init?.headers).get("authorization"), null);
    const cf = (calls[0].init as RequestInit & { cf?: unknown }).cf;
    assert.deepEqual(cf, {
      cacheEverything: true,
      cacheTtlByStatus: { "200-299": 21_600, "300-599": -1 },
    });
  });

  it("relays a private dataset's 401 uncached", async () => {
    globalThis.fetch = (async () =>
      new Response('{"message":"Not authorized"}', {
        status: 401,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const response = await tilesWorker.fetch(
      new Request(`https://tiles.geolibre.app/odp/tiles/${SEAMOUNT_DATASET}/0/0/0.pbf`, {
        headers: { origin: "https://geolibre.app" },
      }),
      {},
      {} as ExecutionContext,
    );
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "no-store");
  });

  it("rejects untrusted origins and unknown paths without fetching", async () => {
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      return new Response();
    }) as typeof fetch;
    const forbidden = await tilesWorker.fetch(
      new Request(`https://tiles.geolibre.app/odp/tiles/${SEAMOUNT_DATASET}/0/0/0.pbf`, {
        headers: { origin: "https://example.com" },
      }),
      {},
      {} as ExecutionContext,
    );
    assert.equal(forbidden.status, 403);
    const missing = await tilesWorker.fetch(
      new Request("https://tiles.geolibre.app/odp/tiles/nope/0/0/0.pbf", {
        headers: { origin: "http://localhost:5173" },
      }),
      {},
      {} as ExecutionContext,
    );
    assert.equal(missing.status, 404);
    assert.equal(fetched, false);
  });
});
