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
    assert.equal(
      parseTimeValue("2015-06-01T10:00:00Z"),
      Date.parse("2015-06-01T10:00:00Z"),
    );
  });

  it("parses numeric strings and rejects non-dates", () => {
    assert.equal(parseTimeValue("1600000000000"), 1_600_000_000_000);
    assert.equal(parseTimeValue("not a date"), null);
    assert.equal(parseTimeValue(""), null);
    assert.equal(parseTimeValue(null), null);
  });
});

describe("detectValueKind", () => {
  it("classifies epoch milliseconds, seconds, ISO dates and datetimes", () => {
    assert.equal(detectValueKind([1_600_000_000_000, 1_700_000_000_000]), "epochMs");
    assert.equal(detectValueKind([1_600_000_000, 1_700_000_000]), "epochS");
    assert.equal(detectValueKind(["2015-06-01", "2016-06-01"]), "isoDate");
    assert.equal(
      detectValueKind(["2015-06-01T10:00:00Z", "2016-06-01T10:00:00Z"]),
      "isoDateTime",
    );
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
    const fc = pointFeatures([
      { date: "2015-06-01" },
      { date: "2020-06-01" },
    ]);
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
});

describe("addGranularityUnits", () => {
  it("advances by calendar units in UTC", () => {
    const base = new Date("2015-06-15T00:00:00Z");
    assert.equal(
      addGranularityUnits(base, "year", 1).toISOString(),
      "2016-06-15T00:00:00.000Z",
    );
    assert.equal(
      addGranularityUnits(base, "month", 2).toISOString(),
      "2015-08-15T00:00:00.000Z",
    );
    assert.equal(
      addGranularityUnits(base, "day", -1).toISOString(),
      "2015-06-14T00:00:00.000Z",
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

  it("builds a date-only string comparison window", () => {
    const filter = buildTimeFilter(isoBinding, new Date("2016-01-01T00:00:00Z"));
    assert.deepEqual(filter, [
      "all",
      [">=", ["to-string", ["get", "date"]], "2016-01-01"],
      ["<", ["to-string", ["get", "date"]], "2017-01-01"],
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
