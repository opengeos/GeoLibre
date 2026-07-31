import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { globeSafeMaxZoom, mercatorFitZoom } from "../packages/map/src/globe-fit-bounds";

/** The viewport the globe measurements in `globe-fit-bounds.ts` were taken on. */
const VIEWPORT = { width: 576, height: 648 };

/**
 * The extent of the KMZ that prompted the ceiling (opengeos/GeoLibre#1552):
 * 426 points across the United States plus three in London, Osaka, and
 * south-east Asia, so the box spans 259°.
 */
const WIDE_BOUNDS: [number, number, number, number] = [
  -124.1624694032033, 16.53894241180868, 135.5137398572391, 51.58247091548506,
];

const close = (actual: number | null, expected: number, tolerance = 0.001): boolean =>
  actual !== null && Math.abs(actual - expected) < tolerance;

describe("mercatorFitZoom", () => {
  it("matches the zoom MapLibre settles on for a flat-map fit", () => {
    // Measured against the live map under the mercator projection on this
    // viewport: zoom 0.4254793721754276.
    const zoom = mercatorFitZoom(WIDE_BOUNDS, VIEWPORT, 40);
    assert.ok(close(zoom, 0.4255), `expected ~0.4255, got ${zoom}`);
  });

  it("zooms further out the wider the extent gets", () => {
    // The globe camera does the opposite past ~150°, which is the whole bug.
    const zooms = [10, 40, 90, 150, 259, 359].map((width) =>
      mercatorFitZoom([-width / 2, -10, width / 2, 10], VIEWPORT, 40),
    );
    for (let index = 1; index < zooms.length; index += 1) {
      const previous = zooms[index - 1];
      const current = zooms[index];
      assert.ok(previous !== null && current !== null);
      assert.ok(current < previous, `zoom rose from ${previous} to ${current}`);
    }
  });

  it("constrains on whichever axis is tighter", () => {
    const tall = mercatorFitZoom([-1, -60, 1, 60], VIEWPORT, 40);
    const wide = mercatorFitZoom([-60, -1, 60, 1], VIEWPORT, 40);
    assert.ok(tall !== null && wide !== null);
    assert.ok(tall < wide);
  });

  it("ignores an axis with no extent", () => {
    // A perfectly horizontal line has no height; its width alone sets the zoom.
    const line = mercatorFitZoom([-60, 10, 60, 10], VIEWPORT, 40);
    const sliver = mercatorFitZoom([-60, 9.9, 60, 10.1], VIEWPORT, 40);
    assert.ok(line !== null && sliver !== null);
    assert.ok(Math.abs(line - sliver) < 0.05);
  });

  it("returns null for a point-sized extent", () => {
    assert.equal(mercatorFitZoom([5, 5, 5, 5], VIEWPORT, 40), null);
  });

  it("returns null when padding leaves no room", () => {
    assert.equal(mercatorFitZoom(WIDE_BOUNDS, { width: 60, height: 60 }, 40), null);
  });

  it("returns null for a non-finite extent", () => {
    assert.equal(mercatorFitZoom([Number.NaN, 0, 10, 10], VIEWPORT, 40), null);
  });

  it("takes the short way round the antimeridian", () => {
    // [170 … -170] spans 20°, not the 340° complement, so it must fit as
    // tightly as the equivalent box that does not wrap.
    const wrapped = mercatorFitZoom([170, -10, -170, 10], VIEWPORT, 40);
    const plain = mercatorFitZoom([-10, -10, 10, 10], VIEWPORT, 40);
    assert.ok(wrapped !== null && plain !== null);
    assert.ok(close(wrapped, plain), `${wrapped} should match the unwrapped ${plain}`);
  });

  it("still reads a full-world extent as 360 degrees", () => {
    const world = mercatorFitZoom([-180, -10, 180, 10], VIEWPORT, 40);
    assert.ok(world !== null && world < 0.1, `expected a whole-world fit, got ${world}`);
  });
});

describe("globeSafeMaxZoom", () => {
  it("caps an extent wider than a hemisphere at the flat-map fit", () => {
    const maxZoom = globeSafeMaxZoom(WIDE_BOUNDS, VIEWPORT, 40);
    assert.ok(close(maxZoom, 0.4255), `expected ~0.4255, got ${maxZoom}`);
  });

  it("leaves a continent-scale fit to MapLibre", () => {
    // Measured on this viewport, the globe camera frames a 90°-wide box with
    // its whole outline inside the padding, so capping it would only pull the
    // camera back for nothing.
    assert.equal(globeSafeMaxZoom([-140, 20, -50, 60], VIEWPORT, 40), null);
    assert.equal(globeSafeMaxZoom([-140, 20, -50, 60], VIEWPORT, 40, 16), 16);
  });

  it("leaves a tall, narrow extent to MapLibre", () => {
    // Latitude cannot span more than 180°, and the globe fit was measured to
    // keep a near-pole-to-pole box in frame, so height alone never triggers
    // the cap; a whole-world extent is caught by its width instead.
    assert.equal(globeSafeMaxZoom([-2, -85, 2, 85], VIEWPORT, 40), null);
  });

  it("caps a whole-world extent", () => {
    const maxZoom = globeSafeMaxZoom([-180, -85, 180, 85], VIEWPORT, 40);
    assert.ok(maxZoom !== null && maxZoom < 1, `expected a whole-globe fit, got ${maxZoom}`);
  });

  it("reads an antimeridian-crossing extent as the span it covers", () => {
    // [170 … -170] covers 20°, not the 340° complement, so it is nowhere near
    // wide enough to need the cap.
    assert.equal(globeSafeMaxZoom([170, -10, -170, 10], VIEWPORT, 40), null);
  });

  it("returns whichever of the two ceilings is tighter", () => {
    // A whole-world extent needs a zoom below 0, so a caller's zoom-16 ceiling
    // cannot loosen it; a sub-hemisphere extent keeps the caller's ceiling
    // untouched (see the continent-scale case above).
    const capped = globeSafeMaxZoom([-180, -85, 180, 85], VIEWPORT, 40, 16);
    const uncapped = globeSafeMaxZoom([-180, -85, 180, 85], VIEWPORT, 40);
    assert.equal(capped, uncapped);
  });

  it("falls back to the caller's ceiling when the viewport is unmeasurable", () => {
    assert.equal(globeSafeMaxZoom(WIDE_BOUNDS, null, 40, 16), 16);
  });

  it("returns null when neither a ceiling nor a viewport applies", () => {
    assert.equal(globeSafeMaxZoom(WIDE_BOUNDS, null, 40), null);
  });
});
