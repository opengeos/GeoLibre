import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import {
  calculateBoundsAlgorithm,
  countFeaturesAlgorithm,
  getAlgorithm,
  getVectorTool,
} from "@geolibre/processing";
import type { FeatureCollection } from "geojson";

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

  it("spatially joins zone attributes onto points", () => {
    const zone: GeoLibreLayer = {
      ...layer,
      id: "zone",
      name: "Zone",
      geojson: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { region: "north" },
            geometry: {
              type: "Polygon",
              coordinates: [
                [
                  [0, 0],
                  [0, 10],
                  [10, 10],
                  [10, 0],
                  [0, 0],
                ],
              ],
            },
          },
        ],
      },
    };
    const points: GeoLibreLayer = {
      ...layer,
      id: "points",
      name: "Points",
      geojson: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { name: "inside" },
            geometry: { type: "Point", coordinates: [5, 5] },
          },
          {
            type: "Feature",
            properties: { name: "outside" },
            geometry: { type: "Point", coordinates: [20, 20] },
          },
        ],
      },
    };

    const tool = getVectorTool("spatial-join");
    assert.ok(tool);

    // Inner join keeps only the point that falls inside the zone.
    let inner: FeatureCollection | null = null;
    tool.run({
      layers: [zone, points],
      parameters: { layer: "points", overlay: "zone", how: "inner" },
      log: () => {},
      addResultLayer: (_name, geojson) => {
        inner = geojson;
      },
    });
    assert.equal(inner!.features.length, 1);
    assert.equal(inner!.features[0].properties?.name, "inside");
    assert.equal(inner!.features[0].properties?.region, "north");

    // Left join keeps both points; the outside one gets no zone attribute.
    let left: FeatureCollection | null = null;
    tool.run({
      layers: [zone, points],
      parameters: { layer: "points", overlay: "zone", how: "left" },
      log: () => {},
      addResultLayer: (_name, geojson) => {
        left = geojson;
      },
    });
    assert.equal(left!.features.length, 2);
    const outside = left!.features.find(
      (f) => f.properties?.name === "outside",
    );
    assert.equal(outside?.properties?.region, undefined);
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
