import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  greatCircleMeters,
  getRoundNum,
  scaleSpan,
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

describe("scaleSpan", () => {
  it("uses m below 1 km and km above for metric", () => {
    assert.deepEqual(scaleSpan(500, "metric"), { span: 500, label: "m" });
    assert.deepEqual(scaleSpan(2500, "metric"), { span: 2.5, label: "km" });
    assert.deepEqual(scaleSpan(1000, "metric"), { span: 1, label: "km" });
  });

  it("uses ft below a mile and mi above for imperial", () => {
    // 100 m ≈ 328.08 ft (under a mile) → feet.
    const short = scaleSpan(100, "imperial");
    assert.equal(short.label, "ft");
    assert.ok(Math.abs(short.span - 328.084) < 1e-2, `${short.span}`);
    // Exactly one statute mile (1609.344 m) → 1 mi.
    const mile = scaleSpan(1609.344, "imperial");
    assert.equal(mile.label, "mi");
    assert.ok(Math.abs(mile.span - 1) < 1e-6, `${mile.span}`);
    // 10 km ≈ 6.2137 mi.
    const long = scaleSpan(10000, "imperial");
    assert.equal(long.label, "mi");
    assert.ok(Math.abs(long.span - 6.21371) < 1e-4, `${long.span}`);
  });

  it("reports nautical miles for nautical", () => {
    const nm = scaleSpan(1852, "nautical");
    assert.equal(nm.label, "nmi");
    assert.ok(Math.abs(nm.span - 1) < 1e-9, `${nm.span}`);
    assert.ok(Math.abs(scaleSpan(9260, "nautical").span - 5) < 1e-9);
  });
});
