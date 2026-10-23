/**
 * Tests for the Measure tool's heading readout (issue #1817).
 *
 * The lab material this was built for checks a student's work by heading
 * ("your heading should be about 310 degrees"), so the azimuth has to be a true
 * great-circle bearing rather than a screen-space angle, and it has to survive
 * the cases where the terrain section gives up.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  compassPoint,
  finalAzimuthDegrees,
  forwardAzimuthDegrees,
} from "../packages/plugins/src/plugins/terrain-measure-geometry";
import { bearingRows } from "../packages/plugins/src/plugins/terrain-measure";

const pt = (lng: number, lat: number) => ({ lng, lat });

describe("forwardAzimuthDegrees", () => {
  it("reads 0 due north and 90 due east", () => {
    assert.equal(Math.round(forwardAzimuthDegrees([0, 0], [0, 10])), 0);
    assert.equal(Math.round(forwardAzimuthDegrees([0, 0], [10, 0])), 90);
  });

  it("reads 180 due south and 270 due west", () => {
    assert.equal(Math.round(forwardAzimuthDegrees([0, 10], [0, 0])), 180);
    assert.equal(Math.round(forwardAzimuthDegrees([10, 0], [0, 0])), 270);
  });

  it("normalises into [0, 360)", () => {
    for (const [a, b] of [
      [
        [0, 0],
        [-10, 10],
      ],
      [
        [0, 0],
        [-10, -10],
      ],
      [
        [179, 0],
        [-179, 5],
      ],
    ] as [[number, number], [number, number]][]) {
      const azimuth = forwardAzimuthDegrees(a, b);
      assert.ok(azimuth >= 0 && azimuth < 360, `azimuth out of range: ${azimuth}`);
    }
  });

  it("is a great-circle bearing, not a flat-map one", () => {
    // Washington D.C. to London. On a Mercator map the line looks due east
    // (~90 deg); the true initial great-circle bearing is markedly north of that.
    const initial = forwardAzimuthDegrees([-77.0366, 38.8977], [-0.1431, 51.5008]);
    assert.ok(initial > 40 && initial < 60, `expected a NE-ish bearing, got ${initial}`);
  });
});

describe("finalAzimuthDegrees", () => {
  it("matches the initial bearing along a meridian", () => {
    // Due north is due north the whole way, so the two ends agree.
    assert.equal(
      Math.round(finalAzimuthDegrees([0, 0], [0, 10])),
      Math.round(forwardAzimuthDegrees([0, 0], [0, 10])),
    );
  });

  it("diverges from the initial bearing on a long geodesic", () => {
    const a: [number, number] = [-77.0366, 38.8977]; // Washington D.C.
    const b: [number, number] = [-0.1431, 51.5008]; // London
    const diff = Math.abs(finalAzimuthDegrees(a, b) - forwardAzimuthDegrees(a, b));
    assert.ok(diff > 30, `expected a large convergence, got ${diff}`);
  });
});

describe("compassPoint", () => {
  it("labels the cardinals and a diagonal", () => {
    assert.equal(compassPoint(0), "N");
    assert.equal(compassPoint(90), "E");
    assert.equal(compassPoint(180), "S");
    assert.equal(compassPoint(270), "W");
    assert.equal(compassPoint(310), "NW");
  });

  it("wraps past 360 back to north", () => {
    assert.equal(compassPoint(359), "N");
    assert.equal(compassPoint(360), "N");
  });
});

describe("bearingRows", () => {
  it("reports a heading for a two-point line", () => {
    const rows = bearingRows({ mode: "distance", points: [pt(0, 0), pt(10, 0)] });
    assert.equal(rows.length, 1);
    assert.match(rows[0][1], /^90° E$/);
  });

  it("adds a final heading only when it differs from the initial one", () => {
    // Short line: the two ends agree, so one row.
    const short = bearingRows({ mode: "distance", points: [pt(0, 0), pt(0.01, 0)] });
    assert.equal(short.length, 1);

    // Trans-Atlantic: convergence is large, so the final heading earns a row.
    const long = bearingRows({
      mode: "distance",
      points: [pt(-77.0366, 38.8977), pt(-0.1431, 51.5008)],
    });
    assert.equal(long.length, 2);
  });

  it("uses the overall first-to-last bearing for a multi-point path", () => {
    // A dog-leg north then east still reports the straight-line NE bearing
    // rather than either individual segment.
    const rows = bearingRows({
      mode: "distance",
      points: [pt(0, 0), pt(0, 10), pt(10, 10)],
    });
    assert.equal(rows.length, 1);
    const degrees = Number.parseFloat(rows[0][1]);
    assert.ok(degrees > 0 && degrees < 90, `expected a NE bearing, got ${rows[0][1]}`);
  });

  it("stays empty for an area measurement", () => {
    assert.deepEqual(bearingRows({ mode: "area", points: [pt(0, 0), pt(1, 0), pt(1, 1)] }), []);
  });

  it("never renders a heading as 360 degrees", () => {
    // An azimuth just under 360 rounds up; "360°" is not a bearing anyone
    // writes, and it disagrees with the "N" the compass label gives it.
    const rows = bearingRows({ mode: "distance", points: [pt(0, 0), pt(-0.0001, 10)] });
    assert.equal(rows.length, 1);
    assert.match(rows[0][1], /^0° N$/, `expected 0 rather than 360: ${rows[0][1]}`);
  });

  it("stays empty for antipodal endpoints", () => {
    // Antipodal points lie on infinitely many great circles, so atan2 still
    // returns a number but it is floating-point noise, not a heading.
    assert.deepEqual(bearingRows({ mode: "distance", points: [pt(0, 0), pt(180, 0)] }), []);
    assert.deepEqual(bearingRows({ mode: "distance", points: [pt(30, 45), pt(-150, -45)] }), []);
  });

  it("does not add a final-heading row that renders identically", () => {
    // The gate compares rendered values, so a raw difference that rounds to the
    // same degree must not produce a second row saying the same thing.
    for (const [lng, lat] of [
      [0.4, 0.1],
      [1, 0.05],
      [-0.6, 0.2],
    ] as [number, number][]) {
      const rows = bearingRows({ mode: "distance", points: [pt(0, 0), pt(lng, lat)] });
      assert.equal(rows.length, 1, `expected a single heading row for ${lng},${lat}`);
    }
  });

  it("stays empty for endpoints separated only by floating-point dust", () => {
    // Number.EPSILON is below the representable step at 5, so 5 + EPSILON === 5
    // and that fixture would only re-test exact equality. 1e-12 is genuinely a
    // different double while still far under the degeneracy tolerance.
    const nudged = 5 + 1e-12;
    assert.notEqual(nudged, 5, "fixture must be a representably distinct value");
    assert.deepEqual(bearingRows({ mode: "distance", points: [pt(5, 5), pt(nudged, 5)] }), []);
  });

  it("treats the antimeridian written both ways as the same point", () => {
    assert.deepEqual(bearingRows({ mode: "distance", points: [pt(180, 5), pt(-180, 5)] }), []);
  });

  it("stays empty for a degenerate or unfinished line", () => {
    assert.deepEqual(bearingRows({ mode: "distance", points: [pt(0, 0)] }), []);
    // Both ends on the same coordinate has no defined bearing.
    assert.deepEqual(bearingRows({ mode: "distance", points: [pt(5, 5), pt(5, 5)] }), []);
  });
});
