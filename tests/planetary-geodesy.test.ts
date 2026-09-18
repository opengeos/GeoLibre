/**
 * Tests for the radius-ratio correction that makes GeoLibre's Turf.js-based
 * geodesy body-aware (issue #1128).
 *
 * Turf hardcodes Earth's radius with no per-call override, so every distance it
 * returns and every distance it is given has to be rescaled by the active body's
 * radius ratio. These tests pin the three conversions and the invariant that
 * matters most: on Earth all three are exact no-ops, so nothing about the
 * default Earth workflow shifts.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  bodyLengthToEarth,
  EARTH_MEAN_RADIUS_METERS,
  earthAreaToBody,
  earthLengthToBody,
  ELLIPSOIDS,
  getActiveBodyRadiusRatio,
  getEllipsoid,
  meanRadiusMeters,
  setActiveEllipsoidId,
} from "@geolibre/core";

afterEach(() => setActiveEllipsoidId("earth"));

/** Mars' radius ratio, the reporter's worked example on the issue. */
const MARS_RATIO = meanRadiusMeters(getEllipsoid("mars")) / EARTH_MEAN_RADIUS_METERS;

describe("getActiveBodyRadiusRatio", () => {
  it("is exactly 1 on Earth, so Earth results are untouched", () => {
    setActiveEllipsoidId("earth");
    assert.equal(getActiveBodyRadiusRatio(), 1);
  });

  it("matches the reported Mars/Earth radius ratio of ~0.532", () => {
    setActiveEllipsoidId("mars");
    // 3389.5 km / 6371.0 km — the issue quotes the inverse, ~1.88x.
    assert.ok(
      Math.abs(getActiveBodyRadiusRatio() - 0.532) < 0.001,
      `got ${getActiveBodyRadiusRatio()}`,
    );
  });

  it("falls back to Earth for an unknown body rather than breaking measurement", () => {
    setActiveEllipsoidId("nibiru");
    assert.equal(getActiveBodyRadiusRatio(), 1);
  });

  it("is positive and finite for every built-in body", () => {
    for (const ellipsoid of ELLIPSOIDS) {
      setActiveEllipsoidId(ellipsoid.id);
      const ratio = getActiveBodyRadiusRatio();
      assert.ok(Number.isFinite(ratio) && ratio > 0, `${ellipsoid.id} gave ${ratio}`);
    }
  });
});

describe("earthLengthToBody", () => {
  it("passes lengths through unchanged on Earth", () => {
    setActiveEllipsoidId("earth");
    assert.equal(earthLengthToBody(3065.81), 3065.81);
  });

  it("scales a Turf distance down by the radius ratio on Mars", () => {
    setActiveEllipsoidId("mars");
    // The repro on the issue: a span Turf/MeasureControl reported as 3065.81 km
    // on Mars is really ~1631 km of Martian ground.
    const corrected = earthLengthToBody(3065.81);
    assert.ok(Math.abs(corrected - 1631) < 2, `got ${corrected}`);
  });

  it("scales down by ~3.7x on the Moon", () => {
    setActiveEllipsoidId("moon");
    const corrected = earthLengthToBody(1000);
    assert.ok(Math.abs(corrected - 272.7) < 0.5, `got ${corrected}`);
  });
});

describe("bodyLengthToEarth", () => {
  it("passes lengths through unchanged on Earth", () => {
    setActiveEllipsoidId("earth");
    assert.equal(bodyLengthToEarth(5000), 5000);
  });

  it("is the exact inverse of earthLengthToBody", () => {
    for (const id of ["moon", "mars", "charon", "venus"]) {
      setActiveEllipsoidId(id);
      const roundTripped = earthLengthToBody(bodyLengthToEarth(1234.5));
      assert.ok(Math.abs(roundTripped - 1234.5) < 1e-9, `${id} gave ${roundTripped}`);
    }
  });

  it("widens a requested buffer distance so it spans that ground on Mars", () => {
    setActiveEllipsoidId("mars");
    // A 100 km Martian buffer is 100 / 0.532 ≈ 188 km of Earth arc for Turf.
    const turfDistance = bodyLengthToEarth(100);
    assert.ok(Math.abs(turfDistance - 100 / MARS_RATIO) < 1e-9);
    assert.ok(turfDistance > 187 && turfDistance < 189, `got ${turfDistance}`);
  });
});

describe("earthAreaToBody", () => {
  it("passes areas through unchanged on Earth", () => {
    setActiveEllipsoidId("earth");
    assert.equal(earthAreaToBody(1_000_000), 1_000_000);
  });

  it("scales by the square of the ratio, not the ratio", () => {
    setActiveEllipsoidId("mars");
    const corrected = earthAreaToBody(1_000_000);
    assert.ok(Math.abs(corrected - 1_000_000 * MARS_RATIO * MARS_RATIO) < 1e-6);
    // Guard against the easy mistake of applying the length correction to area.
    assert.ok(corrected < earthLengthToBody(1_000_000));
  });
});
