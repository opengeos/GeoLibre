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

  it("spatial join drops feature ids, validates inputs, and handles empty join layers", () => {
    const tool = getVectorTool("spatial-join");
    assert.ok(tool);

    // Two overlapping zones so a single input point matches both (one-to-many).
    const zoneFeature = (region: string) => ({
      type: "Feature" as const,
      properties: { region },
      geometry: {
        type: "Polygon" as const,
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
    });
    const zones: GeoLibreLayer = {
      ...layer,
      id: "zones",
      name: "Zones",
      geojson: {
        type: "FeatureCollection",
        features: [zoneFeature("north"), zoneFeature("south")],
      },
    };
    // Input point carries an `id`; a one-to-many join must not duplicate it.
    const pts: GeoLibreLayer = {
      ...layer,
      id: "pts",
      name: "Pts",
      geojson: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            id: "p1",
            properties: { name: "pt" },
            geometry: { type: "Point", coordinates: [5, 5] },
          },
        ],
      },
    };

    let res: FeatureCollection | null = null;
    tool.run({
      layers: [zones, pts],
      parameters: { layer: "pts", overlay: "zones", how: "inner" },
      log: () => {},
      addResultLayer: (_n, g) => {
        res = g;
      },
    });
    assert.equal(res!.features.length, 2);
    assert.ok(res!.features.every((f) => f.id === undefined));

    // Empty join layer: left keeps the input, inner returns nothing.
    const emptyJoin: GeoLibreLayer = {
      ...layer,
      id: "empty",
      name: "Empty",
      geojson: { type: "FeatureCollection", features: [] },
    };
    let leftEmpty: FeatureCollection | null = null;
    tool.run({
      layers: [pts, emptyJoin],
      parameters: { layer: "pts", overlay: "empty", how: "left" },
      log: () => {},
      addResultLayer: (_n, g) => {
        leftEmpty = g;
      },
    });
    assert.equal(leftEmpty!.features.length, 1);

    let innerEmpty: FeatureCollection | null = null;
    tool.run({
      layers: [pts, emptyJoin],
      parameters: { layer: "pts", overlay: "empty", how: "inner" },
      log: () => {},
      addResultLayer: (_n, g) => {
        innerEmpty = g;
      },
    });
    assert.equal(innerEmpty!.features.length, 0);

    // Unknown predicate is rejected (no result layer), mirroring the backend.
    let produced = false;
    const logs: string[] = [];
    tool.run({
      layers: [zones, pts],
      parameters: { layer: "pts", overlay: "zones", predicate: "bogus" },
      log: (m) => logs.push(m),
      addResultLayer: () => {
        produced = true;
      },
    });
    assert.equal(produced, false);
    assert.ok(logs.some((m) => m.includes("unknown predicate")));
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
