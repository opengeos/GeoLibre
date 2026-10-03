import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { useAppStore } from "@geolibre/core";
import type { Point } from "geojson";
import { DOMParser } from "linkedom";
import { addPluginWfsLayer } from "../apps/geolibre-desktop/src/lib/plugin-wfs-layer";

globalThis.DOMParser = DOMParser as unknown as typeof globalThis.DOMParser;
const originalFetch = globalThis.fetch;
const JSON_FEATURES = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      id: "f1",
      properties: { label: "loaded" },
      geometry: { type: "Point", coordinates: [11, 41] },
    },
  ],
};
const GML = `<?xml version="1.0"?><wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:ms="urn:ms"><wfs:member><ms:Feature><ms:geom><gml:Point srsName="urn:ogc:def:crs:EPSG::4326"><gml:pos>41 11</gml:pos></gml:Point></ms:geom><ms:label>projected</ms:label></ms:Feature></wfs:member></wfs:FeatureCollection>`;
const EXCEPTION = `<?xml version="1.0"?><ows:ExceptionReport xmlns:ows="http://www.opengis.net/ows/1.1"/>`;

beforeEach(() => useAppStore.getState().newProject({ name: "Plugin WFS test" }));
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("addPluginWfsLayer", () => {
  it("adds the fetched WFS collection as an editable, refreshable store layer", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify(JSON_FEATURES))) as typeof fetch;
    const id = await addPluginWfsLayer("Plugin features", {
      url: " https://8.8.8.8/wfs?token=secret&request=GetCapabilities&bbox=bad#view ",
      typeName: " ns:roads ",
      bbox: [10, 40, 12, 42],
    });
    const layer = useAppStore.getState().layers.find((candidate) => candidate.id === id);
    assert.ok(layer);
    assert.equal(layer.type, "geojson");
    assert.equal(layer.geojson?.features[0].properties?.label, "loaded");
    assert.deepEqual((layer.geojson?.features[0].geometry as Point).coordinates, [11, 41]);
    assert.equal(layer.metadata.sourceKind, "wfs-getfeature");
    const request = new URL(layer.source.url!);
    assert.equal(request.hash, "", "a fragment would hide the GetFeature parameters");
    assert.equal(request.searchParams.get("token"), "secret");
    assert.equal(request.searchParams.get("request"), "GetFeature");
    assert.equal(request.searchParams.get("bbox"), "40,10,42,12,urn:ogc:def:crs:EPSG::4326");
    assert.equal(request.searchParams.get("count"), "1000");
    assert.equal(request.searchParams.get("typeNames"), "ns:roads");
  });

  it("merges plugin metadata under GeoLibre's own keys (#2855)", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify(JSON_FEATURES))) as typeof fetch;
    const id = await addPluginWfsLayer("Catalogued", {
      url: "https://8.8.8.8/wfs",
      typeName: "ns:roads",
      metadata: { catalogRecordId: "rndt:1", sourceKind: "spoofed" },
    });
    const layer = useAppStore.getState().layers.find((candidate) => candidate.id === id)!;
    assert.equal(layer.metadata.catalogRecordId, "rndt:1");
    assert.equal(layer.metadata.sourceKind, "wfs-getfeature");
    await assert.rejects(
      addPluginWfsLayer("bad", {
        url: "https://8.8.8.8/wfs",
        typeName: "ns:roads",
        metadata: "nope" as never,
      }),
      /options.metadata must be a plain object/,
    );
  });

  it("uses the shared GML fallback and reprojection parser", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      return url.searchParams.get("outputFormat")?.includes("gml")
        ? new Response(GML, { headers: { "content-type": "application/gml+xml" } })
        : new Response(EXCEPTION, { status: 400, headers: { "content-type": "text/xml" } });
    }) as typeof fetch;
    const id = await addPluginWfsLayer("GML", {
      url: "https://8.8.8.8/wfs",
      typeName: "ms:Feature",
    });
    const layer = useAppStore.getState().layers.find((candidate) => candidate.id === id)!;
    assert.deepEqual((layer.geojson?.features[0].geometry as Point).coordinates, [11, 41]);
    assert.equal(layer.geojson?.features[0].properties?.label, "projected");
    assert.match(layer.source.url!, /outputFormat=application%2Fgml/);
  });

  it("rejects invalid inputs and empty results without adding a layer", async () => {
    for (const [options, message] of [
      [{ url: "", typeName: "x" }, /options.url must be a non-empty string/],
      [{ url: "file:///x", typeName: "x" }, /absolute HTTP\(S\) URL/],
      [{ url: "https://8.8.8.8", typeName: " " }, /options.typeName must be a non-empty string/],
      [{ url: "https://8.8.8.8", typeName: "x", bbox: [10, 40, 12, 91] }, /options.bbox/],
    ] as const) {
      await assert.rejects(addPluginWfsLayer("invalid", options as never), message);
    }
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ type: "FeatureCollection", features: [] }))) as typeof fetch;
    await assert.rejects(
      addPluginWfsLayer("empty", { url: "https://8.8.8.8", typeName: "x" }),
      /service returned no features/,
    );
    globalThis.fetch = (async () => new Response("unavailable", { status: 503 })) as typeof fetch;
    await assert.rejects(
      addPluginWfsLayer("failed", { url: "https://8.8.8.8", typeName: "x" }),
      /status 503/,
    );
    assert.equal(useAppStore.getState().layers.length, 0);
  });

  it("rejects a fetch result if the project changed while it was loading", async () => {
    let resolveResponse!: (response: Response) => void;
    let notifyFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      notifyFetchStarted = resolve;
    });
    const response = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    globalThis.fetch = (async () => {
      notifyFetchStarted();
      return response;
    }) as typeof fetch;

    const pendingLayer = addPluginWfsLayer("stale", {
      url: "https://8.8.8.8/wfs",
      typeName: "roads",
    });
    await fetchStarted;
    useAppStore.getState().newProject({ name: "Replacement project" });
    resolveResponse(new Response(JSON.stringify(JSON_FEATURES)));

    await assert.rejects(pendingLayer, /project changed while the layer was loading/);
    assert.equal(useAppStore.getState().layers.length, 0);
  });
});
