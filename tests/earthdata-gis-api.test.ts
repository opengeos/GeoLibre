import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildExportTileUrl,
  buildItemPageUrl,
  buildMaxPixelSizeUrl,
  buildSearchQuery,
  buildSearchUrl,
  buildThumbnailUrl,
  EARTHDATA_GIS_SHARING_URL,
  type EarthdataGisFetch,
  type EarthdataGisItem,
  fetchMinVisibleZoom,
  kindFromPortalType,
  minZoomForPixelSize,
  normalizeItem,
  parseMaxPixelSize,
  parseSearchResponse,
  parseWebMapLayers,
  plainText,
  searchEarthdataGis,
  webMapLayerAsItem,
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
    it("scopes an empty search to every supported item type", () => {
      assert.equal(
        buildSearchQuery(""),
        '(type:"Image Service" OR type:"Map Service" OR type:"Feature Service" OR type:"Web Map")',
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
    it("maps every supported portal type", () => {
      assert.equal(kindFromPortalType("Image Service"), "image");
      assert.equal(kindFromPortalType("Map Service"), "map");
      assert.equal(kindFromPortalType("Feature Service"), "feature");
      assert.equal(kindFromPortalType("Web Map"), "webmap");
    });

    it("rejects portal types this panel cannot render", () => {
      // Web Mapping Applications are the portal's second most common type
      // (~1300), so a regression here would flood the results with rows that
      // carry nothing addable.
      assert.equal(kindFromPortalType("Web Mapping Application"), null);
      assert.equal(kindFromPortalType("Dashboard"), null);
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
      assert.equal(normalizeItem(rawResult({ type: "Web Mapping Application" })), null);
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
        results: [rawResult(), rawResult({ id: "two", type: "Web Mapping Application" })],
      });
      assert.equal(result.total, 42);
      assert.equal(result.nextStart, 21);
      // The unsupported item is filtered out, but the total still reflects the
      // portal's own count.
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

  describe("minZoomForPixelSize", () => {
    it("finds the shallowest zoom whose resolution is finer than MaxPS", () => {
      // The Planet imagery for Hurricane Melissa has MaxPS 30 m at ~18N, and
      // was verified against the live service: blank at 50 m/px, drawing at
      // 25 m/px. z13 gives ~18 m/px there, z12 ~36 m/px.
      assert.equal(minZoomForPixelSize(30, 17.9), 13);
    });

    it("imposes no zoom floor on a service visible at any scale", () => {
      // MaxPS 324000 m is coarser than zoom 0, so the layer draws everywhere.
      assert.equal(minZoomForPixelSize(324000, 64), 0);
    });

    it("scales the threshold with latitude", () => {
      // A metre is fewer pixels near the poles, so high latitudes reach a given
      // ground resolution at a shallower zoom.
      const equator = minZoomForPixelSize(30, 0);
      const arctic = minZoomForPixelSize(30, 70);
      assert.ok(equator !== null && arctic !== null);
      assert.ok(arctic < equator);
    });

    it("halves the requirement when tiles are twice as large", () => {
      assert.equal(minZoomForPixelSize(30, 0, 512), (minZoomForPixelSize(30, 0) as number) - 1);
    });

    it("rejects inputs it cannot reason about", () => {
      assert.equal(minZoomForPixelSize(0, 0), null);
      assert.equal(minZoomForPixelSize(-5, 0), null);
      assert.equal(minZoomForPixelSize(Number.NaN, 0), null);
      assert.equal(minZoomForPixelSize(30, 95), null);
      assert.equal(minZoomForPixelSize(30, 0, 0), null);
    });

    it("clamps an absurdly fine mosaic to the maximum zoom", () => {
      assert.equal(minZoomForPixelSize(1e-9, 0), 24);
    });
  });

  describe("buildMaxPixelSizeUrl", () => {
    it("asks the catalog for the coarsest MaxPS", () => {
      const url = new URL(buildMaxPixelSizeUrl("https://example.com/x/ImageServer/"));
      assert.equal(url.pathname, "/x/ImageServer/query");
      assert.equal(url.searchParams.get("where"), "1=1");
      assert.deepEqual(JSON.parse(url.searchParams.get("outStatistics") ?? "[]"), [
        { statisticType: "max", onStatisticField: "MaxPS", outStatisticFieldName: "maxPixelSize" },
      ]);
    });
  });

  describe("parseMaxPixelSize", () => {
    it("reads the statistic out of the response", () => {
      assert.equal(
        parseMaxPixelSize({ features: [{ attributes: { maxPixelSize: 30.0026 } }] }),
        30.0026,
      );
    });

    it("returns null when the service reports no MaxPS column", () => {
      // Multidimensional CRF services answer with an empty attribute bag; that
      // must mean "no constraint", never "visible at zoom 0 only".
      assert.equal(parseMaxPixelSize({ features: [{ attributes: {} }] }), null);
      assert.equal(parseMaxPixelSize({ features: [] }), null);
      assert.equal(parseMaxPixelSize({}), null);
      assert.equal(parseMaxPixelSize({ features: [{ attributes: { maxPixelSize: null } }] }), null);
      assert.equal(parseMaxPixelSize({ features: [{ attributes: { maxPixelSize: 0 } }] }), null);
    });
  });

  describe("fetchMinVisibleZoom", () => {
    const imageItem = (overrides: Record<string, unknown> = {}) =>
      normalizeItem(rawResult(overrides)) as EarthdataGisItem;

    function scriptedFetch(responses: Array<{ ok?: boolean; body: unknown }>) {
      const calls: string[] = [];
      let index = 0;
      const impl: EarthdataGisFetch = async (url) => {
        calls.push(url);
        const next = responses[index++] ?? { body: {} };
        return {
          ok: next.ok ?? true,
          status: next.ok === false ? 500 : 200,
          json: async () => next.body,
        };
      };
      return { calls, impl };
    }

    it("derives the floor from the service SR and the catalog statistic", async () => {
      const { calls, impl } = scriptedFetch([
        { body: { spatialReference: { latestWkid: 3857 } } },
        { body: { features: [{ attributes: { maxPixelSize: 30 } }] } },
      ]);
      // rawResult's extent spans 14.5N..72.5N, so the midpoint is 43.5N.
      assert.equal(await fetchMinVisibleZoom(imageItem(), impl), minZoomForPixelSize(30, 43.5));
      assert.equal(calls.length, 2);
    });

    it("skips services whose units are degrees, where MaxPS is incomparable", async () => {
      // A 4326 MaxPS of 30 is 30 DEGREES; treating it as metres would compute a
      // huge zoom floor and hide a layer that renders fine.
      const { calls, impl } = scriptedFetch([{ body: { spatialReference: { latestWkid: 4326 } } }]);
      assert.equal(await fetchMinVisibleZoom(imageItem(), impl), null);
      assert.equal(calls.length, 1);
    });

    it("imposes no floor for feature services or items without an extent", async () => {
      const { impl } = scriptedFetch([]);
      const feature = normalizeItem(
        rawResult({ type: "Feature Service", url: "https://example.com/x/FeatureServer" }),
      ) as EarthdataGisItem;
      assert.equal(await fetchMinVisibleZoom(feature, impl), null);
      assert.equal(await fetchMinVisibleZoom(imageItem({ extent: null }), impl), null);
    });

    it("falls back to no floor when a request fails or throws", async () => {
      const failed = scriptedFetch([{ ok: false, body: {} }]);
      assert.equal(await fetchMinVisibleZoom(imageItem(), failed.impl), null);
      const throwing: EarthdataGisFetch = async () => {
        throw new Error("network down");
      };
      assert.equal(await fetchMinVisibleZoom(imageItem(), throwing), null);
    });
  });

  describe("web maps", () => {
    const webMapData = {
      operationalLayers: [
        {
          layerType: "ArcGISMapServiceLayer",
          title: "Fire perimeters",
          url: "https://gis.earthdata.nasa.gov/image/rest/services/F/P/MapServer",
        },
        {
          layerType: "GroupLayer",
          title: "VEG-DIST-STATUS",
          layers: [
            {
              layerType: "ArcGISImageServiceLayer",
              title: "Nested imagery",
              url: "https://gis.earthdata.nasa.gov/image/rest/services/F/I/ImageServer",
            },
          ],
        },
        {
          layerType: "ArcGISFeatureLayer",
          title: "Analyzed area",
          url: "https://gis.earthdata.nasa.gov/maphost/rest/services/Hosted/A/FeatureServer/0",
        },
        { layerType: "VectorTileLayer", title: "Unsupported", url: "https://example.com/vt" },
        { layerType: "ArcGISFeatureLayer", title: "No url" },
      ],
    };

    it("flattens group layers and keeps the web map's order", () => {
      assert.deepEqual(
        parseWebMapLayers(webMapData).map((layer) => [layer.kind, layer.title]),
        [
          ["map", "Fire perimeters"],
          ["image", "Nested imagery"],
          ["feature", "Analyzed area"],
        ],
      );
    });

    it("skips layer types with no MapLibre equivalent and entries with no URL", () => {
      const titles = parseWebMapLayers(webMapData).map((layer) => layer.title);
      assert.ok(!titles.includes("Unsupported"));
      assert.ok(!titles.includes("No url"));
    });

    it("survives a malformed or self-referencing document", () => {
      assert.deepEqual(parseWebMapLayers({}), []);
      assert.deepEqual(parseWebMapLayers(null), []);
      const cyclic: Record<string, unknown> = { layerType: "GroupLayer" };
      cyclic.layers = [cyclic];
      assert.deepEqual(parseWebMapLayers({ operationalLayers: [cyclic] }), []);
    });

    it("projects a web map layer into an addable item that inherits the extent", () => {
      const parent = normalizeItem(rawResult({ type: "Web Map", url: "" })) as EarthdataGisItem;
      const child = webMapLayerAsItem(parent, parseWebMapLayers(webMapData)[0], 0);
      assert.equal(child.kind, "map");
      assert.equal(child.id, `${parent.id}:0`);
      assert.deepEqual(child.bbox, parent.bbox);
      assert.equal(child.thumbnailUrl, null);
    });

    it("keeps a Web Map item even though the portal gives it no service URL", () => {
      // The portal stores a Web Map's `url` as "", so the service-URL guard
      // would otherwise drop every one of the portal's ~1900 web maps.
      const item = normalizeItem(rawResult({ type: "Web Map", url: "" }));
      assert.equal(item?.kind, "webmap");
    });
  });

  describe("MapServer sublayer exports", () => {
    it("moves a sublayer index into a layers=show filter", () => {
      // A web map can reference `…/MapServer/3`; `export` lives on the service,
      // so appending it to the sublayer path would 404.
      const item = {
        ...(normalizeItem(rawResult()) as EarthdataGisItem),
        kind: "map" as const,
        url: "https://gis.earthdata.nasa.gov/gis05/rest/services/A/B/MapServer/3",
      };
      const url = buildExportTileUrl(item);
      assert.ok(
        url?.startsWith("https://gis.earthdata.nasa.gov/gis05/rest/services/A/B/MapServer/export?"),
      );
      assert.ok(url?.includes("layers=show:3"));
    });

    it("leaves a plain MapServer URL alone", () => {
      const item = {
        ...(normalizeItem(rawResult()) as EarthdataGisItem),
        kind: "map" as const,
        url: "https://gis.earthdata.nasa.gov/gis05/rest/services/A/B/MapServer",
      };
      assert.ok(!buildExportTileUrl(item)?.includes("layers=show"));
    });

    it("has no tile template for a web map", () => {
      const item = normalizeItem(rawResult({ type: "Web Map", url: "" })) as EarthdataGisItem;
      assert.equal(buildExportTileUrl(item), null);
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
