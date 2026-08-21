import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import { getVectorTool } from "@geolibre/processing";
import distance from "@turf/distance";
import type { FeatureCollection, Point } from "geojson";

function makeLayer(id: string, name: string, fc: FeatureCollection): GeoLibreLayer {
  return {
    id,
    name,
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
    geojson: fc,
  };
}

function runTool(
  toolId: string,
  layers: GeoLibreLayer[],
  parameters: Record<string, unknown>,
): { messages: string[]; results: FeatureCollection<Point>[] } {
  const tool = getVectorTool(toolId);
  assert.ok(tool, `${toolId} is registered`);
  const messages: string[] = [];
  const results: FeatureCollection<Point>[] = [];
  tool.run({
    layers,
    parameters,
    log: (message) => messages.push(message),
    addResultLayer: (_name, fc) => results.push(fc as FeatureCollection<Point>),
  });
  return { messages, results };
}

describe("extract vertices tool", () => {
  const line = makeLayer("line", "Line", {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { kind: "road" },
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [1, 1],
            [2, 0],
          ],
        },
      },
    ],
  });

  it("turns every vertex into a point with vertex/part indices and original attributes", () => {
    const { messages, results } = runTool("extract-vertices", [line], { layer: "line" });
    assert.equal(results.length, 1);
    const fc = results[0];
    assert.equal(fc.features.length, 3);
    assert.deepEqual(
      fc.features.map((f) => f.geometry.coordinates),
      [
        [0, 0],
        [1, 1],
        [2, 0],
      ],
    );
    assert.ok(fc.features.every((f) => f.properties?.kind === "road"));
    assert.deepEqual(
      fc.features.map((f) => f.properties?.vertex_index),
      [0, 1, 2],
    );
    assert.ok(fc.features.every((f) => f.properties?.part_index === 0));
    assert.ok(messages.some((m) => m.includes("Extracted 3 vertex point(s)")));
  });

  it("indexes polygon rings as separate parts", () => {
    const polygon = makeLayer("poly", "Poly", {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: null,
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [0, 0],
                [0, 1],
                [1, 1],
                [0, 0],
              ],
              [
                [0.2, 0.2],
                [0.2, 0.4],
                [0.4, 0.4],
                [0.2, 0.2],
              ],
            ],
          },
        },
      ],
    });
    const { results } = runTool("extract-vertices", [polygon], { layer: "poly" });
    // Outer ring (4 vertices) + hole (4 vertices).
    assert.equal(results[0].features.length, 8);
    assert.equal(results[0].features.filter((f) => f.properties?.part_index === 1).length, 4);
  });

  it("skips geometry-less features and errors on an empty result", () => {
    const mixed = makeLayer("mixed", "Mixed", {
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: {}, geometry: null }, ...line.geojson.features],
    });
    const skipped = runTool("extract-vertices", [mixed], { layer: "mixed" });
    assert.ok(skipped.messages.some((m) => m.includes("Skipped 1")));
    assert.equal(skipped.results[0].features.length, 3);

    const empty = makeLayer("empty", "Empty", {
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: {}, geometry: null }],
    });
    const failed = runTool("extract-vertices", [empty], { layer: "empty" });
    assert.equal(failed.results.length, 0);
    assert.ok(failed.messages.some((m) => m.startsWith("Error:")));
  });
});

describe("points along geometry tool", () => {
  // ~111 km per degree of longitude at the equator.
  const line = makeLayer("line", "Line", {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { id: "L1" },
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [3, 0],
          ],
        },
      },
    ],
  });

  it("places points at the interval plus the endpoint, carrying distance and attributes", () => {
    const { messages, results } = runTool("points-along-geometry", [line], {
      layer: "line",
      interval: 100,
      units: "kilometers",
    });
    assert.equal(results.length, 1);
    const fc = results[0];
    // ~333 km line at a 100 km interval → interior points at 0/100/200/300 km
    // plus the endpoint (the interval never lands exactly on it).
    const total = distance([0, 0], [3, 0], { units: "kilometers" });
    assert.ok(total > 300 && total < 400, `unexpected line length ${total}`);
    assert.equal(fc.features.length, 5);
    const distances = fc.features.map((f) => f.properties?.distance as number);
    assert.equal(distances[0], 0);
    assert.ok(Math.abs(distances[1] - 100) < 0.01);
    assert.ok(Math.abs(distances[2] - 200) < 0.01);
    assert.ok(Math.abs(distances[3] - 300) < 0.01);
    assert.ok(Math.abs(distances[4] - total) < 0.01);
    // x advances monotonically toward the end vertex.
    assert.deepEqual(
      fc.features.map((f) => Math.round(f.geometry.coordinates[0] * 1e6) / 1e6),
      [...distances.map((d) => Math.round((d / total) * 3 * 1e6) / 1e6), 3].slice(0, 5),
    );
    assert.ok(fc.features.every((f) => f.properties?.id === "L1"));
    assert.ok(messages.some((m) => m.includes("Generated 5 point(s) every 100 kilometers")));
  });

  it("does not duplicate the endpoint when the length is an exact multiple", () => {
    // Length is whatever turf says; a half-length interval must land exactly on
    // the endpoint once, without producing a duplicate final point.
    const total = distance([0, 0], [3, 0], { units: "kilometers" });
    const { results } = runTool("points-along-geometry", [line], {
      layer: "line",
      interval: Number((total / 2).toFixed(9)),
      units: "kilometers",
    });
    assert.equal(results[0].features.length, 3);
    assert.equal(results[0].features[2].geometry.coordinates[0], 3);
  });

  it("walks polygon boundaries ring by ring", () => {
    const square = makeLayer("square", "Square", {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 1],
                [0, 0],
              ],
            ],
          },
        },
      ],
    });
    const { results } = runTool("points-along-geometry", [square], {
      layer: "square",
      interval: 50000,
      units: "meters",
    });
    // ~50 km steps around a ~444 km perimeter → interior points + corners.
    assert.ok(results[0].features.length > 8);
    assert.ok(
      results[0].features.some(
        (f) => f.geometry.coordinates[0] === 0 && f.geometry.coordinates[1] === 0,
      ),
    );
  });

  it("rejects non-positive intervals and non-line input", () => {
    const failed = runTool("points-along-geometry", [line], {
      layer: "line",
      interval: 0,
      units: "kilometers",
    });
    assert.equal(failed.results.length, 0);
    assert.ok(failed.messages.some((m) => m.startsWith("Error:")));

    const points = makeLayer("pts", "Pts", {
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [0, 0] } },
      ],
    });
    const wrongFamily = runTool("points-along-geometry", [points], {
      layer: "pts",
      interval: 1,
      units: "kilometers",
    });
    assert.equal(wrongFamily.results.length, 0);
    assert.ok(wrongFamily.messages.some((m) => m.includes("no line or polygon features")));
  });
});
