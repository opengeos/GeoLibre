import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { useAppStore } from "@geolibre/core";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";
import { addArcGISLayer } from "../packages/plugins/src/plugins/arcgis-layer";

// Minimal ArcGIS FeatureServer layer metadata (the `?f=json` response) with a
// geographic extent so the bounds resolve without Web Mercator reprojection,
// and a copyrightText so the attribution propagation can be asserted.
const LAYER_INFO = {
  name: "USA Major Cities",
  geometryType: "esriGeometryPoint",
  copyrightText: "© Example City Data",
  extent: {
    xmin: -160,
    ymin: 18,
    xmax: -154,
    ymax: 23,
    spatialReference: { wkid: 4326 },
  },
};

// The `/query?f=geojson` response — features carry the attributes that the label
// field picker (and attribute table) read once the layer is a GeoJSON layer.
const QUERY_GEOJSON = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [-157.8, 21.3] },
      properties: { NAME: "Honolulu", POPULATION: 350000 },
    },
  ],
};

// addArcGISLayer reads layer metadata via `response.json()` and query results via
// `response.text()` (it guards against HTML before parsing), so a mock response
// must answer both. `raw` overrides the text body (for the HTML-page case).
function jsonResponse(body: unknown, raw?: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => raw ?? JSON.stringify(body),
  } as Response;
}

/** Routes the two ArcGIS requests by URL: the query endpoint returns GeoJSON. */
function makeArcGISFetch(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    return jsonResponse(url.includes("/query") ? QUERY_GEOJSON : LAYER_INFO);
  }) as typeof fetch;
}

describe("addArcGISLayer (feature layer)", () => {
  let fitBoundsCalls: Array<[number, number, number, number]>;
  let app: GeoLibreAppAPI;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    useAppStore.getState().newProject({ name: "ArcGIS" });
    useAppStore.temporal.getState().clear();
    fitBoundsCalls = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = makeArcGISFetch();
    app = {
      // The feature path never touches the map; only fitBounds is exercised.
      getMap: () => null,
      fitBounds: (bounds) => {
        fitBoundsCalls.push(bounds);
      },
    } as unknown as GeoLibreAppAPI;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("loads a feature layer as a GeoJSON layer with its attributes intact", async () => {
    const id = await addArcGISLayer(app, {
      layerType: "feature",
      sourceType: "url",
      url: "https://example.com/arcgis/rest/services/Cities/FeatureServer/0",
      name: "Cities",
    });

    const layer = useAppStore.getState().layers.find((l) => l.id === id);
    assert.ok(layer, "expected the feature layer to be added to the store");
    // A plain GeoJSON layer (not an opaque external-native "arcgis" layer) is
    // what unlocks labels, the attribute table, identify, and symbology.
    assert.equal(layer.type, "geojson");
    assert.notEqual(layer.metadata.externalNativeLayer, true);
    assert.equal(layer.geojson?.features.length, 1);
    // The attributes the label field picker reads must survive the round trip.
    assert.deepEqual(Object.keys(layer.geojson?.features[0]?.properties ?? {}), [
      "NAME",
      "POPULATION",
    ]);
    // The persisted source path is the GeoJSON query endpoint (so a refresh
    // re-fetches features), not the service-description base URL.
    assert.match(layer.sourcePath ?? "", /\/FeatureServer\/0\/query\?/);
    // The service copyright is carried into MapLibre's attribution control.
    assert.equal(layer.source.attribution, "© Example City Data");
    // The geographic extent is fitted directly (no Web Mercator conversion).
    assert.deepEqual(fitBoundsCalls, [[-160, 18, -154, 23]]);
  });

  it("never persists the access token in the refresh URL", async () => {
    const fetchUrls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      fetchUrls.push(url);
      return jsonResponse(url.includes("/query") ? QUERY_GEOJSON : LAYER_INFO);
    }) as typeof fetch;

    const id = await addArcGISLayer(app, {
      layerType: "feature",
      sourceType: "url",
      url: "https://example.com/arcgis/rest/services/Cities/FeatureServer/0",
      token: "secret-token-123",
    });

    const layer = useAppStore.getState().layers.find((l) => l.id === id);
    // The token reaches the live request but must not be saved to the project.
    assert.ok(
      fetchUrls.some((url) => url.includes("token=secret-token-123")),
      "expected the query request to carry the token",
    );
    assert.doesNotMatch(layer?.sourcePath ?? "", /token=/);
  });

  it("rejects a non-GeoJSON query response instead of adding an empty layer", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      return url.includes("/query")
        ? jsonResponse({ error: { message: "Token Required" } })
        : jsonResponse(LAYER_INFO);
    }) as typeof fetch;

    await assert.rejects(
      addArcGISLayer(app, {
        layerType: "feature",
        sourceType: "url",
        url: "https://example.com/arcgis/rest/services/Cities/FeatureServer/0",
      }),
      /Token Required/,
    );
    assert.equal(useAppStore.getState().layers.length, 0);
  });

  it("rejects an HTML login page returned with a 200 status", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      return url.includes("/query")
        ? jsonResponse(null, "<!DOCTYPE html><html><body>Sign in</body></html>")
        : jsonResponse(LAYER_INFO);
    }) as typeof fetch;

    await assert.rejects(
      addArcGISLayer(app, {
        layerType: "feature",
        sourceType: "url",
        url: "https://example.com/arcgis/rest/services/Cities/FeatureServer/0",
      }),
      /HTML instead of GeoJSON/,
    );
    assert.equal(useAppStore.getState().layers.length, 0);
  });

  it("warns but still loads when the query exceeds the service record limit", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      return url.includes("/query")
        ? jsonResponse({ ...QUERY_GEOJSON, exceededTransferLimit: true })
        : jsonResponse(LAYER_INFO);
    }) as typeof fetch;

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      const id = await addArcGISLayer(app, {
        layerType: "feature",
        sourceType: "url",
        url: "https://example.com/arcgis/rest/services/Cities/FeatureServer/0",
      });
      // The partial dataset still loads — truncation must not block the layer.
      const layer = useAppStore.getState().layers.find((l) => l.id === id);
      assert.equal(layer?.geojson?.features.length, 1);
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /truncated/i);
  });

  it("resolves a portal-item feature layer through the portal item URL", async () => {
    const serviceUrl = "https://example.com/arcgis/rest/services/Cities/FeatureServer/0";
    const fetchUrls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      fetchUrls.push(url);
      if (url.includes("/content/items/")) {
        return jsonResponse({ url: serviceUrl });
      }
      return jsonResponse(url.includes("/query") ? QUERY_GEOJSON : LAYER_INFO);
    }) as typeof fetch;

    const id = await addArcGISLayer(app, {
      layerType: "feature",
      sourceType: "portal-item",
      itemId: "abc123def456",
      name: "Cities",
    });

    const layer = useAppStore.getState().layers.find((l) => l.id === id);
    assert.ok(layer, "expected the portal-item feature layer to be added");
    assert.equal(layer.type, "geojson");
    assert.equal(layer.geojson?.features.length, 1);
    assert.deepEqual(fitBoundsCalls, [[-160, 18, -154, 23]]);
    // Assert the portal path was genuinely walked: the item metadata lookup and
    // a query against the resolved service URL both happened.
    assert.ok(
      fetchUrls.some((url) => url.includes("/content/items/abc123def456")),
      "expected portal item metadata to be fetched",
    );
    assert.ok(
      fetchUrls.some((url) => url.startsWith(`${serviceUrl}/query`)),
      "expected the resolved service URL to be queried",
    );
  });
});
