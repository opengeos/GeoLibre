import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FeatureCollection } from "geojson";
import {
  addGranularityUnits,
  buildTimeBinding,
  buildTimeFilter,
  detectTimeProperties,
  detectValueKind,
  parseTimeValue,
  type TimeBinding,
} from "../packages/plugins/src/plugins/time-slider-binding";

function pointFeatures(
  values: { date?: unknown; epoch?: unknown; label?: string }[],
): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: values.map((props, index) => ({
      type: "Feature",
      properties: { ...props, name: props.label ?? `f${index}` },
      geometry: { type: "Point", coordinates: [index, index] },
    })),
  };
}

describe("parseTimeValue", () => {
  it("reads epoch milliseconds and seconds by magnitude", () => {
    assert.equal(parseTimeValue(1_600_000_000_000), 1_600_000_000_000);
    assert.equal(parseTimeValue(1_600_000_000), 1_600_000_000_000);
  });

  it("parses ISO date and datetime strings", () => {
    assert.equal(parseTimeValue("2015-06-01"), Date.parse("2015-06-01"));
    assert.equal(parseTimeValue("2015-06-01T10:00:00Z"), Date.parse("2015-06-01T10:00:00Z"));
  });

  it("parses numeric strings and rejects non-dates", () => {
    assert.equal(parseTimeValue("1600000000000"), 1_600_000_000_000);
    assert.equal(parseTimeValue("not a date"), null);
    assert.equal(parseTimeValue(""), null);
    assert.equal(parseTimeValue(null), null);
  });

  it("rejects bare years and small integers instead of reading them as 1970", () => {
    assert.equal(parseTimeValue(2015), null);
    assert.equal(parseTimeValue("2016"), null);
    assert.equal(parseTimeValue(42), null);
  });
});

describe("detectTimeProperties", () => {
  it("does not offer a bare-year integer column as a timestamp", () => {
    const fc = pointFeatures([
      { date: "2015-06-01", label: "a" },
      { date: "2016-06-01", label: "b" },
    ]).features.map((f, i) => ({
      ...f,
      properties: { ...f.properties, year: 2015 + i },
    }));
    const candidates = detectTimeProperties({
      type: "FeatureCollection",
      features: fc,
    });
    assert.ok(!candidates.some((c) => c.property === "year"));
    assert.ok(candidates.some((c) => c.property === "date"));
  });
});

describe("detectValueKind", () => {
  it("classifies epoch milliseconds, seconds, ISO dates and datetimes", () => {
    assert.equal(detectValueKind([1_600_000_000_000, 1_700_000_000_000]), "epochMs");
    assert.equal(detectValueKind([1_600_000_000, 1_700_000_000]), "epochS");
    assert.equal(detectValueKind(["2015-06-01", "2016-06-01"]), "isoDate");
    assert.equal(detectValueKind(["2015-06-01T10:00:00Z", "2016-06-01T10:00:00Z"]), "isoDateTime");
  });

  it("does not classify a mixed numeric/string sample as epoch", () => {
    // A 50/50 epoch-number vs ISO-string sample must not become epoch, which
    // would coerce the ISO strings to NaN and silently drop them.
    assert.equal(detectValueKind([1_600_000_000_000, "2016-06-01T10:00:00Z"]), "isoDateTime");
    assert.equal(detectValueKind([1_600_000_000, "2016-06-01"]), "isoDate");
    // An empty / unknown sample falls back to the safe string comparison.
    assert.equal(detectValueKind([]), "isoDateTime");
  });
});

describe("detectTimeProperties", () => {
  it("returns covered timestamp columns, best coverage first", () => {
    const fc = pointFeatures([
      { date: "2015-06-01", epoch: 1_600_000_000_000 },
      { date: "2016-06-01", epoch: 1_700_000_000_000 },
      { date: "not-a-date", epoch: 1_800_000_000_000 },
    ]);
    const candidates = detectTimeProperties(fc);
    const props = candidates.map((c) => c.property);
    assert.ok(props.includes("date"));
    assert.ok(props.includes("epoch"));
    // `name` is never a timestamp column.
    assert.ok(!props.includes("name"));
    // epoch parses for all three features, date for two of three.
    const epoch = candidates.find((c) => c.property === "epoch");
    assert.equal(epoch?.coverage, 1);
  });

  it("ignores collections with no time-like property", () => {
    const fc = pointFeatures([{ label: "a" }, { label: "b" }]);
    assert.deepEqual(detectTimeProperties(fc), []);
  });
});

describe("buildTimeBinding", () => {
  it("computes the extent, value kind, and default window", () => {
    const fc = pointFeatures([{ date: "2015-06-01" }, { date: "2020-06-01" }]);
    const binding = buildTimeBinding(fc, "date");
    assert.ok(binding);
    assert.equal(binding?.valueKind, "isoDate");
    assert.equal(binding?.min, Date.parse("2015-06-01"));
    assert.equal(binding?.max, Date.parse("2020-06-01"));
    assert.equal(binding?.window.before, 0);
    assert.equal(binding?.window.after, 1);
  });

  it("returns null when the property has no parseable values", () => {
    const fc = pointFeatures([{ date: "x" }, { date: "y" }]);
    assert.equal(buildTimeBinding(fc, "date"), null);
  });

  it("detects the value kind when invalid rows lead the data", () => {
    const fc = pointFeatures([
      { date: "n/a" },
      { date: "" },
      { date: "2015-06-01" },
      { date: "2016-06-01" },
    ]);
    const binding = buildTimeBinding(fc, "date");
    // The leading invalid rows must not starve value-kind detection.
    assert.equal(binding?.valueKind, "isoDate");
    assert.equal(binding?.min, Date.parse("2015-06-01"));
  });
});

describe("addGranularityUnits", () => {
  it("advances by calendar units in UTC", () => {
    const base = new Date("2015-06-15T00:00:00Z");
    assert.equal(addGranularityUnits(base, "year", 1).toISOString(), "2016-06-15T00:00:00.000Z");
    assert.equal(addGranularityUnits(base, "month", 2).toISOString(), "2015-08-15T00:00:00.000Z");
    assert.equal(addGranularityUnits(base, "day", -1).toISOString(), "2015-06-14T00:00:00.000Z");
  });

  it("clamps the day at month-end boundaries instead of rolling over", () => {
    assert.equal(
      addGranularityUnits(new Date("2015-01-31T00:00:00Z"), "month", 1).toISOString(),
      "2015-02-28T00:00:00.000Z",
    );
    assert.equal(
      addGranularityUnits(new Date("2024-02-29T00:00:00Z"), "year", 1).toISOString(),
      "2025-02-28T00:00:00.000Z",
    );
    // Month overflow folds into the year.
    assert.equal(
      addGranularityUnits(new Date("2015-12-15T00:00:00Z"), "month", 2).toISOString(),
      "2016-02-15T00:00:00.000Z",
    );
  });
});

describe("buildTimeFilter", () => {
  const isoBinding: TimeBinding = {
    property: "date",
    valueKind: "isoDate",
    min: Date.parse("2015-01-01"),
    max: Date.parse("2020-01-01"),
    granularity: "year",
    window: { unit: "year", before: 0, after: 1 },
  };

  it("builds a date-only string comparison window on a 10-char slice", () => {
    const filter = buildTimeFilter(isoBinding, new Date("2016-01-01T00:00:00Z"));
    assert.deepEqual(filter, [
      "all",
      [">=", ["slice", ["to-string", ["get", "date"]], 0, 10], "2016-01-01"],
      ["<", ["slice", ["to-string", ["get", "date"]], 0, 10], "2017-01-01"],
    ]);
  });

  it("compares datetimes on a 19-char slice so Z/offset/ms do not break bounds", () => {
    const binding: TimeBinding = { ...isoBinding, valueKind: "isoDateTime" };
    const filter = buildTimeFilter(binding, new Date("2016-01-01T00:00:00Z"));
    assert.deepEqual(filter, [
      "all",
      [">=", ["slice", ["to-string", ["get", "date"]], 0, 19], "2016-01-01T00:00:00"],
      ["<", ["slice", ["to-string", ["get", "date"]], 0, 19], "2017-01-01T00:00:00"],
    ]);
  });

  it("scales epoch-second windows into the stored unit", () => {
    const binding: TimeBinding = {
      ...isoBinding,
      valueKind: "epochS",
    };
    const filter = buildTimeFilter(binding, new Date("2016-01-01T00:00:00Z"));
    const lower = Date.parse("2016-01-01T00:00:00Z") / 1000;
    const upper = Date.parse("2017-01-01T00:00:00Z") / 1000;
    assert.deepEqual(filter, [
      "all",
      [">=", ["to-number", ["get", "date"]], lower],
      ["<", ["to-number", ["get", "date"]], upper],
    ]);
  });
});
