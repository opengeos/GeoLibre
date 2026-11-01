import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MinHeap } from "../packages/geolibre-layer-limiter/src/heap";
import {
  computeRingAreaHectares,
  getFeatureArea,
  isFeatureInBBox,
} from "../packages/geolibre-layer-limiter/src/geometry";
import {
  AreaPriorityLimiter,
  optimizeFeatureCollection,
} from "../packages/geolibre-layer-limiter/src/index";

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
    const heap = new MinHeap<number>((a, b) => a - b);
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

  it("matches features across the antimeridian when the viewport runs past ±180°", () => {
    const feat = {
      type: "Feature",
      geometry: { type: "Point", coordinates: [-175.0, -30.0] },
    };
    assert.equal(isFeatureInBBox(feat, [175.0, -31.0, 195.0, -29.0]), true);
    // A viewport ending at 185° wraps to -175°, so the point sits exactly on its inclusive edge
    assert.equal(isFeatureInBBox(feat, [175.0, -31.0, 185.0, -29.0]), true);
    assert.equal(isFeatureInBBox(feat, [175.0, -31.0, 184.0, -29.0]), false);
  });

  it("subtracts hole rings from polygon area", () => {
    const outer = [
      [140.0, -30.0],
      [140.01, -30.0],
      [140.01, -30.01],
      [140.0, -30.01],
      [140.0, -30.0],
    ];
    const hole = [
      [140.0025, -30.0025],
      [140.0075, -30.0025],
      [140.0075, -30.0075],
      [140.0025, -30.0075],
      [140.0025, -30.0025],
    ];
    const solid = getFeatureArea({ geometry: { type: "Polygon", coordinates: [outer] } });
    const withHole = getFeatureArea({ geometry: { type: "Polygon", coordinates: [outer, hole] } });
    // The hole is a quarter of the outer ring
    assert.ok(Math.abs(withHole - solid * 0.75) < solid * 0.005, `${withHole} vs ${solid}`);
  });

  it("treats shape_area as square meters", () => {
    assert.equal(getFeatureArea({ properties: { shape_area: 800 }, geometry: null }), 0.08);
    assert.equal(getFeatureArea({ properties: { shape_area: 250000 }, geometry: null }), 25);
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
    const areas = result.optimizedGeoJSON.features.map((f) => Number(f.properties?.area_ha ?? 0));
    assert.deepEqual(areas, [100, 95, 90, 85, 80]);
  });

  it("keeps the smallest areas in ascending order when sortOrder is asc", () => {
    const features = [];
    for (let i = 1; i <= 20; i++) {
      features.push({
        type: "Feature",
        properties: { id: i, area_ha: i * 5 },
        geometry: { type: "Point", coordinates: [140.0 + i * 0.01, -30.0] },
      });
    }
    const geojson = { type: "FeatureCollection", features };

    const result = optimizeFeatureCollection(geojson, { maxFeatures: 5, sortOrder: "asc" });
    const areas = result.optimizedGeoJSON.features.map((f) => Number(f.properties?.area_ha ?? 0));
    assert.deepEqual(areas, [5, 10, 15, 20, 25]);
  });

  it("culls features outside the bbox and below minAreaThreshold", () => {
    const features = [
      // inside the bbox and above the threshold
      {
        type: "Feature",
        properties: { area_ha: 50 },
        geometry: { type: "Point", coordinates: [140, -30] },
      },
      // outside the bbox
      {
        type: "Feature",
        properties: { area_ha: 80 },
        geometry: { type: "Point", coordinates: [150, -30] },
      },
      // inside the bbox but below the threshold
      {
        type: "Feature",
        properties: { area_ha: 2 },
        geometry: { type: "Point", coordinates: [140.5, -30] },
      },
    ];
    const geojson = { type: "FeatureCollection", features };

    const result = optimizeFeatureCollection(geojson, {
      bbox: [139, -31, 141, -29],
      minAreaThreshold: 5,
    });
    assert.equal(result.stats.totalInViewport, 1);
    assert.deepEqual(
      result.optimizedGeoJSON.features.map((f) => f.properties?.area_ha),
      [50],
    );
  });

  it("falls back to the default cap for zero or negative maxFeatures", () => {
    const features = [];
    for (let i = 1; i <= 3; i++) {
      features.push({
        type: "Feature",
        properties: { area_ha: i },
        geometry: { type: "Point", coordinates: [140.0 + i * 0.01, -30.0] },
      });
    }
    const geojson = { type: "FeatureCollection", features };

    for (const maxFeatures of [0, -1]) {
      const result = optimizeFeatureCollection(geojson, { maxFeatures });
      assert.equal(result.stats.maxFeatures, 500);
      assert.equal(result.stats.renderedCount, 3);
    }
  });
});

describe("AreaPriorityLimiter", () => {
  it("keeps raw data after disable when a pending debounce fires", async () => {
    const raw = {
      type: "FeatureCollection",
      features: [1, 2, 3].map((id) => ({
        type: "Feature" as const,
        properties: { id, area_ha: id * 10 },
        geometry: { type: "Point", coordinates: [140 + id * 0.01, -30.0] },
      })),
    };
    const sourceData: unknown[] = [];
    const handlers = new Map<string, () => void>();
    const map = {
      on: (event: string, handler: () => void) => handlers.set(event, handler),
      off: (event: string) => handlers.delete(event),
      getBounds: () => ({
        getWest: () => 139,
        getSouth: () => -31,
        getEast: () => 141,
        getNorth: () => -29,
      }),
      getSource: () => ({ setData: (data: unknown) => sourceData.push(data) }),
    };

    const limiter = new AreaPriorityLimiter(map, {
      sourceId: "areas",
      data: raw,
      maxFeatures: 1,
      debounceMs: 5,
    });

    limiter.enable();
    handlers.get("moveend")?.();
    limiter.disable();
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(sourceData.at(-1), raw);
  });
});
