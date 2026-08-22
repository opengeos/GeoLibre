import assert from "node:assert/strict";
import test from "node:test";
import {
  browserAssetHref,
  connectStac,
  assetDisplayFormat,
  assetFormat,
  isAzureBlobHref,
  isVisualizableAsset,
  itemBbox,
  openCatalogNode,
  searchStacApi,
  searchStaticStac,
  assetTargets,
  canAddAsset,
  icechunkBranch,
  isIcechunkAsset,
  requiresTarget,
  withItemBounds,
  type StacItem,
  zarrCrs,
  zarrLayerRequest,
  zarrReaderTargetCheck,
  zarrTargetCheck,
  zarrStoreTakesKeys,
  zarrStorePath,
  zarrTargets,
} from "../packages/plugins/src/plugins/stac-api";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("browserAssetHref converts anonymous S3 STAC assets to fetchable HTTPS URLs", () => {
  assert.equal(
    browserAssetHref("s3://public-bucket/path/to/data.tif", "https://example.com/catalog/"),
    "https://public-bucket.s3.amazonaws.com/path/to/data.tif",
  );
  assert.equal(
    browserAssetHref("./data.tif", "https://example.com/catalog/item.json"),
    "https://example.com/catalog/data.tif",
  );
});

test("browserAssetHref resolves Azure hrefs against the account named beside them", () => {
  // abfs names the container first and carries the account in table:storage_options, so the
  // account is prepended as the host rather than read out of the href (GeoLibre#1976).
  assert.equal(
    browserAssetHref(
      "abfs://us-census/2020/cb_2020_us_state_500k.parquet",
      "https://planetarycomputer.microsoft.com/api/stac/v1/",
      "ai4edataeuwest",
    ),
    "https://ai4edataeuwest.blob.core.windows.net/us-census/2020/cb_2020_us_state_500k.parquet",
  );
  assert.equal(
    browserAssetHref("az://container/a.parquet", "https://example.com/", "acct"),
    "https://acct.blob.core.windows.net/container/a.parquet",
  );
  // With no account there is nothing to resolve against, so the href is left alone rather
  // than guessed at.
  assert.equal(
    browserAssetHref("abfs://us-census/2020/x.parquet", "https://example.com/"),
    "abfs://us-census/2020/x.parquet",
  );
});

test("browserAssetHref reads the canonical ABFS form, which names its own account", () => {
  // abfs[s]://<container>@<account>.dfs.core.windows.net/<path> carries both parts, so it
  // resolves without storage options and must not be read as if the host were the container.
  assert.equal(
    browserAssetHref(
      "abfss://container@acct.dfs.core.windows.net/dir/a.parquet",
      "https://x.test/",
    ),
    "https://acct.blob.core.windows.net/container/dir/a.parquet",
  );
  // An account named beside it does not override the one the URI states.
  assert.equal(
    browserAssetHref(
      "abfs://container@acct.dfs.core.windows.net/a.parquet",
      "https://x.test/",
      "other",
    ),
    "https://acct.blob.core.windows.net/container/a.parquet",
  );
  // The canonical host with no container is not resolvable, so it is left alone.
  assert.equal(
    browserAssetHref("abfss://acct.dfs.core.windows.net/a.parquet", "https://x.test/"),
    "abfss://acct.dfs.core.windows.net/a.parquet",
  );
});

test("an Azure asset with nothing to resolve it against is named but not offered", () => {
  // browserAssetHref leaves the href alone when no account names the container, and none of the
  // readers behind Add speak abfs://, so the panel must not enable Add for it.
  const asset = { href: "abfs://us-census/2020/x.parquet", type: "application/x-parquet" };
  assert.equal(assetDisplayFormat(asset), "parquet");
  assert.equal(assetFormat(asset), null);
  assert.equal(isVisualizableAsset(asset), false);
  // Once resolved, the same asset is addable.
  const resolved = { ...asset, href: browserAssetHref(asset.href, "https://x.test/", "acct") };
  assert.equal(assetFormat(resolved), "parquet");
});

test("isAzureBlobHref recognizes only blob-storage URLs", () => {
  assert.equal(
    isAzureBlobHref("https://ai4edataeuwest.blob.core.windows.net/us-census/x.parquet"),
    true,
  );
  assert.equal(isAzureBlobHref("https://example.com/x.parquet"), false);
  // A host merely ending in the suffix as a substring must not match.
  assert.equal(isAzureBlobHref("https://notblob.core.windows.net.evil.com/x"), false);
  assert.equal(isAzureBlobHref("not a url"), false);
});

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

test("connectStac reads only the root of a static catalog", async () => {
  const fetched: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    fetched.push(String(input));
    return jsonResponse({
      type: "Catalog",
      id: "warehouse",
      links: [
        { rel: "child", href: "./topics/catalog.json", title: "Serving Topics" },
        { rel: "child", href: "./maps/collection.json", title: "Geologic Maps" },
        { rel: "child", href: "./unlabelled/thing.json" },
      ],
    });
  }) as typeof fetch;

  const connection = await connectStac("https://example.com/stac/catalog.json", fetcher);
  assert.equal(connection.isApi, false);
  assert.deepEqual(fetched, ["https://example.com/stac/catalog.json"]);
  assert.deepEqual(
    connection.children?.map((node) => [node.title, node.kind]),
    [
      ["Serving Topics", "container"],
      ["Geologic Maps", "collection"],
      // No title, so the folder it sits in has to name it.
      ["unlabelled", "container"],
    ],
  );
});

test("connectStac redirects the retired USGS static catalog to its supported API", async () => {
  const fetched: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    fetched.push(String(input));
    return jsonResponse({
      type: "Catalog",
      id: "usgs_astrogeology_api",
      links: [
        {
          rel: "search",
          href: "https://stac.astrogeology.usgs.gov/api/search",
        },
      ],
    });
  }) as typeof fetch;

  const connection = await connectStac(
    "http://asc-stacbrowser.s3-website-us-west-2.amazonaws.com/catalog.json",
    fetcher,
  );

  assert.equal(connection.url, "https://stac.astrogeology.usgs.gov/api");
  assert.deepEqual(fetched, ["https://stac.astrogeology.usgs.gov/api"]);
  assert.equal(connection.isApi, true);
});

test("connectStac upgrades HTTP-only S3 website catalogs to their HTTPS endpoint", async () => {
  const fetched: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    fetched.push(String(input));
    return jsonResponse({ type: "Catalog", id: "archive", links: [] });
  }) as typeof fetch;

  await connectStac("http://example.s3-website-us-west-2.amazonaws.com/catalog.json", fetcher);

  assert.deepEqual(fetched, ["https://example.s3.us-west-2.amazonaws.com/catalog.json"]);
});

test("connectStac reads a dotted S3 bucket through the path-style HTTPS endpoint", async () => {
  const fetched: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    fetched.push(String(input));
    return jsonResponse({ type: "Catalog", id: "archive", links: [] });
  }) as typeof fetch;

  // The virtual hosted-style certificate wildcard covers a single label, so a
  // bucket holding a dot has to go through the path-style endpoint instead.
  await connectStac(
    "http://example.catalog.s3-website-us-west-2.amazonaws.com/catalog.json",
    fetcher,
  );

  assert.deepEqual(fetched, ["https://s3.us-west-2.amazonaws.com/example.catalog/catalog.json"]);
});

test("openCatalogNode reports what a node turned out to be and what is inside it", async () => {
  const fetcher = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith("collection.json")) {
      return jsonResponse({ type: "Collection", id: "hazards", links: [] });
    }
    if (String(input).endsWith("scenes.json")) {
      // A catalog is allowed to link items with no collection in between.
      return jsonResponse({
        type: "Catalog",
        id: "scenes",
        links: [
          { rel: "item", href: "./a.json" },
          { rel: "item", href: "./b.json" },
          { rel: "self", href: "./scenes.json" },
        ],
      });
    }
    return jsonResponse({
      type: "Catalog",
      id: "topics",
      links: [{ rel: "child", href: "./hazards/collection.json", title: "Hazards" }],
    });
  }) as typeof fetch;

  const catalog = await openCatalogNode("https://example.com/stac/topics/catalog.json", fetcher);
  assert.equal(catalog.items, 0);
  assert.equal(catalog.kind, "container");
  assert.deepEqual(
    catalog.children.map((node) => [node.title, node.href]),
    [["Hazards", "https://example.com/stac/topics/hazards/collection.json"]],
  );

  const collection = await openCatalogNode("https://example.com/stac/x/collection.json", fetcher);
  assert.equal(collection.kind, "collection");
  assert.deepEqual(collection.children, []);

  // Items the node carries itself are counted, and only those: `self` is not one of them.
  const scenes = await openCatalogNode("https://example.com/stac/scenes.json", fetcher);
  assert.equal(scenes.items, 2);
  assert.deepEqual(scenes.children, []);
});

test("searchStaticStac starts at the chosen collection instead of walking from the root", async () => {
  // The root's other branch is large enough to exhaust the visit cap on its own. Walking from
  // the root would spend the search there and return nothing for the collection asked for.
  const bulk = Array.from({ length: 40 }, (_value, index) => ({
    rel: "child" as const,
    href: `bulk/${index}.json`,
  }));
  const docs: Record<string, unknown> = {
    "https://example.com/stac/catalog.json": {
      type: "Catalog",
      id: "root",
      links: [
        { rel: "child", href: "./bulk/catalog.json" },
        { rel: "child", href: "./wanted.json" },
      ],
    },
    "https://example.com/stac/bulk/catalog.json": {
      type: "Catalog",
      id: "bulk",
      links: bulk,
    },
    "https://example.com/stac/wanted.json": {
      type: "Collection",
      id: "wanted",
      links: [{ rel: "item", href: "item.json" }],
    },
    "https://example.com/stac/item.json": {
      type: "Feature",
      id: "wanted-item",
      collection: "wanted",
      bbox: [0, 0, 1, 1],
      geometry: null,
      properties: { datetime: "2024-05-01T00:00:00Z" },
      assets: {},
    },
  };
  for (const link of bulk) {
    docs[`https://example.com/stac/bulk/${link.href.split("/")[1]}`] = {
      type: "Catalog",
      id: link.href,
      links: [],
    };
  }
  const calls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    return jsonResponse(docs[url]);
  }) as typeof fetch;

  const result = await searchStaticStac(
    {
      url: "https://example.com/stac/catalog.json",
      title: "Static",
      isApi: false,
      collections: [],
      children: [],
      root: docs["https://example.com/stac/catalog.json"] as Record<string, unknown>,
    },
    { entries: ["https://example.com/stac/wanted.json"], limit: 20 },
    fetcher,
  );

  assert.deepEqual(
    result.items.map((item) => item.id),
    ["wanted-item"],
  );
  assert.equal(
    calls.some((url) => url.includes("/bulk/")),
    false,
    "the unselected branch is never visited",
  );
});

test("connectStac reads child links only, and names them when the link does not", async () => {
  const fetcher = (async () =>
    jsonResponse({
      type: "Catalog",
      id: "warehouse",
      links: [
        { rel: "self", href: "./catalog.json" },
        { rel: "root", href: "./catalog.json" },
        { rel: "parent", href: "../catalog.json" },
        { rel: "item", href: "./scene.json", title: "A scene, not a folder" },
        { rel: "child", href: "./maps/collection.json", title: "Geologic Maps" },
        // A bare % is legal in a path and fatal to decodeURIComponent.
        { rel: "child", href: "./100%_coverage/catalog.json" },
        { rel: "child", href: "./UPPER/CATALOG.JSON" },
        { rel: "child", href: "./quads/" },
        // At the root there is no folder to borrow a name from.
        { rel: "child", href: "/standalone.json" },
      ],
    })) as typeof fetch;

  const connection = await connectStac("https://example.com/stac/catalog.json", fetcher);
  assert.deepEqual(
    connection.children?.map((node) => [node.title, node.kind]),
    [
      ["Geologic Maps", "collection"],
      ["100%_coverage", "container"],
      ["UPPER", "container"],
      ["quads", "container"],
      ["standalone", "container"],
    ],
  );
});

test("connectStac offers no tree for an API, which is searched through its endpoint", async () => {
  // NASA's CMR is an API that also lists a sub-catalog per provider, but its root search endpoint
  // 404s — only each provider's own answers — so those branches cannot be searched from here.
  const fetcher = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/collections")) return jsonResponse({ collections: [] });
    return jsonResponse({
      type: "Catalog",
      id: "api",
      conformsTo: ["https://api.stacspec.org/v1.0.0/item-search"],
      links: [
        { rel: "data", href: "./collections" },
        { rel: "child", href: "./LPCLOUD/catalog.json", title: "LPCLOUD" },
      ],
    });
  }) as typeof fetch;

  const connection = await connectStac("https://example.com/stac/", fetcher);
  assert.equal(connection.isApi, true);
  assert.deepEqual(connection.children, []);
});

test("openCatalogNode refuses a document that is not an object", async () => {
  const fetcher = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith("missing.json")) return jsonResponse(null);
    if (String(input).endsWith("list.json")) return jsonResponse([1, 2]);
    return jsonResponse({ status: 404 }, 404);
  }) as typeof fetch;

  for (const href of ["https://example.com/missing.json", "https://example.com/list.json"]) {
    await assert.rejects(
      () => openCatalogNode(href, fetcher),
      /did not return a STAC document/,
      `${href} must not read as an empty catalog`,
    );
  }
  await assert.rejects(() => openCatalogNode("https://example.com/gone.json", fetcher), /404/);
});

test("several chosen collections are searched together, and the root is not read twice", async () => {
  const docs: Record<string, unknown> = {
    "https://example.com/stac/catalog.json": {
      type: "Catalog",
      links: [{ rel: "item", href: "./root-item.json" }],
    },
    "https://example.com/stac/a.json": {
      type: "Collection",
      id: "a",
      links: [{ rel: "item", href: "./a-item.json" }],
    },
    "https://example.com/stac/b.json": {
      type: "Collection",
      id: "b",
      links: [{ rel: "item", href: "./b-item.json" }],
    },
  };
  for (const id of ["root-item", "a-item", "b-item"]) {
    docs[`https://example.com/stac/${id}.json`] = {
      type: "Feature",
      id,
      collection: "c",
      bbox: [0, 0, 1, 1],
      geometry: null,
      properties: { datetime: "2024-05-01T00:00:00Z" },
      assets: {},
    };
  }
  const reads: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    reads.push(String(input));
    return jsonResponse(docs[String(input)]);
  }) as typeof fetch;
  const connection = {
    url: "https://example.com/stac/catalog.json",
    title: "Static",
    isApi: false,
    collections: [],
    root: docs["https://example.com/stac/catalog.json"] as Record<string, unknown>,
  };

  const result = await searchStaticStac(
    connection,
    {
      // The root is one of the chosen entries: the caller already has that document, so asking
      // the network for it again would be a read spent on something already in hand.
      entries: [
        "https://example.com/stac/a.json",
        "https://example.com/stac/b.json",
        connection.url,
      ],
      limit: 20,
    },
    fetcher,
  );

  assert.deepEqual(result.items.map((item) => item.id).sort(), ["a-item", "b-item", "root-item"]);
  assert.equal(
    reads.filter((url) => url === connection.url).length,
    0,
    "the root came from the connection, not from a second read",
  );
});

test("openCatalogNode reports a collection's extent, and ignores a malformed one", async () => {
  const extents: Record<string, unknown> = {
    good: { spatial: { bbox: [[-114, 37, -109, 42]] } },
    // A 3D extent carries six numbers; the map only wants the four that are horizontal.
    deep: { spatial: { bbox: [[-114, 37, 0, -109, 42, 2000]] } },
    empty: { spatial: { bbox: [] } },
    words: { spatial: { bbox: [["west", "south", "east", "north"]] } },
    short: { spatial: { bbox: [[-114, 37]] } },
    // Half of five is not an index: the middle of an odd box is a coordinate that does not exist.
    odd: { spatial: { bbox: [[-114, 37, 0, -109, 42]] } },
    infinite: { spatial: { bbox: [[-114, 37, Number.POSITIVE_INFINITY, 42]] } },
    temporalOnly: { temporal: { interval: [["2024-01-01T00:00:00Z", null]] } },
    notAnObject: "everywhere",
  };
  const fetcher = (async (input: RequestInfo | URL) => {
    const key = new URL(String(input)).pathname.slice(1).replace(".json", "");
    return jsonResponse({ type: "Collection", id: key, links: [], extent: extents[key] });
  }) as typeof fetch;

  const bboxOf = async (key: string) =>
    (await openCatalogNode(`https://example.com/${key}.json`, fetcher)).bbox;

  assert.deepEqual(await bboxOf("good"), [-114, 37, -109, 42]);
  assert.deepEqual(await bboxOf("deep"), [-114, 37, -109, 42]);
  for (const key of ["empty", "words", "short", "odd", "infinite", "temporalOnly", "notAnObject"]) {
    assert.equal(await bboxOf(key), undefined, `${key} is not an extent the map can be sent to`);
  }
});

test("openCatalogNode gives up when the search that asked for it is called off", async () => {
  const controller = new AbortController();
  let seen: AbortSignal | undefined;
  const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    seen = init?.signal ?? undefined;
    if (seen?.aborted) throw new DOMException("aborted", "AbortError");
    return jsonResponse({ type: "Catalog", links: [] });
  }) as typeof fetch;

  await openCatalogNode("https://example.com/stac/catalog.json", fetcher, controller.signal);
  assert.equal(seen, controller.signal, "the caller's signal reaches the request");

  controller.abort();
  await assert.rejects(
    () => openCatalogNode("https://example.com/stac/catalog.json", fetcher, controller.signal),
    /abort/i,
  );
});

test("a search the caller abandons stops reading", async () => {
  // A static catalog has no index, so a walk opens documents to answer a filter. One nobody is
  // waiting for should stop rather than read its way to the page budget.
  const controller = new AbortController();
  let reads = 0;
  const docs: Record<string, unknown> = {
    "https://example.com/stac/catalog.json": {
      type: "Catalog",
      links: Array.from({ length: 60 }, (_value, index) => ({
        rel: "item",
        href: `./item-${index}.json`,
      })),
    },
  };
  for (let index = 0; index < 60; index += 1) {
    docs[`https://example.com/stac/item-${index}.json`] = {
      type: "Feature",
      id: `i${index}`,
      collection: "c",
      // Nothing matches, so the walk would otherwise read every one of them.
      bbox: [100, 40, 101, 41],
      geometry: null,
      properties: { datetime: "2024-05-01T00:00:00Z" },
      assets: {},
    };
  }
  const fetcher = (async (input: RequestInfo | URL) => {
    reads += 1;
    if (reads > 12) controller.abort();
    return jsonResponse(docs[String(input)]);
  }) as typeof fetch;

  const result = await searchStaticStac(
    {
      url: "https://example.com/stac/catalog.json",
      title: "Static",
      isApi: false,
      collections: [],
      root: docs["https://example.com/stac/catalog.json"] as Record<string, unknown>,
    },
    { limit: 20, bbox: [-1, -1, 1, 1], signal: controller.signal },
    fetcher,
  );

  assert.deepEqual(result.items, []);
  assert.ok(reads < 40, `stopped early, having read ${reads} of 60`);
});

test("a search keeps the collection filter it began with as later pages arrive", async () => {
  // The tree's selection can change between Load more clicks; the filter must not follow it, or
  // one accumulated list ends up filtered two ways.
  const docs: Record<string, unknown> = {
    "https://example.com/stac/catalog.json": {
      type: "Catalog",
      links: Array.from({ length: 4 }, (_value, index) => ({
        rel: "item",
        href: `./item-${index}.json`,
      })),
    },
  };
  for (let index = 0; index < 4; index += 1) {
    docs[`https://example.com/stac/item-${index}.json`] = {
      type: "Feature",
      id: `i${index}`,
      collection: index % 2 === 0 ? "a" : "b",
      bbox: [0, 0, 1, 1],
      geometry: null,
      properties: { datetime: "2024-05-01T00:00:00Z" },
      assets: {},
    };
  }
  const fetcher = (async (input: RequestInfo | URL) =>
    jsonResponse(docs[String(input)])) as typeof fetch;
  const connection = {
    url: "https://example.com/stac/catalog.json",
    title: "Static",
    isApi: false,
    collections: [],
    root: docs["https://example.com/stac/catalog.json"] as Record<string, unknown>,
  };

  const first = await searchStaticStac(connection, { limit: 1, collections: ["a"] }, fetcher);
  assert.deepEqual(
    first.items.map((item) => item.id),
    ["i0"],
  );
  assert.ok(first.cursor);
  // The user picks a tree entry and drops the collection filter before asking for more.
  const second = await searchStaticStac(
    connection,
    { limit: 5, cursor: first.cursor, entries: ["https://example.com/stac/other.json"] },
    fetcher,
  );
  assert.deepEqual(
    second.items.map((item) => item.id),
    ["i2"],
    "page two filters the way page one did",
  );
});

test("a search keeps the extent and dates it began with as later pages arrive", async () => {
  // The panel re-reads its form on every Load more, so a filter typed mid-walk must not apply to
  // half a list: page one set the terms.
  const docs: Record<string, unknown> = {
    "https://example.com/stac/catalog.json": {
      type: "Catalog",
      links: Array.from({ length: 4 }, (_value, index) => ({
        rel: "item",
        href: `./item-${index}.json`,
      })),
    },
  };
  for (let index = 0; index < 4; index += 1) {
    docs[`https://example.com/stac/item-${index}.json`] = {
      type: "Feature",
      id: `i${index}`,
      collection: "c",
      bbox: index < 2 ? [0, 0, 1, 1] : [100, 40, 101, 41],
      geometry: null,
      properties: { datetime: index < 2 ? "2024-05-01T00:00:00Z" : "1999-01-01T00:00:00Z" },
      assets: {},
    };
  }
  const fetcher = (async (input: RequestInfo | URL) =>
    jsonResponse(docs[String(input)])) as typeof fetch;
  const connection = {
    url: "https://example.com/stac/catalog.json",
    title: "Static",
    isApi: false,
    collections: [],
    root: docs["https://example.com/stac/catalog.json"] as Record<string, unknown>,
  };

  const first = await searchStaticStac(connection, { limit: 1 }, fetcher);
  assert.deepEqual(
    first.items.map((item) => item.id),
    ["i0"],
  );
  const second = await searchStaticStac(
    connection,
    {
      limit: 5,
      cursor: first.cursor,
      bbox: [-1, -1, 2, 2],
      datetime: "2024-01-01T00:00:00Z/..",
    },
    fetcher,
  );
  assert.deepEqual(
    second.items.map((item) => item.id),
    ["i1", "i2", "i3"],
    "an extent and a date range typed mid-walk do not apply to the rest of a started search",
  );
});

test("an untouched tree leaves the search walking the whole catalog", async () => {
  // The panel always passes `entries`, empty when nothing in the tree is chosen. Reading that as
  // "search nothing" would break every default search on a static catalog.
  const docs: Record<string, unknown> = {
    "https://example.com/stac/catalog.json": {
      type: "Catalog",
      links: [{ rel: "item", href: "./only.json" }],
    },
    "https://example.com/stac/only.json": {
      type: "Feature",
      id: "only",
      collection: "c",
      bbox: [0, 0, 1, 1],
      geometry: null,
      properties: { datetime: "2024-05-01T00:00:00Z" },
      assets: {},
    },
  };
  const fetcher = (async (input: RequestInfo | URL) =>
    jsonResponse(docs[String(input)])) as typeof fetch;
  const connection = {
    url: "https://example.com/stac/catalog.json",
    title: "Static",
    isApi: false,
    collections: [],
    // A catalog one level deep: items at the root, nothing to put in a tree.
    children: [],
    root: docs["https://example.com/stac/catalog.json"] as Record<string, unknown>,
  };

  const result = await searchStaticStac(connection, { entries: [], limit: 20 }, fetcher);
  assert.deepEqual(
    result.items.map((item) => item.id),
    ["only"],
  );
  assert.equal(result.matched, 1);
});

test("a link is read as a collection however its query or fragment is written", async () => {
  const fetcher = (async () =>
    jsonResponse({
      type: "Catalog",
      links: [
        { rel: "child", href: "./a/collection.json?version=2" },
        { rel: "child", href: "./b/collection.json#section" },
        { rel: "child", href: "./c/COLLECTION.JSON" },
        { rel: "child", href: "./d/catalog.json" },
      ],
    })) as typeof fetch;

  const connection = await connectStac("https://example.com/stac/catalog.json", fetcher);
  assert.deepEqual(
    connection.children?.map((node) => node.kind),
    ["collection", "collection", "collection", "container"],
  );
});

test("a tree selection narrows where the search starts without voiding the collection filter", async () => {
  const docs: Record<string, unknown> = {
    "https://example.com/stac/landsat.json": {
      type: "Collection",
      id: "landsat",
      links: [
        { rel: "child", href: "./l8/collection.json" },
        { rel: "child", href: "./l9/collection.json" },
      ],
    },
    "https://example.com/stac/l8/collection.json": {
      type: "Collection",
      id: "landsat-8",
      links: [{ rel: "item", href: "./scene.json" }],
    },
    "https://example.com/stac/l9/collection.json": {
      type: "Collection",
      id: "landsat-9",
      links: [{ rel: "item", href: "./scene.json" }],
    },
  };
  for (const [id, path] of [
    ["L8", "l8"],
    ["L9", "l9"],
  ]) {
    docs[`https://example.com/stac/${path}/scene.json`] = {
      type: "Feature",
      id,
      collection: `landsat-${id === "L8" ? 8 : 9}`,
      bbox: [0, 0, 1, 1],
      geometry: null,
      properties: { datetime: "2024-05-01T00:00:00Z" },
      assets: {},
    };
  }
  const fetcher = (async (input: RequestInfo | URL) =>
    jsonResponse(docs[String(input)])) as typeof fetch;
  const connection = {
    url: "https://example.com/stac/catalog.json",
    title: "Static",
    isApi: false,
    collections: [],
    root: { type: "Catalog", links: [] } as Record<string, unknown>,
  };

  const both = await searchStaticStac(
    connection,
    { entries: ["https://example.com/stac/landsat.json"], limit: 20 },
    fetcher,
  );
  assert.deepEqual(both.items.map((item) => item.id).sort(), ["L8", "L9"]);

  const narrowed = await searchStaticStac(
    connection,
    {
      entries: ["https://example.com/stac/landsat.json"],
      collections: ["landsat-9"],
      limit: 20,
    },
    fetcher,
  );
  assert.deepEqual(
    narrowed.items.map((item) => item.id),
    ["L9"],
    "both filters apply; neither is silently dropped",
  );
});

test("a searched item's Azure asset arrives resolved against its storage options", async () => {
  const fetcher = (async () =>
    jsonResponse({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          id: "2020-census-states",
          geometry: null,
          collection: "us-census",
          properties: { datetime: "2021-08-01T00:00:00Z" },
          assets: {
            data: {
              href: "abfs://us-census/2020/cb_2020_us_state_500k.parquet",
              type: "application/x-parquet",
              "table:storage_options": { account_name: "ai4edataeuwest" },
            },
          },
        },
      ],
      links: [],
    })) as typeof fetch;
  const result = await searchStacApi(
    {
      url: "https://planetarycomputer.microsoft.com/api/stac/v1/",
      title: "Planetary Computer",
      isApi: true,
      searchUrl: "https://planetarycomputer.microsoft.com/api/stac/v1/search",
      collections: [],
      root: {},
    },
    { limit: 10 },
    fetcher,
  );
  assert.equal(
    result.items[0].assets.data.href,
    "https://ai4edataeuwest.blob.core.windows.net/us-census/2020/cb_2020_us_state_500k.parquet",
  );
});

test("storage options on the item resolve an asset that carries none of its own", async () => {
  // The table extension allows the options to sit once on the item rather than on every asset.
  const fetcher = (async () =>
    jsonResponse({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          id: "shared-options",
          geometry: null,
          collection: "us-census",
          properties: {
            datetime: "2021-08-01T00:00:00Z",
            "table:storage_options": { account_name: "ai4edataeuwest" },
          },
          assets: {
            data: { href: "abfs://us-census/2020/a.parquet", type: "application/x-parquet" },
          },
        },
      ],
      links: [],
    })) as typeof fetch;
  const result = await searchStacApi(
    {
      url: "https://planetarycomputer.microsoft.com/api/stac/v1/",
      title: "Planetary Computer",
      isApi: true,
      searchUrl: "https://planetarycomputer.microsoft.com/api/stac/v1/search",
      collections: [],
      root: {},
    },
    { limit: 10 },
    fetcher,
  );
  assert.equal(
    result.items[0].assets.data.href,
    "https://ai4edataeuwest.blob.core.windows.net/us-census/2020/a.parquet",
  );
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
            data: {
              href: "s3://public-bucket/one.tif",
              type: "image/tiff; application=geotiff",
            },
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
      additional: {
        query: { "eo:cloud_cover": { lt: 10 } },
        sortby: [{ field: "properties.datetime", direction: "desc" }],
        // Standard form fields remain authoritative.
        limit: 999,
        bbox: [0, 0, 0, 0],
      },
      limit: 10,
    },
    fetcher,
  );
  assert.deepEqual(body, {
    query: { "eo:cloud_cover": { lt: 10 } },
    sortby: [{ field: "properties.datetime", direction: "desc" }],
    limit: 10,
    bbox: [-10, -5, 10, 5],
    datetime: "2024-01-01/2024-02-01",
    collections: ["demo"],
  });
  assert.equal(result.items[0].id, "one");
  assert.equal(result.items[0].assets.data.href, "https://public-bucket.s3.amazonaws.com/one.tif");
  assert.equal(result.matched, 4);
  assert.deepEqual(result.next, {
    href: "https://example.com/stac/search?token=next",
    method: "POST",
    body: { token: "next" },
  });
});

test("searchStacApi falls back to GET when the search endpoint rejects POST", async () => {
  const calls: Array<{ url: string; method?: string }> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method });
    if (init?.method === "POST") throw new Error("405 Method Not Allowed");
    return jsonResponse({
      type: "FeatureCollection",
      numberMatched: 1,
      features: [
        {
          type: "Feature",
          id: "get-only",
          bbox: [-1, -2, 3, 4],
          geometry: null,
          properties: { datetime: "2024-01-15T00:00:00Z" },
          assets: { data: { href: "https://example.com/one.tif" } },
        },
      ],
      links: [],
    });
  }) as typeof fetch;

  const result = await searchStacApi(
    {
      url: "https://example.com/stac/",
      title: "Demo",
      isApi: true,
      searchUrl: "https://example.com/stac/search",
      collections: [],
      root: {},
    },
    {
      bbox: [-10, -5, 10, 5],
      datetime: "2024-01-01/2024-02-01",
      collections: ["demo"],
      additional: { filter: { op: "=", args: [{ property: "platform" }, "sentinel-2a"] } },
      limit: 10,
    },
    fetcher,
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[1].method, undefined);
  const fallback = new URL(calls[1].url);
  assert.equal(fallback.pathname, "/stac/search");
  assert.equal(fallback.searchParams.get("limit"), "10");
  assert.equal(fallback.searchParams.get("bbox"), "-10,-5,10,5");
  assert.equal(fallback.searchParams.get("datetime"), "2024-01-01/2024-02-01");
  assert.equal(fallback.searchParams.get("collections"), "demo");
  assert.equal(
    fallback.searchParams.get("filter"),
    JSON.stringify({ op: "=", args: [{ property: "platform" }, "sentinel-2a"] }),
  );
  assert.equal(result.items[0].id, "get-only");
  assert.equal(result.matched, 1);
});

test("searchStaticStac traverses child and item links and applies filters", async () => {
  const docs: Record<string, unknown> = {
    "https://example.com/collection.json": {
      type: "Collection",
      links: [
        { rel: "item", href: "inside.json" },
        { rel: "item", href: "outside.json" },
        { rel: "item", href: "elevated.json" },
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
    // 3D bbox: [minX, minY, minZ, maxX, maxY, maxZ]. Inside the search extent, but
    // reading it as 2D would compare minZ (-500) against the extent's minX and drop it.
    "https://example.com/elevated.json": {
      type: "Feature",
      id: "elevated",
      collection: "demo",
      bbox: [0, 0, -500, 2, 2, -100],
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
    ["inside", "elevated"],
  );
});

test("searchStaticStac exposes assets attached directly to a Collection", async () => {
  const url = "https://example.com/data/collection.json";
  const root = {
    type: "Collection",
    id: "collection-assets",
    title: "Collection assets",
    extent: {
      spatial: {
        bbox: [
          [4.8, 52, 5.2, 52.2],
          [10, 60, 11, 61],
        ],
      },
      temporal: {
        interval: [
          ["2020-01-01T00:00:00Z", "2020-12-31T23:59:59Z"],
          ["2022-01-01T00:00:00Z", "2022-12-31T23:59:59Z"],
        ],
      },
    },
    assets: {
      geoparquet: { href: "data.parquet", type: "application/vnd.apache.parquet" },
      pmtiles: { href: "tiles.pmtiles", type: "application/vnd.pmtiles" },
    },
    links: [],
  };

  const result = await searchStaticStac(
    { url, title: "Static collection", isApi: false, collections: [], root },
    { bbox: [10.5, 60.5, 10.6, 60.6], datetime: "2020-06-01", limit: 20 },
  );

  assert.equal(result.matched, 1);
  assert.equal(result.items[0].id, "collection-assets::collection-assets");
  assert.equal(result.items[0].properties.title, "Collection assets");
  assert.deepEqual(result.items[0].bbox, [4.8, 52, 5.2, 52.2]);
  assert.equal(result.items[0].assets.geoparquet.href, "https://example.com/data/data.parquet");
  assert.equal(result.items[0].assets.pmtiles.href, "https://example.com/data/tiles.pmtiles");

  const outsideTime = await searchStaticStac(
    { url, title: "Static collection", isApi: false, collections: [], root },
    { datetime: "2021-01-01", limit: 20 },
  );
  assert.equal(outsideTime.matched, 0);

  const laterInterval = await searchStaticStac(
    { url, title: "Static collection", isApi: false, collections: [], root },
    { datetime: "2022-06-01", limit: 20 },
  );
  assert.equal(laterInterval.matched, 1);

  const openEnded = {
    ...root,
    extent: { ...root.extent, temporal: { interval: [[null, "2020-12-31T23:59:59Z"]] } },
  };
  const beforeOpenEnd = await searchStaticStac(
    { url, title: "Static collection", isApi: false, collections: [], root: openEnded },
    { datetime: "1900-01-01", limit: 20 },
  );
  assert.equal(beforeOpenEnd.matched, 1);

  const unknownExtents = {
    ...root,
    extent: { spatial: { bbox: {} as unknown as number[][] } },
  };
  const unknownTime = await searchStaticStac(
    { url, title: "Static collection", isApi: false, collections: [], root: unknownExtents },
    { datetime: "2024-01-01", limit: 20 },
  );
  assert.equal(unknownTime.matched, 1);
  assert.equal(unknownTime.items[0].bbox, undefined);
});

test("searchStaticStac pages through a catalog holding more items than one page fits", async () => {
  const total = 25;
  const docs: Record<string, unknown> = {
    "https://example.com/stac/catalog.json": {
      type: "Catalog",
      links: Array.from({ length: total }, (_value, index) => ({
        rel: "item",
        href: `./item${index}.json`,
      })),
    },
  };
  for (let index = 0; index < total; index += 1) {
    docs[`https://example.com/stac/item${index}.json`] = {
      type: "Feature",
      id: `item${index}`,
      collection: "many",
      bbox: [0, 0, 1, 1],
      geometry: null,
      properties: { datetime: "2024-05-01T00:00:00Z" },
      assets: {},
    };
  }
  const fetcher = (async (input: RequestInfo | URL) =>
    jsonResponse(docs[String(input)])) as typeof fetch;
  const connection = {
    url: "https://example.com/stac/catalog.json",
    title: "Static",
    isApi: false,
    collections: [],
    children: [],
    root: docs["https://example.com/stac/catalog.json"] as Record<string, unknown>,
  };

  const first = await searchStaticStac(connection, { limit: 10 }, fetcher);
  assert.equal(first.items.length, 10);
  assert.ok(first.cursor, "a walk with documents left over reports where it stopped");
  assert.equal(first.matched, undefined);

  const second = await searchStaticStac(connection, { limit: 10, cursor: first.cursor }, fetcher);
  assert.equal(second.items.length, 10);
  assert.deepEqual(
    second.items.map((item) => item.id).filter((id) => first.items.some((seen) => seen.id === id)),
    [],
    "a resumed page repeats nothing from the page before it",
  );

  const third = await searchStaticStac(connection, { limit: 10, cursor: second.cursor }, fetcher);
  assert.equal(third.items.length, 5);
  assert.equal(third.cursor, undefined, "the walk is done, so there is nothing to resume");
  assert.equal(third.matched, 25);
});

test("searchStaticStac reads items before folders, so a page is not spent on structure", async () => {
  // Items one folder down, behind a hundred empty ones. Discovery order spends the page on
  // folders and returns nothing.
  const docs: Record<string, unknown> = {
    "https://example.com/stac/catalog.json": {
      type: "Catalog",
      links: [
        { rel: "child", href: "./has-items.json" },
        ...Array.from({ length: 100 }, (_value, index) => ({
          rel: "child",
          href: `./empty${index}.json`,
        })),
      ],
    },
    "https://example.com/stac/has-items.json": {
      type: "Catalog",
      links: Array.from({ length: 3 }, (_value, index) => ({
        rel: "item",
        href: `./item${index}.json`,
      })),
    },
  };
  for (let index = 0; index < 100; index += 1) {
    docs[`https://example.com/stac/empty${index}.json`] = { type: "Catalog", links: [] };
  }
  for (let index = 0; index < 3; index += 1) {
    docs[`https://example.com/stac/item${index}.json`] = {
      type: "Feature",
      id: `item${index}`,
      collection: "c",
      bbox: [0, 0, 1, 1],
      geometry: null,
      properties: { datetime: "2024-05-01T00:00:00Z" },
      assets: {},
    };
  }
  let reads = 0;
  const fetcher = (async (input: RequestInfo | URL) => {
    reads += 1;
    return jsonResponse(docs[String(input)]);
  }) as typeof fetch;

  const result = await searchStaticStac(
    {
      url: "https://example.com/stac/catalog.json",
      title: "Static",
      isApi: false,
      collections: [],
      root: docs["https://example.com/stac/catalog.json"] as Record<string, unknown>,
    },
    { limit: 3 },
    fetcher,
  );

  assert.equal(result.items.length, 3);
  // Discovery order costs a hundred more.
  assert.ok(reads < 30, `expected the items to be reached quickly, took ${reads} reads`);
});

test("a page stops reading at its budget rather than crawling the whole catalog", async () => {
  // No items anywhere, so only the budget can end the page.
  let reads = 0;
  const fetcher = (async () => {
    reads += 1;
    return jsonResponse({
      type: "Catalog",
      links: [
        { rel: "child", href: `./${reads}-a.json` },
        { rel: "child", href: `./${reads}-b.json` },
      ],
    });
  }) as typeof fetch;

  const result = await searchStaticStac(
    {
      url: "https://example.com/stac/catalog.json",
      title: "Static",
      isApi: false,
      collections: [],
      root: { type: "Catalog", links: [{ rel: "child", href: "./a.json" }] },
    },
    { limit: 20 },
    fetcher,
  );

  assert.deepEqual(result.items, []);
  assert.ok(reads <= 300, `a page must stop at its budget, read ${reads}`);
  assert.ok(result.cursor, "and report that the walk is unfinished");
});

test("a read that fails once is retried rather than dropped from the search", async () => {
  // The batch leaves the queue before its requests go out, so a failure that took the batch with
  // it would strand every document in it — and any folder among them, its whole subtree.
  let failures = 0;
  const docs: Record<string, unknown> = {
    "https://example.com/stac/catalog.json": {
      type: "Catalog",
      links: [
        { rel: "item", href: "./flaky.json" },
        { rel: "item", href: "./steady.json" },
      ],
    },
  };
  for (const id of ["flaky", "steady"]) {
    docs[`https://example.com/stac/${id}.json`] = {
      type: "Feature",
      id,
      collection: "c",
      bbox: [0, 0, 1, 1],
      geometry: null,
      properties: { datetime: "2024-05-01T00:00:00Z" },
      assets: {},
    };
  }
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("flaky.json") && failures === 0) {
      failures += 1;
      throw new Error("network");
    }
    return jsonResponse(docs[url]);
  }) as typeof fetch;

  const connection = {
    url: "https://example.com/stac/catalog.json",
    title: "Static",
    isApi: false,
    collections: [],
    children: [],
    root: docs["https://example.com/stac/catalog.json"] as Record<string, unknown>,
  };

  const first = await searchStaticStac(connection, { limit: 20 }, fetcher);
  const ids = [...first.items.map((item) => item.id)];
  if (first.cursor) {
    const second = await searchStaticStac(connection, { limit: 20, cursor: first.cursor }, fetcher);
    ids.push(...second.items.map((item) => item.id));
  }
  assert.deepEqual(ids.sort(), ["flaky", "steady"]);
});

test("a page that runs out of reads before matching anything returns a cursor, not a total", async () => {
  // The panel says "no results" off a finished empty page, so an unfinished one must not look
  // finished: the match here sits past the first page's read budget.
  const root = {
    type: "Catalog",
    links: Array.from({ length: 400 }, (_, index) => ({
      rel: "child",
      href: `./child-${index}.json`,
    })),
  };
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("child-399.json")) {
      return jsonResponse({ type: "Catalog", links: [{ rel: "item", href: "./deep.json" }] });
    }
    if (url.endsWith("deep.json")) {
      return jsonResponse({
        type: "Feature",
        id: "deep",
        collection: "c",
        bbox: [0, 0, 1, 1],
        geometry: null,
        properties: { datetime: "2024-05-01T00:00:00Z" },
        assets: {},
      });
    }
    return jsonResponse({ type: "Catalog", links: [] });
  }) as typeof fetch;

  const connection = {
    url: "https://example.com/stac/catalog.json",
    title: "Static",
    isApi: false,
    collections: [],
    root,
  };

  const first = await searchStaticStac(connection, { limit: 20 }, fetcher);
  assert.deepEqual(first.items, []);
  assert.ok(first.cursor, "an unfinished walk must hand back a cursor");
  assert.equal(first.matched, undefined, "an unfinished walk has no total to report");

  const second = await searchStaticStac(connection, { limit: 20, cursor: first.cursor }, fetcher);
  assert.deepEqual(
    second.items.map((item) => item.id),
    ["deep"],
  );
  assert.equal(second.cursor, undefined);
  assert.equal(second.matched, 1);
});

test("a document that never reads leaves the search without a total", async () => {
  const docs: Record<string, unknown> = {
    "https://example.com/stac/catalog.json": {
      type: "Catalog",
      links: [
        { rel: "item", href: "./good.json" },
        { rel: "child", href: "./dead.json" },
      ],
    },
    "https://example.com/stac/good.json": {
      type: "Feature",
      id: "good",
      collection: "c",
      bbox: [0, 0, 1, 1],
      geometry: null,
      properties: { datetime: "2024-05-01T00:00:00Z" },
      assets: {},
    },
  };
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("dead.json")) throw new Error("gone");
    return jsonResponse(docs[url]);
  }) as typeof fetch;

  const connection = {
    url: "https://example.com/stac/catalog.json",
    title: "Static",
    isApi: false,
    collections: [],
    children: [],
    root: docs["https://example.com/stac/catalog.json"] as Record<string, unknown>,
  };

  let result = await searchStaticStac(connection, { limit: 20 }, fetcher);
  const ids = result.items.map((item) => item.id);
  while (result.cursor) {
    result = await searchStaticStac(connection, { limit: 20, cursor: result.cursor }, fetcher);
    ids.push(...result.items.map((item) => item.id));
  }
  assert.deepEqual(ids, ["good"]);
  // The dead child's subtree went unread, so "1 of 1" would overstate what was searched.
  assert.equal(result.matched, undefined);
});

test("an asset's format comes from its media type, or its extension when there is none", async () => {
  // The registered type is what a spec-following catalog sends; the extension covers the rest.
  assert.equal(
    assetFormat({ href: "https://example.com/a.pmtiles", type: "application/vnd.pmtiles" }),
    "pmtiles",
  );
  assert.equal(assetFormat({ href: "https://example.com/a.PMTILES" }), "pmtiles");
  assert.equal(assetFormat({ href: "https://example.com/a.pmtiles?token=1" }), "pmtiles");
  assert.equal(assetFormat({ href: "https://example.com/tiles?id=7&f=pmtiles" }), null);
  assert.equal(assetFormat({ href: "https://example.com/a.tif", type: "image/tiff" }), "cog");
  assert.equal(
    assetFormat({ href: "https://example.com/a.json", type: "application/geo+json" }),
    "geojson",
  );
  assert.equal(assetFormat({ href: "https://example.com/data.bin" }), null);
  assert.equal(
    assetDisplayFormat({
      href: "https://example.com/data.bin",
      type: "application/vnd.apache.parquet",
    }),
    "parquet",
  );
  assert.equal(assetDisplayFormat({ href: "https://example.com/data.parquet" }), "parquet");
  assert.equal(
    assetFormat({ href: "https://example.com/data.bin", type: "application/vnd.apache.parquet" }),
    "parquet",
  );
  assert.equal(assetFormat({ href: "https://example.com/data.parquet" }), "parquet");

  // Archives under a directory named for another format are read by the asset, not the path.
  assert.equal(assetFormat({ href: "https://example.com/geotiff/a.pmtiles" }), "pmtiles");

  // A declared media type wins over any extension, whichever format each names.
  assert.equal(
    assetFormat({ href: "https://example.com/a.pmtiles", type: "application/geo+json" }),
    "geojson",
  );
  assert.equal(
    assetFormat({ href: "https://example.com/a.geojson", type: "application/vnd.pmtiles" }),
    "pmtiles",
  );

  assert.equal(
    isVisualizableAsset({ href: "https://example.com/a.pmtiles", type: "application/vnd.pmtiles" }),
    true,
  );
  assert.equal(
    isVisualizableAsset({
      href: "https://example.com/data.bin",
      type: "application/vnd.apache.parquet",
    }),
    true,
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
  assert.deepEqual(
    itemBbox({
      type: "Feature",
      id: "mars-themis",
      // THEMIS publishes proj:bbox here even though STAC bbox must be lon/lat.
      bbox: [7_112_945, -1_778_200, 10_669_445, -3_852_900],
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [120, -30],
            [180, -30],
            [180, -65],
            [120, -65],
            [120, -30],
          ],
        ],
      },
      properties: {},
      assets: {},
    }),
    [120, -65, 180, -30],
  );
  assert.deepEqual(
    itemBbox({
      type: "Feature",
      id: "nested-collection",
      bbox: [7_112_945, -1_778_200, 10_669_445, -3_852_900],
      geometry: {
        type: "GeometryCollection",
        geometries: [
          {
            type: "GeometryCollection",
            geometries: [
              {
                type: "Polygon",
                coordinates: [
                  [
                    [120, -30],
                    [150, -30],
                    [150, -65],
                    [120, -65],
                    [120, -30],
                  ],
                ],
              },
            ],
          },
          { type: "Point", coordinates: [180, -50] },
        ],
      },
      properties: {},
      assets: {},
    }),
    [120, -65, 180, -30],
  );
  // A projected bbox with no geometry to fall back on has no usable extent, so
  // the caller must be told that rather than handed the projected numbers.
  assert.equal(
    itemBbox({
      type: "Feature",
      id: "projected-bbox-no-geometry",
      bbox: [7_112_945, -1_778_200, 10_669_445, -3_852_900],
      geometry: null,
      properties: {},
      assets: {},
    }),
    undefined,
  );
  // A geometry carrying the same projected-metre bug as the bbox must not be
  // wrapped into a plausible-looking angle.
  assert.equal(
    itemBbox({
      type: "Feature",
      id: "projected-geometry",
      bbox: [7_112_945, -1_778_200, 10_669_445, -3_852_900],
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [7_112_945, -30],
            [10_669_445, -30],
            [10_669_445, -65],
            [7_112_945, -65],
            [7_112_945, -30],
          ],
        ],
      },
      properties: {},
      assets: {},
    }),
    undefined,
  );
  // 0-360 east longitude is a real planetary convention, not a broken CRS.
  assert.deepEqual(
    itemBbox({
      type: "Feature",
      id: "east-longitude",
      bbox: [7_112_945, -1_778_200, 10_669_445, -3_852_900],
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [200, -30],
            [240, -30],
            [240, -65],
            [200, -65],
            [200, -30],
          ],
        ],
      },
      properties: {},
      assets: {},
    }),
    [-160, -65, -120, -30],
  );
});

test("Zarr assets are recognized by media type and by store extension", () => {
  assert.equal(
    assetFormat({ href: "https://example.com/era5.zarr", type: "application/vnd+zarr" }),
    "zarr",
  );
  // A store is a directory, and catalogs write it with or without the trailing slash.
  assert.equal(assetFormat({ href: "https://example.com/era5.zarr/" }), "zarr");
  // An href reaching into the store is still Zarr, even from a catalog that declares no type.
  assert.equal(
    assetFormat({ href: "https://example.com/scene.zarr/measurements/reflectance/r10m" }),
    "zarr",
  );
  assert.equal(assetFormat({ href: "https://example.com/era5.zarr?v=2" }), "zarr");
  // Named but out of reach: nothing behind Add speaks abfs, so it is labelled and not offered.
  assert.equal(assetDisplayFormat({ href: "abfs://era5/ERA5/a.zarr" }), "zarr");
  assert.equal(assetFormat({ href: "abfs://era5/ERA5/a.zarr" }), null);
});

test("a Zarr asset's storage options resolve its Azure href", async () => {
  // Zarr keeps the account under xarray:open_kwargs rather than table:storage_options (era5-pds).
  const fetcher = (async () =>
    jsonResponse({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          id: "era5-pds-2020-12-fc",
          geometry: null,
          collection: "era5-pds",
          properties: { datetime: "2020-12-01T00:00:00Z" },
          assets: {
            precipitation_amount_1hour_Accumulation: {
              href: "abfs://era5/ERA5/2020/12/precipitation_amount_1hour_Accumulation.zarr",
              type: "application/vnd+zarr",
              "xarray:open_kwargs": { storage_options: { account_name: "cpdataeuwest" } },
            },
          },
        },
      ],
      links: [],
    })) as typeof fetch;
  const result = await searchStacApi(
    {
      url: "https://planetarycomputer.microsoft.com/api/stac/v1/",
      title: "Planetary Computer",
      isApi: true,
      searchUrl: "https://planetarycomputer.microsoft.com/api/stac/v1/search",
      collections: [],
      root: {},
    },
    { limit: 10 },
    fetcher,
  );
  const asset = result.items[0].assets.precipitation_amount_1hour_Accumulation;
  assert.equal(
    asset.href,
    "https://cpdataeuwest.blob.core.windows.net/era5/ERA5/2020/12/precipitation_amount_1hour_Accumulation.zarr",
  );
  assert.equal(assetFormat(asset), "zarr");
});

test("a Zarr store's drawable targets are its spatial variables", () => {
  const item = (variables: Record<string, unknown>): StacItem => ({
    type: "Feature",
    id: "era5-pds-2020-12-fc",
    geometry: null,
    properties: {
      "cube:dimensions": {
        lat: { type: "spatial" },
        lon: { type: "spatial" },
        time: { type: "temporal" },
      },
      "cube:variables": variables,
    },
    assets: {},
  });
  const era5 = item({
    time1_bounds: { dimensions: ["time", "nv"] },
    precip: { dimensions: ["time", "lat", "lon"], unit: "m" },
    tasmax: { dimensions: ["time", "lat", "lon"], unit: "K" },
  });

  // An asset keyed by a variable holds that one alone; bounds span no two spatial dimensions.
  assert.deepEqual(zarrTargets(era5, "precip"), [{ id: "precip", label: "precip (m)" }]);
  assert.deepEqual(zarrTargets(era5, "data"), [
    { id: "precip", label: "precip (m)" },
    { id: "tasmax", label: "tasmax (K)" },
  ]);
  assert.deepEqual(zarrTargets(item({ flat: { dimensions: ["time"] } }), "data"), []);
  // A key that names a variable the store cannot draw holds nothing: the item's other variables
  // belong to other assets' stores, so offering them would name arrays that are not there.
  assert.deepEqual(zarrTargets(era5, "time1_bounds"), []);

  // Two spatial dimensions are not enough when a catalog names its axes: a vertical
  // cross-section spans latitude and depth, and the renderer draws a horizontal raster.
  const profile: StacItem = {
    type: "Feature",
    id: "profile",
    geometry: null,
    properties: {
      "cube:dimensions": {
        lat: { type: "spatial", axis: "y" },
        lon: { type: "spatial", axis: "x" },
        depth: { type: "spatial", axis: "z" },
      },
      "cube:variables": {
        section: { dimensions: ["lat", "depth"], unit: "degC" },
        surface: { dimensions: ["lat", "lon"], unit: "degC" },
      },
    },
    assets: {},
  };
  assert.deepEqual(zarrTargets(profile, "data"), [{ id: "surface", label: "surface (degC)" }]);

  // A cube that labels only some of its axes says less than it appears to, so the pair is judged
  // only when every spatial dimension it spans is named.
  const halfLabelled: StacItem = {
    type: "Feature",
    id: "half-labelled",
    geometry: null,
    properties: {
      "cube:dimensions": {
        lat: { type: "spatial", axis: "y" },
        lon: { type: "spatial" },
      },
      "cube:variables": { sst: { dimensions: ["lat", "lon"], unit: "degC" } },
    },
    assets: {},
  };
  assert.deepEqual(zarrTargets(halfLabelled, "data"), [{ id: "sst", label: "sst (degC)" }]);

  // An axis written in a spelling the extension does not use tells us nothing, so it must not be
  // read as "not horizontal" — that would drop every variable a such a catalog publishes.
  const shouted: StacItem = {
    type: "Feature",
    id: "shouted",
    geometry: null,
    properties: {
      "cube:dimensions": {
        lat: { type: "spatial", axis: "Y" },
        lon: { type: "spatial", axis: "X" },
      },
      "cube:variables": { sst: { dimensions: ["lat", "lon"] } },
    },
    assets: {},
  };
  assert.deepEqual(zarrTargets(shouted, "data"), [{ id: "sst", label: "sst" }]);

  // Nor does a value the extension never defines — a number, a compass word — say "not
  // horizontal"; it is simply not an axis, and the spatial pair carries the decision instead.
  const oddAxes: StacItem = {
    type: "Feature",
    id: "odd-axes",
    geometry: null,
    properties: {
      "cube:dimensions": {
        lat: { type: "spatial", axis: 2 },
        lon: { type: "spatial", axis: "east" },
      },
      "cube:variables": { sst: { dimensions: ["lat", "lon"] } },
    },
    assets: {},
  };
  assert.deepEqual(zarrTargets(oddAxes, "data"), [{ id: "sst", label: "sst" }]);

  // The same cross-section, shouted: an axis is recognized whatever its case, so this stays out.
  const shoutedSection: StacItem = {
    type: "Feature",
    id: "shouted-section",
    geometry: null,
    properties: {
      "cube:dimensions": {
        lat: { type: "spatial", axis: "Y" },
        depth: { type: "spatial", axis: "Z" },
      },
      "cube:variables": { section: { dimensions: ["lat", "depth"] } },
    },
    assets: {},
  };
  assert.deepEqual(zarrTargets(shoutedSection, "data"), []);
  // A list where an object belongs would otherwise yield indices as variable names.
  assert.deepEqual(
    zarrTargets({ ...era5, properties: { "cube:variables": ["precip"] } }, "data"),
    [],
  );
});

test("a Zarr layer request carries the store, the array, and the panel's raster options", () => {
  const inside = "https://objects.eodc.eu/bucket/S2C.zarr/measurements/reflectance/r10m/b02";

  // An href reaching into the store is split: the reader opens the store, then the array within.
  assert.deepEqual(zarrStorePath(inside), {
    url: "https://objects.eodc.eu/bucket/S2C.zarr",
    path: "measurements/reflectance/r10m/b02",
  });
  assert.deepEqual(zarrStorePath("https://example.com/demo.zarr"), {
    url: "https://example.com/demo.zarr",
  });

  assert.deepEqual(
    zarrLayerRequest("https://example.com/demo.zarr", "temperature", {
      colormap: "viridis",
      rescaleMin: -100,
      rescaleMax: 100,
    }),
    {
      url: "https://example.com/demo.zarr",
      variable: "temperature",
      colormap: "viridis",
      clim: [-100, 100],
    },
  );

  // Half a range is no range: the renderer would have to invent the other bound.
  assert.deepEqual(zarrLayerRequest("https://example.com/demo.zarr", "t", { rescaleMin: 0 }), {
    url: "https://example.com/demo.zarr",
    variable: "t",
  });
  assert.deepEqual(zarrLayerRequest("https://example.com/demo.zarr", "t", { rescaleMax: 1 }), {
    url: "https://example.com/demo.zarr",
    variable: "t",
  });
  // A store addressed inside still opens at its root, with the array as the variable.
  assert.equal(
    zarrLayerRequest(inside, "measurements/reflectance/r10m/b02").url,
    "https://objects.eodc.eu/bucket/S2C.zarr",
  );

  // A signed href carries a query, which names no part of the array and no part of the key.
  const signed = "https://acct.blob.core.windows.net/c/S2.zarr/measurements/b02?st=2026&sig=abc";
  assert.deepEqual(zarrStorePath(signed), {
    url: "https://acct.blob.core.windows.net/c/S2.zarr?st=2026&sig=abc",
    path: "measurements/b02",
  });
  // The reader appends `/<key>` to whatever it is given, so such a store cannot be read at all.
  assert.equal(zarrStoreTakesKeys("https://example.com/a.zarr"), true);
  assert.equal(zarrStoreTakesKeys("https://example.com/a.zarr?sig=abc"), false);
});

test("a projected Zarr store carries its CRS, and WGS84 stays implicit", () => {
  const item = (properties: Record<string, unknown>): StacItem => ({
    type: "Feature",
    id: "item",
    geometry: null,
    properties,
    assets: {},
  });
  const asset = { href: "https://example.com/a.zarr", type: "application/vnd+zarr" };

  // EOPF puts the code on the asset; other catalogs put it on the item or the cube dimensions.
  assert.equal(zarrCrs(item({}), { ...asset, "proj:code": "epsg:32632" }), "EPSG:32632");
  assert.equal(zarrCrs(item({}), { ...asset, "proj:epsg": 32633 }), "EPSG:32633");
  assert.equal(zarrCrs(item({ "proj:code": "EPSG:5070" }), asset), "EPSG:5070");
  assert.equal(
    zarrCrs(
      item({
        "cube:dimensions": {
          x: { type: "spatial", reference_system: 32612 },
          time: { type: "temporal", reference_system: 4326 },
        },
      }),
      asset,
    ),
    "EPSG:32612",
  );
  // The datacube extension also allows an OGC CRS URI rather than a code.
  assert.equal(
    zarrCrs(
      item({
        "cube:dimensions": {
          x: { type: "spatial", reference_system: "http://www.opengis.net/def/crs/EPSG/0/32612" },
        },
      }),
      asset,
    ),
    "EPSG:32612",
  );
  assert.equal(zarrCrs(item({}), asset), undefined);
  // A code the renderer already assumes would be noise in the request.
  assert.deepEqual(zarrLayerRequest("https://example.com/a.zarr", "t", { crs: "EPSG:4326" }), {
    url: "https://example.com/a.zarr",
    variable: "t",
  });
  assert.equal(
    zarrLayerRequest("https://example.com/a.zarr", "t", { crs: "EPSG:32632" }).crs,
    "EPSG:32632",
  );
});

test("a Zarr layer records the item's extent, so Zoom to layer has somewhere to go", () => {
  const item = (bbox?: number[]): StacItem =>
    ({
      type: "Feature",
      id: "item",
      geometry: null,
      ...(bbox ? { bbox } : {}),
      properties: {},
      assets: {},
    }) as StacItem;

  assert.deepEqual(withItemBounds({ tileType: "raster" }, item([-114, 37, -109, 42])), {
    tileType: "raster",
    bounds: [-114, 37, -109, 42],
  });
  // A 3D bbox is flattened to its horizontal part, as the rest of the panel does.
  assert.deepEqual(
    withItemBounds({}, item([-114, 37, 100, -109, 42, 900])).bounds,
    [-114, 37, -109, 42],
  );
  // Nothing to record leaves the metadata exactly as it was, rather than an undefined field.
  assert.deepEqual(withItemBounds({ tileType: "raster" }, item()), { tileType: "raster" });
});

test("a Zarr variable read through a store reaches the same verdicts", async () => {
  const asked: string[] = [];
  const encode = (body: unknown) => new TextEncoder().encode(JSON.stringify(body));
  const reader = (nodes: Record<string, unknown>) => async (key: string) => {
    asked.push(key);
    const match = Object.entries(nodes).find(([name]) => key.endsWith(name));
    return match ? encode(match[1]) : undefined;
  };

  // An Icechunk repository is v3, so the array answers on the first key it is asked for.
  assert.equal(
    await zarrReaderTargetCheck(reader({ "AET/zarr.json": { node_type: "array" } }), "AET"),
    "array",
  );
  assert.deepEqual(asked, ["/AET/zarr.json"]);
  assert.equal(
    await zarrReaderTargetCheck(reader({ "r10m/zarr.json": { node_type: "group" } }), "r10m"),
    "group",
  );
  // A store that answers every key with "no such key" is telling us about the variable, not about
  // itself: it opened, and does not hold that one. Checked against dynamical.org's public
  // archive: a variable it does not carry resolves undefined on all three keys.
  assert.equal(await zarrReaderTargetCheck(reader({}), "nope"), "missing");
  // A reader that throws on every key — a repository it cannot read at all — is the other verdict.
  assert.equal(
    await zarrReaderTargetCheck(async () => {
      throw new Error("unsupported spec version");
    }, "AET"),
    "unavailable",
  );
  // Metadata that will not parse is the store failing to answer rather than the variable missing.
  assert.equal(
    await zarrReaderTargetCheck(async () => new TextEncoder().encode("not json"), "AET"),
    "unavailable",
  );
  // So is a body that parses but is not a node: the store answered, just not with metadata.
  assert.equal(await zarrReaderTargetCheck(async () => encode([1, 2, 3]), "AET"), "unavailable");
  assert.equal(await zarrReaderTargetCheck(async () => encode(null), "AET"), "unavailable");
  // Nor is a v3 node that names no kind, or names one no store has: it answered, but said nothing.
  assert.equal(
    await zarrReaderTargetCheck(reader({ "AET/zarr.json": { shape: [2, 2] } }), "AET"),
    "unavailable",
  );
  assert.equal(
    await zarrReaderTargetCheck(reader({ "AET/zarr.json": { node_type: "banana" } }), "AET"),
    "unavailable",
  );

  // One key refused is not the whole manifest, the same way it is not over HTTP.
  const refusesV3 = async (key: string) => {
    if (key.endsWith("zarr.json")) throw new Error("no such key");
    return key.endsWith("AET/.zarray") ? encode({}) : undefined;
  };
  assert.equal(await zarrReaderTargetCheck(refusesV3, "AET"), "array");

  // An abandoned add stops between keys rather than reading the rest of the manifest.
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    zarrReaderTargetCheck(
      reader({ "AET/zarr.json": { node_type: "array" } }),
      "AET",
      controller.signal,
    ),
    (error: Error) => error.name === "AbortError",
  );
});

test("a Zarr variable check says which problem it found, not merely that there was one", async () => {
  const asked: string[] = [];
  const serving = (bodies: Record<string, unknown>, status = 404) =>
    (async (url: string) => {
      asked.push(String(url));
      const match = Object.entries(bodies).find(([key]) => String(url).endsWith(key));
      return match
        ? new Response(JSON.stringify(match[1]), { status: 200 })
        : new Response("", { status });
    }) as unknown as typeof fetch;

  const store = "https://example.com/a.zarr";
  assert.equal(
    await zarrTargetCheck(store, "sst", serving({ "sst/zarr.json": { node_type: "array" } })),
    "array",
  );
  // EOPF keys an asset to a group of bands: a real path, and nothing to draw.
  assert.equal(
    await zarrTargetCheck(store, "r10m", serving({ "r10m/zarr.json": { node_type: "group" } })),
    "group",
  );
  // Metadata that names nothing is not an invitation to try — and not a group either: a document
  // that does not say which kind of node it is has told us about itself, not about the variable.
  assert.equal(
    await zarrTargetCheck(store, "sst", serving({ "sst/zarr.json": {} })),
    "unavailable",
  );
  // A 200 that is not the metadata says nothing: the v2 keys still get their turn.
  const htmlThenZarray = (async (url: string) =>
    String(url).endsWith("zarr.json")
      ? new Response("<html>proxy</html>", { status: 200 })
      : new Response(JSON.stringify({}), {
          status: String(url).endsWith("sst/.zarray") ? 200 : 404,
        })) as unknown as typeof fetch;
  assert.equal(await zarrTargetCheck(store, "sst", htmlThenZarray), "array");

  // A host answering 200 for every path proves nothing: a `.zarray` that is not metadata is
  // not an array.
  const catchAll = (async () =>
    new Response("<html>index</html>", { status: 200 })) as unknown as typeof fetch;
  assert.equal(await zarrTargetCheck(store, "sst", catchAll), "unavailable");

  // v2 has no node type: `.zarray` names an array, `.zgroup` names a group.
  assert.equal(await zarrTargetCheck(store, "sst", serving({ "sst/.zarray": {} })), "array");
  assert.equal(await zarrTargetCheck(store, "bands", serving({ "bands/.zgroup": {} })), "group");

  // A private container answers 409 (Azure), 403 or 401 — a missing token, not a missing array.
  for (const status of [401, 403, 409]) {
    assert.equal(await zarrTargetCheck(store, "sst", serving({}, status)), "unauthorized");
  }
  // A bucket without `ListBucket` refuses a key that is merely absent, so the refusal must not end
  // the search: `.zarray` still answers, and the store is readable after all.
  const refusesMissing = (async (url: string) =>
    String(url).endsWith("sst/.zarray")
      ? new Response(JSON.stringify({}), { status: 200 })
      : new Response("", { status: 403 })) as unknown as typeof fetch;
  assert.equal(await zarrTargetCheck(store, "sst", refusesMissing), "array");
  assert.equal(await zarrTargetCheck(store, "sst", serving({}, 404)), "unavailable");

  // A key cannot be appended after a query, so such a store is named as its own problem rather
  // than guessed at — `?v=2` is no more a credentials failure than `?sig=x` is a missing array.
  asked.length = 0;
  assert.equal(
    await zarrTargetCheck("https://example.com/a.zarr?sig=x", "sst", serving({})),
    "unsupported-url",
  );
  assert.equal(
    await zarrTargetCheck("https://example.com/a.zarr?v=2", "sst", serving({})),
    "unsupported-url",
  );
  assert.deepEqual(asked, [], "a store that cannot take keys is never asked for one");

  // A host that rejects every key is unreachable, and says so once every key has been tried.
  const blocked: string[] = [];
  const rejecting = (async (url: string) => {
    blocked.push(String(url));
    throw new TypeError("Failed to fetch");
  }) as unknown as typeof fetch;
  assert.equal(await zarrTargetCheck(store, "sst", rejecting), "unavailable");
  assert.equal(blocked.length, 3);

  // A gateway that omits CORS headers on its 404s throws for a key that is merely absent, so a
  // v2 store must not be condemned by the v3 key it never had.
  const throwsOnV3 = (async (url: string) => {
    if (String(url).endsWith("zarr.json")) throw new TypeError("Failed to fetch");
    return String(url).endsWith("sst/.zarray")
      ? new Response(JSON.stringify({}), { status: 200 })
      : new Response("", { status: 404 });
  }) as unknown as typeof fetch;
  assert.equal(await zarrTargetCheck(store, "sst", throwsOnV3), "array");

  // A refusal already seen still explains a later failure: the host asked for a token first.
  const refusedThenBlocked = (async (url: string) => {
    if (String(url).endsWith("zarr.json")) return new Response("", { status: 403 });
    throw new TypeError("Failed to fetch");
  }) as unknown as typeof fetch;
  assert.equal(await zarrTargetCheck(store, "sst", refusedThenBlocked), "unauthorized");
});

test("Add waits on a choice only for the formats that hold several layers", () => {
  const zarr = { href: "https://example.com/a.zarr", type: "application/vnd.zarr" };
  const cog = { href: "https://example.com/a.tif", type: "image/tiff" };
  const item = (variables: Record<string, unknown>): StacItem => ({
    type: "Feature",
    id: "item",
    geometry: null,
    properties: {
      "cube:dimensions": { x: { type: "spatial" }, y: { type: "spatial" } },
      "cube:variables": variables,
    },
    assets: {},
  });
  const drawable = item({ AET: { dimensions: ["time", "y", "x"] } });

  // An Icechunk repository is a manifest rather than a Zarr hierarchy, read through its own
  // reader — so it is addable, and its variables come from the item like any other store's.
  assert.equal(canAddAsset(drawable, "data", { ...zarr, "icechunk:branch": "main" }), true);
  assert.equal(isIcechunkAsset(zarr), false);
  // A catalog may say it once on the item rather than on every asset it publishes.
  const icechunkItem = {
    ...drawable,
    properties: { ...drawable.properties, "icechunk:branch": "main" },
  } as StacItem;
  assert.equal(isIcechunkAsset(zarr, icechunkItem), true);
  assert.equal(canAddAsset(icechunkItem, "data", zarr), true);
  // A signed URL is no more addable for a repository than for a plain store: the manifest reader
  // asks for `<store>/<key>` too, so the signature would land in the middle of the request.
  assert.equal(
    canAddAsset(icechunkItem, "data", { ...zarr, href: "https://example.com/repo?sig=abc" }),
    false,
  );

  // The field is typed as a string but arrives as JSON, so a value that is not one names no branch.
  assert.equal(icechunkBranch({ ...zarr, "icechunk:branch": "dev" }), "dev");
  assert.equal(icechunkBranch(zarr, icechunkItem), "main");
  assert.equal(icechunkBranch({ ...zarr, "icechunk:branch": "  " }), undefined);
  assert.equal(icechunkBranch({ ...zarr, "icechunk:branch": 7 as unknown as string }), undefined);
  // A padded name is trimmed rather than sent as written: it reaches a request path.
  assert.equal(icechunkBranch({ ...zarr, "icechunk:branch": " dev " }), "dev");
  // An unusable value on the asset falls through to the item rather than overriding it.
  assert.equal(
    icechunkBranch({ ...zarr, "icechunk:branch": 7 as unknown as string }, icechunkItem),
    "main",
  );
  // Naming the field at all declares the format, even when the value names no branch: the reader
  // opens the default branch, where treating it as a plain store would only produce 404s.
  assert.equal(isIcechunkAsset({ ...zarr, "icechunk:branch": "" }), true);
  assert.equal(isIcechunkAsset({ ...zarr, "icechunk:branch": 7 as unknown as string }), true);
  assert.equal(icechunkBranch({ ...zarr, "icechunk:branch": "" }), undefined);
  assert.equal(canAddAsset(icechunkItem, "data", { ...zarr, "icechunk:branch": "" }), true);

  assert.equal(requiresTarget(zarr), true);
  assert.equal(requiresTarget(cog), false);
  assert.equal(canAddAsset(drawable, "data", zarr), true);
  assert.deepEqual(assetTargets(drawable, "data", cog), []);
  // A store whose variables are all one-dimensional has nothing to draw, so Add stays dead.
  assert.equal(canAddAsset(item({ flat: { dimensions: ["time"] } }), "data", zarr), false);
  assert.equal(canAddAsset(drawable, "data", cog), true);

  // A store URL that cannot take keys is answerable without asking the host, so Add is refused up
  // front rather than enabled and then failed on the click.
  assert.equal(
    canAddAsset(drawable, "data", { ...zarr, href: "https://example.com/a.zarr?sig=abc" }),
    false,
  );
});

test("an item names the Zarr account in either spelling, as an asset does", async () => {
  const fetcher = (async () =>
    jsonResponse({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          id: "item-level-account",
          geometry: null,
          collection: "era5-pds",
          properties: {
            datetime: "2020-12-01T00:00:00Z",
            "xarray:open_kwargs": { storage_options: { account_name: "cpdataeuwest" } },
          },
          assets: { data: { href: "abfs://era5/a.zarr", type: "application/vnd+zarr" } },
        },
      ],
      links: [],
    })) as typeof fetch;
  const result = await searchStacApi(
    {
      url: "https://planetarycomputer.microsoft.com/api/stac/v1/",
      title: "Planetary Computer",
      isApi: true,
      searchUrl: "https://planetarycomputer.microsoft.com/api/stac/v1/search",
      collections: [],
      root: {},
    },
    { limit: 10 },
    fetcher,
  );
  assert.equal(
    result.items[0].assets.data.href,
    "https://cpdataeuwest.blob.core.windows.net/era5/a.zarr",
  );
});

test("an asset's own storage options outrank the ones beside them", async () => {
  const fetcher = (async () =>
    jsonResponse({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          id: "both-options",
          geometry: null,
          collection: "era5-pds",
          properties: {
            datetime: "2020-12-01T00:00:00Z",
            "table:storage_options": { account_name: "itemaccount" },
          },
          assets: {
            tasmax: {
              href: "abfs://era5/a.zarr",
              type: "application/vnd+zarr",
              "table:storage_options": { account_name: "assetaccount" },
              "xarray:open_kwargs": { storage_options: { account_name: "xarrayaccount" } },
            },
          },
        },
      ],
      links: [],
    })) as typeof fetch;
  const result = await searchStacApi(
    {
      url: "https://planetarycomputer.microsoft.com/api/stac/v1/",
      title: "Planetary Computer",
      isApi: true,
      searchUrl: "https://planetarycomputer.microsoft.com/api/stac/v1/search",
      collections: [],
      root: {},
    },
    { limit: 10 },
    fetcher,
  );
  assert.equal(
    result.items[0].assets.tasmax.href,
    "https://assetaccount.blob.core.windows.net/era5/a.zarr",
  );
});
