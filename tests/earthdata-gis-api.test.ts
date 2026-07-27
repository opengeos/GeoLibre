import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildExportTileUrl,
  buildItemPageUrl,
  buildSearchQuery,
  buildSearchUrl,
  buildThumbnailUrl,
  EARTHDATA_GIS_SHARING_URL,
  type EarthdataGisFetch,
  type EarthdataGisItem,
  kindFromPortalType,
  normalizeItem,
  parseSearchResponse,
  plainText,
  searchEarthdataGis,
} from "../packages/plugins/src/plugins/earthdata-gis-api";

/** A raw portal search record, close to the real API shape. */
function rawResult(overrides: Record<string, unknown> = {}) {
  return {
    id: "0252904123a74e74a7cff652d52a5b19",
    owner: "mstisdal",
    modified: 1782156691121,
    title: "TEMPO Nitrogen Dioxide",
    type: "Image Service",
    tags: ["TEMPO", "air quality"],
    snippet: "<p>Tropospheric NO<sub>2</sub></p>",
    description: "<p>Layer overview</p><p>Second &amp; last</p>",
    thumbnail: "thumbnail/o_wDates.PNG",
    extent: [
      [-168.5, 14.5],
      [-13.5, 72.5],
    ],
    accessInformation: "NASA LaRC ASDC",
    licenseInfo: "<b>NASA data policy</b>",
    url: "https://gis.earthdata.nasa.gov/image/rest/services/LARC/TEMPO_NO2/ImageServer",
    ...overrides,
  };
}

/** A fetch stub returning a fixed body, recording the URL it was called with. */
function stubFetch(body: unknown, ok = true, status = 200) {
  const calls: string[] = [];
  const impl: EarthdataGisFetch = async (url) => {
    calls.push(url);
    return { ok, status, json: async () => body };
  };
  return { calls, impl };
}

describe("earthdata gis api", () => {
  describe("buildSearchQuery", () => {
    it("scopes an empty search to every servable service type", () => {
      assert.equal(
        buildSearchQuery(""),
        '(type:"Image Service" OR type:"Map Service" OR type:"Feature Service")',
      );
    });

    it("drops the OR group when a single kind is selected", () => {
      assert.equal(buildSearchQuery("", ["feature"]), 'type:"Feature Service"');
    });

    it("ANDs the user's terms with the type scope", () => {
      assert.equal(buildSearchQuery("wildfire", ["map"]), '(wildfire) AND type:"Map Service"');
    });

    it("replaces Lucene metacharacters so a stray quote cannot 400 the query", () => {
      // Unbalanced quotes / brackets / a bare colon are what a user typing a
      // dataset name actually produces; they must degrade to a word search.
      assert.equal(
        buildSearchQuery('SWOT: "river (reach)"', ["image"]),
        '(SWOT river reach) AND type:"Image Service"',
      );
    });

    it("keeps negation and wildcard operators intact", () => {
      assert.equal(
        buildSearchQuery("fire -smoke temp*", ["map"]),
        '(fire -smoke temp*) AND type:"Map Service"',
      );
    });
  });

  describe("buildSearchUrl", () => {
    it("sorts an unfiltered browse newest-first", () => {
      const url = new URL(buildSearchUrl());
      assert.equal(url.searchParams.get("sortField"), "modified");
      assert.equal(url.searchParams.get("sortOrder"), "desc");
      assert.equal(url.searchParams.get("start"), "1");
      assert.equal(url.searchParams.get("f"), "json");
    });

    it("leaves ranking to the portal once there are search terms", () => {
      const url = new URL(buildSearchUrl({ terms: "flood" }));
      assert.equal(url.searchParams.get("sortField"), null);
      assert.equal(url.searchParams.get("q"), buildSearchQuery("flood"));
    });

    it("carries paging and a bbox filter", () => {
      const url = new URL(buildSearchUrl({ start: 21, num: 20, bbox: [-125, 25, -66, 50] }));
      assert.equal(url.searchParams.get("start"), "21");
      assert.equal(url.searchParams.get("num"), "20");
      assert.equal(url.searchParams.get("bbox"), "-125,25,-66,50");
    });
  });

  describe("plainText", () => {
    it("strips markup and decodes the entities the portal emits", () => {
      assert.equal(plainText("<p>A &amp; B</p><p>C&nbsp;D</p>"), "A & B\n\nC D");
    });

    it("collapses the source's in-paragraph hard wraps back into one line", () => {
      // The portal's rich-text editor hard-wraps inside a <p>; keeping those
      // newlines would render the details view as ragged half-width lines.
      assert.equal(
        plainText("<p>The TEMPO instrument\nis a grating\nspectrometer.</p><p>Second.</p>"),
        "The TEMPO instrument is a grating spectrometer.\n\nSecond.",
      );
    });

    it("keeps an explicit <br> as a paragraph break", () => {
      assert.equal(plainText("First<br>Second"), "First\n\nSecond");
    });

    it("returns an empty string for a non-string field", () => {
      assert.equal(plainText(null), "");
      assert.equal(plainText(undefined), "");
    });
  });

  describe("kindFromPortalType", () => {
    it("maps the three servable portal types", () => {
      assert.equal(kindFromPortalType("Image Service"), "image");
      assert.equal(kindFromPortalType("Map Service"), "map");
      assert.equal(kindFromPortalType("Feature Service"), "feature");
    });

    it("rejects portal types this panel cannot render", () => {
      // Web Maps are the single most common item type in the portal, so a
      // regression here would flood the results with unaddable rows.
      assert.equal(kindFromPortalType("Web Map"), null);
      assert.equal(kindFromPortalType(undefined), null);
    });
  });

  describe("normalizeItem", () => {
    it("normalizes a portal record into a catalog item", () => {
      const item = normalizeItem(rawResult());
      assert.ok(item);
      assert.equal(item.kind, "image");
      assert.equal(item.title, "TEMPO Nitrogen Dioxide");
      assert.equal(item.snippet, "Tropospheric NO2");
      assert.equal(item.description, "Layer overview\n\nSecond & last");
      assert.equal(item.licenseInfo, "NASA data policy");
      assert.equal(item.owner, "mstisdal");
      assert.deepEqual(item.bbox, [-168.5, 14.5, -13.5, 72.5]);
      assert.equal(
        item.thumbnailUrl,
        `${EARTHDATA_GIS_SHARING_URL}/content/items/0252904123a74e74a7cff652d52a5b19/info/thumbnail/o_wDates.PNG`,
      );
      assert.equal(item.itemPageUrl, buildItemPageUrl(item.id));
    });

    it("formats the modified timestamp as a date", () => {
      assert.equal(normalizeItem(rawResult({ modified: 0 }))?.modified, "1970-01-01");
      assert.equal(normalizeItem(rawResult({ modified: "recently" }))?.modified, null);
    });

    it("drops records without a servable type or an http(s) service URL", () => {
      assert.equal(normalizeItem(rawResult({ type: "Web Map" })), null);
      assert.equal(normalizeItem(rawResult({ url: "" })), null);
      // A `javascript:` URL would otherwise reach a rendered <a href>.
      assert.equal(normalizeItem(rawResult({ url: "javascript:alert(1)" })), null);
      assert.equal(normalizeItem(rawResult({ id: "" })), null);
    });

    it("treats a degenerate extent as no extent", () => {
      assert.equal(
        normalizeItem(
          rawResult({
            extent: [
              [10, 10],
              [10, 20],
            ],
          }),
        )?.bbox,
        null,
      );
      assert.equal(normalizeItem(rawResult({ extent: null }))?.bbox, null);
    });
  });

  describe("buildExportTileUrl", () => {
    const item = (overrides: Partial<EarthdataGisItem>): EarthdataGisItem =>
      ({ ...normalizeItem(rawResult()), ...overrides }) as EarthdataGisItem;

    it("renders an ImageServer through exportImage", () => {
      const url = buildExportTileUrl(item({}));
      assert.ok(url?.startsWith(`${rawResult().url}/exportImage?`));
    });

    it("renders a MapServer through export", () => {
      const url = buildExportTileUrl(
        item({
          kind: "map",
          url: "https://gis.earthdata.nasa.gov/gis05/rest/services/A/B/MapServer",
        }),
      );
      assert.ok(
        url?.startsWith("https://gis.earthdata.nasa.gov/gis05/rest/services/A/B/MapServer/export?"),
      );
    });

    it("leaves the {bbox-epsg-3857} token unencoded for MapLibre to substitute", () => {
      // URLSearchParams would percent-encode the braces, which MapLibre never
      // substitutes — the layer would then request one broken tile forever.
      const url = buildExportTileUrl(item({}));
      assert.ok(url?.includes("bbox={bbox-epsg-3857}"));
      assert.ok(!url?.includes("%7Bbbox"));
    });

    it("requests 3857 PNG tiles matching the raster source's tile size", () => {
      const url = buildExportTileUrl(item({}));
      assert.ok(url?.includes("bboxSR=3857"));
      assert.ok(url?.includes("imageSR=3857"));
      assert.ok(url?.includes("size=256,256"));
      assert.ok(url?.includes("format=png32"));
      assert.ok(url?.includes("transparent=true"));
      assert.ok(url?.endsWith("f=image"));
    });

    it("has no tile template for a feature service", () => {
      assert.equal(buildExportTileUrl(item({ kind: "feature" })), null);
    });

    it("collapses a trailing slash on the service URL", () => {
      const url = buildExportTileUrl(item({ url: `${rawResult().url}/` }));
      assert.ok(url?.includes("/ImageServer/exportImage?"));
    });
  });

  describe("buildThumbnailUrl", () => {
    it("returns null when the item has no thumbnail", () => {
      assert.equal(buildThumbnailUrl("abc", ""), null);
      assert.equal(buildThumbnailUrl("abc", undefined), null);
    });

    it("escapes each path segment without escaping the separators", () => {
      assert.equal(
        buildThumbnailUrl("abc", "thumbnail/a b.png"),
        `${EARTHDATA_GIS_SHARING_URL}/content/items/abc/info/thumbnail/a%20b.png`,
      );
    });
  });

  describe("parseSearchResponse", () => {
    it("normalizes results and reports the next page offset", () => {
      const result = parseSearchResponse({
        total: 42,
        nextStart: 21,
        results: [rawResult(), rawResult({ id: "two", type: "Web Map" })],
      });
      assert.equal(result.total, 42);
      assert.equal(result.nextStart, 21);
      // The Web Map is filtered out, but the total still reflects the portal's.
      assert.equal(result.items.length, 1);
    });

    it("reads the portal's -1 end-of-results marker as no next page", () => {
      const result = parseSearchResponse({ total: 1, nextStart: -1, results: [rawResult()] });
      assert.equal(result.nextStart, null);
    });

    it("throws on the portal's HTTP-200 error envelope", () => {
      // A malformed query answers 200 with an error body, so the status alone
      // would report success on a search that returned nothing.
      assert.throws(
        () =>
          parseSearchResponse({ error: { code: 400, messages: ["Unable to perform search."] } }),
        /Unable to perform search/,
      );
    });

    it("falls back to the item count when the portal omits a total", () => {
      assert.equal(parseSearchResponse({ results: [rawResult()] }).total, 1);
    });
  });

  describe("searchEarthdataGis", () => {
    it("requests the built search URL and returns normalized items", async () => {
      const { calls, impl } = stubFetch({ total: 1, nextStart: -1, results: [rawResult()] });
      const result = await searchEarthdataGis({ terms: "TEMPO", kinds: ["image"] }, impl);
      assert.equal(calls.length, 1);
      assert.equal(calls[0], buildSearchUrl({ terms: "TEMPO", kinds: ["image"] }));
      assert.equal(result.items[0]?.title, "TEMPO Nitrogen Dioxide");
    });

    it("surfaces a transport failure with its status", async () => {
      const { impl } = stubFetch({}, false, 503);
      await assert.rejects(() => searchEarthdataGis({}, impl), /503/);
    });
  });
});
