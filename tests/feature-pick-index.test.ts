import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Feature, FeatureCollection } from "geojson";
import { featurePickIndex } from "../packages/map/src/feature-pick-index";

// The index only narrows the candidates: it must never drop a feature whose
// bounds are within the tolerance, and must keep the collection's order.

/** A deterministic pseudo-random sequence, so failures reproduce. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

const square = (x: number, y: number, d: number): Feature => ({
  type: "Feature",
  properties: {},
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [x, y],
        [x + d, y],
        [x + d, y + d],
        [x, y + d],
        [x, y],
      ],
    ],
  },
});

/** The candidates a linear scan of every feature's bounds finds. */
function bruteForce(collection: FeatureCollection, [x, y]: [number, number], t: number): number[] {
  const hits: number[] = [];
  collection.features.forEach((feature, i) => {
    const g = feature.geometry;
    if (!g || g.type !== "Polygon") {
      if (g?.type === "Point") {
        const [px, py] = g.coordinates;
        if (Math.abs(px - x) <= t && Math.abs(py - y) <= t) hits.push(i);
      }
      return;
    }
    const xs = g.coordinates[0].map((p) => p[0]);
    const ys = g.coordinates[0].map((p) => p[1]);
    if (
      x + t >= Math.min(...xs) &&
      x - t <= Math.max(...xs) &&
      y + t >= Math.min(...ys) &&
      y - t <= Math.max(...ys)
    )
      hits.push(i);
  });
  return hits;
}

describe("featurePickIndex", () => {
  it("finds exactly the features whose bounds are near the point, in order", () => {
    const next = random(7);
    const features: Feature[] = [];
    for (let i = 0; i < 2000; i++)
      features.push(
        next() < 0.5
          ? square(next() * 100 - 50, next() * 60 - 30, next() * 3)
          : {
              type: "Feature",
              properties: {},
              geometry: { type: "Point", coordinates: [next() * 100 - 50, next() * 60 - 30] },
            },
      );
    // One feature spanning the whole extent, and one with no geometry.
    features.push(square(-60, -40, 120));
    features.push({ type: "Feature", properties: {}, geometry: null as never });
    const collection: FeatureCollection = { type: "FeatureCollection", features };
    const index = featurePickIndex(collection);
    for (let q = 0; q < 300; q++) {
      const point: [number, number] = [next() * 120 - 60, next() * 80 - 40];
      const tolerance = [0, 0.05, 0.5, 5][q % 4];
      assert.deepEqual(
        index.candidates(point, tolerance),
        bruteForce(collection, point, tolerance),
      );
    }
    // A point outside the extent (beyond the tolerance) has no candidates.
    assert.deepEqual(index.candidates([500, 500], 1), []);
  });
  it("is built once per collection", () => {
    const collection: FeatureCollection = {
      type: "FeatureCollection",
      features: [square(0, 0, 1)],
    };
    assert.equal(featurePickIndex(collection), featurePickIndex(collection));
    assert.deepEqual(
      featurePickIndex({ type: "FeatureCollection", features: [] }).candidates([0, 0], 1),
      [],
    );
  });
  it("keeps a pick over a large layer cheap", () => {
    const features: Feature[] = [];
    for (let i = 0; i < 100_000; i++)
      features.push({
        type: "Feature",
        properties: {},
        geometry: { type: "Point", coordinates: [(i % 400) * 0.1, Math.floor(i / 400) * 0.1] },
      });
    const index = featurePickIndex({ type: "FeatureCollection", features });
    const started = performance.now();
    for (let q = 0; q < 1000; q++) index.candidates([(q % 40) + 0.03, (q % 25) + 0.03], 0.02);
    // A thousand picks: far under a frame each (the old scan walked all 100k).
    assert.ok(performance.now() - started < 500);
    assert.deepEqual(index.candidates([1.0, 1.0], 0.01), [4010]);
  });
});
