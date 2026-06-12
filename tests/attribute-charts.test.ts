import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeHistogram,
  computeScatter,
  formatAxisValue,
  numericColumns,
  numericValues,
  toFiniteNumber,
  type ChartRow,
} from "../apps/geolibre-desktop/src/lib/attribute-charts";

function rows(...properties: Record<string, unknown>[]): ChartRow[] {
  return properties.map((p) => ({ properties: p }));
}

describe("toFiniteNumber", () => {
  it("accepts finite numbers and numeric strings, rejects the rest", () => {
    assert.equal(toFiniteNumber(42), 42);
    assert.equal(toFiniteNumber("3.5"), 3.5);
    assert.equal(toFiniteNumber("  -7 "), -7);
    assert.equal(toFiniteNumber(""), null);
    assert.equal(toFiniteNumber("abc"), null);
    assert.equal(toFiniteNumber(true), null);
    assert.equal(toFiniteNumber(null), null);
    assert.equal(toFiniteNumber(Number.NaN), null);
    assert.equal(toFiniteNumber(Infinity), null);
  });
});

describe("numericColumns", () => {
  it("keeps columns that are mostly numeric, drops text/id-like ones", () => {
    const data = rows(
      { pop: 10, name: "A", code: "x1" },
      { pop: 20, name: "B", code: "x2" },
      { pop: 30, name: "C", code: 99 },
    );
    assert.deepEqual(numericColumns(data, ["pop", "name", "code"]), ["pop"]);
  });

  it("requires at least two numeric values", () => {
    const data = rows({ a: 1 }, { a: null }, { a: "" });
    assert.deepEqual(numericColumns(data, ["a"]), []);
  });

  it("accepts numeric strings as numeric", () => {
    const data = rows({ a: "1" }, { a: "2" }, { a: "3" });
    assert.deepEqual(numericColumns(data, ["a"]), ["a"]);
  });
});

describe("numericValues", () => {
  it("collects only the finite numeric values", () => {
    const data = rows({ a: 1 }, { a: "2" }, { a: "x" }, { a: null });
    assert.deepEqual(numericValues(data, "a"), [1, 2]);
  });
});

describe("computeHistogram", () => {
  it("returns null for no values", () => {
    assert.equal(computeHistogram([], 10), null);
  });

  it("bins values into equal-width buckets with the max in the last bin", () => {
    const result = computeHistogram([0, 1, 2, 3, 4], 2);
    assert.ok(result);
    assert.equal(result.min, 0);
    assert.equal(result.max, 4);
    assert.equal(result.total, 5);
    assert.equal(result.bins.length, 2);
    // bin 0: [0,2) -> 0,1 ; bin 1: [2,4] -> 2,3,4
    assert.equal(result.bins[0].count, 2);
    assert.equal(result.bins[1].count, 3);
    assert.equal(result.maxCount, 3);
  });

  it("collapses to a single bin when all values are equal", () => {
    const result = computeHistogram([5, 5, 5], 8);
    assert.ok(result);
    assert.equal(result.bins.length, 1);
    assert.equal(result.bins[0].count, 3);
    assert.equal(result.min, 5);
    assert.equal(result.max, 5);
  });

  it("clamps the bin count into range", () => {
    assert.equal(computeHistogram([1, 2, 3], 0)?.bins.length, 1);
    assert.equal(computeHistogram([1, 2, 3], 999)?.bins.length, 50);
  });
});

describe("computeScatter", () => {
  it("returns only rows where both fields are finite, with extents", () => {
    const data = rows(
      { x: 1, y: 10 },
      { x: 2, y: 20 },
      { x: "bad", y: 30 },
      { x: 4, y: null },
    );
    const result = computeScatter(data, "x", "y");
    assert.ok(result);
    assert.deepEqual(result.points, [
      { x: 1, y: 10 },
      { x: 2, y: 20 },
    ]);
    assert.equal(result.xMin, 1);
    assert.equal(result.xMax, 2);
    assert.equal(result.yMin, 10);
    assert.equal(result.yMax, 20);
  });

  it("returns null when no row has both values", () => {
    const data = rows({ x: 1, y: null }, { x: null, y: 2 });
    assert.equal(computeScatter(data, "x", "y"), null);
  });
});

describe("formatAxisValue", () => {
  it("formats integers, decimals, and extreme magnitudes compactly", () => {
    assert.equal(formatAxisValue(42), "42");
    assert.equal(formatAxisValue(3.14159), "3.142");
    assert.equal(formatAxisValue(0.5), "0.5");
    assert.equal(formatAxisValue(1234567), "1234567");
    assert.equal(formatAxisValue(0.0001), "1.0e-4");
  });
});
