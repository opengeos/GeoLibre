import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Feature, FeatureCollection, MultiPolygon, Polygon, Position } from "geojson";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import {
  fillPolygonGaps,
  fillPolygonGapsTool,
  fixPolygonOverlapsTool,
  polygonGeodesicArea,
  resolvePolygonOverlaps,
} from "../packages/processing/src/topology-tools";
import type { ProcessingContext } from "../packages/processing/src/types";

/** Axis-aligned rectangle polygon feature in degree coordinates. */
function rect(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  properties: Record<string, unknown> = {},
): Feature<Polygon> {
  return {
    type: "Feature",
    properties,
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [x0, y0],
          [x1, y0],
          [x1, y1],
          [x0, y1],
          [x0, y0],
        ],
      ],
    },
  };
}

function fcOf(...features: Feature[]): FeatureCollection {
  return { type: "FeatureCollection", features };
}

function ringArea(ring: Position[]): number {
  let sum = 0;
  for (let i = 0; i + 1 < ring.length; i++) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return Math.abs(sum) / 2;
}

/** Planar area in square degrees, holes subtracted: exact for these inputs. */
function planarArea(feature: Feature | undefined): number {
  const geometry = feature?.geometry as Polygon | MultiPolygon;
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  let area = 0;
  for (const rings of polygons) {
    rings.forEach((ring, i) => {
      area += i === 0 ? ringArea(ring) : -ringArea(ring);
    });
  }
  return area;
}

function byName(fc: FeatureCollection, name: string): Feature | undefined {
  return fc.features.find((f) => f.properties?.name === name);
}

function ctxFor(fc: FeatureCollection, parameters: Record<string, unknown>) {
  const logs: string[] = [];
  const results: { name: string; geojson: FeatureCollection }[] = [];
  const layer: GeoLibreLayer = {
    id: "layer-1",
    name: "layer-1",
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
    geojson: fc,
  };
  const ctx: ProcessingContext = {
    layers: [layer],
    parameters: { layer: "layer-1", ...parameters },
    log: (message) => logs.push(message),
    addResultLayer: (name, geojson) => results.push({ name, geojson }),
  };
  return { ctx, logs, results };
}

// A is 2x2 (area 4), B is 3x2 (area 6); they overlap in the 1x2 strip x 1..2.
const A = rect(0, 0, 2, 2, { name: "A", rank: 1 });
const B = rect(1, 0, 4, 2, { name: "B", rank: 5 });
const POINT: Feature = {
  type: "Feature",
  properties: { name: "P" },
  geometry: { type: "Point", coordinates: [1.5, 1] },
};

describe("polygonGeodesicArea", () => {
  it("matches the spherical area of a one-degree cell at the equator", () => {
    // Exact spherical cell area: R^2 * dLng * (sin(lat1) - sin(lat0)).
    const R = 6371008.8;
    const expected = R * R * (Math.PI / 180) * Math.sin(Math.PI / 180);
    const area = polygonGeodesicArea(rect(0, 0, 1, 1).geometry);
    assert.ok(Math.abs(area - expected) / expected < 1e-9, `${area} vs ${expected}`);
  });

  it("subtracts holes", () => {
    const outer = rect(0, 0, 4, 4).geometry.coordinates[0];
    const hole = rect(1, 1, 2, 2).geometry.coordinates[0];
    const donut: Polygon = { type: "Polygon", coordinates: [outer, hole] };
    const expected =
      polygonGeodesicArea(rect(0, 0, 4, 4).geometry) -
      polygonGeodesicArea(rect(1, 1, 2, 2).geometry);
    assert.ok(Math.abs(polygonGeodesicArea(donut) - expected) < 1e-3);
  });
});

describe("resolvePolygonOverlaps", () => {
  it("gives the overlap to the largest polygon", () => {
    const { collection, modified, removed } = resolvePolygonOverlaps(fcOf(A, B, POINT), {
      rule: "largest",
    });
    assert.equal(modified, 1);
    assert.equal(removed, 0);
    assert.equal(planarArea(byName(collection, "A")), 2);
    assert.equal(planarArea(byName(collection, "B")), 6);
    // Order and non-polygon features are preserved.
    assert.deepEqual(
      collection.features.map((f) => f.properties?.name),
      ["A", "B", "P"],
    );
    assert.deepEqual(byName(collection, "P"), POINT);
  });

  it("gives the overlap to the smallest polygon", () => {
    const { collection } = resolvePolygonOverlaps(fcOf(A, B), { rule: "smallest" });
    assert.equal(planarArea(byName(collection, "A")), 4);
    assert.equal(planarArea(byName(collection, "B")), 4);
  });

  it("gives the overlap to the first feature", () => {
    const { collection } = resolvePolygonOverlaps(fcOf(B, A), { rule: "first" });
    assert.equal(planarArea(byName(collection, "B")), 6);
    assert.equal(planarArea(byName(collection, "A")), 2);
  });

  it("ranks by attribute priority in either direction", () => {
    const high = resolvePolygonOverlaps(fcOf(A, B), {
      rule: "attribute",
      priorityField: "rank",
      priorityOrder: "high",
    }).collection;
    assert.equal(planarArea(byName(high, "B")), 6);
    assert.equal(planarArea(byName(high, "A")), 2);
    const low = resolvePolygonOverlaps(fcOf(A, B), {
      rule: "attribute",
      priorityField: "rank",
      priorityOrder: "low",
    }).collection;
    assert.equal(planarArea(byName(low, "A")), 4);
    assert.equal(planarArea(byName(low, "B")), 4);
  });

  it("ranks features without a priority value last", () => {
    const unranked = rect(0, 0, 2, 2, { name: "A" });
    const { collection } = resolvePolygonOverlaps(fcOf(unranked, B), {
      rule: "attribute",
      priorityField: "rank",
      priorityOrder: "low",
    });
    assert.equal(planarArea(byName(collection, "B")), 6);
    assert.equal(planarArea(byName(collection, "A")), 2);
  });

  it("resolves a three-way overlap so no area is counted twice", () => {
    const C = rect(0, 1, 4, 3, { name: "C" }); // area 8
    const { collection } = resolvePolygonOverlaps(fcOf(A, B, C), { rule: "largest" });
    // C (8) wins first, B (6) keeps its lower half (3), A keeps x 0..1, y 0..1.
    assert.equal(planarArea(byName(collection, "C")), 8);
    assert.equal(planarArea(byName(collection, "B")), 3);
    assert.equal(planarArea(byName(collection, "A")), 1);
    const total = collection.features.reduce((sum, f) => sum + planarArea(f), 0);
    assert.equal(total, 12); // the union of the three: 4x3
  });

  it("removes a polygon fully covered by a higher-priority one", () => {
    const inner = rect(1, 0.5, 2, 1.5, { name: "inner" });
    const { collection, removed } = resolvePolygonOverlaps(fcOf(B, inner), { rule: "largest" });
    assert.equal(removed, 1);
    assert.equal(collection.features.length, 1);
  });

  it("leaves polygons that only touch unchanged", () => {
    const left = rect(0, 0, 1, 1, { name: "L" });
    const right = rect(1, 0, 2, 1, { name: "R" });
    const { collection, modified } = resolvePolygonOverlaps(fcOf(left, right), {
      rule: "largest",
    });
    assert.equal(modified, 0);
    assert.deepEqual(collection.features, [left, right]);
  });
});

// A ring of polygons around a 1x2 gap at x 1..2, y 1..3. The left neighbour
// shares the gap's full 2-unit side; every other neighbour shares 1 unit.
const BOTTOM = rect(0, 0, 3, 1, { name: "bottom" });
const TOP = rect(0, 3, 3, 4, { name: "top" });
const LEFT = rect(0, 1, 1, 3, { name: "left" });
const RIGHT_LOW = rect(2, 1, 3, 2, { name: "rightLow" });
const RIGHT_HIGH = rect(2, 2, 3, 3, { name: "rightHigh" });

describe("fillPolygonGaps", () => {
  it("merges an enclosed gap into the neighbour with the longest shared boundary", () => {
    const fc = fcOf(BOTTOM, TOP, RIGHT_LOW, RIGHT_HIGH, LEFT);
    const result = fillPolygonGaps(fc, 0);
    assert.equal(result.filled, 1);
    assert.equal(planarArea(byName(result.collection, "left")), 4);
    for (const name of ["bottom", "top"]) {
      assert.equal(planarArea(byName(result.collection, name)), 3);
    }
    for (const name of ["rightLow", "rightHigh"]) {
      assert.equal(planarArea(byName(result.collection, name)), 1);
    }
    // The coverage is now gap-free: 3x4.
    const total = result.collection.features.reduce((sum, f) => sum + planarArea(f), 0);
    assert.equal(total, 12);
  });

  it("leaves gaps larger than the threshold open", () => {
    const fc = fcOf(BOTTOM, TOP, LEFT, RIGHT_LOW, RIGHT_HIGH);
    const gapArea = polygonGeodesicArea(rect(1, 1, 2, 3).geometry);
    const tooSmall = fillPolygonGaps(fc, gapArea * 0.99);
    assert.equal(tooSmall.filled, 0);
    assert.equal(tooSmall.skippedLarge, 1);
    assert.equal(tooSmall.collection, fc);
    const bigEnough = fillPolygonGaps(fc, gapArea * 1.01);
    assert.equal(bigEnough.filled, 1);
  });

  it("does not fill a hole inside a single polygon", () => {
    const donut: Feature<Polygon> = {
      type: "Feature",
      properties: { name: "donut" },
      geometry: {
        type: "Polygon",
        coordinates: [
          rect(0, 0, 4, 4).geometry.coordinates[0],
          rect(1, 1, 2, 2).geometry.coordinates[0],
        ],
      },
    };
    const result = fillPolygonGaps(fcOf(donut), 0);
    assert.equal(result.filled, 0);
    assert.equal(result.skippedHoles, 1);
  });
});

describe("autofix tools", () => {
  it("fix-polygon-overlaps adds a repaired layer", async () => {
    const { ctx, results, logs } = ctxFor(fcOf(A, B), { rule: "largest" });
    await fixPolygonOverlapsTool.run(ctx);
    assert.equal(results.length, 1);
    assert.equal(planarArea(byName(results[0].geojson, "A")), 2);
    assert.match(logs.join("\n"), /Trimmed 1 polygon/);
  });

  it("fix-polygon-overlaps needs a field for the attribute rule", async () => {
    const { ctx, results, logs } = ctxFor(fcOf(A, B), { rule: "attribute" });
    await fixPolygonOverlapsTool.run(ctx);
    assert.equal(results.length, 0);
    assert.match(logs.join("\n"), /priority field/);
  });

  it("fill-polygon-gaps adds a repaired layer", async () => {
    const { ctx, results } = ctxFor(fcOf(BOTTOM, TOP, LEFT, RIGHT_LOW, RIGHT_HIGH), {
      maxArea: 0,
    });
    await fillPolygonGapsTool.run(ctx);
    assert.equal(results.length, 1);
    assert.equal(planarArea(byName(results[0].geojson, "left")), 4);
  });
});

it("keeps occupied islands out of filled gaps", () => {
  const island = rect(1.25, 1.5, 1.75, 2.5, { name: "island" });
  const result = fillPolygonGaps(fcOf(BOTTOM, TOP, LEFT, RIGHT_LOW, RIGHT_HIGH, island), 0);
  assert.equal(result.filled, 1);
  assert.ok(planarArea(byName(result.collection, "island")) >= 0.5);
  assert.equal(
    result.collection.features.reduce((sum, feature) => sum + planarArea(feature), 0),
    12,
  );
});
