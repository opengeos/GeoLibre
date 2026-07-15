import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildListObjectsUrl,
  buildObjectUrl,
  canStream,
  classifyKey,
  fetchCatalog,
  fetchProduct,
  filterProducts,
  formatBytes,
  isAddable,
  isTooLargeToOpen,
  LARGE_FILE_BYTES,
  listProductObjects,
  MAX_VECTOR_BYTES,
  mergeProducts,
  objectNote,
  parseFeed,
  parseListObjects,
  parseProduct,
  parseProductList,
  parseProductRef,
  productUrl,
  SOURCE_COOP_DATA_BASE,
  STREAM_HINT_BYTES,
  synthesizeProduct,
  usesDuckDB,
  type SourceCoopFetch,
  type SourceCoopFormat,
  type SourceCoopObject,
  type SourceCoopProduct,
} from "../packages/plugins/src/plugins/source-coop-api";

const NO_SUCH_BUCKET_PATTERN = /NoSuchBucket/;
const UNEXPECTED_RESPONSE_PATTERN = /unexpected response/;

/** A raw `/api/v1/products/*` record, close to the real API shape. */
function rawProduct(overrides: Record<string, unknown> = {}) {
  return {
    account_id: "protomaps",
    product_id: "openstreetmap",
    title: "OpenStreetMap Open Data Products",
    description: "Distributions of OpenStreetMap vector geodata.",
    visibility: "public",
    disabled: false,
    featured: 1,
    updated_at: "2025-08-21T16:39:55.567Z",
    metadata: { tags: ["openstreetmap", "vector", "pmtiles"] },
    ...overrides,
  };
}

/** A fetch stub recording requested URLs and returning a fixed body. */
function stubFetch(
  body: string,
  init: { ok?: boolean; status?: number } = {},
): { fetchImpl: SourceCoopFetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl: SourceCoopFetch = async (url) => {
    calls.push(url);
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      text: async () => body,
    };
  };
  return { fetchImpl, calls };
}

function product(overrides: Partial<SourceCoopProduct> = {}): SourceCoopProduct {
  return {
    accountId: "acme",
    productId: "buildings",
    title: "Buildings",
    description: "",
    tags: [],
    updatedAt: null,
    featured: false,
    url: "https://source.coop/acme/buildings",
    ...overrides,
  };
}

describe("parseProduct", () => {
  it("normalizes a product record", () => {
    const parsed = parseProduct(rawProduct());
    assert.equal(parsed?.accountId, "protomaps");
    assert.equal(parsed?.productId, "openstreetmap");
    assert.equal(parsed?.title, "OpenStreetMap Open Data Products");
    assert.deepEqual(parsed?.tags, ["openstreetmap", "vector", "pmtiles"]);
    assert.equal(parsed?.url, "https://source.coop/protomaps/openstreetmap");
  });

  it("reads `featured` as a rank number, not a boolean", () => {
    assert.equal(parseProduct(rawProduct({ featured: 1 }))?.featured, true);
    assert.equal(parseProduct(rawProduct({ featured: 0 }))?.featured, false);
    assert.equal(
      parseProduct(rawProduct({ featured: undefined }))?.featured,
      false,
    );
  });

  it("falls back to the product id when the title is missing", () => {
    assert.equal(parseProduct(rawProduct({ title: "" }))?.title, "openstreetmap");
  });

  it("rejects records with no identity", () => {
    assert.equal(parseProduct(rawProduct({ account_id: "" })), null);
    assert.equal(parseProduct(rawProduct({ product_id: undefined })), null);
    assert.equal(parseProduct({}), null);
    assert.equal(parseProduct(null), null);
    assert.equal(parseProduct("not a product"), null);
  });

  it("drops products whose data is not anonymously readable", () => {
    assert.equal(parseProduct(rawProduct({ disabled: true })), null);
    assert.equal(parseProduct(rawProduct({ visibility: "restricted" })), null);
    assert.equal(parseProduct(rawProduct({ visibility: "unlisted" })), null);
  });

  it("tolerates a missing or malformed metadata.tags", () => {
    assert.deepEqual(parseProduct(rawProduct({ metadata: {} }))?.tags, []);
    assert.deepEqual(
      parseProduct(rawProduct({ metadata: { tags: "pmtiles" } }))?.tags,
      [],
    );
    assert.deepEqual(
      parseProduct(rawProduct({ metadata: { tags: ["ok", 7] } }))?.tags,
      ["ok"],
    );
  });
});

describe("productUrl", () => {
  it("is the single source of the product page link", () => {
    assert.equal(
      productUrl("opengeos", "natural-earth"),
      "https://source.coop/opengeos/natural-earth",
    );
  });

  it("agrees with every record producer, so the three cannot drift", () => {
    const expected = productUrl("opengeos", "natural-earth");
    assert.equal(
      synthesizeProduct("opengeos", "natural-earth", "Natural Earth").url,
      expected,
    );
    assert.equal(
      parseProduct({ account_id: "opengeos", product_id: "natural-earth" })?.url,
      expected,
    );
    const [fromFeed] = parseFeed(
      `<rss><channel><item><title>Natural Earth</title>` +
        `<link>https://source.coop/opengeos/natural-earth</link>` +
        `</item></channel></rss>`,
    );
    assert.equal(fromFeed.url, expected);
  });
});

describe("synthesizeProduct", () => {
  it("builds a usable record from an id alone, for a pinned panel", () => {
    const product = synthesizeProduct("opengeos", "natural-earth", "Natural Earth");
    assert.equal(product.accountId, "opengeos");
    assert.equal(product.productId, "natural-earth");
    assert.equal(product.title, "Natural Earth");
    assert.equal(product.url, "https://source.coop/opengeos/natural-earth");
    // Left empty for a later fetchProduct to fill in.
    assert.equal(product.description, "");
    assert.deepEqual(product.tags, []);
    assert.equal(product.updatedAt, null);
    assert.equal(product.featured, false);
  });

  it("produces the ids that drive a file listing, so no metadata read is needed", () => {
    const product = synthesizeProduct("opengeos", "natural-earth", "Natural Earth");
    assert.equal(
      buildListObjectsUrl({
        accountId: product.accountId,
        prefix: `${product.productId}/`,
      }),
      `${SOURCE_COOP_DATA_BASE}/opengeos?list-type=2&prefix=natural-earth%2F&max-keys=200&delimiter=%2F`,
    );
  });
});

describe("parseProductList", () => {
  it("reads the { products: [...] } wrapper and a bare array alike", () => {
    assert.equal(parseProductList({ products: [rawProduct()] }).length, 1);
    assert.equal(parseProductList([rawProduct()]).length, 1);
  });

  it("skips unusable records rather than failing the page", () => {
    const parsed = parseProductList({
      products: [rawProduct(), {}, rawProduct({ product_id: "other" })],
    });
    assert.deepEqual(
      parsed.map((entry) => entry.productId),
      ["openstreetmap", "other"],
    );
  });

  it("returns nothing for a non-list body", () => {
    assert.deepEqual(parseProductList({}), []);
    assert.deepEqual(parseProductList("<html>404</html>"), []);
  });
});

describe("parseProductRef", () => {
  it("splits an account/product id", () => {
    assert.deepEqual(parseProductRef("protomaps/openstreetmap"), {
      accountId: "protomaps",
      productId: "openstreetmap",
    });
  });

  it("tolerates a trailing slash and surrounding space", () => {
    assert.deepEqual(parseProductRef("  vida/open-buildings/ "), {
      accountId: "vida",
      productId: "open-buildings",
    });
  });

  it("rejects free text and deeper paths", () => {
    assert.equal(parseProductRef("buildings"), null);
    assert.equal(parseProductRef("open buildings"), null);
    assert.equal(parseProductRef("a/b/c"), null);
    assert.equal(parseProductRef(""), null);
  });
});

describe("parseFeed", () => {
  const feed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Source.coop Products</title>
  <link>https://source.coop</link>
  <item>
    <title>Global Fields of The World (FTW)</title>
    <description>Field boundaries &amp; more</description>
    <link>https://source.coop/ftw/global-data</link>
    <pubDate>Wed, 04 Feb 2026 19:13:13 GMT</pubDate>
  </item>
  <item>
    <title>Elsewhere</title>
    <description>Not a product link</description>
    <link>https://example.com/nope</link>
    <pubDate>Wed, 04 Feb 2026 19:13:13 GMT</pubDate>
  </item>
</channel></rss>`;

  it("recovers product identity from each item link", () => {
    const products = parseFeed(feed);
    assert.equal(products.length, 1);
    assert.equal(products[0].accountId, "ftw");
    assert.equal(products[0].productId, "global-data");
    assert.equal(products[0].title, "Global Fields of The World (FTW)");
  });

  it("decodes XML entities in text nodes", () => {
    assert.equal(parseFeed(feed)[0].description, "Field boundaries & more");
  });

  it("converts pubDate to an ISO timestamp", () => {
    assert.equal(parseFeed(feed)[0].updatedAt, "2026-02-04T19:13:13.000Z");
  });

  it("returns nothing for a non-feed body", () => {
    assert.deepEqual(parseFeed("<html>404</html>"), []);
  });
});

describe("classifyKey", () => {
  it("recognizes the formats GeoLibre can render", () => {
    assert.equal(classifyKey("openstreetmap/tiles/v3.pmtiles"), "pmtiles");
    assert.equal(classifyKey("nwi/wetlands/AK.parquet"), "geoparquet");
    assert.equal(classifyKey("x/y.geoparquet"), "geoparquet");
    assert.equal(classifyKey("opengeos/dem.tif"), "cog");
    assert.equal(classifyKey("a/b.tiff"), "cog");
    assert.equal(classifyKey("opengeos/us_cities.geojson"), "geojson");
    assert.equal(classifyKey("a/b.fgb"), "flatgeobuf");
    assert.equal(classifyKey("a/b.gpkg"), "gpkg");
    assert.equal(classifyKey("a/b.csv"), "csv");
  });

  it("is case-insensitive", () => {
    assert.equal(classifyKey("A/B.PMTiles"), "pmtiles");
  });

  it("classifies anything else as other", () => {
    assert.equal(classifyKey("ftw/global-data/README.md"), "other");
    assert.equal(classifyKey("a/catalog.json"), "other");
    assert.equal(classifyKey("a/data.db"), "other");
  });

  it("only `other` is unaddable", () => {
    assert.equal(isAddable("pmtiles"), true);
    assert.equal(isAddable("geoparquet"), true);
    assert.equal(isAddable("cog"), true);
    assert.equal(isAddable("other"), false);
  });
});

describe("buildObjectUrl", () => {
  it("builds a data URL without repeating the product prefix", () => {
    assert.equal(
      buildObjectUrl("protomaps", "openstreetmap/tiles/v3.pmtiles"),
      `${SOURCE_COOP_DATA_BASE}/protomaps/openstreetmap/tiles/v3.pmtiles`,
    );
  });

  it("preserves path separators while encoding each segment", () => {
    // Hive-partitioned keys carry `=`, which must survive intact.
    assert.equal(
      buildObjectUrl("vida", "b/pmtiles/by_country/country_iso=AFG/AFG.pmtiles"),
      `${SOURCE_COOP_DATA_BASE}/vida/b/pmtiles/by_country/country_iso%3DAFG/AFG.pmtiles`,
    );
  });

  it("encodes a segment containing a space", () => {
    assert.equal(
      buildObjectUrl("acme", "p/my file.parquet"),
      `${SOURCE_COOP_DATA_BASE}/acme/p/my%20file.parquet`,
    );
  });
});

describe("buildListObjectsUrl", () => {
  it("addresses the account as the bucket, with the product as a prefix", () => {
    const url = new URL(
      buildListObjectsUrl({ accountId: "protomaps", prefix: "openstreetmap/" }),
    );
    // A trailing slash after the account is a NoSuchBucket 404 upstream.
    assert.equal(url.pathname, "/protomaps");
    assert.equal(url.searchParams.get("list-type"), "2");
    assert.equal(url.searchParams.get("prefix"), "openstreetmap/");
    assert.equal(url.searchParams.get("delimiter"), "/");
  });

  it("addresses a subfolder by prefix, never by path", () => {
    const url = new URL(
      buildListObjectsUrl({
        accountId: "protomaps",
        prefix: "openstreetmap/tiles/",
      }),
    );
    assert.equal(url.pathname, "/protomaps");
    assert.equal(url.searchParams.get("prefix"), "openstreetmap/tiles/");
  });

  it("encodes the account segment, so a stray URL character cannot truncate the path", () => {
    // accountId comes from unvalidated API/feed text; `#` would otherwise cut
    // the path short and silently list the wrong bucket.
    const url = new URL(buildListObjectsUrl({ accountId: "a#b", prefix: "p/" }));
    assert.equal(url.pathname, "/a%23b");
    assert.equal(url.searchParams.get("prefix"), "p/");
  });

  it("percent-encodes a continuation token", () => {
    const raw = "a+b/c=d";
    const url = buildListObjectsUrl({
      accountId: "acme",
      prefix: "p/",
      token: raw,
    });
    assert.ok(!url.includes("a+b/c=d"));
    assert.equal(new URL(url).searchParams.get("continuation-token"), raw);
  });

  it("omits the delimiter for a recursive listing", () => {
    const url = new URL(
      buildListObjectsUrl({ accountId: "a", prefix: "p/", delimited: false }),
    );
    assert.equal(url.searchParams.get("delimiter"), null);
  });
});

describe("parseListObjects", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>protomaps</Name><Prefix>openstreetmap/</Prefix>
  <IsTruncated>true</IsTruncated><KeyCount>3</KeyCount>
  <NextContinuationToken>tok123</NextContinuationToken>
  <Contents>
    <Key>openstreetmap/tiles/v3.pmtiles</Key>
    <LastModified>2024-08-30T08:28:56.000Z</LastModified>
    <Size>123545745644</Size>
  </Contents>
  <Contents>
    <Key>openstreetmap/notes.txt</Key>
    <LastModified>2024-08-30T08:28:56.000Z</LastModified>
    <Size>12</Size>
  </Contents>
  <Contents>
    <Key>openstreetmap/folder/</Key>
    <LastModified>2024-08-30T08:28:56.000Z</LastModified>
    <Size>0</Size>
  </Contents>
  <CommonPrefixes><Prefix>openstreetmap/tiles/</Prefix></CommonPrefixes>
</ListBucketResult>`;

  it("parses keys, sizes, formats, and URLs", () => {
    const listing = parseListObjects(xml, "protomaps");
    const [first] = listing.objects;
    assert.equal(first.key, "openstreetmap/tiles/v3.pmtiles");
    assert.equal(first.name, "v3.pmtiles");
    assert.equal(first.size, 123545745644);
    assert.equal(first.format, "pmtiles");
    assert.equal(
      first.url,
      `${SOURCE_COOP_DATA_BASE}/protomaps/openstreetmap/tiles/v3.pmtiles`,
    );
  });

  it("drops the zero-byte folder placeholder objects", () => {
    const listing = parseListObjects(xml, "protomaps");
    assert.deepEqual(
      listing.objects.map((entry) => entry.name),
      ["v3.pmtiles", "notes.txt"],
    );
  });

  it("reads common prefixes as folders", () => {
    assert.deepEqual(parseListObjects(xml, "protomaps").folders, [
      "openstreetmap/tiles/",
    ]);
  });

  it("returns the continuation token only while truncated", () => {
    assert.equal(parseListObjects(xml, "protomaps").nextToken, "tok123");
    const complete = xml.replace(
      "<IsTruncated>true</IsTruncated>",
      "<IsTruncated>false</IsTruncated>",
    );
    assert.equal(parseListObjects(complete, "protomaps").nextToken, null);
  });

  it("returns an empty listing for a body with no contents", () => {
    const listing = parseListObjects("<ListBucketResult/>", "acme");
    assert.deepEqual(listing.objects, []);
    assert.deepEqual(listing.folders, []);
    assert.equal(listing.nextToken, null);
  });
});

describe("listProductObjects", () => {
  it("surfaces the S3 error code when the proxy refuses", async () => {
    const { fetchImpl } = stubFetch(
      "<Error><Code>NoSuchBucket</Code></Error>",
      { ok: false, status: 404 },
    );
    await assert.rejects(
      listProductObjects({ accountId: "nope", prefix: "p/" }, fetchImpl),
      NO_SUCH_BUCKET_PATTERN,
    );
  });
});

describe("filterProducts", () => {
  const catalog = [
    product({ accountId: "vida", productId: "buildings", title: "Buildings" }),
    product({
      accountId: "acme",
      productId: "roads",
      title: "Roads",
      description: "Also covers buildings in cities.",
    }),
    product({
      accountId: "other",
      productId: "tiles",
      title: "Tiles",
      tags: ["buildings"],
    }),
  ];

  it("returns everything for an empty query", () => {
    assert.equal(filterProducts(catalog, "").length, 3);
    assert.equal(filterProducts(catalog, "   ").length, 3);
  });

  it("matches title, id, description, and tags", () => {
    assert.equal(filterProducts(catalog, "buildings").length, 3);
    assert.equal(filterProducts(catalog, "vida").length, 1);
  });

  it("ranks a title hit above a description-only hit", () => {
    const [first] = filterProducts(catalog, "buildings");
    assert.equal(first.title, "Buildings");
  });

  it("ranks a tag hit above a description-only hit", () => {
    const ranked = filterProducts(catalog, "buildings").map((p) => p.productId);
    assert.ok(ranked.indexOf("tiles") < ranked.indexOf("roads"));
  });

  it("narrows on every term, so extra words never widen the result", () => {
    assert.equal(filterProducts(catalog, "buildings roads").length, 1);
    assert.equal(filterProducts(catalog, "buildings nomatch").length, 0);
  });

  it("is case-insensitive", () => {
    assert.equal(filterProducts(catalog, "BUILDINGS").length, 3);
  });
});

describe("mergeProducts", () => {
  it("prefers the record carrying tags for a duplicate id", () => {
    const feedEntry = product({ title: "From feed" });
    const apiEntry = product({ title: "From API", tags: ["pmtiles"] });
    const merged = mergeProducts([feedEntry], [apiEntry]);
    assert.equal(merged.length, 1);
    assert.deepEqual(merged[0].tags, ["pmtiles"]);
  });

  it("keeps the richer record when the later one is thinner", () => {
    const apiEntry = product({ tags: ["pmtiles"], description: "Full" });
    const feedEntry = product({ tags: [], description: "" });
    const merged = mergeProducts([apiEntry], [feedEntry]);
    assert.deepEqual(merged[0].tags, ["pmtiles"]);
    assert.equal(merged[0].description, "Full");
  });

  it("keeps distinct ids apart", () => {
    const merged = mergeProducts(
      [product({ productId: "a" })],
      [product({ productId: "b" })],
    );
    assert.equal(merged.length, 2);
  });
});

describe("fetchProduct", () => {
  it("requests the product under the configured endpoint", async () => {
    const { fetchImpl, calls } = stubFetch(JSON.stringify(rawProduct()));
    const parsed = await fetchProduct("protomaps", "openstreetmap", {
      endpoint: "https://proxy.example.com/source-coop",
      fetchImpl,
    });
    assert.equal(
      calls[0],
      "https://proxy.example.com/source-coop/products/protomaps/openstreetmap",
    );
    assert.equal(parsed?.accountId, "protomaps");
  });

  it("returns null rather than throwing when the product is missing", async () => {
    const { fetchImpl } = stubFetch("{}", { ok: false, status: 404 });
    assert.equal(await fetchProduct("a", "b", { fetchImpl }), null);
  });

  it("returns null for the HTML body an unknown /api/v1 path serves as 200", async () => {
    const { fetchImpl } = stubFetch("<!DOCTYPE html><html>404</html>");
    assert.equal(await fetchProduct("a", "b", { fetchImpl }), null);
  });
});

describe("fetchCatalog", () => {
  it("rejects an HTML body served with status 200", async () => {
    const { fetchImpl } = stubFetch("<!DOCTYPE html><html>404</html>");
    // Both sources fail: the feed parses to nothing and featured is not JSON.
    await assert.rejects(
      fetchCatalog({ endpoint: "https://p.example.com", fetchImpl }),
      UNEXPECTED_RESPONSE_PATTERN,
    );
  });

  it("still returns a catalog when only one source succeeds", async () => {
    const calls: string[] = [];
    const fetchImpl: SourceCoopFetch = async (url) => {
      calls.push(url);
      if (url.endsWith("/feed")) throw new Error("feed down");
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ products: [rawProduct()] }),
      };
    };
    const catalog = await fetchCatalog({
      endpoint: "https://p.example.com",
      fetchImpl,
    });
    assert.equal(catalog.length, 1);
    assert.equal(catalog[0].accountId, "protomaps");
  });

  it("reads the feed from feedUrl when given, bypassing the endpoint", async () => {
    const calls: string[] = [];
    const fetchImpl: SourceCoopFetch = async (url) => {
      calls.push(url);
      return { ok: true, status: 200, text: async () => "<rss></rss>" };
    };
    await fetchCatalog({
      endpoint: "https://source.coop/api/v1",
      feedUrl: "https://source.coop/feed.xml",
      fetchImpl,
    }).catch(() => undefined);
    assert.ok(calls.includes("https://source.coop/feed.xml"));
  });
});

describe("formatBytes", () => {
  it("scales to a readable unit", () => {
    assert.equal(formatBytes(0), "0 B");
    assert.equal(formatBytes(12), "12 B");
    assert.equal(formatBytes(1536), "1.5 KB");
    assert.equal(formatBytes(4535386), "4.3 MB");
    assert.equal(formatBytes(123545745644), "115 GB");
  });

  it("handles a nonsense size without producing NaN", () => {
    assert.equal(formatBytes(Number.NaN), "0 B");
    assert.equal(formatBytes(-5), "0 B");
  });
});

/** Every member of the SourceCoopFormat union. */
const ALL_FORMATS: SourceCoopFormat[] = [
  "pmtiles",
  "geoparquet",
  "cog",
  "geojson",
  "flatgeobuf",
  "gpkg",
  "csv",
  "other",
];

function object(
  format: SourceCoopFormat,
  size: number,
  name = `data.${format}`,
): SourceCoopObject {
  return {
    key: `product/${name}`,
    name,
    size,
    lastModified: null,
    format,
    url: `${SOURCE_COOP_DATA_BASE}/account/product/${name}`,
  };
}

describe("usesDuckDB", () => {
  it("covers the formats the vector control reads", () => {
    for (const format of [
      "geoparquet",
      "geojson",
      "flatgeobuf",
      "gpkg",
      "csv",
    ] as const) {
      assert.equal(usesDuckDB(format), true, format);
    }
  });

  it("excludes the formats read by their own range-request readers", () => {
    // PMTiles and COG never touch DuckDB, so the 2 GiB limit must not reach
    // them — a 40 GB PMTiles is a normal, working case.
    assert.equal(usesDuckDB("pmtiles"), false);
    assert.equal(usesDuckDB("cog"), false);
    assert.equal(usesDuckDB("other"), false);
  });

  it("never claims a format is DuckDB-backed unless it can go on the map", () => {
    // The two questions are independent, so this is the one relationship that
    // does hold between them. FORMAT_READER is exhaustive over SourceCoopFormat
    // at compile time, which is what stops a new format from drifting; this
    // guards the direction a type cannot express.
    for (const format of ALL_FORMATS) {
      if (usesDuckDB(format)) assert.equal(isAddable(format), true, format);
    }
  });
});

describe("canStream", () => {
  it("is GeoParquet only", () => {
    assert.equal(canStream("geoparquet"), true);
  });

  it("is false for formats the control would silently copy anyway", () => {
    for (const format of [
      "geojson",
      "flatgeobuf",
      "gpkg",
      "csv",
      "pmtiles",
      "cog",
      "other",
    ] as const) {
      assert.equal(canStream(format), false, format);
    }
  });
});

describe("isTooLargeToOpen", () => {
  it("rejects a DuckDB-format file past what DuckDB-WASM can open", () => {
    assert.equal(isTooLargeToOpen(object("geoparquet", 3 * 1024 ** 3)), true);
    assert.equal(isTooLargeToOpen(object("geojson", 3 * 1024 ** 3)), true);
  });

  it("draws the line exactly at the 32-bit limit", () => {
    assert.equal(
      isTooLargeToOpen(object("geoparquet", MAX_VECTOR_BYTES)),
      false,
    );
    assert.equal(
      isTooLargeToOpen(object("geoparquet", MAX_VECTOR_BYTES + 1)),
      true,
    );
  });

  it("never rejects PMTiles or COG, at any size", () => {
    // These stream through their own readers; the DuckDB limit is irrelevant.
    assert.equal(isTooLargeToOpen(object("pmtiles", 40 * 1024 ** 3)), false);
    assert.equal(isTooLargeToOpen(object("cog", 40 * 1024 ** 3)), false);
  });

  it("treats a missing size as openable rather than blocking the add", () => {
    // listProductObjects defaults an unparseable <Size> to 0, which must not
    // read as "too large" — the add should be attempted and allowed to fail.
    assert.equal(isTooLargeToOpen(object("geoparquet", 0)), false);
  });
});

describe("objectNote", () => {
  it("promises streaming only for the formats that actually do it", () => {
    assert.equal(objectNote(object("pmtiles", LARGE_FILE_BYTES)), "streams");
    assert.equal(objectNote(object("cog", 40 * 1024 ** 3)), "streams");
  });

  it("stays quiet for a small PMTiles", () => {
    assert.equal(objectNote(object("pmtiles", 10 * 1024 ** 2)), "none");
  });

  it("offers the choice on a large GeoParquet", () => {
    assert.equal(
      objectNote(object("geoparquet", STREAM_HINT_BYTES)),
      "streamChoice",
    );
    assert.equal(
      objectNote(object("geoparquet", 847 * 1024 ** 2)),
      "streamChoice",
    );
  });

  it("stays quiet on a small GeoParquet, where a copy is cheap", () => {
    assert.equal(objectNote(object("geoparquet", 5 * 1024 ** 2)), "none");
  });

  it("says a big GeoParquet cannot be opened rather than promising streaming", () => {
    // The regression this guards: at 2 GiB a GeoParquet does not stream, it
    // fails outright, so the PMTiles wording must not be reused here.
    assert.equal(objectNote(object("geoparquet", LARGE_FILE_BYTES)), "tooLarge");
    assert.equal(objectNote(object("geojson", 3 * 1024 ** 3)), "tooLarge");
  });

  it("never nudges a non-streamable vector format toward Stream", () => {
    // A big FlatGeobuf under the limit has no choice to offer: the control
    // would copy it either way.
    assert.equal(objectNote(object("flatgeobuf", 500 * 1024 ** 2)), "none");
    assert.equal(objectNote(object("csv", 500 * 1024 ** 2)), "none");
  });

  it("stays quiet for a format that cannot go on the map at all", () => {
    assert.equal(objectNote(object("other", 40 * 1024 ** 3)), "none");
  });
});
