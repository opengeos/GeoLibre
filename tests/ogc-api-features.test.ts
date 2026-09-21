import assert from "node:assert/strict";
import type { Feature, FeatureCollection } from "geojson";
import { describe, it } from "node:test";

import {
  createOgcCollectionsUrl,
  createOgcItemsUrl,
  fetchOgcFeatureItems,
  nextItemsPageUrl,
  parseOgcCollections,
  parseOgcFeaturesUrl,
  viewBoundsToOgcBbox,
} from "../apps/geolibre-desktop/src/lib/ogc-api-features";
import { buildOgcFeaturesLayer } from "../apps/geolibre-desktop/src/components/layout/add-data/apply-service";

/** A minimal point feature, numbered so pages can be told apart. */
function feature(index: number): Feature {
  return {
    type: "Feature",
    properties: { index },
    geometry: { type: "Point", coordinates: [index, index] },
  };
}

/** A page of features plus the links document an OGC API service returns. */
function page(features: Feature[], next?: string, numberMatched?: number): unknown {
  return {
    type: "FeatureCollection",
    features,
    ...(numberMatched !== undefined ? { numberMatched } : {}),
    links: [
      { rel: "self", type: "application/geo+json", href: "https://ex.com/self" },
      ...(next ? [{ rel: "next", type: "application/geo+json", href: next }] : []),
    ],
  };
}

/**
 * Runs `body` with `globalThis.fetch` answering from a URL map, returning the
 * URLs that were requested in order.
 */
async function withFetch(
  responses: Record<string, unknown>,
  body: () => Promise<void>,
): Promise<string[]> {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const document = responses[url];
    return Promise.resolve({
      ok: document !== undefined,
      status: document !== undefined ? 200 : 404,
      headers: new Headers({ "content-type": "application/geo+json" }),
      json: async () => document ?? {},
    } as Response);
  }) as typeof fetch;
  try {
    await body();
  } finally {
    globalThis.fetch = original;
  }
  return calls;
}

describe("parseOgcFeaturesUrl", () => {
  it("keeps a landing page URL as the base", () => {
    assert.deepEqual(parseOgcFeaturesUrl("https://ex.com/ogcapi"), {
      baseUrl: "https://ex.com/ogcapi",
      collectionId: "",
      extraQuery: "",
    });
  });

  it("strips a trailing slash and the /collections segment", () => {
    assert.equal(parseOgcFeaturesUrl("https://ex.com/ogcapi/").baseUrl, "https://ex.com/ogcapi");
    assert.equal(
      parseOgcFeaturesUrl("https://ex.com/ogcapi/collections").baseUrl,
      "https://ex.com/ogcapi",
    );
  });

  it("reads the collection id out of a collection or items URL", () => {
    for (const url of [
      "https://ex.com/ogcapi/collections/parking_live",
      "https://ex.com/ogcapi/collections/parking_live/items",
      "https://ex.com/ogcapi/collections/parking_live/items/",
    ]) {
      assert.deepEqual(
        parseOgcFeaturesUrl(url),
        { baseUrl: "https://ex.com/ogcapi", collectionId: "parking_live", extraQuery: "" },
        url,
      );
    }
  });

  it("decodes a percent-encoded collection id", () => {
    assert.equal(
      parseOgcFeaturesUrl("https://ex.com/ogcapi/collections/road%20signs/items").collectionId,
      "road signs",
    );
  });

  it("handles a service mounted at the site root", () => {
    assert.deepEqual(parseOgcFeaturesUrl("https://ex.com/collections/lakes/items"), {
      baseUrl: "https://ex.com",
      collectionId: "lakes",
      extraQuery: "",
    });
  });

  it("drops the request parameters it sets itself and keeps the rest", () => {
    const parsed = parseOgcFeaturesUrl(
      "https://ex.com/ogcapi/collections/lakes/items?f=html&limit=10&offset=20&bbox=1,2,3,4&apikey=abc",
    );
    assert.equal(parsed.baseUrl, "https://ex.com/ogcapi");
    assert.equal(parsed.collectionId, "lakes");
    assert.equal(parsed.extraQuery, "apikey=abc");
  });

  it("rejects an empty or non-absolute URL", () => {
    assert.throws(() => parseOgcFeaturesUrl("   "), /Enter an OGC API - Features service URL/);
    assert.throws(() => parseOgcFeaturesUrl("example.com/ogcapi"), /absolute/);
    assert.throws(() => parseOgcFeaturesUrl("ftp://ex.com/ogcapi"), /absolute/);
  });
});

describe("createOgcCollectionsUrl / createOgcItemsUrl", () => {
  it("requests JSON and carries the preserved query", () => {
    assert.equal(
      createOgcCollectionsUrl({ baseUrl: "https://ex.com/ogcapi", extraQuery: "apikey=abc" }),
      "https://ex.com/ogcapi/collections?apikey=abc&f=json",
    );
    assert.equal(
      createOgcCollectionsUrl({ baseUrl: "https://ex.com/ogcapi", extraQuery: "" }),
      "https://ex.com/ogcapi/collections?f=json",
    );
  });

  it("builds an items URL with the optional filters", () => {
    assert.equal(
      createOgcItemsUrl({
        baseUrl: "https://ex.com/ogcapi",
        collectionId: "lakes",
        limit: 500,
        bbox: "1,2,3,4",
        datetime: "2026-01-01/2026-02-01",
      }),
      "https://ex.com/ogcapi/collections/lakes/items?f=json&limit=500&bbox=1%2C2%2C3%2C4&datetime=2026-01-01%2F2026-02-01",
    );
  });

  it("percent-encodes a collection id with a space", () => {
    assert.equal(
      createOgcItemsUrl({ baseUrl: "https://ex.com/ogcapi", collectionId: "road signs" }),
      "https://ex.com/ogcapi/collections/road%20signs/items?f=json",
    );
  });
});

describe("parseOgcCollections", () => {
  it("reads ids and titles, deduplicating and defaulting the title", () => {
    const options = parseOgcCollections({
      collections: [
        { id: "lakes", title: "Large Lakes" },
        { id: "obs" },
        { id: "lakes", title: "Duplicate" },
        { id: "  " },
        null,
      ],
    });
    assert.deepEqual(options, [
      { id: "lakes", title: "Large Lakes" },
      { id: "obs", title: "obs" },
    ]);
  });

  it("skips collections that are not feature collections", () => {
    const options = parseOgcCollections({
      collections: [
        { id: "lakes", itemType: "feature" },
        { id: "dem", itemType: "coverage" },
        { id: "records", itemType: "record" },
        { id: "legacy" },
      ],
    });
    assert.deepEqual(
      options.map((option) => option.id),
      ["lakes", "legacy"],
    );
  });

  it("throws when the document is not a collections response", () => {
    assert.throws(
      () => parseOgcCollections({ type: "FeatureCollection", features: [] }),
      /not an OGC API - Features collections document/,
    );
  });
});

describe("nextItemsPageUrl", () => {
  const current = "https://ex.com/ogcapi/collections/lakes/items?f=json&limit=10";

  it("resolves a relative next link and keeps f=json", () => {
    const url = nextItemsPageUrl({ links: [{ rel: "next", href: "items?offset=10" }] }, current);
    assert.equal(url, "https://ex.com/ogcapi/collections/lakes/items?offset=10&f=json");
  });

  it("ignores links that are not a JSON next page", () => {
    assert.equal(nextItemsPageUrl({ links: [{ rel: "prev", href: "?offset=0" }] }, current), null);
    assert.equal(
      nextItemsPageUrl({ links: [{ rel: "next", type: "text/html", href: "?f=html" }] }, current),
      null,
    );
    assert.equal(nextItemsPageUrl({}, current), null);
  });

  it("refuses a next link that leaves the service's origin", () => {
    assert.equal(
      nextItemsPageUrl({ links: [{ rel: "next", href: "https://evil.example/items" }] }, current),
      null,
    );
  });
});

describe("viewBoundsToOgcBbox", () => {
  it("formats an in-range view as west,south,east,north", () => {
    assert.equal(viewBoundsToOgcBbox([4.85, 52.3, 4.95, 52.4]), "4.85,52.3,4.95,52.4");
  });

  it("rounds to six decimals rather than emitting float noise", () => {
    assert.equal(viewBoundsToOgcBbox([4.8512345678, 52.3, 4.95, 52.4]), "4.851235,52.3,4.95,52.4");
  });

  it("collapses a view wider than one world copy to the full longitude span", () => {
    assert.equal(viewBoundsToOgcBbox([-400, -60, 400, 60]), "-180,-60,180,60");
  });

  it("wraps a view panned a whole world copy east, keeping its width", () => {
    assert.equal(viewBoundsToOgcBbox([350, -10, 370, 10]), "-10,-10,10,10");
    assert.equal(viewBoundsToOgcBbox([-370, -10, -350, 10]), "-10,-10,10,10");
  });

  it("widens a view straddling the antimeridian instead of crossing the box", () => {
    // A `west > east` box is how the specification spells a crossing one, but
    // pygeoapi sorts the pair and answers with the complement of the view. The
    // full width is a superset of the view under either reading.
    assert.equal(viewBoundsToOgcBbox([170, -10, 190, 10]), "-180,-10,180,10");
    assert.equal(viewBoundsToOgcBbox([-190, -10, -170, 10]), "-180,-10,180,10");
  });

  it("still reads as the whole world when the span only rounds up to 360", () => {
    // The `span < 360` test runs on the raw extent, so these take the wrapping
    // path; it has to arrive at the same full-width box the shortcut would.
    assert.equal(viewBoundsToOgcBbox([-180, -10, 179.9999996, 10]), "-180,-10,180,10");
    assert.equal(viewBoundsToOgcBbox([-10, -10, 349.9999996, 10]), "-180,-10,180,10");
  });

  it("clamps latitudes that run past the poles", () => {
    assert.equal(viewBoundsToOgcBbox([-10, -95, 10, 95]), "-10,-90,10,90");
  });

  it("rejects an extent with no usable area", () => {
    assert.equal(viewBoundsToOgcBbox([10, 20, 10, 30]), null);
    assert.equal(viewBoundsToOgcBbox([0, 20, 10, 20]), null);
    assert.equal(viewBoundsToOgcBbox([0, Number.NaN, 10, 20]), null);
    assert.equal(viewBoundsToOgcBbox([0, 10, 20]), null);
  });

  it("rejects a span too narrow to survive rounding", () => {
    // An empty box would filter every feature out rather than narrow the query.
    assert.equal(viewBoundsToOgcBbox([0, 0, 0.0000004, 1]), null);
    assert.equal(viewBoundsToOgcBbox([0, 0, 1, 0.0000004]), null);
  });
});

describe("fetchOgcFeatureItems", () => {
  it("follows next links until maxFeatures is reached", async () => {
    const first = "https://ex.com/ogcapi/collections/lakes/items?f=json&limit=25";
    const second = "https://ex.com/ogcapi/collections/lakes/items?offset=10&f=json";
    const third = "https://ex.com/ogcapi/collections/lakes/items?offset=20&f=json";
    let result: Awaited<ReturnType<typeof fetchOgcFeatureItems>> | undefined;
    const calls = await withFetch(
      {
        [first]: page([feature(0), feature(1)], second, 5),
        [second]: page([feature(2), feature(3)], third, 5),
        [third]: page([feature(4)], undefined, 5),
      },
      async () => {
        result = await fetchOgcFeatureItems({
          baseUrl: "https://ex.com/ogcapi",
          collectionId: "lakes",
          maxFeatures: 25,
        });
      },
    );
    assert.equal(calls.length, 3);
    assert.equal(result?.pages, 3);
    assert.equal(result?.data.features.length, 5);
    assert.equal(result?.numberMatched, 5);
    assert.equal(result?.truncated, false);
    assert.equal(result?.url, first);
  });

  it("stops at maxFeatures and reports the collection as truncated", async () => {
    const first = "https://ex.com/ogcapi/collections/lakes/items?f=json&limit=3";
    const second = "https://ex.com/ogcapi/collections/lakes/items?offset=2&f=json";
    let result: Awaited<ReturnType<typeof fetchOgcFeatureItems>> | undefined;
    const calls = await withFetch(
      {
        [first]: page([feature(0), feature(1)], second, 100),
        [second]: page([feature(2), feature(3)], second, 100),
      },
      async () => {
        result = await fetchOgcFeatureItems({
          baseUrl: "https://ex.com/ogcapi",
          collectionId: "lakes",
          maxFeatures: 3,
        });
      },
    );
    assert.equal(calls.length, 2);
    assert.equal(result?.data.features.length, 3);
    assert.equal(result?.truncated, true);
  });

  it("stops on an empty page even when the service still advertises next", async () => {
    const first = "https://ex.com/ogcapi/collections/lakes/items?f=json&limit=50";
    const second = "https://ex.com/ogcapi/collections/lakes/items?offset=2&f=json";
    let result: Awaited<ReturnType<typeof fetchOgcFeatureItems>> | undefined;
    const calls = await withFetch(
      {
        [first]: page([feature(0), feature(1)], second),
        // A last page that is empty but still links onward; without the
        // empty-page stop this would page until the safety cap.
        [second]: page([], "https://ex.com/ogcapi/collections/lakes/items?offset=4&f=json"),
      },
      async () => {
        result = await fetchOgcFeatureItems({
          baseUrl: "https://ex.com/ogcapi",
          collectionId: "lakes",
          maxFeatures: 50,
        });
      },
    );
    assert.equal(calls.length, 2);
    assert.equal(result?.data.features.length, 2);
    assert.equal(result?.truncated, false);
  });

  it("does not loop when next points back at a page already read", async () => {
    const first = "https://ex.com/ogcapi/collections/lakes/items?f=json&limit=50";
    let result: Awaited<ReturnType<typeof fetchOgcFeatureItems>> | undefined;
    const calls = await withFetch({ [first]: page([feature(0)], first) }, async () => {
      result = await fetchOgcFeatureItems({
        baseUrl: "https://ex.com/ogcapi",
        collectionId: "lakes",
        maxFeatures: 50,
      });
    });
    assert.equal(calls.length, 1);
    assert.equal(result?.data.features.length, 1);
  });

  it("rejects a response that is not a FeatureCollection", async () => {
    const first = "https://ex.com/ogcapi/collections/lakes/items?f=json&limit=10";
    await withFetch({ [first]: { code: "NotFound" } }, async () => {
      await assert.rejects(
        fetchOgcFeatureItems({
          baseUrl: "https://ex.com/ogcapi",
          collectionId: "lakes",
          maxFeatures: 10,
        }),
        /not a GeoJSON FeatureCollection/,
      );
    });
  });
});

describe("buildOgcFeaturesLayer", () => {
  const data: FeatureCollection = {
    type: "FeatureCollection",
    features: [feature(0), feature(1)],
  };

  it("persists the request so the layer can replay its paged walk on refresh", () => {
    const layer = buildOgcFeaturesLayer({
      name: "Lakes",
      itemsUrl: "https://ex.com/ogcapi/collections/lakes/items?f=json&limit=1000",
      data,
      baseUrl: "https://ex.com/ogcapi",
      collectionId: "lakes",
      maxFeatures: 1000,
      numberMatched: 25,
      truncated: false,
    });
    assert.equal(layer.type, "geojson");
    assert.equal(layer.name, "Lakes");
    assert.equal(layer.source.service, "ogc-features");
    assert.equal(layer.source.baseUrl, "https://ex.com/ogcapi");
    assert.equal(layer.source.collectionId, "lakes");
    assert.equal(layer.source.maxFeatures, 1000);
    assert.equal(layer.metadata.sourceKind, "ogc-features-items");
    assert.equal(layer.metadata.featureCount, 2);
    assert.equal(layer.metadata.numberMatched, 25);
    assert.equal(layer.geojson, data);
    assert.equal(layer.sourcePath, layer.source.url);
  });

  it("omits the optional filters that were not used", () => {
    const layer = buildOgcFeaturesLayer({
      name: "Lakes",
      itemsUrl: "https://ex.com/ogcapi/collections/lakes/items?f=json",
      data,
      baseUrl: "https://ex.com/ogcapi",
      collectionId: "lakes",
      maxFeatures: 1000,
      bbox: "",
      truncated: true,
    });
    assert.equal(layer.source.bbox, undefined);
    assert.equal(layer.source.datetime, undefined);
    assert.equal(layer.source.extraQuery, undefined);
    assert.equal(layer.metadata.numberMatched, undefined);
    assert.equal(layer.metadata.truncated, true);
  });

  it("reserves a different palette color for a pending batch sibling", () => {
    const params = {
      name: "First",
      itemsUrl: "https://ex.com/ogcapi/collections/first/items?f=json",
      data,
      baseUrl: "https://ex.com/ogcapi",
      collectionId: "first",
      maxFeatures: 1000,
      truncated: false,
    };
    const first = buildOgcFeaturesLayer(params);
    const second = buildOgcFeaturesLayer({
      ...params,
      name: "Second",
      collectionId: "second",
      pendingLayers: [first],
    });
    assert.notEqual(second.style.fillColor, first.style.fillColor);
  });
});
