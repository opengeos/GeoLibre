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
});
