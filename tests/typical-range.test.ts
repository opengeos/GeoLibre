import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatRangeBound,
  MIN_VALUES_TO_CLIP,
  typicalRange,
} from "../apps/geolibre-desktop/src/lib/typical-range";

/** 0, 1, …, n-1 — evenly spread, no outliers. */
const sequence = (n: number, start = 0): number[] => Array.from({ length: n }, (_, i) => start + i);

describe("typicalRange (#3455)", () => {
  it("returns null when there are no finite numbers", () => {
    assert.equal(typicalRange([]), null);
    assert.equal(typicalRange([null, undefined, Number.NaN, "12", Infinity]), null);
  });

  it("keeps the exact extent for values without outliers", () => {
    const range = typicalRange(sequence(1000));
    assert.deepEqual(range, {
      min: 0,
      max: 999,
      low: 0,
      high: 999,
      clipped: false,
      below: 0,
      above: 0,
      count: 1000,
    });
  });

  it("keeps the exact extent for a long tail that is not an outlier", () => {
    // A right-skewed field: the tail is long, but the typical span is still
    // more than a tenth of the extent, so nothing is clipped.
    const values = sequence(1000).map((i) => Math.round(Math.pow(i / 999, 2.2) * 4800));
    const range = typicalRange(values);
    assert.equal(range?.clipped, false);
    assert.equal(range?.low, range?.min);
    assert.equal(range?.high, range?.max);
  });

  it("clips to the 1st–99th percentile and counts the values beyond it", () => {
    // 1,282 typical values 0…4,800 plus one huge and one negative outlier.
    const typical = sequence(1282).map((i) => Math.round((i / 1281) * 4800));
    const range = typicalRange([...typical, 1e12, -42.5]);
    assert.ok(range);
    assert.equal(range.clipped, true);
    assert.equal(range.count, 1284);
    assert.equal(range.min, -42.5);
    assert.equal(range.max, 1e12);
    // Inward-rounded ranks: index ceil(0.01 · 1283) = 13 and floor(0.99 · 1283)
    // = 1270 of the sorted values, both real values from the field.
    const sorted = [...typical, 1e12, -42.5].sort((a, b) => a - b);
    assert.equal(range.low, sorted[13]);
    assert.equal(range.high, sorted[1270]);
    assert.ok(range.low >= 0 && range.high <= 4800);
    assert.equal(range.below, sorted.filter((value) => value < range.low).length);
    assert.equal(range.above, sorted.filter((value) => value > range.high).length);
    assert.ok(range.below >= 1 && range.above >= 1);
  });

  it("clips an all-negative field the same way", () => {
    const values = [...sequence(500, -600), -1e9];
    const range = typicalRange(values);
    assert.equal(range?.clipped, true);
    assert.equal(range?.min, -1e9);
    assert.ok((range?.low ?? 0) >= -600 && (range?.high ?? 0) <= -101);
    assert.ok((range?.below ?? 0) >= 1);
  });

  it("does not clip when every value is equal", () => {
    const range = typicalRange(Array(50).fill(7));
    assert.equal(range?.clipped, false);
    assert.equal(range?.low, 7);
    assert.equal(range?.high, 7);
  });

  it("does not clip when 99% of values are identical", () => {
    // The typical span is zero, so there is no slider to scale to.
    const range = typicalRange([...Array(200).fill(0), 1e12]);
    assert.equal(range?.clipped, false);
    assert.equal(range?.max, 1e12);
  });

  it("does not clip tiny arrays", () => {
    const tiny = [1, 2, 3, 1e12];
    assert.ok(tiny.length < MIN_VALUES_TO_CLIP);
    assert.equal(typicalRange(tiny)?.clipped, false);
    assert.equal(typicalRange([5])?.clipped, false);
  });

  it("ignores NaN, null and non-numbers", () => {
    const values: unknown[] = [...sequence(100), 1e12, Number.NaN, null, undefined, "9e99"];
    const range = typicalRange(values);
    assert.equal(range?.count, 101);
    assert.equal(range?.clipped, true);
    assert.equal(range?.above, 1);
  });
});

describe("formatRangeBound", () => {
  it("groups thousands and trims small values to three significant digits", () => {
    assert.equal(formatRangeBound(4615.4, "en"), "4,615");
    assert.equal(formatRangeBound(0.23456, "en"), "0.235");
    assert.equal(formatRangeBound(-42.5, "en"), "-42.5");
    assert.equal(formatRangeBound(0, "en"), "0");
  });

  it("switches to scientific notation at extreme magnitudes", () => {
    assert.equal(formatRangeBound(1e12, "en"), "1E12");
    assert.equal(formatRangeBound(Number.NaN, "en"), "");
  });
});
