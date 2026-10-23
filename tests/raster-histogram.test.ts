import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  autoStretchRange,
  effectiveChannelRange,
  histogramBars,
  histogramBinEdges,
  histogramDomain,
  histogramPercentile,
  moveHandle,
  nearestHandle,
  nudgeStep,
  pixelToValue,
  roundForDomain,
  setChannelRange,
  valueToPixel,
} from "../apps/geolibre-desktop/src/lib/raster-histogram";

const flat = { min: 0, max: 100, histogram: [10, 10, 10, 10] };

describe("histogramBinEdges", () => {
  it("returns bins + 1 evenly spaced edges from min to max", () => {
    assert.deepEqual(histogramBinEdges(flat), [0, 25, 50, 75, 100]);
  });

  it("pins the last edge to max so float drift never shortens the top bin", () => {
    const edges = histogramBinEdges({ min: 0, max: 0.3, histogram: [1, 1, 1] });
    assert.equal(edges.length, 4);
    assert.equal(edges[3], 0.3);
  });

  it("has no edges for an empty histogram", () => {
    assert.deepEqual(histogramBinEdges({ min: 0, max: 1, histogram: [] }), []);
  });
});

describe("histogramPercentile / autoStretchRange", () => {
  it("interpolates within a bin", () => {
    assert.equal(histogramPercentile(flat, 0.5), 50);
    assert.equal(histogramPercentile(flat, 0.1), 10);
  });

  it("mirrors the renderer's 2-98 percentile auto stretch", () => {
    const [lo, hi] = autoStretchRange(flat);
    assert.ok(Math.abs(lo - 2) < 1e-9);
    assert.ok(Math.abs(hi - 98) < 1e-9);
  });

  it("falls back to the data extremes for an empty histogram", () => {
    const empty = { min: 3, max: 9, histogram: [0, 0] };
    assert.deepEqual(autoStretchRange(empty), [3, 9]);
  });
});

describe("histogramDomain", () => {
  it("spans the data range by default", () => {
    assert.deepEqual(histogramDomain(flat), [0, 100]);
  });

  it("widens to include a stretch set past the data", () => {
    assert.deepEqual(histogramDomain(flat, [-20, 140]), [-20, 140]);
  });

  it("has no domain for constant data", () => {
    assert.equal(histogramDomain({ min: 5, max: 5, histogram: [4] }), null);
  });

  it("ignores non-finite range values", () => {
    assert.deepEqual(histogramDomain(flat, [Number.NaN, 50]), [0, 100]);
  });
});

describe("valueToPixel / pixelToValue", () => {
  const domain: [number, number] = [100, 200];

  it("maps values linearly onto the chart width and back", () => {
    assert.equal(valueToPixel(150, domain, 240), 120);
    assert.equal(pixelToValue(120, domain, 240), 150);
    assert.equal(valueToPixel(100, domain, 240), 0);
    assert.equal(valueToPixel(200, domain, 240), 240);
  });

  it("clamps values outside the domain to the chart edges", () => {
    assert.equal(valueToPixel(50, domain, 240), 0);
    assert.equal(valueToPixel(500, domain, 240), 240);
  });

  it("clamps a pointer dragged past either end to the domain", () => {
    assert.equal(pixelToValue(-30, domain, 240), 100);
    assert.equal(pixelToValue(999, domain, 240), 200);
  });

  it("degrades safely on a zero-width chart or domain", () => {
    assert.equal(pixelToValue(10, domain, 0), 100);
    assert.equal(valueToPixel(5, [1, 1], 240), 0);
  });
});

describe("roundForDomain", () => {
  it("rounds reflectance-scale values to integers", () => {
    assert.equal(roundForDomain(1234.5678, [0, 10000]), 1235);
  });

  it("keeps three decimals for a unit domain", () => {
    assert.equal(roundForDomain(0.123456, [0, 1]), 0.123);
  });
});

describe("moveHandle", () => {
  const domain: [number, number] = [0, 100];

  it("moves only the grabbed handle", () => {
    assert.deepEqual(moveHandle([10, 90], "min", 20, domain), [20, 90]);
    assert.deepEqual(moveHandle([10, 90], "max", 80, domain), [10, 80]);
  });

  it("clamps to the domain", () => {
    assert.deepEqual(moveHandle([10, 90], "min", -50, domain), [0, 90]);
    assert.deepEqual(moveHandle([10, 90], "max", 500, domain), [10, 100]);
  });

  it("never lets the handles cross or meet", () => {
    const [lo, hi] = moveHandle([10, 90], "min", 95, domain);
    assert.ok(lo < hi);
    assert.equal(hi, 90);
    const [lo2, hi2] = moveHandle([10, 90], "max", 5, domain);
    assert.ok(lo2 < hi2);
    assert.equal(lo2, 10);
  });
});

describe("nearestHandle / nudgeStep", () => {
  it("grabs the nearer handle", () => {
    assert.equal(nearestHandle([10, 90], 20), "min");
    assert.equal(nearestHandle([10, 90], 70), "max");
  });

  it("breaks a tie by the side of the window the press is on", () => {
    assert.equal(nearestHandle([50, 50], 40), "min");
    assert.equal(nearestHandle([50, 50], 60), "max");
  });

  it("nudges by a hundredth of the domain", () => {
    assert.equal(nudgeStep([0, 500]), 5);
    assert.equal(nudgeStep([3, 3]), 0);
  });
});

describe("histogramBars", () => {
  it("projects each non-empty bin onto the chart, scaled to the tallest", () => {
    const bars = histogramBars({ min: 0, max: 100, histogram: [5, 0, 10, 0] }, [0, 100], 200, 40);
    assert.deepEqual(bars, [
      { x: 0, width: 50, height: 20 },
      { x: 100, width: 50, height: 40 },
    ]);
  });

  it("draws nothing for an all-empty histogram", () => {
    assert.deepEqual(histogramBars({ min: 0, max: 1, histogram: [0, 0] }, [0, 1], 100, 10), []);
  });
});

describe("setChannelRange / effectiveChannelRange", () => {
  it("keeps a single-band rescale as one pair", () => {
    assert.deepEqual(setChannelRange(null, 0, [5, 50], [[5, 50]]), [[5, 50]]);
    assert.deepEqual(setChannelRange([[1, 2]], 0, [5, 50], [[1, 2]]), [[5, 50]]);
  });

  it("pins the other RGB channels at their auto windows when rescale was unset", () => {
    const next = setChannelRange(
      null,
      1,
      [10, 20],
      [
        [0, 1],
        [2, 3],
        [4, 5],
      ],
    );
    assert.deepEqual(next, [
      [0, 1],
      [10, 20],
      [4, 5],
    ]);
  });

  it("expands a broadcast single pair to every RGB channel before editing one", () => {
    const next = setChannelRange(
      [[0, 255]],
      2,
      [10, 200],
      [
        [0, 255],
        [0, 255],
        [0, 255],
      ],
    );
    assert.deepEqual(next, [
      [0, 255],
      [0, 255],
      [10, 200],
    ]);
  });

  it("reads a channel's saved pair, the broadcast pair, or the auto window", () => {
    assert.deepEqual(
      effectiveChannelRange(
        [
          [0, 1],
          [2, 3],
        ],
        1,
        null,
      ),
      [2, 3],
    );
    assert.deepEqual(effectiveChannelRange([[0, 9]], 2, null), [0, 9]);
    const auto = effectiveChannelRange(null, 0, flat);
    assert.ok(auto && Math.abs(auto[0] - 2) < 1e-9 && Math.abs(auto[1] - 98) < 1e-9);
    assert.equal(effectiveChannelRange(null, 0, null), null);
  });
});
