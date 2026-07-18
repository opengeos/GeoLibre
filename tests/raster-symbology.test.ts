import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GeoLibreLayer } from "@geolibre/core";
import {
  buildContinuousColormapRgba,
  buildSteppedColormapRgba,
  clampRasterClassCount,
  computeRasterBreaks,
  defaultRasterSymbology,
  percentileFromHistogram,
  savedRasterSymbology,
} from "../packages/plugins/src/plugins/raster-symbology";

function layerWith(rasterSymbology: unknown): GeoLibreLayer {
  return {
    id: "raster-1",
    name: "dem.tif",
    type: "cog",
    source: { type: "raster" },
    visible: true,
    opacity: 1,
    style: {} as GeoLibreLayer["style"],
    metadata: { rasterSymbology },
  };
}

describe("clampRasterClassCount", () => {
  it("clamps to [2, 12] and rounds", () => {
    assert.equal(clampRasterClassCount(0), 2);
    assert.equal(clampRasterClassCount(1), 2);
    assert.equal(clampRasterClassCount(99), 12);
    assert.equal(clampRasterClassCount(5.6), 6);
    assert.equal(clampRasterClassCount(Number.NaN), 2);
  });
});

describe("percentileFromHistogram", () => {
  const uniform = { min: 0, max: 100, histogram: Array(10).fill(10) };

  it("interpolates the median of a uniform histogram", () => {
    assert.equal(percentileFromHistogram(uniform, 0.5), 50);
  });

  it("returns the bounds at p=0 and p=1", () => {
    assert.equal(percentileFromHistogram(uniform, 0), 0);
    assert.equal(percentileFromHistogram(uniform, 1), 100);
  });

  it("returns min for an empty histogram", () => {
    assert.equal(percentileFromHistogram({ min: 5, max: 9, histogram: [] }, 0.5), 5);
  });
});

describe("computeRasterBreaks", () => {
  it("produces classCount+1 evenly spaced equal-interval edges", () => {
    const breaks = computeRasterBreaks("equal-interval", { min: 0, max: 100, histogram: [] }, 4);
    assert.deepEqual(breaks, [0, 25, 50, 75, 100]);
  });

  it("derives quantile edges from the histogram", () => {
    const breaks = computeRasterBreaks(
      "quantile",
      { min: 0, max: 100, histogram: Array(10).fill(10) },
      2,
    );
    assert.deepEqual(breaks, [0, 50, 100]);
  });

  it("passes through and sorts manual edges of the right length", () => {
    const breaks = computeRasterBreaks("manual", null, 3, [10, 0, 30, 20]);
    assert.deepEqual(breaks, [0, 10, 20, 30]);
  });

  it("falls back to equal-interval when manual edges are the wrong length", () => {
    const breaks = computeRasterBreaks("manual", { min: 0, max: 10, histogram: [] }, 2, [1, 2]);
    assert.deepEqual(breaks, [0, 5, 10]);
  });

  it("keeps fallback edges ascending when stats are absent and manual edges are unsorted", () => {
    const breaks = computeRasterBreaks("manual", null, 2, [10, -5]);
    assert.deepEqual(breaks, [-5, 2.5, 10]);
  });
});

describe("buildSteppedColormapRgba", () => {
  it("produces a 256x1 RGBA buffer with stepped class colors", () => {
    // viridis sampled to 2 classes: #440154 and #fde725.
    const rgba = buildSteppedColormapRgba([0, 1, 2], "viridis", false);
    assert.equal(rgba.length, 256 * 4);
    // First column -> class 0.
    assert.deepEqual([rgba[0], rgba[1], rgba[2], rgba[3]], [68, 1, 84, 255]);
    // Just below the midpoint stays in class 0, just above flips to class 1.
    assert.equal(rgba[127 * 4], 68);
    assert.equal(rgba[128 * 4], 253);
    // Last column -> class 1.
    assert.deepEqual([rgba[255 * 4], rgba[255 * 4 + 1], rgba[255 * 4 + 2]], [253, 231, 37]);
  });

  it("reverses the class colors when requested", () => {
    const rgba = buildSteppedColormapRgba([0, 1, 2], "viridis", true);
    // Reversed: first column is now the last class color.
    assert.deepEqual([rgba[0], rgba[1], rgba[2]], [253, 231, 37]);
    assert.deepEqual([rgba[255 * 4], rgba[255 * 4 + 1], rgba[255 * 4 + 2]], [68, 1, 84]);
  });

  it("renders a single flat color when the range is degenerate", () => {
    const rgba = buildSteppedColormapRgba([5, 5], "viridis", false);
    assert.equal(rgba.length, 256 * 4);
    assert.deepEqual([rgba[0], rgba[255 * 4]], [rgba[0], rgba[0]]);
  });

  it("uses custom colors over the named ramp when supplied", () => {
    // Two custom classes: pure red then pure blue, ignoring "viridis".
    const rgba = buildSteppedColormapRgba([0, 1, 2], "viridis", false, ["#ff0000", "#0000ff"]);
    assert.deepEqual([rgba[0], rgba[1], rgba[2]], [255, 0, 0]);
    assert.deepEqual([rgba[255 * 4], rgba[255 * 4 + 1], rgba[255 * 4 + 2]], [0, 0, 255]);
  });
});

describe("buildContinuousColormapRgba", () => {
  it("interpolates a smooth gradient across the row", () => {
    const rgba = buildContinuousColormapRgba(["#000000", "#ffffff"], false);
    assert.equal(rgba.length, 256 * 4);
    // Endpoints are the anchor colors; the middle is a midpoint gray.
    assert.deepEqual([rgba[0], rgba[1], rgba[2]], [0, 0, 0]);
    assert.deepEqual([rgba[255 * 4], rgba[255 * 4 + 1], rgba[255 * 4 + 2]], [255, 255, 255]);
    assert.ok(rgba[128 * 4] > 0 && rgba[128 * 4] < 255);
  });

  it("flips the gradient when reversed", () => {
    const rgba = buildContinuousColormapRgba(["#000000", "#ffffff"], true);
    assert.deepEqual([rgba[0], rgba[1], rgba[2]], [255, 255, 255]);
    assert.deepEqual([rgba[255 * 4], rgba[255 * 4 + 1], rgba[255 * 4 + 2]], [0, 0, 0]);
  });
});

describe("savedRasterSymbology", () => {
  it("returns null when absent or malformed", () => {
    assert.equal(savedRasterSymbology(layerWith(undefined)), null);
    assert.equal(savedRasterSymbology(layerWith({ ramp: "viridis" })), null);
    assert.equal(savedRasterSymbology(layerWith([1, 2, 3])), null);
  });

  it("validates a well-formed record beyond the authoring cap", () => {
    // A categorical symbology from the Raster Attribute Table stores one class
    // per pixel value, so stored classCounts above the UI's 12-class authoring
    // cap must round-trip (up to RASTER_MAX_STORED_CLASSES).
    const result = savedRasterSymbology(
      layerWith({
        classified: true,
        ramp: "plasma",
        method: "quantile",
        classCount: 99,
        breaks: Array.from({ length: 100 }, (_, index) => index),
      }),
    );
    assert.ok(result);
    assert.equal(result.classCount, 99);
    assert.equal(result.method, "quantile");
  });

  it("derives the class count from the breaks when the stored count disagrees", () => {
    // Legacy records could store a clamped-down count next to unclamped
    // breaks (or vice versa); the breaks are authoritative, so the record
    // renders from its edges instead of being dropped.
    const result = savedRasterSymbology(
      layerWith({
        classified: true,
        ramp: "plasma",
        method: "quantile",
        classCount: 99,
        breaks: Array.from({ length: 13 }, (_, index) => index),
      }),
    );
    assert.ok(result);
    assert.equal(result.classCount, 12);
  });

  it("rejects breaks outside the stored-class bounds", () => {
    const base = {
      classified: true,
      ramp: "plasma",
      method: "quantile" as const,
      classCount: 5,
    };
    // One class (two edges) is below the two-class minimum.
    assert.equal(savedRasterSymbology(layerWith({ ...base, breaks: [0, 1] })), null);
    // 258 edges would be 257 classes, past RASTER_MAX_STORED_CLASSES.
    assert.equal(
      savedRasterSymbology(
        layerWith({
          ...base,
          breaks: Array.from({ length: 258 }, (_, index) => index),
        }),
      ),
      null,
    );
  });

  it("keeps and normalizes custom colors with >= 2 valid entries", () => {
    const result = savedRasterSymbology(
      layerWith({
        classified: false,
        ramp: "viridis",
        customColors: ["#F00", "00ff00", "garbage"],
        reversed: false,
        method: "equal-interval",
        classCount: 5,
        breaks: [0, 1, 2, 3, 4, 5],
      }),
    );
    assert.ok(result);
    assert.deepEqual(result.customColors, ["#ff0000", "#00ff00"]);
  });

  it("drops custom colors that resolve to fewer than two valid entries", () => {
    const result = savedRasterSymbology(
      layerWith({
        classified: false,
        ramp: "viridis",
        customColors: ["#ff0000", "nope"],
        reversed: false,
        method: "equal-interval",
        classCount: 5,
        breaks: [0, 1, 2, 3, 4, 5],
      }),
    );
    assert.ok(result);
    assert.equal(result.customColors, undefined);
  });

  it("rejects non-ascending or wrong-length breaks", () => {
    assert.equal(
      savedRasterSymbology(
        layerWith({
          classified: true,
          ramp: "viridis",
          reversed: false,
          method: "equal-interval",
          classCount: 2,
          breaks: [0, 50], // needs 3 edges
        }),
      ),
      null,
    );
    assert.equal(
      savedRasterSymbology(
        layerWith({
          classified: true,
          ramp: "viridis",
          reversed: false,
          method: "equal-interval",
          classCount: 2,
          breaks: [0, 100, 50], // not ascending
        }),
      ),
      null,
    );
  });
});

describe("defaultRasterSymbology", () => {
  it("starts unclassified with correctly sized equal-interval edges", () => {
    const symbology = defaultRasterSymbology("turbo", {
      min: 0,
      max: 10,
      histogram: [],
    });
    assert.equal(symbology.classified, false);
    assert.equal(symbology.ramp, "turbo");
    assert.equal(symbology.breaks.length, symbology.classCount + 1);
    assert.equal(symbology.breaks[0], 0);
    assert.equal(symbology.breaks.at(-1), 10);
  });
});
