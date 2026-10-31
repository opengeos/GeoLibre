import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MinHeap } from "../packages/geolibre-layer-limiter/src/heap";
import {
  computeRingAreaHectares,
  getFeatureArea,
  isFeatureInBBox,
} from "../packages/geolibre-layer-limiter/src/geometry";
import { optimizeFeatureCollection } from "../packages/geolibre-layer-limiter/src/index";

describe("MinHeap", () => {
  it("maintains minimum element at root and extracts sorted descending", () => {
    const heap = new MinHeap<{ id: number; score: number }>((a, b) => a.score - b.score);
    heap.push({ id: 1, score: 50 });
    heap.push({ id: 2, score: 10 });
    heap.push({ id: 3, score: 90 });
    heap.push({ id: 4, score: 30 });

    assert.equal(heap.peek()?.score, 10);
    assert.equal(heap.size(), 4);

    const sorted = heap.toArraySortedDescending();
    assert.deepEqual(
      sorted.map((s) => s.score),
      [90, 50, 30, 10],
    );
  });

  it("handles empty heap peek and pop gracefully", () => {
    const heap = new MinHeap();
    assert.equal(heap.peek(), null);
    assert.equal(heap.pop(), null);
    assert.equal(heap.size(), 0);
  });
});

describe("geometry area and bbox", () => {
  it("approximates planar polygon area via Shoelace formula in hectares", () => {
    // 0.01 degree bounding box near latitude -30
    const ring = [
      [140.0, -30.0],
      [140.01, -30.0],
      [140.01, -30.01],
      [140.0, -30.01],
      [140.0, -30.0],
    ];
    const ha = computeRingAreaHectares(ring);
    assert.ok(ha > 50 && ha < 150, `Expected ~100 ha, got ${ha}`);
  });

  it("extracts area from property candidates before geometry calculation", () => {
    const feat = {
      type: "Feature",
      properties: { area_ha: 24.5 },
      geometry: null,
    };
    assert.equal(getFeatureArea(feat), 24.5);
  });

  it("performs fast bounding box intersection check", () => {
    const feat = {
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [140.0, -30.0],
            [140.01, -30.0],
            [140.01, -30.01],
            [140.0, -30.01],
            [140.0, -30.0],
          ],
        ],
      },
    };
    assert.equal(isFeatureInBBox(feat, [139.0, -31.0, 141.0, -29.0]), true);
    assert.equal(isFeatureInBBox(feat, [150.0, -35.0, 151.0, -34.0]), false);
  });
});

describe("optimizeFeatureCollection", () => {
  it("caps features to maxFeatures and prioritizes largest areas descending", () => {
    const features = [];
    for (let i = 1; i <= 20; i++) {
      features.push({
        type: "Feature",
        properties: { id: i, area_ha: i * 5 },
        geometry: {
          type: "Point",
          coordinates: [140.0 + i * 0.01, -30.0],
        },
      });
    }
    const geojson = { type: "FeatureCollection", features };

    const result = optimizeFeatureCollection(geojson, { maxFeatures: 5 });
    assert.equal(result.stats.isCapped, true);
    assert.equal(result.stats.totalInViewport, 20);
    assert.equal(result.stats.renderedCount, 5);
    assert.equal(result.optimizedGeoJSON.features.length, 5);

    // Verify top 5 largest: 100, 95, 90, 85, 80
    const areas = result.optimizedGeoJSON.features.map(
      (f: { properties: { area_ha: number } }) => f.properties.area_ha
    );
    assert.deepEqual(areas, [100, 95, 90, 85, 80]);
  });
});
