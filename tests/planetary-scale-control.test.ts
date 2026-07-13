import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  greatCircleMeters,
  getRoundNum,
} from "../packages/map/src/planetary-scale-control";
import { getEllipsoid, meanRadiusMeters } from "../packages/core/src/ellipsoids";

const EARTH_R = meanRadiusMeters(getEllipsoid("earth"));
const MOON_R = meanRadiusMeters(getEllipsoid("moon"));
const MARS_R = meanRadiusMeters(getEllipsoid("mars"));

describe("greatCircleMeters", () => {
  it("measures one equatorial degree as ~1/360 of the circumference", () => {
    const d = greatCircleMeters({ lng: 0, lat: 0 }, { lng: 1, lat: 0 }, EARTH_R);
    const expected = (2 * Math.PI * EARTH_R) / 360;
    assert.ok(Math.abs(d - expected) < 1e-3, `${d} vs ${expected}`);
  });

  it("scales linearly with the body radius (the whole point of the fix)", () => {
    const a = { lng: 10, lat: 20 };
    const b = { lng: 12, lat: 24 };
    const earth = greatCircleMeters(a, b, EARTH_R);
    const moon = greatCircleMeters(a, b, MOON_R);
    const mars = greatCircleMeters(a, b, MARS_R);
    // Same pixels → same angular span → distance is just radius × angle, so the
    // ratio of distances is exactly the ratio of radii.
    assert.ok(Math.abs(moon / earth - MOON_R / EARTH_R) < 1e-9);
    assert.ok(Math.abs(mars / earth - MARS_R / EARTH_R) < 1e-9);
    // Sanity: the Moon reads much shorter than Earth for the same span.
    assert.ok(moon < earth * 0.3);
  });

  it("is zero for coincident points", () => {
    const p = { lng: -45, lat: 12 };
    assert.equal(greatCircleMeters(p, p, EARTH_R), 0);
  });
});

describe("getRoundNum", () => {
  it("snaps to 1/2/3/5/10 × 10ⁿ", () => {
    assert.equal(getRoundNum(1), 1);
    assert.equal(getRoundNum(2.4), 2);
    assert.equal(getRoundNum(3.9), 3);
    assert.equal(getRoundNum(4.9), 3);
    assert.equal(getRoundNum(6), 5);
    assert.equal(getRoundNum(9.9), 5);
    assert.equal(getRoundNum(23), 20);
    assert.equal(getRoundNum(2345), 2000);
    assert.equal(getRoundNum(70000), 50000);
  });

  it("rounds sub-unit spans DOWN, not up (the width-blowup guard)", () => {
    // MapLibre's digit-count getRoundNum returns 1 for any 0<x<1, which rounds
    // *up* and makes the bar wider than maxWidth. Ours must stay ≤ the input.
    assert.ok(Math.abs(getRoundNum(0.9) - 0.5) < 1e-9);
    assert.ok(Math.abs(getRoundNum(0.4) - 0.3) < 1e-9);
    assert.ok(Math.abs(getRoundNum(0.05) - 0.05) < 1e-9);
  });

  it("never exceeds its input for any positive span", () => {
    for (const x of [1e-6, 0.017, 0.5, 0.99, 1, 7.3, 42, 999, 123456]) {
      assert.ok(getRoundNum(x) <= x + 1e-12, `getRoundNum(${x}) > ${x}`);
    }
  });

  it("returns 0 for non-positive input", () => {
    assert.equal(getRoundNum(0), 0);
    assert.equal(getRoundNum(-5), 0);
  });
});
