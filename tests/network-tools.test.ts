import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import { layerToSequencedPoints } from "@geolibre/processing";
import type { Feature, FeatureCollection } from "geojson";

function pointLayer(features: Feature[]): GeoLibreLayer {
  return {
    id: "layer-a",
    name: "Points",
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
    geojson: { type: "FeatureCollection", features } as FeatureCollection,
  };
}

function point(coords: [number, number], props: Record<string, unknown>): Feature {
  return {
    type: "Feature",
    properties: props,
    geometry: { type: "Point", coordinates: coords },
  };
}

describe("layerToSequencedPoints", () => {
  it("keeps feature order when no order field is given", () => {
    const layer = pointLayer([
      point([-77.05, 38.88], { name: "Lincoln" }),
      point([-77.01, 38.89], { name: "Capitol" }),
    ]);
    const ids = layerToSequencedPoints(layer, "").map((p) => p.id);
    assert.deepEqual(ids, ["Lincoln", "Capitol"]);
  });

  it("sorts by a timestamp field before routing", () => {
    const layer = pointLayer([
      point([-77.01, 38.89], { name: "Capitol", t: "2026-06-19T12:00:00Z" }),
      point([-77.05, 38.88], { name: "Lincoln", t: "2026-06-19T09:00:00Z" }),
      point([-77.03, 38.89], { name: "Monument", t: "2026-06-19T10:00:00Z" }),
    ]);
    const ids = layerToSequencedPoints(layer, "t").map((p) => p.id);
    assert.deepEqual(ids, ["Lincoln", "Monument", "Capitol"]);
  });

  it("skips non-point and invalid-coordinate features", () => {
    const layer = pointLayer([
      point([-77.05, 38.88], { name: "ok" }),
      {
        type: "Feature",
        properties: { name: "line" },
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [1, 1],
          ],
        },
      },
      point([Number.NaN, 38.9], { name: "bad-coord" }),
    ]);
    const ids = layerToSequencedPoints(layer, "").map((p) => p.id);
    assert.deepEqual(ids, ["ok"]);
  });

  it("preserves feature order for equal order values (stable sort)", () => {
    const layer = pointLayer([
      point([-77.01, 38.89], { name: "first", seq: 1 }),
      point([-77.02, 38.89], { name: "second", seq: 1 }),
      point([-77.03, 38.89], { name: "third", seq: 0 }),
    ]);
    const ids = layerToSequencedPoints(layer, "seq").map((p) => p.id);
    assert.deepEqual(ids, ["third", "first", "second"]);
  });

  it("falls back to the feature index as id when no id/name property exists", () => {
    const layer = pointLayer([point([-77.05, 38.88], {}), point([-77.01, 38.89], {})]);
    const ids = layerToSequencedPoints(layer, "").map((p) => p.id);
    assert.deepEqual(ids, [0, 1]);
  });
});
