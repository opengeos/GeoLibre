import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  categoricalColumns,
  computeBar,
  computeBox,
  computeHistogram,
  computeLine,
  computePie,
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
    const data = rows({ x: 1, y: 10 }, { x: 2, y: 20 }, { x: "bad", y: 30 }, { x: 4, y: null });
    const result = computeScatter(data, "x", "y");
    assert.ok(result);
    assert.deepEqual(result.points, [
      { x: 1, y: 10 },
      { x: 2, y: 20 },
    ]);
    assert.equal(result.total, 2);
    assert.equal(result.xMin, 1);
    assert.equal(result.xMax, 2);
    assert.equal(result.yMin, 10);
    assert.equal(result.yMax, 20);
  });

  it("caps rendered points but keeps full count and extents", () => {
    const data = rows({ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }, { x: 9, y: 9 });
    const result = computeScatter(data, "x", "y", 2);
    assert.ok(result);
    assert.equal(result.points.length, 2); // capped sample
    assert.equal(result.total, 4); // full count
    assert.equal(result.xMax, 9); // extents span all points, not just the sample
    assert.equal(result.yMax, 9);
  });

  it("samples evenly across the dataset, not just the leading rows", () => {
    const data = Array.from({ length: 10 }, (_, i) => ({
      properties: { x: i, y: i },
    }));
    const result = computeScatter(data, "x", "y", 5);
    assert.ok(result);
    // stride = ceil(10/5) = 2 → indices 0,2,4,6,8 span the whole range.
    assert.deepEqual(
      result.points.map((p) => p.x),
      [0, 2, 4, 6, 8],
    );
  });

  it("returns null when no row has both values", () => {
    const data = rows({ x: 1, y: null }, { x: null, y: 2 });
    assert.equal(computeScatter(data, "x", "y"), null);
  });
});

describe("categoricalColumns", () => {
  it("keeps low-cardinality fields and drops high-cardinality ones", () => {
    const data = rows(
      { kind: "a", id: "u1" },
      { kind: "b", id: "u2" },
      { kind: "a", id: "u3" },
      { kind: "a", id: "u4" },
    );
    // kind has 2 distinct values; id has 4 (one per row) → excluded at cap 3.
    assert.deepEqual(categoricalColumns(data, ["kind", "id"], 3), ["kind"]);
  });

  it("treats low-cardinality numeric codes as categorical", () => {
    const data = rows({ year: 2020 }, { year: 2021 }, { year: 2020 });
    assert.deepEqual(categoricalColumns(data, ["year"]), ["year"]);
  });

  it("rejects fully-unique fields even in a small sample", () => {
    const data = rows({ code: "a" }, { code: "b" }, { code: "c" });
    assert.deepEqual(categoricalColumns(data, ["code"]), []);
  });

  it("rejects mostly-unique id-like columns relative to row count", () => {
    // 20 rows: `name` is unique per row (id-like) and excluded; `kind` repeats.
    const data = Array.from({ length: 20 }, (_, i) => ({
      properties: { name: `n${i}`, kind: i % 2 === 0 ? "x" : "y" },
    }));
    assert.deepEqual(categoricalColumns(data, ["name", "kind"]), ["kind"]);
  });
});

describe("computeBar", () => {
  const data = rows(
    { kind: "a", pop: 10 },
    { kind: "b", pop: 20 },
    { kind: "a", pop: 30 },
    { kind: "a", pop: null },
  );

  it("counts rows per category, sorted by value descending", () => {
    const result = computeBar(data, "kind", "count", null);
    assert.ok(result);
    assert.deepEqual(
      result.bars.map((b) => [b.label, b.value]),
      [
        ["a", 3],
        ["b", 1],
      ],
    );
    assert.equal(result.maxValue, 3);
  });

  it("sums and averages a value field over finite values only", () => {
    const sum = computeBar(data, "kind", "sum", "pop");
    assert.equal(sum?.bars.find((b) => b.label === "a")?.value, 40);
    const mean = computeBar(data, "kind", "mean", "pop");
    // category "a": values 10 and 30 (null skipped) → mean 20
    assert.equal(mean?.bars.find((b) => b.label === "a")?.value, 20);
  });

  it("reports a negative minValue and zero maxValue for all-negative sums", () => {
    const data = rows({ k: "a", v: -5 }, { k: "a", v: -3 }, { k: "b", v: -1 });
    const result = computeBar(data, "k", "sum", "v");
    assert.equal(result?.maxValue, 0);
    assert.equal(result?.minValue, -8);
  });

  it("omits sum/mean categories that have no numeric samples", () => {
    const data = rows({ kind: "a", v: 5 }, { kind: "b", v: null }, { kind: "b", v: "x" });
    // "b" has no finite value → excluded from sum (not shown as a zero bar).
    const result = computeBar(data, "kind", "sum", "v");
    assert.deepEqual(
      result?.bars.map((b) => b.label),
      ["a"],
    );
  });

  it("buckets null/blank categories as (blank) and caps to top-N", () => {
    const blanks = rows({ k: null }, { k: "" }, { k: "x" });
    const result = computeBar(blanks, "k", "count", null);
    assert.equal(result?.bars.find((b) => b.label === "(blank)")?.value, 2);

    const many = rows({ k: "a" }, { k: "b" }, { k: "c" }, { k: "a" });
    const capped = computeBar(many, "k", "count", null, 2);
    assert.equal(capped?.bars.length, 2);
    assert.equal(capped?.truncated, 1);
  });
});

describe("computeLine", () => {
  it("keeps original row index as x and skips non-numeric rows", () => {
    const data = rows({ v: 5 }, { v: "x" }, { v: 9 });
    const result = computeLine(data, "v");
    assert.ok(result);
    assert.deepEqual(result.points, [
      { index: 0, value: 5 },
      { index: 2, value: 9 },
    ]);
    assert.equal(result.min, 5);
    assert.equal(result.max, 9);
    assert.equal(result.length, 3);
  });

  it("returns null when no value is numeric", () => {
    assert.equal(computeLine(rows({ v: "a" }), "v"), null);
  });
});

describe("computeBox", () => {
  it("computes the five-number summary with interpolation", () => {
    const result = computeBox([1, 2, 3, 4, 5]);
    assert.deepEqual(result, {
      min: 1,
      q1: 2,
      median: 3,
      q3: 4,
      max: 5,
      count: 5,
    });
  });

  it("handles a single value and empty input", () => {
    assert.deepEqual(computeBox([7]), {
      min: 7,
      q1: 7,
      median: 7,
      q3: 7,
      max: 7,
      count: 1,
    });
    assert.equal(computeBox([]), null);
  });
});

describe("formatAxisValue", () => {
  it("formats integers, decimals, and extreme magnitudes compactly", () => {
    assert.equal(formatAxisValue(42), "42");
    assert.equal(formatAxisValue(3.14159), "3.142");
    assert.equal(formatAxisValue(0.5), "0.5");
    assert.equal(formatAxisValue(1234567), "1234567");
    assert.equal(formatAxisValue(0.0001), "1.0e-4");
    // negatives mirror their positive counterparts
    assert.equal(formatAxisValue(-42), "-42");
    assert.equal(formatAxisValue(-0.0001), "-1.0e-4");
    // very large integers switch to exponential so labels stay short
    assert.equal(formatAxisValue(9007199254740991), "9.0e+15");
  });
});

describe("computePie", () => {
  it("counts rows per category and totals the whole", () => {
    const data = rows({ kind: "a" }, { kind: "a" }, { kind: "b" }, { kind: null });
    const result = computePie(data, "kind", "count", null);
    assert.ok(result);
    assert.equal(result.total, 4);
    assert.equal(result.slices.length, 3); // a, b, (blank)
    assert.equal(result.slices[0].label, "a");
    assert.equal(result.slices[0].value, 2);
  });

  it("sums a value field and keeps only positive contributions", () => {
    const data = rows({ kind: "a", amt: 10 }, { kind: "b", amt: -5 }, { kind: "c", amt: 0 });
    const result = computePie(data, "kind", "sum", "amt");
    assert.ok(result);
    // Only "a" has a positive sum; non-positive slices are dropped.
    assert.equal(result.slices.length, 1);
    assert.equal(result.total, 10);
  });

  it("folds categories beyond the cap into an (other) slice", () => {
    const data = rows(...Array.from({ length: 12 }, (_, i) => ({ kind: `k${i}` })));
    const result = computePie(data, "kind", "count", null, 4);
    assert.ok(result);
    assert.equal(result.slices.length, 4);
    assert.equal(result.slices[3].label, "(other)");
    // 12 unique singletons; the top 3 are shown, the other 9 fold together.
    assert.equal(result.otherCount, 9);
    assert.equal(result.total, 12);
  });

  it("returns null when there is nothing positive to chart", () => {
    assert.equal(computePie(rows(), "kind", "count", null), null);
    assert.equal(computePie(rows({ kind: "a", amt: -1 }), "kind", "sum", "amt"), null);
  });

  it("renames the overflow slice when a real (other) category exists", () => {
    const data = rows(
      { kind: "(other)" },
      { kind: "(other)" },
      { kind: "a" },
      { kind: "b" },
      { kind: "c" },
    );
    // Cap at 2 slices: one real category plus the folded remainder. The real
    // "(other)" category is the largest, so the fold must use a distinct label.
    const result = computePie(data, "kind", "count", null, 2);
    assert.ok(result);
    const labels = result.slices.map((s) => s.label);
    assert.equal(new Set(labels).size, labels.length); // no duplicate labels
    assert.ok(labels.includes("(other categories)"));
  });
});
