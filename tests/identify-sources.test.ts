import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { DOMParser } from "linkedom";
import {
  fetchWmsIdentifyProperties,
  isPixelIdentifyLayer,
  pixelIdentifyProperties,
} from "../packages/map/src/identify-sources";
import { geojsonLayer } from "./helpers/layer-fixtures";

// Engine-neutral identify sources shared by the MapLibre and Mapbox canvases
// (#2475): WMS GetFeatureInfo needs only the clicked lngLat and the zoom.
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const wmsLayer = (source: Record<string, unknown> = {}) =>
  geojsonLayer({
    id: "wms",
    type: "wms",
    geojson: undefined,
    source: { type: "raster", url: "https://wms.example/service", layers: "roads", ...source },
  });

function stubFetch(body: string, contentType: string) {
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(body, { status: 200, headers: { "content-type": contentType } });
  }) as typeof fetch;
  return urls;
}

describe("fetchWmsIdentifyProperties", () => {
  it("queries a box centered on the click, sized by the zoom", async () => {
    const urls = stubFetch(
      JSON.stringify({ type: "FeatureCollection", features: [{ id: 7, properties: { a: 1 } }] }),
      "application/json",
    );
    const result = await fetchWmsIdentifyProperties(
      wmsLayer({ infoFormat: "application/json" }),
      [0, 0],
      10,
      new AbortController().signal,
    );
    assert.deepEqual(result, { featureId: 7, properties: { a: 1 } });
    const url = new URL(urls[0], "http://localhost");
    const inner = url.searchParams.get("url") ? new URL(url.searchParams.get("url")!) : url;
    assert.equal(inner.searchParams.get("REQUEST"), "GetFeatureInfo");
    const [minX, minY, maxX, maxY] = inner.searchParams.get("BBOX")!.split(",").map(Number);
    assert.ok(Math.abs(minX + maxX) < 1e-6 && Math.abs(minY + maxY) < 1e-6);
    // 101 px at zoom 10 of 512-px tiles.
    const span = maxX - minX;
    const expected = (101 * (2 * Math.PI * 6378137)) / (512 * 2 ** 10);
    assert.ok(Math.abs(span - expected) < 1e-6);
  });

  it("falls back to the text of an HTML response", async () => {
    stubFetch("<html><body><p>Road  42</p></body></html>", "text/html");
    const original = globalThis.DOMParser;
    globalThis.DOMParser = DOMParser as unknown as typeof globalThis.DOMParser;
    try {
      const result = await fetchWmsIdentifyProperties(
        wmsLayer({ infoFormat: "text/html" }),
        [10, 20],
        4,
        new AbortController().signal,
      );
      assert.deepEqual(result, { properties: { result: "Road 42" } });
    } finally {
      globalThis.DOMParser = original;
    }
  });
});

describe("pixel identify helpers", () => {
  it("flags Time Slider pixel layers and formats their band rows", () => {
    assert.equal(isPixelIdentifyLayer(geojsonLayer({ metadata: { pixelIdentify: true } })), true);
    assert.equal(isPixelIdentifyLayer(geojsonLayer()), false);
    const rows = pixelIdentifyProperties({
      sourceId: "s",
      date: "2026-01-01",
      url: "https://x",
      bands: [
        { index: 1, name: "red", value: 12, isNodata: false },
        { index: 2, name: null, value: 0, isNodata: true },
      ],
    });
    assert.equal(rows.Date, "2026-01-01");
    assert.equal(rows.red, "12");
    assert.match(String(rows["Band 2"]), /nodata/);
  });
});
