import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GeoLibreLayer } from "@geolibre/core";
import { getLayerBounds } from "../packages/map/src/geojson-loader";

function layerWith(features: GeoLibreLayer["geojson"]): GeoLibreLayer {
  return {
    id: "layer-1",
    name: "Test",
    type: "geojson",
    visible: true,
    opacity: 1,
    source: { type: "geojson", url: "" },
    metadata: {},
    geojson: features,
  } as unknown as GeoLibreLayer;
}

describe("getLayerBounds", () => {
  it("returns the bbox for features with real geometry", () => {
    const bounds = getLayerBounds(
      layerWith({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [-78.638, 35.779] },
            properties: {},
          },
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [-70, 40] },
            properties: {},
          },
        ],
      }),
    );

    assert.deepEqual(bounds, [-78.638, 35.779, -70, 40]);
  });

  it("returns null for a table layer whose features all have null geometry", () => {
    const bounds = getLayerBounds(
      layerWith({
        type: "FeatureCollection",
        features: [
          { type: "Feature", geometry: null, properties: { code: "AVH" } },
          { type: "Feature", geometry: null, properties: { code: "BDP" } },
        ],
      }),
    );

    assert.equal(bounds, null);
  });

  it("returns null when there is no geojson", () => {
    assert.equal(getLayerBounds(layerWith(undefined)), null);
  });

  it("uses stored source bounds for a non-GeoJSON layer", () => {
    const layer = layerWith(undefined);
    layer.type = "raster";
    layer.source = { type: "raster", bounds: [-80, 30, -70, 40] };
    assert.deepEqual(getLayerBounds(layer), [-80, 30, -70, 40]);
  });

  it("falls back to metadata bounds when source bounds are invalid", () => {
    const layer = layerWith(undefined);
    layer.source.bounds = [-80, Number.NaN, -70, 40];
    layer.metadata.bounds = [-10, -5, 10, 5];
    assert.deepEqual(getLayerBounds(layer), [-10, -5, 10, 5]);
  });
});
