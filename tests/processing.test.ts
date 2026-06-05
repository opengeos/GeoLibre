import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import {
  calculateBoundsAlgorithm,
  countFeaturesAlgorithm,
  getAlgorithm,
} from "@geolibre/processing";

const layer: GeoLibreLayer = {
  id: "layer-a",
  name: "Layer A",
  type: "geojson",
  source: { type: "geojson" },
  visible: true,
  opacity: 1,
  style: { ...DEFAULT_LAYER_STYLE },
  metadata: {},
  geojson: {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { name: "A" },
        geometry: { type: "Point", coordinates: [-78, 35] },
      },
      {
        type: "Feature",
        properties: { name: "B" },
        geometry: { type: "Point", coordinates: [-77, 36] },
      },
    ],
  },
};

describe("processing registry", () => {
  it("finds registered algorithms by id", () => {
    assert.equal(getAlgorithm("count-features"), countFeaturesAlgorithm);
    assert.equal(getAlgorithm("missing"), undefined);
  });

  it("counts GeoJSON features", () => {
    const messages: string[] = [];
    countFeaturesAlgorithm.run({
      layers: [layer],
      parameters: { layer: "layer-a" },
      log: (message) => messages.push(message),
    });

    assert.deepEqual(messages, ["Feature count: 2"]);
  });

  it("calculates and fits layer bounds", () => {
    const messages: string[] = [];
    let fittedBounds: [number, number, number, number] | null = null;

    calculateBoundsAlgorithm.run({
      layers: [layer],
      parameters: { layer: "layer-a" },
      log: (message) => messages.push(message),
      fitBounds: (bounds) => {
        fittedBounds = bounds;
      },
    });

    assert.deepEqual(messages, ["Bounds: [-78.000000, 35.000000, -77.000000, 36.000000]"]);
    assert.deepEqual(fittedBounds, [-78, 35, -77, 36]);
  });
});
