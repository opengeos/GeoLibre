/**
 * Earth curvature and refraction in the interactive viewshed (issue #3530).
 *
 * Every expectation is a closed form: the apparent drop `d²(1 - k) / 2R` and
 * the smooth-Earth horizon `sqrt(2Rh / (1 - k))`, evaluated by hand, then
 * checked against what the viewshed walk actually marks visible over a flat
 * plain. A flat plain is the one terrain where curvature is the *only* thing
 * that can hide a cell, so the visible radius must equal the horizon.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  curvatureDrop,
  DEFAULT_REFRACTION_COEFFICIENT,
  EARTH_RADIUS_METERS,
  horizonDistance,
  MAX_REFRACTION_COEFFICIENT,
  MIN_EARTH_RADIUS_METERS,
  resolveCurvature,
} from "../packages/processing/src/earth-curvature";
import {
  computeViewshed,
  computeViewshedAsync,
  metersToLatDegrees,
  metersToLonDegrees,
  type TerrainDem,
} from "../packages/processing/src/terrain-viewshed";

const near = (actual: number, expected: number, tolerance: number, label?: string) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label ?? "value"}: expected ${expected} +/- ${tolerance}, got ${actual}`,
  );

describe("curvatureDrop", () => {
  it("matches the hand-computed drop at 10 km", () => {
    // 10 000² / (2 * 6 371 008.8) = 7.848 m of pure curvature; refraction at
    // k = 0.13 gives back 13 % of it, leaving 6.828 m.
    near(curvatureDrop(10_000, 0), 7.8481, 1e-3, "no refraction");
    near(curvatureDrop(10_000), 6.8279, 1e-3, "k = 0.13");
    near(curvatureDrop(10_000, 0.13, 6_371_000), 6.8279, 1e-3, "custom radius");
  });

  it("grows with the square of the distance", () => {
    near(curvatureDrop(50_000), 25 * curvatureDrop(10_000), 1e-9);
    // The ~170 m at the 50 km viewshed cap the docs quote.
    near(curvatureDrop(50_000), 170.7, 0.1);
  });

  it("halves when the radius doubles", () => {
    near(curvatureDrop(10_000, 0.13, 2 * EARTH_RADIUS_METERS), curvatureDrop(10_000) / 2, 1e-9);
  });
});

describe("horizonDistance", () => {
  it("is the inverse of the drop", () => {
    // sqrt(2 * 6 371 008.8 * 2 / 0.87) = 5 412 m for a 2 m eye.
    near(horizonDistance(2), 5411.9, 0.5);
    near(curvatureDrop(horizonDistance(2)), 2, 1e-9);
    assert.equal(horizonDistance(0), 0);
  });
});

describe("resolveCurvature", () => {
  it("fills defaults", () => {
    assert.deepEqual(resolveCurvature(), {
      curvature: true,
      refractionCoefficient: DEFAULT_REFRACTION_COEFFICIENT,
      earthRadiusMeters: EARTH_RADIUS_METERS,
    });
  });

  it("clamps out-of-range values and replaces non-finite ones", () => {
    const resolved = resolveCurvature({ refractionCoefficient: 5, earthRadiusMeters: 10 });
    assert.equal(resolved.refractionCoefficient, MAX_REFRACTION_COEFFICIENT);
    assert.equal(resolved.earthRadiusMeters, MIN_EARTH_RADIUS_METERS);
    const fallback = resolveCurvature({ refractionCoefficient: NaN, earthRadiusMeters: Infinity });
    assert.equal(fallback.refractionCoefficient, DEFAULT_REFRACTION_COEFFICIENT);
    assert.equal(fallback.earthRadiusMeters, EARTH_RADIUS_METERS);
  });
});

/**
 * A flat plain 3 rows tall and `halfSpanMeters` either side of (0, 0), with
 * 100 m cells, so column `c` sits `(c - mid) * 100` m east of the observer.
 */
function plain(halfSpanMeters: number, elevation?: (col: number) => number) {
  const cell = 100;
  const width = (2 * halfSpanMeters) / cell + 1;
  const height = 3;
  const mid = (width - 1) / 2;
  const values = new Float32Array(width * height);
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      values[row * width + col] = elevation ? elevation(col - mid) : 0;
    }
  }
  const dLon = metersToLonDegrees(halfSpanMeters, 0);
  const dLat = metersToLatDegrees(cell);
  const dem: TerrainDem = { width, height, values, bbox: [-dLon, -dLat, dLon, dLat] };
  /** Visibility of the cell `metersEast` of the observer, on the middle row. */
  const visibleAt = (visible: Uint8Array, metersEast: number) =>
    visible[1 * width + mid + Math.round(metersEast / cell)] === 1;
  return { dem, visibleAt };
}

describe("computeViewshed with curvature", () => {
  const observer = { lng: 0, lat: 0, heightMeters: 2 };

  it("sees a flat plain to the horizon and no further", () => {
    const { dem, visibleAt } = plain(10_000);
    const { visible } = computeViewshed(dem, observer);
    // Horizon for a 2 m eye at k = 0.13 is 5 412 m.
    assert.equal(visibleAt(visible, 5_300), true, "inside the horizon");
    assert.equal(visibleAt(visible, -5_300), true, "inside the horizon, westward");
    assert.equal(visibleAt(visible, 5_500), false, "just past the horizon");
    assert.equal(visibleAt(visible, 9_000), false, "well past the horizon");
  });

  it("sees the whole plain with curvature off", () => {
    const { dem, visibleAt } = plain(10_000);
    const { visible } = computeViewshed(dem, observer, 0, { curvature: false });
    assert.equal(visibleAt(visible, 9_000), true);
    assert.equal(visibleAt(visible, 10_000), true);
  });

  it("moves the horizon with the refraction coefficient", () => {
    const { dem, visibleAt } = plain(10_000);
    // Without refraction the horizon pulls in to sqrt(2R * 2) = 5 048 m, so a
    // cell at 5.2 km is lost; at k = 0.13 (horizon 5 412 m) it is still seen.
    const bent = computeViewshed(dem, observer, 0, { refractionCoefficient: 0.13 });
    const straight = computeViewshed(dem, observer, 0, { refractionCoefficient: 0 });
    assert.equal(visibleAt(bent.visible, 5_200), true);
    assert.equal(visibleAt(straight.visible, 5_200), false);
    assert.equal(visibleAt(straight.visible, 4_900), true);
  });

  it("moves the horizon with the Earth radius", () => {
    const { dem, visibleAt } = plain(10_000);
    // Doubling R pushes the horizon out by sqrt(2): 5 412 m -> 7 654 m.
    const { visible } = computeViewshed(dem, observer, 0, {
      earthRadiusMeters: 2 * EARTH_RADIUS_METERS,
    });
    assert.equal(visibleAt(visible, 7_500), true);
    assert.equal(visibleAt(visible, 7_800), false);
  });

  it("sees a tower over the horizon when the two horizons meet", () => {
    // A 10 m tower is visible from a 2 m eye out to horizon(2) + horizon(10)
    // = 5 412 + 12 101 = 17 513 m over smooth ground.
    const tower = (metersEast: number) =>
      plain(20_000, (offset) => (offset * 100 === metersEast ? 10 : 0));
    const at15 = tower(15_000);
    assert.equal(at15.visibleAt(computeViewshed(at15.dem, observer).visible, 15_000), true);
    const at19 = tower(19_000);
    assert.equal(at19.visibleAt(computeViewshed(at19.dem, observer).visible, 19_000), false);
  });

  it("passes the curvature model through the async path", async () => {
    const { dem, visibleAt } = plain(10_000);
    const result = await computeViewshedAsync(dem, observer, 0, undefined, { curvature: false });
    assert.equal(visibleAt(result.visible, 9_000), true);
  });
});
