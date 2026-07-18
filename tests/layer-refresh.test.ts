import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import {
  fetchWfsGeoJson,
  isRefreshableLayer,
  isVectorControlRefreshLayer,
  WFS_XML_RESPONSE_ERROR,
} from "../apps/geolibre-desktop/src/lib/layer-refresh";

function makeLayer(patch: Partial<GeoLibreLayer> = {}): GeoLibreLayer {
  return {
    id: "layer-1",
    name: "Test Layer",
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: DEFAULT_LAYER_STYLE,
    metadata: {},
    ...patch,
  };
}

describe("isVectorControlRefreshLayer / isRefreshableLayer", () => {
  it("treats a vector-control URL layer as refreshable", () => {
    const layer = makeLayer({
      type: "geojson",
      source: { type: "geojson", url: "https://x.com/a.geojson" },
      metadata: {
        sourceKind: "maplibre-gl-vector",
        externalNativeLayer: true,
      },
    });

    assert.equal(isVectorControlRefreshLayer(layer), true);
    assert.equal(isRefreshableLayer(layer), true);
  });

  it("does not treat a file-backed vector-control layer (no url) as a vector-control refresh layer", () => {
    const layer = makeLayer({
      type: "geojson",
      source: { type: "geojson" },
      metadata: {
        sourceKind: "maplibre-gl-vector",
        externalNativeLayer: true,
      },
    });

    assert.equal(isVectorControlRefreshLayer(layer), false);
    assert.equal(isRefreshableLayer(layer), false);
  });

  it("does not treat a vector-control layer without the externalNativeLayer flag as refreshable", () => {
    const layer = makeLayer({
      type: "geojson",
      source: { type: "geojson", url: "https://x.com/a.geojson" },
      metadata: {
        sourceKind: "maplibre-gl-vector",
        // externalNativeLayer intentionally absent — exercises the three-way AND
      },
    });

    assert.equal(isVectorControlRefreshLayer(layer), false);
    assert.equal(isRefreshableLayer(layer), false);
  });

  it("treats a vector-control layer whose URL comes from sourcePath as refreshable", () => {
    const layer = makeLayer({
      type: "geojson",
      source: { type: "geojson" },
      sourcePath: "https://x.com/a.geojson",
      metadata: {
        sourceKind: "maplibre-gl-vector",
        externalNativeLayer: true,
      },
    });

    assert.equal(isVectorControlRefreshLayer(layer), true);
    assert.equal(isRefreshableLayer(layer), true);
  });

  it("treats a tiles-mode (vector-tiles) vector-control layer as refreshable", () => {
    const layer = makeLayer({
      type: "vector-tiles",
      source: { type: "vector", url: "https://x.com/a.pmtiles" },
      metadata: {
        sourceKind: "maplibre-gl-vector",
        externalNativeLayer: true,
      },
    });

    assert.equal(isVectorControlRefreshLayer(layer), true);
    assert.equal(isRefreshableLayer(layer), true);
  });

  it("does not treat a plain store layer as a vector-control refresh layer", () => {
    const layer = makeLayer({
      type: "geojson",
      source: { type: "geojson", url: "https://x.com/a.geojson" },
      metadata: { sourceKind: "geojson-url" },
    });

    assert.equal(isVectorControlRefreshLayer(layer), false);
  });

  it("still treats a WFS layer as refreshable (refactor regression guard)", () => {
    const layer = makeLayer({
      type: "geojson",
      source: { type: "geojson", url: "https://x.com/wfs?service=WFS" },
      metadata: { sourceKind: "wfs-getfeature" },
    });

    assert.equal(isRefreshableLayer(layer), true);
  });

  it("legacy untagged geojson-url layer is refreshable via the store path", () => {
    const layer = makeLayer({
      type: "geojson",
      source: { type: "geojson", url: "https://example.com/data.geojson" },
      metadata: {},
    });

    assert.equal(isRefreshableLayer(layer), true);
    assert.equal(isVectorControlRefreshLayer(layer), false);
  });

  it("treats a URL-backed GeoRSS layer as refreshable", () => {
    const layer = makeLayer({
      type: "geojson",
      source: { type: "geojson", url: "https://example.com/feed.atom" },
      sourcePath: "https://example.com/feed.atom",
      metadata: { sourceKind: "georss" },
    });

    assert.equal(isRefreshableLayer(layer), true);
  });

  it("does not refresh a GeoRSS layer loaded from a local file", () => {
    const layer = makeLayer({
      type: "geojson",
      source: { type: "geojson", url: "/home/user/feed.xml" },
      sourcePath: "/home/user/feed.xml",
      metadata: { sourceKind: "georss" },
    });

    assert.equal(isRefreshableLayer(layer), false);
  });
});

describe("fetchWfsGeoJson output-format fallback", () => {
  const originalFetch = globalThis.fetch;
  const FEATURE_COLLECTION = {
    type: "FeatureCollection",
    features: [{ type: "Feature", geometry: null, properties: { name: "x" } }],
  };

  const baseParams = {
    endpoint: "https://geo.example.com/WFSServer",
    typeName: "ANM:Area",
    version: "2.0.0",
    outputFormat: "application/json",
    srsName: "EPSG:4326",
    maxFeatures: "1000",
  };

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("uses the requested format when the server honors it (no retries)", async () => {
    const requestedFormats: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      requestedFormats.push(new URL(url).searchParams.get("outputFormat") ?? "");
      return new Response(JSON.stringify(FEATURE_COLLECTION), { status: 200 });
    }) as typeof fetch;

    const result = await fetchWfsGeoJson(baseParams);
    assert.equal(result.outputFormat, "application/json");
    assert.equal(result.data.features.length, 1);
    assert.deepEqual(requestedFormats, ["application/json"]);
    assert.match(result.url, /outputFormat=application%2Fjson/);
  });

  it("retries with an alternate GeoJSON token when the requested one returns XML", async () => {
    const requestedFormats: string[] = [];
    // Emulate an ArcGIS WFS: it answers "application/json" with a GML
    // ExceptionReport (XML) but returns GeoJSON for the "GEOJSON" token.
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const format = new URL(url).searchParams.get("outputFormat") ?? "";
      requestedFormats.push(format);
      if (format === "GEOJSON") {
        return new Response(JSON.stringify(FEATURE_COLLECTION), { status: 200 });
      }
      return new Response("<ExceptionReport>bad format</ExceptionReport>", {
        status: 200,
      });
    }) as typeof fetch;

    const result = await fetchWfsGeoJson(baseParams);
    assert.equal(result.outputFormat, "GEOJSON");
    assert.equal(result.data.features.length, 1);
    // The requested format is tried first, then the ArcGIS "GEOJSON" alias.
    assert.deepEqual(requestedFormats, ["application/json", "GEOJSON"]);
    assert.match(result.url, /outputFormat=GEOJSON/);
  });

  it("does not re-request the requested token as an alias", async () => {
    const requestedFormats: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      requestedFormats.push(new URL(url).searchParams.get("outputFormat") ?? "");
      const format = new URL(url).searchParams.get("outputFormat") ?? "";
      // Only the second alias ("json") yields GeoJSON here.
      return format === "json"
        ? new Response(JSON.stringify(FEATURE_COLLECTION), { status: 200 })
        : new Response("<ExceptionReport/>", { status: 200 });
    }) as typeof fetch;

    // Request "GEOJSON" (uppercase): it must not be tried twice even though it
    // is also in the alias list.
    const result = await fetchWfsGeoJson({
      ...baseParams,
      outputFormat: "GEOJSON",
    });
    assert.equal(result.outputFormat, "json");
    assert.equal(
      requestedFormats.filter((f) => f === "GEOJSON").length,
      1,
      "the requested GEOJSON token should be requested exactly once",
    );
  });

  it("throws the XML error when no format yields GeoJSON", async () => {
    globalThis.fetch = (async () =>
      new Response("<ExceptionReport/>", { status: 200 })) as typeof fetch;

    await assert.rejects(fetchWfsGeoJson(baseParams), (error: Error) => {
      assert.equal(error.message, WFS_XML_RESPONSE_ERROR);
      return true;
    });
  });

  it("does not retry on a non-XML failure (bad JSON body)", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("not json at all", { status: 200 });
    }) as typeof fetch;

    await assert.rejects(fetchWfsGeoJson(baseParams));
    assert.equal(calls, 1, "a non-XML parse error must not trigger a retry");
  });

  it("does not retry when the body is an HTML error page (proxy/WAF)", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      // A corporate proxy / WAF / auth page starts with "<" but is not a WFS
      // format rejection, so trying other output formats is pointless.
      return new Response("<!DOCTYPE html><html><body>Blocked</body></html>", {
        status: 200,
      });
    }) as typeof fetch;

    await assert.rejects(fetchWfsGeoJson(baseParams), (error: Error) => {
      assert.equal(error.message, WFS_XML_RESPONSE_ERROR);
      return true;
    });
    assert.equal(calls, 1, "an HTML error page must not trigger format retries");
  });

  it("detects HTML that starts with a prolog/comment before <html> (no retry)", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      // Leading XML prolog + comment before the real HTML — the narrow
      // start-anchored check would miss this; the head sniff catches it.
      return new Response(
        '<?xml version="1.0"?><!-- WAF --><html><head><title>Blocked</title></head></html>',
        { status: 200 },
      );
    }) as typeof fetch;

    await assert.rejects(fetchWfsGeoJson(baseParams));
    assert.equal(calls, 1, "prolog-prefixed HTML must not trigger retries");
  });

  it("detects HTML via a text/html content type even without HTML tags", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("<blocked>proxy denied</blocked>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }) as typeof fetch;

    await assert.rejects(fetchWfsGeoJson(baseParams));
    assert.equal(calls, 1, "a text/html response must not trigger retries");
  });

  it("still retries a real OWS ExceptionReport (not misread as HTML)", async () => {
    const formats: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const format = new URL(url).searchParams.get("outputFormat") ?? "";
      formats.push(format);
      if (format === "GEOJSON") {
        return new Response(JSON.stringify(FEATURE_COLLECTION), { status: 200 });
      }
      return new Response(
        '<?xml version="1.0"?><ows:ExceptionReport><ows:Exception/></ows:ExceptionReport>',
        { status: 200, headers: { "content-type": "application/xml" } },
      );
    }) as typeof fetch;

    const result = await fetchWfsGeoJson(baseParams);
    assert.equal(result.outputFormat, "GEOJSON");
    assert.deepEqual(formats, ["application/json", "GEOJSON"]);
  });

  it("skips an empty requested format instead of requesting outputFormat=", async () => {
    const requestedFormats: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      requestedFormats.push(new URL(url).searchParams.get("outputFormat") ?? "");
      return new Response(JSON.stringify(FEATURE_COLLECTION), { status: 200 });
    }) as typeof fetch;

    const result = await fetchWfsGeoJson({ ...baseParams, outputFormat: "" });
    // The first (and only) request uses the first GeoJSON alias, never "".
    assert.equal(requestedFormats[0], "application/json");
    assert.ok(!requestedFormats.includes(""), "no empty outputFormat request");
    assert.equal(result.data.features.length, 1);
  });
});
