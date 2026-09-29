import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Point } from "geojson";
import { DOMParser } from "linkedom";

// Desktop runtime: WFS GetFeature goes through the native fetch_url_response
// command, which bypasses CORS and keeps the body of a non-2xx answer.
interface NativeCall {
  cmd: string;
  url: string;
}
const calls: NativeCall[] = [];
let answer: (url: string) => {
  status: number;
  content_type: string | null;
  body: string;
} = () => ({ status: 200, content_type: "application/json", body: "{}" });

(globalThis as { window?: unknown }).window = {
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  __TAURI_INTERNALS__: {
    invoke: async (cmd: string, args: { url: string }) => {
      calls.push({ cmd, url: args.url });
      const { status, content_type, body } = answer(args.url);
      // Tauri serializes Vec<u8> as a plain number array.
      return { status, content_type, body: Array.from(new TextEncoder().encode(body)) };
    },
  },
  dispatchEvent: () => true,
  addEventListener: () => {},
};
globalThis.DOMParser = DOMParser as unknown as typeof globalThis.DOMParser;

const { fetchWfsGeoJson } = await import("../apps/geolibre-desktop/src/lib/layer-refresh");

const GML = `<?xml version="1.0" encoding="UTF-8"?>
<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:ms="urn:ms">
  <wfs:member><ms:Reda>
    <ms:geom><gml:Point srsName="urn:ogc:def:crs:EPSG::4326"><gml:pos>54.44 14.11</gml:pos></gml:Point></ms:geom>
    <ms:NAME>Świnoujście</ms:NAME>
  </ms:Reda></wfs:member>
</wfs:FeatureCollection>`;
const EXCEPTION = `<?xml version="1.0"?><ows:ExceptionReport xmlns:ows="http://www.opengis.net/ows/1.1"/>`;

describe("WFS GetFeature on desktop", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    calls.length = 0;
  });

  it("fetches natively and reads a 400 ExceptionReport to reach the GML fallback", async () => {
    globalThis.fetch = (async () => {
      throw new Error("the webview fetch must not be used for a WFS request on desktop");
    }) as typeof fetch;
    answer = (url) =>
      new URL(url).searchParams.get("outputFormat")?.includes("gml")
        ? { status: 200, content_type: "application/gml+xml; version=3.2", body: GML }
        : { status: 400, content_type: "text/xml", body: EXCEPTION };

    const result = await fetchWfsGeoJson(
      {
        endpoint: "https://mapy.example.pl/wfs",
        typeName: "ms:Reda",
        version: "2.0.0",
        outputFormat: "application/json",
        srsName: "EPSG:4326",
        maxFeatures: "10",
      },
      { useWfsProxy: true },
    );

    assert.ok(calls.every((call) => call.cmd === "fetch_url_response"));
    assert.equal(result.outputFormat, "application/gml+xml; version=3.2");
    const [feature] = result.data.features;
    assert.deepEqual((feature.geometry as Point).coordinates, [14.11, 54.44]);
    assert.equal(feature.properties?.NAME, "Świnoujście");
  });

  it("retries a request once when the connection drops", async () => {
    let gmlAttempts = 0;
    answer = (url) => {
      if (!new URL(url).searchParams.get("outputFormat")?.includes("gml")) {
        return { status: 400, content_type: "text/xml", body: EXCEPTION };
      }
      gmlAttempts += 1;
      if (gmlAttempts === 1) {
        throw new Error(
          "Request failed: error sending request for url (https://mapy.example.pl/wfs)",
        );
      }
      return { status: 200, content_type: "application/gml+xml", body: GML };
    };
    const result = await fetchWfsGeoJson(
      {
        endpoint: "https://mapy.example.pl/wfs",
        typeName: "ms:Reda",
        version: "2.0.0",
        outputFormat: "application/json",
        srsName: "EPSG:4326",
      },
      { useWfsProxy: true },
    );
    assert.equal(gmlAttempts, 2);
    assert.equal(result.data.features.length, 1);
  });

  it("fails at once on a client error, and retries a gateway error only once", async () => {
    const params = {
      endpoint: "https://mapy.example.pl/wfs",
      typeName: "ms:Reda",
      version: "2.0.0",
      outputFormat: "application/json",
      srsName: "EPSG:4326",
    };
    answer = () => ({ status: 404, content_type: "text/plain", body: "missing" });
    await assert.rejects(fetchWfsGeoJson(params, { useWfsProxy: true }), /status 404/);
    assert.equal(calls.length, 1);

    calls.length = 0;
    answer = () => ({ status: 503, content_type: "text/plain", body: "busy" });
    await assert.rejects(fetchWfsGeoJson(params, { useWfsProxy: true }), /status 503/);
    assert.equal(calls.length, 2);
  });
});
