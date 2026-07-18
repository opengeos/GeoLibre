import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { setActiveEllipsoidId } from "@geolibre/core";

import {
  buildAreaGrid,
  densifyLine,
  haversineMeters,
  pointInRing,
  surfaceArea,
  surfaceDistance,
  type LngLat,
} from "../packages/plugins/src/plugins/terrain-measure-geometry";
import {
  computeTerrainReadout,
  sampleMapTerrain,
  sampleRemoteElevations,
  terrainReadoutIsPartial,
  terrainReadoutRows,
  type TerrainMapLike,
} from "../packages/plugins/src/plugins/terrain-measure";
import type { FetchLike } from "../packages/plugins/src/plugins/elevation-profile/elevation/client";

const EARTH_RADIUS = 6371008.8;

const closeTo = (actual: number, expected: number, delta: number): void => {
  assert.ok(
    Math.abs(actual - expected) <= delta,
    `expected ${actual} to be within ${delta} of ${expected}`,
  );
};

describe("terrain-measure geometry: densifyLine", () => {
  it("keeps endpoints and spaces samples evenly", () => {
    // ~1113 m of longitude at the equator.
    const coords: LngLat[] = [
      [0, 0],
      [0.01, 0],
    ];
    const { coords: sampled, distances } = densifyLine(coords, 100, 500, EARTH_RADIUS);
    assert.deepEqual(sampled[0], coords[0]);
    assert.deepEqual(sampled[sampled.length - 1], coords[1]);
    // ~1113 m at 100 m spacing → 13 samples (ceil(1113/100) + 1).
    assert.equal(sampled.length, 13);
    assert.equal(distances[0], 0);
    closeTo(distances[distances.length - 1], 1113, 2);
    // Even spacing.
    closeTo(distances[1] - distances[0], distances[2] - distances[1], 1e-6);
  });

  it("caps the sample count at maxPoints", () => {
    const coords: LngLat[] = [
      [0, 0],
      [1, 0],
    ];
    const { coords: sampled } = densifyLine(coords, 1, 50, EARTH_RADIUS);
    assert.equal(sampled.length, 50);
  });

  it("handles degenerate input", () => {
    assert.deepEqual(densifyLine([], 10, 10, EARTH_RADIUS).coords, []);
    const same: LngLat[] = [
      [5, 5],
      [5, 5],
    ];
    assert.deepEqual(densifyLine(same, 10, 10, EARTH_RADIUS).distances, [0, 0]);
  });
});

describe("terrain-measure geometry: surfaceDistance", () => {
  it("equals the planar distance over flat terrain", () => {
    const result = surfaceDistance([0, 100, 200], [50, 50, 50]);
    closeTo(result.surfaceMeters, 200, 1e-9);
    closeTo(result.planarMeters, 200, 1e-9);
    assert.equal(result.gainMeters, 0);
    assert.equal(result.lossMeters, 0);
  });

  it("computes the 3-4-5 slope", () => {
    // 400 m run with 300 m rise → 500 m along the surface.
    const result = surfaceDistance([0, 400], [0, 300]);
    closeTo(result.surfaceMeters, 500, 1e-9);
    assert.equal(result.gainMeters, 300);
    assert.equal(result.lossMeters, 0);
    assert.equal(result.minElevationMeters, 0);
    assert.equal(result.maxElevationMeters, 300);
  });

  it("accumulates gain and loss over a ridge", () => {
    const result = surfaceDistance([0, 100, 200], [0, 80, 20]);
    assert.equal(result.gainMeters, 80);
    assert.equal(result.lossMeters, 60);
    closeTo(result.surfaceMeters, Math.hypot(100, 80) + Math.hypot(100, 60), 1e-9);
  });

  it("falls back to planar length across missing samples", () => {
    const result = surfaceDistance([0, 100, 200], [0, null, 100]);
    // Both segments touch the null sample, so both fall back to planar.
    closeTo(result.surfaceMeters, 200, 1e-9);
    assert.equal(result.sampledCount, 2);
    assert.equal(result.missingCount, 1);
  });
});

describe("terrain-measure geometry: pointInRing / buildAreaGrid", () => {
  const square: LngLat[] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
    [0, 0],
  ];

  it("classifies inside and outside points", () => {
    assert.equal(pointInRing([0.5, 0.5], square), true);
    assert.equal(pointInRing([1.5, 0.5], square), false);
    assert.equal(pointInRing([-0.5, 0.5], square), false);
  });

  it("builds a bounded grid with interior flags", () => {
    const grid = buildAreaGrid(square, 100, EARTH_RADIUS);
    assert.ok(grid);
    assert.ok(grid.cols * grid.rows <= 100);
    assert.ok(grid.cols >= 2 && grid.rows >= 2);
    assert.equal(grid.coords.length, grid.cols * grid.rows);
    assert.ok(grid.inside.some(Boolean));
    assert.ok(grid.cellWidthMeters > 0 && grid.cellHeightMeters > 0);
  });

  it("keeps the grid within maxSamples for very skinny polygons", () => {
    // A ~10 m x 5000 m north-south sliver: without a row cap, rows would
    // blow past the budget while cols sits at its floor of 2.
    const sliver: LngLat[] = [
      [0, 0],
      [0.0001, 0],
      [0.0001, 0.045],
      [0, 0.045],
      [0, 0],
    ];
    const grid = buildAreaGrid(sliver, 256, EARTH_RADIUS);
    assert.ok(grid);
    assert.ok(grid.cols * grid.rows <= 256, `expected ${grid.cols}x${grid.rows} <= 256 samples`);
    const wide: LngLat[] = [
      [0, 0],
      [0.045, 0],
      [0.045, 0.0001],
      [0, 0.0001],
      [0, 0],
    ];
    const wideGrid = buildAreaGrid(wide, 256, EARTH_RADIUS);
    assert.ok(wideGrid);
    assert.ok(wideGrid.cols * wideGrid.rows <= 256);
  });

  it("returns null for degenerate rings", () => {
    assert.equal(buildAreaGrid([], 100, EARTH_RADIUS), null);
    const line: LngLat[] = [
      [0, 0],
      [1, 0],
      [2, 0],
    ];
    assert.equal(buildAreaGrid(line, 100, EARTH_RADIUS), null);
  });
});

describe("terrain-measure geometry: surfaceArea", () => {
  const square: LngLat[] = [
    [0, 0],
    [0.01, 0],
    [0.01, 0.01],
    [0, 0.01],
    [0, 0],
  ];

  it("returns the planar area over flat terrain", () => {
    const grid = buildAreaGrid(square, 64, EARTH_RADIUS)!;
    const elevations = grid.coords.map(() => 100);
    const result = surfaceArea(grid, elevations, 1_000_000);
    assert.ok(result);
    closeTo(result.surfaceSquareMeters, 1_000_000, 1e-6);
    closeTo(result.meanSlopeDegrees, 0, 1e-9);
    assert.equal(result.missingCount, 0);
  });

  it("scales the area by the slope secant on a uniform incline", () => {
    const grid = buildAreaGrid(square, 64, EARTH_RADIUS)!;
    // Elevation rises 1 m per meter eastward → 45° slope, secant √2.
    const elevations = grid.coords.map((_, i) => (i % grid.cols) * grid.cellWidthMeters);
    const result = surfaceArea(grid, elevations, 1_000_000);
    assert.ok(result);
    closeTo(result.surfaceSquareMeters, 1_000_000 * Math.SQRT2, 1000);
    closeTo(result.meanSlopeDegrees, 45, 0.1);
  });

  it("clamps the mean slope like the area's secant", () => {
    const grid = buildAreaGrid(square, 64, EARTH_RADIUS)!;
    // A pathological spike: elevation rises 1000 m per meter eastward.
    const elevations = grid.coords.map((_, i) => (i % grid.cols) * grid.cellWidthMeters * 1000);
    const result = surfaceArea(grid, elevations, 1_000_000);
    assert.ok(result);
    // Both readouts are protected by the same 85-degree cap, so they can't
    // silently disagree on spiky DEM data.
    assert.ok(result.meanSlopeDegrees <= 85);
    closeTo(result.meanSlopeDegrees, 85, 0.01);
    closeTo(result.surfaceSquareMeters, 1_000_000 / Math.cos((85 * Math.PI) / 180), 1);
  });

  it("returns null when most samples are missing", () => {
    const grid = buildAreaGrid(square, 64, EARTH_RADIUS)!;
    const elevations = grid.coords.map(() => null);
    assert.equal(surfaceArea(grid, elevations, 1_000_000), null);
  });
});

describe("terrain-measure geometry: haversineMeters", () => {
  it("measures a degree of longitude at the equator", () => {
    const meters = haversineMeters([0, 0], [1, 0], EARTH_RADIUS);
    closeTo(meters, 111195, 10);
  });

  it("scales with the body radius", () => {
    const earth = haversineMeters([0, 0], [1, 0], EARTH_RADIUS);
    const half = haversineMeters([0, 0], [1, 0], EARTH_RADIUS / 2);
    closeTo(half, earth / 2, 1e-6);
  });
});

describe("terrain-measure samplers", () => {
  it("sampleMapTerrain returns null when terrain is off", () => {
    const map: TerrainMapLike = {
      getTerrain: () => null,
      queryTerrainElevation: () => 100,
    };
    assert.equal(sampleMapTerrain(map, [[0, 0]]), null);
    assert.equal(sampleMapTerrain(null, [[0, 0]]), null);
  });

  it("sampleMapTerrain divides the exaggeration back out", () => {
    const map: TerrainMapLike = {
      getTerrain: () => ({ exaggeration: 2 }),
      queryTerrainElevation: () => 200,
    };
    assert.deepEqual(sampleMapTerrain(map, [[0, 0]]), [100]);
  });

  it("sampleMapTerrain passes through nulls for unloaded tiles", () => {
    const map: TerrainMapLike = {
      getTerrain: () => ({ exaggeration: 1 }),
      queryTerrainElevation: (point) => (point[0] === 0 ? 50 : null),
    };
    assert.deepEqual(
      sampleMapTerrain(map, [
        [0, 0],
        [1, 1],
      ]),
      [50, null],
    );
  });

  it("sampleRemoteElevations chunks requests and survives a failed chunk", async () => {
    const calls: number[] = [];
    const fetchImpl: FetchLike = async (url) => {
      const count = (url.match(/latitude=([^&]*)/)?.[1] ?? "").split(",").length;
      calls.push(count);
      if (calls.length === 2) return new Response("boom", { status: 500 });
      return new Response(JSON.stringify({ elevation: Array(count).fill(7) }), { status: 200 });
    };
    const points: LngLat[] = Array.from({ length: 150 }, (_, i) => [i / 1000, 0]);
    const elevations = await sampleRemoteElevations(points, fetchImpl);
    assert.deepEqual(calls, [100, 50]);
    assert.equal(elevations.length, 150);
    assert.equal(elevations[0], 7);
    assert.equal(elevations[149], null);
  });
});

describe("terrain-measure readout", () => {
  const slopeMap: TerrainMapLike = {
    getTerrain: () => ({ exaggeration: 1 }),
    // 0.75 m of elevation per meter of northward ground distance → a 3-4-5
    // slope along a south-to-north line.
    queryTerrainElevation: (point) => point[1] * ((Math.PI * EARTH_RADIUS) / 180) * 0.75,
  };

  it("computes a 3-4-5 surface distance from map terrain", async () => {
    const readout = await computeTerrainReadout(
      {
        id: "m1",
        mode: "distance",
        points: [
          { lng: 0, lat: 0 },
          { lng: 0, lat: 0.01 },
        ],
        distance: 1113,
      },
      slopeMap,
    );
    assert.ok(readout);
    if (readout.kind !== "distance") assert.fail("expected a distance readout");
    const planar = readout.result.planarMeters;
    closeTo(readout.result.surfaceMeters, planar * 1.25, planar * 0.001);
    assert.equal(terrainReadoutIsPartial(readout), false);
  });

  it("flags a readout as partial when some samples have no elevation", async () => {
    const patchyMap: TerrainMapLike = {
      getTerrain: () => ({ exaggeration: 1 }),
      // Northern half of the line has no loaded DEM tile.
      queryTerrainElevation: (point) => (point[1] > 0.005 ? null : 100),
    };
    const readout = await computeTerrainReadout(
      {
        id: "m-partial",
        mode: "distance",
        points: [
          { lng: 0, lat: 0 },
          { lng: 0, lat: 0.01 },
        ],
        distance: 1113,
      },
      patchyMap,
    );
    assert.ok(readout);
    if (readout.kind !== "distance") assert.fail("expected a distance readout");
    assert.equal(terrainReadoutIsPartial(readout), true);
    assert.ok(readout.result.missingCount > 0);
    assert.ok(readout.result.sampledCount > 0);
  });

  it("renders unit-aware rows", async () => {
    const readout = await computeTerrainReadout(
      {
        id: "m2",
        mode: "distance",
        points: [
          { lng: 0, lat: 0 },
          { lng: 0, lat: 0.01 },
        ],
        distance: 1113,
      },
      slopeMap,
    );
    assert.ok(readout);
    const rows = terrainReadoutRows(readout, {
      distanceUnit: "kilometers",
      areaUnit: "square-kilometers",
    });
    assert.equal(rows.length, 3);
    assert.match(rows[0][1], /km$/);
    assert.match(rows[1][1], /\bm$/);
    const imperialRows = terrainReadoutRows(readout, {
      distanceUnit: "miles",
      areaUnit: "acres",
    });
    assert.match(imperialRows[0][1], /mi$/);
    assert.match(imperialRows[1][1], /ft/);
  });

  it("computes a slope-corrected area readout", async () => {
    const readout = await computeTerrainReadout(
      {
        id: "m3",
        mode: "area",
        points: [
          { lng: 0, lat: 0 },
          { lng: 0.01, lat: 0 },
          { lng: 0.01, lat: 0.01 },
          { lng: 0, lat: 0.01 },
        ],
        area: 1_000_000,
      },
      slopeMap,
    );
    assert.ok(readout);
    if (readout.kind !== "area") assert.fail("expected an area readout");
    // sec(atan(0.75)) = 1.25 on a uniform 3-4-5 incline.
    closeTo(readout.result.surfaceSquareMeters, 1_250_000, 5_000);
    const rows = terrainReadoutRows(readout, {
      distanceUnit: "meters",
      areaUnit: "hectares",
    });
    assert.match(rows[0][1], /ha$/);
    assert.match(rows[1][1], /°$/);
  });

  it("returns null when the only source is terrain and it is off (non-Earth)", async () => {
    setActiveEllipsoidId("moon");
    try {
      const readout = await computeTerrainReadout(
        {
          id: "m4",
          mode: "distance",
          points: [
            { lng: 0, lat: 0 },
            { lng: 0, lat: 0.01 },
          ],
          distance: 1113,
        },
        { getTerrain: () => null, queryTerrainElevation: () => null },
      );
      assert.equal(readout, null);
    } finally {
      setActiveEllipsoidId("earth");
    }
  });
});
