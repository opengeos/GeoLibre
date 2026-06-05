import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseDelimitedTextFields,
  parseDelimitedTextLayer,
} from "../apps/geolibre-desktop/src/lib/delimited-text";
import {
  MIN_REFRESH_INTERVAL_MS,
  createWfsGetFeatureUrl,
  getLayerRefreshConfig,
  isRefreshableLayer,
  setLayerRefreshConfig,
} from "../apps/geolibre-desktop/src/lib/layer-refresh";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";

function layer(patch: Partial<GeoLibreLayer> = {}): GeoLibreLayer {
  return {
    id: "layer-a",
    name: "Layer A",
    type: "geojson",
    source: { type: "geojson", url: "https://example.com/data.geojson" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
    geojson: { type: "FeatureCollection", features: [] },
    ...patch,
  };
}

describe("delimited text parsing", () => {
  it("handles quoted delimiters and duplicate field names", () => {
    const fields = parseDelimitedTextFields(
      'name,name,longitude,latitude\n"Raleigh, NC",capital,-78.638,35.779',
      ",",
    );

    assert.deepEqual(fields, ["name", "name_2", "longitude", "latitude"]);
  });

  it("creates point features and reports skipped coordinate rows", () => {
    const result = parseDelimitedTextLayer(
      [
        "name,longitude,latitude",
        "Valid,-78.638,35.779",
        "Bad longitude,200,35",
        "Bad latitude,-78,95",
      ].join("\n"),
      {
        delimiter: ",",
        longitudeField: "longitude",
        latitudeField: "latitude",
      },
    );

    assert.equal(result.totalRows, 3);
    assert.equal(result.skippedRows, 2);
    assert.equal(result.data.features.length, 1);
    assert.deepEqual(result.data.features[0].geometry.coordinates, [
      -78.638,
      35.779,
    ]);
  });

  it("rejects files with no valid coordinates", () => {
    assert.throws(
      () =>
        parseDelimitedTextLayer("lon,lat\nbad,also-bad", {
          delimiter: ",",
          longitudeField: "lon",
          latitudeField: "lat",
        }),
      /No rows contained valid longitude and latitude values/,
    );
  });
});

describe("layer refresh helpers", () => {
  it("builds WFS 2.x GetFeature URLs with count and typeNames", () => {
    const url = createWfsGetFeatureUrl({
      endpoint: "https://example.com/wfs?token=abc",
      typeName: "workspace:layer",
      version: "2.0.0",
      outputFormat: "application/json",
      srsName: "EPSG:4326",
      maxFeatures: "50",
    });

    assert.equal(
      url,
      "https://example.com/wfs?token=abc&service=WFS&request=GetFeature&version=2.0.0&typeNames=workspace%3Alayer&outputFormat=application%2Fjson&srsName=EPSG%3A4326&count=50",
    );
  });

  it("clamps persisted refresh intervals and omits disabled config", () => {
    const source = layer({
      metadata: { refresh: { enabled: true, intervalMs: 50 } },
    });

    assert.deepEqual(getLayerRefreshConfig(source), {
      enabled: true,
      intervalMs: MIN_REFRESH_INTERVAL_MS,
    });
    assert.deepEqual(
      setLayerRefreshConfig(source, { enabled: false, intervalMs: 0 }),
      { metadata: {} },
    );
  });

  it("only treats HTTP GeoJSON and WFS sources as refreshable", () => {
    assert.equal(isRefreshableLayer(layer()), true);
    assert.equal(
      isRefreshableLayer(
        layer({
          source: { type: "geojson", url: "/local/data.geojson" },
          sourcePath: "/local/data.geojson",
        }),
      ),
      false,
    );
    assert.equal(
      isRefreshableLayer(
        layer({
          metadata: { externalNativeLayer: true },
        }),
      ),
      false,
    );
  });
});
