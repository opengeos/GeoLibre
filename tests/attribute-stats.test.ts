import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  coerceNumericStringRows,
  type ChartRow,
} from "../apps/geolibre-desktop/src/lib/attribute-charts";
import {
  computeFieldStats,
  computeNumericStats,
  computeTextStats,
  formatStatValue,
  resolveStatsScope,
  statsScopeAvailability,
  type NumericFieldStats,
  type TextFieldStats,
} from "../apps/geolibre-desktop/src/lib/attribute-stats";

function rows(...properties: Record<string, unknown>[]): ChartRow[] {
  return properties.map((p) => ({ properties: p }));
}

describe("computeNumericStats", () => {
  it("returns null for an empty sample", () => {
    assert.equal(computeNumericStats([]), null);
  });

  it("computes the full summary for a numeric sample", () => {
    const stats = computeNumericStats([2, 4, 4, 4, 5, 5, 7, 9]);
    assert.ok(stats);
    assert.equal(stats.kind, "numeric");
    assert.equal(stats.count, 8);
    assert.equal(stats.min, 2);
    assert.equal(stats.max, 9);
    assert.equal(stats.sum, 40);
    assert.equal(stats.mean, 5);
    assert.equal(stats.median, 4.5);
    assert.equal(stats.unique, 5);
    // Sample standard deviation (n − 1).
    assert.ok(Math.abs(stats.std - 2.13809) < 1e-4);
  });

  it("uses the middle value as median for an odd count", () => {
    const stats = computeNumericStats([3, 1, 2]) as NumericFieldStats;
    assert.equal(stats.median, 2);
  });

  it("reports a zero standard deviation for a single value", () => {
    const stats = computeNumericStats([42]) as NumericFieldStats;
    assert.equal(stats.std, 0);
    assert.equal(stats.mean, 42);
    assert.equal(stats.median, 42);
  });

  it("folds in the supplied null and non-numeric counts", () => {
    const stats = computeNumericStats([1, 2], 3, 1) as NumericFieldStats;
    assert.equal(stats.nulls, 3);
    assert.equal(stats.nonNumeric, 1);
  });
});

describe("computeTextStats", () => {
  it("counts populated, blank, and distinct values", () => {
    const data = rows(
      { city: "A" },
      { city: "B" },
      { city: "A" },
      { city: "" },
      { city: null },
      { city: "   " },
    );
    const stats = computeTextStats(data, "city");
    assert.equal(stats.kind, "text");
    assert.equal(stats.count, 3);
    assert.equal(stats.nulls, 3);
    assert.equal(stats.unique, 2);
  });

  it("lists the most frequent values, ties broken alphabetically", () => {
    const data = rows({ c: "x" }, { c: "x" }, { c: "y" }, { c: "y" }, { c: "z" }, { c: "a" });
    const stats = computeTextStats(data, "c", 2);
    assert.deepEqual(stats.top, [
      { value: "x", count: 2 },
      { value: "y", count: 2 },
    ]);
  });

  it("coerces non-string values to their string form", () => {
    const data = rows({ c: 1 }, { c: 1 }, { c: true });
    const stats = computeTextStats(data, "c") as TextFieldStats;
    assert.equal(stats.unique, 2);
    assert.equal(stats.top[0].value, "1");
    assert.equal(stats.top[0].count, 2);
  });
});

describe("computeFieldStats", () => {
  it("treats a mostly-numeric field as numeric and counts blanks", () => {
    const data = rows({ pop: 10 }, { pop: "20" }, { pop: 30 }, { pop: null }, { pop: "" });
    const stats = computeFieldStats(data, "pop") as NumericFieldStats;
    assert.equal(stats.kind, "numeric");
    assert.equal(stats.count, 2);
    assert.equal(stats.nulls, 2);
    assert.equal(stats.nonNumeric, 1);
    assert.equal(stats.sum, 40);
  });

  it("counts non-numeric non-blank values separately for a numeric field", () => {
    const data = rows({ v: 1 }, { v: 2 }, { v: 3 }, { v: "n/a" });
    const stats = computeFieldStats(data, "v") as NumericFieldStats;
    assert.equal(stats.kind, "numeric");
    assert.equal(stats.count, 3);
    assert.equal(stats.nonNumeric, 1);
    assert.equal(stats.nulls, 0);
  });

  it("treats an id-like text field as text", () => {
    const data = rows({ name: "Alpha" }, { name: "Beta" }, { name: "Gamma" });
    const stats = computeFieldStats(data, "name");
    assert.equal(stats.kind, "text");
  });

  it("keeps numeric-looking strings as text", () => {
    const data = rows({ fips: "37009" }, { fips: "37005" }, { fips: "37171" });
    const stats = computeFieldStats(data, "fips");
    assert.ok(stats);
    assert.equal(stats.kind, "text");
    assert.equal(stats.unique, 3);
  });

  it("infers numeric strings for a string-only source", () => {
    const data = rows({ population: "10" }, { population: "20" }, { population: "30" });
    const stats = computeFieldStats(coerceNumericStringRows(data), "population");
    assert.ok(stats);
    assert.equal(stats.kind, "numeric");
    if (stats.kind === "numeric") assert.equal(stats.sum, 60);
  });

  it("treats a field with fewer than two numeric values as text", () => {
    const data = rows({ v: 1 }, { v: null });
    const stats = computeFieldStats(data, "v");
    assert.equal(stats?.kind, "text");
  });
});

describe("formatStatValue", () => {
  it("renders integers without decimals", () => {
    assert.equal(formatStatValue(1000), (1000).toLocaleString());
  });

  it("trims trailing precision on fractional values", () => {
    assert.equal(formatStatValue(2.5), "2.5");
  });

  it("uses exponential notation for extreme magnitudes", () => {
    assert.equal(formatStatValue(0.00001), (0.00001).toExponential(3));
  });

  it("renders non-finite values as an em dash", () => {
    assert.equal(formatStatValue(Number.NaN), "—");
    assert.equal(formatStatValue(Infinity), "—");
  });
});

describe("statsScopeAvailability", () => {
  const layer = rows({ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 });

  it("offers a scope only when it narrows the layer", () => {
    assert.deepEqual(statsScopeAvailability(layer, layer, []), {
      hasFilter: false,
      hasSelection: false,
    });
    assert.deepEqual(statsScopeAvailability(layer, layer.slice(0, 2), [layer[3]]), {
      hasFilter: true,
      hasSelection: true,
    });
  });

  it("drops a selection that covers the whole layer", () => {
    assert.equal(statsScopeAvailability(layer, layer, layer).hasSelection, false);
  });

  it("drops the filtered scope when it holds exactly the selected rows", () => {
    const selected = [layer[1], layer[2]];
    const availability = statsScopeAvailability(layer, [layer[1], layer[2]], selected);
    assert.deepEqual(availability, { hasFilter: false, hasSelection: true });
  });

  it("keeps both scopes when the same number of rows differ", () => {
    const availability = statsScopeAvailability(layer, [layer[0], layer[1]], [layer[2], layer[3]]);
    assert.deepEqual(availability, { hasFilter: true, hasSelection: true });
  });
});

describe("resolveStatsScope", () => {
  const both = { hasFilter: true, hasSelection: true };

  it("keeps a scope that is still offered", () => {
    assert.equal(resolveStatsScope("filtered", both), "filtered");
    assert.equal(resolveStatsScope("selected", both), "selected");
    assert.equal(resolveStatsScope("all", both), "all");
  });

  it("hands over to the other narrowed scope when one disappears", () => {
    assert.equal(
      resolveStatsScope("filtered", { hasFilter: false, hasSelection: true }),
      "selected",
    );
    assert.equal(
      resolveStatsScope("selected", { hasFilter: true, hasSelection: false }),
      "filtered",
    );
  });

  it("falls back to the whole layer once nothing narrows it", () => {
    const none = { hasFilter: false, hasSelection: false };
    assert.equal(resolveStatsScope("filtered", none), "all");
    assert.equal(resolveStatsScope("selected", none), "all");
  });
});
