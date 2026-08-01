import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  arcGisHubItemDataUrl,
  arcGisHubItemPageUrl,
  arcGisHubItemThumbnailUrl,
  buildArcGisHubSearchUrl,
  fetchFeatureServiceGeoJson,
  itemBounds,
  sanitizeArcGisHubSearchText,
} from "../packages/plugins/src/plugins/arcgis-hub-api";

describe("ArcGIS Hub catalog client", () => {
  it("builds a public dataset search with paging and map bounds", () => {
    const url = new URL(
      buildArcGisHubSearchUrl("bike lanes", {
        start: 21,
        num: 20,
        bbox: [-80, 35, -79, 36],
      }),
    );
    assert.equal(url.origin, "https://www.arcgis.com");
    assert.equal(url.pathname, "/sharing/rest/search");
    assert.match(url.searchParams.get("q") ?? "", /bike lanes/);
    assert.match(url.searchParams.get("q") ?? "", /Feature Service/);
    assert.match(url.searchParams.get("q") ?? "", /access:public/);
    assert.equal(url.searchParams.get("start"), "21");
    assert.equal(url.searchParams.get("bbox"), "-80,35,-79,36");
  });

  it("treats Lucene punctuation and operators as plain search separators", () => {
    assert.equal(
      sanitizeArcGisHubSearchText('roads) OR (owner:private && "quoted"'),
      "roads owner private quoted",
    );
    const query = new URL(buildArcGisHubSearchUrl("roads) OR (owner:private")).searchParams.get(
      "q",
    );
    assert.equal(
      query,
      '(roads owner private) AND (type:"Feature Service" OR type:"GeoJson" OR type:"CSV" OR type:"Shapefile" OR type:"KML" OR type:"File Geodatabase") AND access:public',
    );
  });

  it("builds safe Hub details and item-data URLs", () => {
    const item = { id: "abc 123" };
    assert.equal(arcGisHubItemPageUrl(item), "https://hub.arcgis.com/datasets/abc%20123/about");
    assert.equal(
      arcGisHubItemDataUrl(item),
      "https://www.arcgis.com/sharing/rest/content/items/abc%20123/data",
    );
    assert.equal(
      arcGisHubItemThumbnailUrl({ ...item, thumbnail: "thumbnail/ago_downloaded.png" }),
      "https://www.arcgis.com/sharing/rest/content/items/abc%20123/info/thumbnail/ago_downloaded.png",
    );
    assert.equal(arcGisHubItemThumbnailUrl(item), null);
  });

  it("normalizes valid item extents and rejects invalid ones", () => {
    const base = {
      id: "1",
      title: "Dataset",
      owner: "owner",
      type: "Feature Service",
    };
    assert.deepEqual(
      itemBounds({
        ...base,
        extent: [
          [-80, 35],
          [-79, 36],
        ],
      }),
      [-80, 35, -79, 36],
    );
    assert.equal(
      itemBounds({
        ...base,
        extent: [
          [Number.NaN, 35],
          [-79, 36],
        ],
      }),
      null,
    );
  });

  it("downloads every feature service page rather than truncating at the service limit", async () => {
    const originalFetch = globalThis.fetch;
    const requests: URL[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      requests.push(url);
      if (url.searchParams.get("returnIdsOnly") === "true") {
        return Response.json({ objectIds: Array.from({ length: 1001 }, (_, index) => index + 1) });
      }
      const ids = (url.searchParams.get("objectIds") ?? "").split(",");
      return Response.json({
        type: "FeatureCollection",
        features: ids.map((id) => ({
          type: "Feature",
          geometry: null,
          properties: { id: Number(id) },
        })),
      });
    }) as typeof fetch;
    try {
      const result = await fetchFeatureServiceGeoJson(
        "https://example.com/arcgis/rest/services/Test/FeatureServer/0",
      );
      assert.equal(result.features.length, 1001);
      assert.equal(requests.length, 12);
      assert.equal(requests[1].searchParams.get("f"), "geojson");
      assert.equal(requests.at(-1)?.searchParams.get("objectIds"), "1001");
      assert.ok(requests.slice(1).every((url) => url.href.length < 2_000));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("normalizes service URLs and skips group layers when resolving a download layer", async () => {
    const originalFetch = globalThis.fetch;
    const requests: URL[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      requests.push(url);
      if (url.searchParams.get("f") === "json" && !url.pathname.endsWith("/query")) {
        return Response.json({
          layers: [{ id: 0, subLayerIds: [1] }, { id: 1 }],
        });
      }
      if (url.searchParams.get("returnIdsOnly") === "true") {
        return Response.json({ objectIds: [7] });
      }
      return Response.json({
        type: "FeatureCollection",
        features: [{ type: "Feature", geometry: null, properties: { id: 7 } }],
      });
    }) as typeof fetch;
    try {
      const result = await fetchFeatureServiceGeoJson(
        "https://example.com/arcgis/rest/services/Test/FeatureServer/?token=discard#fragment",
      );
      assert.equal(result.features.length, 1);
      assert.equal(requests[0].pathname, "/arcgis/rest/services/Test/FeatureServer");
      assert.equal(requests[1].pathname, "/arcgis/rest/services/Test/FeatureServer/1/query");
      assert.equal(requests[1].searchParams.has("token"), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
