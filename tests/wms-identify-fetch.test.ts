import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { DOMParser } from "linkedom";
import { createNativeWmsIdentifyFetcher } from "../apps/geolibre-desktop/src/lib/wms-identify-fetch";
import {
  fetchWmsIdentifyProperties,
  setWmsIdentifyFetcher,
} from "../packages/map/src/identify-sources";
import { geojsonLayer } from "./helpers/layer-fixtures";

// Desktop identify goes through the native client, not the webview fetch, so a
// WMS server without CORS headers still answers (#2712).
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  setWmsIdentifyFetcher(null);
});

const wmsLayer = (source: Record<string, unknown> = {}) =>
  geojsonLayer({
    id: "wms",
    type: "wms",
    geojson: undefined,
    source: { type: "raster", url: "https://wms.example/service", layers: "dtm", ...source },
  });

const bytes = (text: string) => Array.from(new TextEncoder().encode(text));

describe("native WMS identify fetcher", () => {
  it("sends GetFeatureInfo through the installed fetcher, not the webview fetch", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    const urls: string[] = [];
    setWmsIdentifyFetcher(
      createNativeWmsIdentifyFetcher(async (url) => {
        urls.push(url);
        return bytes("@2 Pixel Value; NoData;");
      }),
    );
    const result = await fetchWmsIdentifyProperties(
      wmsLayer({ infoFormat: "text/plain" }),
      [17, 39.5],
      10,
      new AbortController().signal,
    );
    assert.deepEqual(result, { properties: { result: "@2 Pixel Value; NoData;" } });
    // The raw URL, never the dev-server proxy path.
    assert.equal(new URL(urls[0]).host, "wms.example");
    assert.equal(new URL(urls[0]).searchParams.get("REQUEST"), "GetFeatureInfo");
  });

  it("parses JSON without a content-type header", async () => {
    setWmsIdentifyFetcher(
      createNativeWmsIdentifyFetcher(async () =>
        Uint8Array.from(
          bytes(
            JSON.stringify({ type: "FeatureCollection", features: [{ properties: { v: 3 } }] }),
          ),
        ),
      ),
    );
    const result = await fetchWmsIdentifyProperties(
      wmsLayer({ infoFormat: "application/json" }),
      [0, 0],
      5,
      new AbortController().signal,
    );
    assert.deepEqual(result?.properties, { v: 3 });
  });

  for (const infoFormat of ["text/plain", "application/json"]) {
    it(`reads an HTML body as HTML when ${infoFormat} was requested`, async () => {
      setWmsIdentifyFetcher(
        createNativeWmsIdentifyFetcher(async () =>
          bytes("<!DOCTYPE html><html><body><p>Pixel  12</p></body></html>"),
        ),
      );
      const original = globalThis.DOMParser;
      globalThis.DOMParser = DOMParser as unknown as typeof globalThis.DOMParser;
      try {
        const result = await fetchWmsIdentifyProperties(
          wmsLayer({ infoFormat }),
          [0, 0],
          5,
          new AbortController().signal,
        );
        assert.deepEqual(result, { properties: { result: "Pixel 12" } });
      } finally {
        globalThis.DOMParser = original;
      }
    });
  }

  it("keeps probing after an unexpected HTML page", async () => {
    setWmsIdentifyFetcher(
      createNativeWmsIdentifyFetcher(async (url) => {
        const format = new URL(url).searchParams.get("INFO_FORMAT");
        if (format === "application/json") return bytes("<html><body>Server error</body></html>");
        return bytes(
          format === "text/plain"
            ? "value 7"
            : "<ServiceExceptionReport>no html</ServiceExceptionReport>",
        );
      }),
    );
    const original = globalThis.DOMParser;
    globalThis.DOMParser = DOMParser as unknown as typeof globalThis.DOMParser;
    try {
      const result = await fetchWmsIdentifyProperties(
        wmsLayer(),
        [0, 0],
        5,
        new AbortController().signal,
      );
      assert.deepEqual(result, { properties: { result: "value 7" } });
    } finally {
      globalThis.DOMParser = original;
    }
  });

  it("turns a native status error into a response and keeps probing formats", async () => {
    const formats: string[] = [];
    setWmsIdentifyFetcher(
      createNativeWmsIdentifyFetcher(async (url) => {
        const format = new URL(url).searchParams.get("INFO_FORMAT")!;
        formats.push(format);
        if (format !== "text/plain") throw "Request failed with status 400 Bad Request";
        return bytes("value 12");
      }),
    );
    const result = await fetchWmsIdentifyProperties(
      wmsLayer(),
      [0, 0],
      5,
      new AbortController().signal,
    );
    assert.deepEqual(formats, [
      "application/json",
      "application/geojson",
      "text/html",
      "text/plain",
    ]);
    assert.deepEqual(result, { properties: { result: "value 12" } });
  });

  it("reports the status when every format fails", async () => {
    const fetcher = createNativeWmsIdentifyFetcher(async () => {
      throw new Error("Request failed with status 404 Not Found");
    });
    const response = await fetcher("https://wms.example/x", new AbortController().signal);
    assert.equal(response.status, 404);
    setWmsIdentifyFetcher(fetcher);
    await assert.rejects(
      fetchWmsIdentifyProperties(
        wmsLayer({ infoFormat: "text/plain" }),
        [0, 0],
        5,
        new AbortController().signal,
      ),
      /^Error: WMS GetFeatureInfo failed: HTTP 404$/,
    );
  });

  it("rethrows transport errors", async () => {
    const fetcher = createNativeWmsIdentifyFetcher(async () => {
      throw "error sending request: dns error";
    });
    await assert.rejects(
      fetcher("https://wms.example/x", new AbortController().signal),
      /dns error/,
    );
  });

  it("rejects with an AbortError as soon as the signal aborts", async () => {
    let release: (value: number[]) => void = () => {};
    const fetcher = createNativeWmsIdentifyFetcher(
      () => new Promise<number[]>((resolve) => (release = resolve)),
    );
    const controller = new AbortController();
    const pending = fetcher("https://wms.example/x", controller.signal);
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    release([]);

    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(fetcher("https://wms.example/x", aborted.signal), {
      name: "AbortError",
    });
  });
});
