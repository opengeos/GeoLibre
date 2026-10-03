import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { redactConfigurationCredentials, type GeoLibreLayer } from "@geolibre/core";
import "./helpers/dom";
import { geojsonLayer } from "./helpers/layer-fixtures";

// Loaded after the harness so its CSS imports and Vite globals are handled.
const { layerMetadataPayload } =
  await import("../apps/geolibre-desktop/src/components/panels/layer-panel/layer-panel-utils");
const { buildWmsLayer } =
  await import("../apps/geolibre-desktop/src/components/layout/add-data/apply-service");
const { pluginLayerMetadata } =
  await import("../apps/geolibre-desktop/src/lib/plugin-layer-metadata");

function tileLayer(overrides: Partial<GeoLibreLayer>): GeoLibreLayer {
  return {
    ...geojsonLayer(),
    type: "xyz",
    geojson: undefined,
    source: { type: "raster", tiles: ["https://tiles.example.com/{z}/{x}/{y}.png"] },
    metadata: {},
    ...overrides,
  };
}

describe("layerMetadataPayload (#2855)", () => {
  it("shows a WMS layer's service address and request fields", () => {
    const layer = buildWmsLayer({
      name: "GEBCO",
      endpoint: "https://wms.gebco.net/mapserv?",
      layers: "GEBCO_LATEST",
      styles: "",
      format: "image/png",
      transparent: true,
      tileSize: "256",
      version: "1.3.0",
      crs: "EPSG:4326",
    });
    const payload = layerMetadataPayload(layer);
    const source = payload.source as Record<string, unknown>;
    assert.equal(payload.service, "wms");
    assert.equal(payload.layerType, "wms");
    assert.equal(source.url, "https://wms.gebco.net/mapserv");
    assert.equal(source.layers, "GEBCO_LATEST");
    assert.equal(source.version, "1.3.0");
    assert.equal(source.format, "image/png");
    assert.equal(source.crs, "EPSG:4326");
  });

  it("removes credentials from the source, sourcePath, and metadata", () => {
    const layer = tileLayer({
      type: "wms",
      sourcePath: "https://user:pw@example.com/wms?token=secret&map=a",
      source: {
        type: "raster",
        url: "https://example.com/wms?apikey=secret&map=a",
        tiles: ["https://example.com/wms?access_token=secret&BBOX={bbox-epsg-3857}"],
        requestHeaders: { Authorization: "Bearer abc", "X-Ref": "Bearer ${TOKEN}" },
        layers: "roads",
      },
      metadata: { catalogRecordId: "abc", token: "secret" },
    });
    const json = JSON.stringify(layerMetadataPayload(layer));
    assert.doesNotMatch(json, /secret|user:pw|Bearer abc/);
    const payload = layerMetadataPayload(layer);
    const source = payload.source as Record<string, unknown>;
    assert.equal(source.url, "https://example.com/wms?map=a");
    // Tile-template placeholders survive the redaction unencoded.
    assert.deepEqual(source.tiles, ["https://example.com/wms?BBOX={bbox-epsg-3857}"]);
    assert.deepEqual(source.requestHeaders, { "X-Ref": "Bearer ${TOKEN}" });
    assert.equal(payload.sourcePath, "https://example.com/wms?map=a");
    assert.equal(payload.catalogRecordId, "abc");
    assert.equal("token" in payload, false);
  });

  it("leaves out inlined data and the source of GeoJSON-like layers", () => {
    const zarr = tileLayer({
      type: "zarr",
      source: { type: "zarr", url: "https://example.com/a.zarr", kerchunkRefs: { a: 1 } },
    });
    assert.deepEqual(layerMetadataPayload(zarr).source, {
      type: "zarr",
      url: "https://example.com/a.zarr",
    });
    assert.equal("source" in layerMetadataPayload(geojsonLayer()), false);
  });

  it("does not mutate the layer", () => {
    const layer = tileLayer({ source: { type: "raster", url: "https://x.test/?token=s" } });
    layerMetadataPayload(layer);
    assert.equal(layer.source.url, "https://x.test/?token=s");
  });
});

describe("redactConfigurationCredentials", () => {
  it("drops credential fields and URL parameters without touching the input", () => {
    const input = { url: "https://x.test/a?map=1&token=2", apiKey: "k", nested: { password: "p" } };
    assert.deepEqual(redactConfigurationCredentials(input), {
      url: "https://x.test/a?map=1",
      nested: {},
    });
    assert.equal(input.apiKey, "k");
  });
});

describe("pluginLayerMetadata", () => {
  it("returns a JSON copy of a plain object", () => {
    const source = { id: "abc", nested: { url: "https://x.test" }, skip: undefined };
    const copy = pluginLayerMetadata("addWmsLayer", source);
    assert.deepEqual(copy, { id: "abc", nested: { url: "https://x.test" } });
    assert.notEqual(copy, source);
    assert.equal(pluginLayerMetadata("addWmsLayer", undefined), undefined);
    assert.equal(pluginLayerMetadata("addWmsLayer", null), undefined);
  });

  it("rejects non-plain or non-serializable values", () => {
    for (const value of ["text", 1, ["a"], new Date(), new Map()]) {
      assert.throws(() => pluginLayerMetadata("addTileLayer", value), /plain object/);
    }
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assert.throws(() => pluginLayerMetadata("addTileLayer", cyclic), /JSON-serializable/);
  });
});
