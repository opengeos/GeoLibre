import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChartRow } from "../apps/geolibre-desktop/src/lib/attribute-charts";
import type { NumericFieldStats } from "../apps/geolibre-desktop/src/lib/attribute-stats";
import {
  COLUMN_EXPLORER_TOP_VALUES,
  populatedCount,
  summarizeColumn,
  summarizeColumns,
} from "../apps/geolibre-desktop/src/lib/column-explorer";

function rows(...properties: Record<string, unknown>[]): ChartRow[] {
  return properties.map((p) => ({ properties: p }));
}

describe("summarizeColumn", () => {
  it("summarizes a numeric field with a histogram", () => {
    const data = rows({ pop: 10 }, { pop: 20 }, { pop: 30 }, { pop: 40 }, { pop: null });
    const summary = summarizeColumn(data, "pop");
    assert.ok(summary);
    assert.equal(summary.key, "pop");
    assert.equal(summary.stats.kind, "numeric");
    const stats = summary.stats as NumericFieldStats;
    assert.equal(stats.count, 4);
    assert.equal(stats.nulls, 1);
    assert.equal(stats.min, 10);
    assert.equal(stats.max, 40);
    // A numeric field gets a distribution covering its finite values.
    assert.ok(summary.histogram);
    assert.equal(summary.histogram.total, 4);
    assert.equal(summary.total, 5);
  });

  it("summarizes a text field with top values and no histogram", () => {
    const data = rows({ kind: "a" }, { kind: "a" }, { kind: "b" }, { kind: "" });
    const summary = summarizeColumn(data, "kind");
    assert.ok(summary);
    assert.equal(summary.stats.kind, "text");
    assert.equal(summary.histogram, null);
    if (summary.stats.kind === "text") {
      assert.equal(summary.stats.nulls, 1);
      assert.equal(summary.stats.unique, 2);
      assert.deepEqual(summary.stats.top[0], { value: "a", count: 2 });
    }
  });

  it("lists up to COLUMN_EXPLORER_TOP_VALUES distinct text values", () => {
    const data = rows(...Array.from({ length: 20 }, (_, i) => ({ id: `v${i}` })));
    const summary = summarizeColumn(data, "id");
    assert.ok(summary);
    if (summary.stats.kind === "text") {
      assert.equal(summary.stats.top.length, COLUMN_EXPLORER_TOP_VALUES);
      assert.equal(summary.stats.unique, 20);
    }
  });
});

describe("summarizeColumns", () => {
  it("preserves the given column order", () => {
    const data = rows({ a: 1, b: "x" }, { a: 2, b: "y" });
    const summaries = summarizeColumns(data, ["b", "a"]);
    assert.deepEqual(
      summaries.map((s) => s.key),
      ["b", "a"],
    );
  });

  it("returns an empty list for no columns", () => {
    assert.deepEqual(summarizeColumns(rows({ a: 1 }), []), []);
  });
});

describe("populatedCount", () => {
  it("counts rows that hold a value (total minus nulls)", () => {
    const data = rows({ v: 1 }, { v: 2 }, { v: null }, { v: "" });
    const summary = summarizeColumn(data, "v");
    assert.ok(summary);
    // Two populated values, two blanks counted as null.
    assert.equal(summary.stats.nulls, 2);
    assert.equal(populatedCount(summary), 2);
  });

  it("counts non-numeric text in a numeric field as populated", () => {
    const data = rows({ v: 1 }, { v: 2 }, { v: 3 }, { v: "n/a" });
    const summary = summarizeColumn(data, "v");
    assert.ok(summary);
    assert.equal(summary.stats.kind, "numeric");
    // The "n/a" row is not null, so it is populated even though it is excluded
    // from the numeric statistics.
    assert.equal(summary.stats.nulls, 0);
    assert.equal(populatedCount(summary), 4);
  });
});
