import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  normalizeStretchMethod,
  percentile,
  stretchSamples,
  viewportRange,
  wantsAutoStretch,
} from "../apps/geolibre-desktop/src/lib/viewport-stretch";

function reading(values: number[], nodata: number | null) {
  return { values, nodata };
}

describe("stretchSamples", () => {
  it("drops the NoData sentinel even though it is a finite number", () => {
    // The bug this guards: -9999 passes Number.isFinite, so filtering on that
    // alone would leave the fill in and pin a min/max stretch to it.
    assert.deepEqual(stretchSamples(reading([-9999, 4, 9, -9999], -9999)), [4, 9]);
  });

  it("drops the NaN that an unreadable tile leaves behind", () => {
    assert.deepEqual(stretchSamples(reading([1, Number.NaN, 3], null)), [1, 3]);
  });

  it("keeps every finite sample when the raster declares no NoData", () => {
    assert.deepEqual(stretchSamples(reading([-9999, 0, 5], null)), [-9999, 0, 5]);
  });

  it("reads a window that missed the raster as no samples, not as a failure", () => {
    assert.deepEqual(stretchSamples(reading([], 0)), []);
  });

  it("treats an unavailable layer as no samples", () => {
    assert.deepEqual(stretchSamples(null), []);
    assert.deepEqual(stretchSamples(undefined), []);
  });
});

describe("viewportRange", () => {
  it("spans the whole sample under minmax", () => {
    assert.deepEqual(viewportRange([5, 1, 9, 3], "minmax"), [1, 9]);
  });

  it("clips the tails under percentile", () => {
    const values = Array.from({ length: 101 }, (_, index) => index);
    assert.deepEqual(viewportRange(values, "percentile"), [5, 95]);
  });

  it("spans two deviations either side of the mean under stddev", () => {
    // mean 5, population variance 4, so deviation 2 and the range is 5 +/- 4.
    assert.deepEqual(viewportRange([3, 7], "stddev"), [1, 9]);
  });

  it("collapses to the single value when the window sampled one usable pixel", () => {
    assert.deepEqual(viewportRange([7], "minmax"), [7, 7]);
    assert.deepEqual(viewportRange([7], "percentile"), [7, 7]);
  });
});

describe("percentile", () => {
  it("interpolates between the two straddling samples", () => {
    assert.equal(percentile([0, 10], 0.25), 2.5);
  });

  it("returns the only sample rather than indexing past the end", () => {
    assert.equal(percentile([42], 0.95), 42);
  });
});

describe("normalizeStretchMethod", () => {
  it("keeps a recognised method", () => {
    assert.equal(normalizeStretchMethod("percentile"), "percentile");
    assert.equal(normalizeStretchMethod("stddev"), "stddev");
    assert.equal(normalizeStretchMethod("minmax"), "minmax");
  });

  it("falls back to minmax for a missing or unrecognised value", () => {
    assert.equal(normalizeStretchMethod(undefined), "minmax");
    assert.equal(normalizeStretchMethod(null), "minmax");
    assert.equal(normalizeStretchMethod("bogus"), "minmax");
    assert.equal(normalizeStretchMethod(3), "minmax");
  });
});

describe("wantsAutoStretch", () => {
  it("drives a single-band raster with auto-stretch on", () => {
    assert.equal(wantsAutoStretch({ mode: "single", viewportStretchAuto: true }, false), true);
  });

  it("leaves the layer alone when auto-stretch is off", () => {
    assert.equal(wantsAutoStretch({ mode: "single" }, false), false);
    assert.equal(wantsAutoStretch({ mode: "single", viewportStretchAuto: false }, false), false);
  });

  it("skips an RGB layer, whose rescale holds one pair per channel", () => {
    // viewportStretchAuto is not cleared on the switch to RGB, so the mode
    // check is what stops a single-entry range overwriting all three.
    assert.equal(wantsAutoStretch({ mode: "rgb", viewportStretchAuto: true }, false), false);
  });

  it("skips a classified layer, whose range comes from its breaks", () => {
    assert.equal(wantsAutoStretch({ mode: "single", viewportStretchAuto: true }, true), false);
  });

  it("treats a missing or malformed raster state as not asking for it", () => {
    assert.equal(wantsAutoStretch(undefined, false), false);
    assert.equal(wantsAutoStretch(null, false), false);
    assert.equal(wantsAutoStretch([{ viewportStretchAuto: true }], false), false);
  });
});
