import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { useAppStore } from "@geolibre/core";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";
import { addArcGISLayer } from "../packages/plugins/src/plugins/arcgis-layer";

// Minimal ArcGIS FeatureServer layer metadata (the `?f=json` response) with a
// geographic extent so the bounds resolve without Web Mercator reprojection.
const LAYER_INFO = {
  name: "USA Major Cities",
  geometryType: "esriGeometryPoint",
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

/** Routes the two ArcGIS requests by URL: the query endpoint returns GeoJSON. */
function makeArcGISFetch(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = url.includes("/query") ? QUERY_GEOJSON : LAYER_INFO;
    return {
      ok: true,
      status: 200,
      json: async () => body,
    } as Response;
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
    // The geographic extent is fitted directly (no Web Mercator conversion).
    assert.deepEqual(fitBoundsCalls, [[-160, 18, -154, 23]]);
  });

  it("rejects a non-GeoJSON query response instead of adding an empty layer", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const body = url.includes("/query")
        ? { error: { message: "Token Required" } }
        : LAYER_INFO;
      return { ok: true, status: 200, json: async () => body } as Response;
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
});
