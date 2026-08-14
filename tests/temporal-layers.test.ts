import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  __resetTemporalLayersForTests,
  buildSelectorTimeBinding,
  getTemporalLayerAdapter,
  getTemporalLayersVersion,
  isSelectorTimeBinding,
  nearestTimeIndex,
  registerTemporalLayer,
  resolveSelectorDisplayUnits,
  subscribeTemporalLayers,
  toEpochMsAxis,
  type TemporalLayerAdapter,
} from "../packages/plugins/src/plugins/temporal-layers.ts";

// The Time Slider's third binding kind: a layer whose time is an *internal
// dimension* (a Zarr data cube's `time` axis) rather than a feature property or
// a separate dated source (opengeos/GeoLibre#1448). These cover the vocabulary
// the slider and the Layers panel both read.

const DAY = 86_400_000;

function stubAdapter(values: Array<Date | number | string>): TemporalLayerAdapter {
  return { getTimeValues: () => values, setTime: () => {} };
}

afterEach(() => {
  __resetTemporalLayersForTests();
});

describe("toEpochMsAxis", () => {
  it("reads dates, epoch numbers, and ISO strings into epoch milliseconds", () => {
    const axis = toEpochMsAxis([
      new Date("2020-01-01T00:00:00Z"),
      1_580_515_200_000,
      1_583_020_800,
      "2020-04-01T00:00:00Z",
    ]);
    assert.deepEqual(axis, [
      Date.UTC(2020, 0, 1),
      1_580_515_200_000,
      1_583_020_800_000,
      Date.UTC(2020, 3, 1),
    ]);
  });

  it("keeps index alignment by holding an unreadable value as NaN", () => {
    // Dropping the bad entry would shift every later index, so a selector built
    // from the axis would fetch the wrong slice.
    const axis = toEpochMsAxis(["2020-01-01", "not a date", "2020-01-03"]);
    assert.equal(axis?.length, 3);
    assert.equal(Number.isNaN(axis?.[1]), true);
    assert.equal(axis?.[2], Date.UTC(2020, 0, 3));
  });

  it("returns null when nothing in the axis is a timestamp", () => {
    assert.equal(toEpochMsAxis([1, 2, 3]), null);
    assert.equal(toEpochMsAxis([]), null);
    assert.equal(toEpochMsAxis(undefined), null);
  });
});

describe("nearestTimeIndex", () => {
  const axis = [Date.UTC(2020, 0, 1), Date.UTC(2020, 0, 2), Date.UTC(2020, 0, 3)];

  it("snaps a date between two slices to the closer one", () => {
    assert.equal(nearestTimeIndex(axis, Date.UTC(2020, 0, 2) + 3 * 3_600_000), 1);
    assert.equal(nearestTimeIndex(axis, Date.UTC(2020, 0, 2) + 20 * 3_600_000), 2);
  });

  it("clamps a date outside the axis to its ends", () => {
    assert.equal(nearestTimeIndex(axis, Date.UTC(1990, 0, 1)), 0);
    assert.equal(nearestTimeIndex(axis, Date.UTC(2050, 0, 1)), 2);
  });

  it("breaks an exact tie toward the earlier slice so stepping never skips one", () => {
    assert.equal(nearestTimeIndex(axis, Date.UTC(2020, 0, 1) + DAY / 2), 0);
  });

  it("ignores positions the axis could not express as a timestamp", () => {
    const withGap = [Number.NaN, Date.UTC(2020, 0, 2), Number.NaN];
    assert.equal(nearestTimeIndex(withGap, Date.UTC(2020, 0, 1)), 1);
    assert.equal(nearestTimeIndex([Number.NaN], 0), -1);
    assert.equal(nearestTimeIndex([], 0), -1);
  });
});

describe("buildSelectorTimeBinding", () => {
  it("takes the extent from the axis and a granularity from its span", () => {
    const values = Array.from({ length: 40 }, (_, i) => Date.UTC(2020, 0, 1) + i * DAY);
    const binding = buildSelectorTimeBinding("time", values);
    assert.ok(binding);
    assert.equal(binding.kind, "selector");
    assert.equal(binding.dimension, "time");
    assert.equal(binding.min, Date.UTC(2020, 0, 1));
    assert.equal(binding.max, Date.UTC(2020, 0, 1) + 39 * DAY);
    // 39 days sits in the "day" bucket, matching what a vector binding of the
    // same span would choose, so a cube and a vector layer share one track.
    assert.equal(binding.granularity, "day");
  });

  it("honors an adapter's granularity and displayed slider units", () => {
    const values = Array.from({ length: 35 * 365 }, (_, i) => Date.UTC(1990, 0, 1) + i * DAY);
    const binding = buildSelectorTimeBinding("time", values, {
      granularity: "day",
      displayUnits: ["day"],
    });
    assert.ok(binding);
    assert.equal(binding.granularity, "day");
    assert.deepEqual(binding.displayUnits, ["day"]);
  });

  it("keeps the active granularity in the displayed slider units", () => {
    const binding = buildSelectorTimeBinding("time", [Date.UTC(2020, 0, 1), Date.UTC(2020, 0, 2)], {
      granularity: "day",
      displayUnits: ["month"],
    });
    assert.deepEqual(binding?.displayUnits, ["day", "month"]);
  });

  it("intersects shared display units and falls back to the active granularity", () => {
    const base = {
      kind: "selector" as const,
      dimension: "time",
      min: Date.UTC(2020, 0, 1),
      max: Date.UTC(2020, 0, 2),
    };
    assert.deepEqual(
      resolveSelectorDisplayUnits(
        [
          { ...base, granularity: "day", displayUnits: ["day", "month"] },
          { ...base, granularity: "month", displayUnits: ["month"] },
        ],
        "month",
      ),
      ["month"],
    );
    assert.deepEqual(
      resolveSelectorDisplayUnits(
        [
          { ...base, granularity: "day", displayUnits: ["day"] },
          { ...base, granularity: "month", displayUnits: ["month"] },
        ],
        "day",
      ),
      ["day"],
    );
  });

  it("gives a single-slice cube a non-zero span so the slider can still move", () => {
    const binding = buildSelectorTimeBinding("time", [Date.UTC(2020, 0, 1)]);
    assert.ok(binding);
    assert.equal(binding.max - binding.min, DAY);
  });

  it("falls back to `time` for a blank dimension name", () => {
    assert.equal(buildSelectorTimeBinding("  ", [Date.UTC(2020, 0, 1)])?.dimension, "time");
  });

  it("returns null when the axis holds no usable timestamp", () => {
    assert.equal(buildSelectorTimeBinding("time", [1, 2, 3]), null);
    assert.equal(buildSelectorTimeBinding("time", []), null);
  });
});

describe("isSelectorTimeBinding", () => {
  it("accepts a well-formed selector binding", () => {
    assert.equal(
      isSelectorTimeBinding({
        kind: "selector",
        dimension: "time",
        min: 0,
        max: DAY,
        granularity: "day",
      }),
      true,
    );
  });

  it("rejects the vector-filter binding it sits alongside", () => {
    // Both live on `metadata.timeBinding`, so the discriminator is what keeps the
    // slider from driving a filter binding through a selector adapter.
    assert.equal(
      isSelectorTimeBinding({
        property: "date",
        valueKind: "isoDate",
        min: 0,
        max: DAY,
        granularity: "day",
        window: { unit: "day", before: 0, after: 1 },
      }),
      false,
    );
  });

  it("rejects malformed values", () => {
    assert.equal(isSelectorTimeBinding(null), false);
    assert.equal(isSelectorTimeBinding({ kind: "selector", dimension: "" }), false);
    assert.equal(
      isSelectorTimeBinding({
        kind: "selector",
        dimension: "time",
        min: Number.NaN,
        max: 1,
      }),
      false,
    );
  });
});

describe("the temporal adapter registry", () => {
  it("registers, reads back, and unregisters an adapter", () => {
    const adapter = stubAdapter([Date.UTC(2020, 0, 1)]);
    const detach = registerTemporalLayer("cube-1", adapter);
    assert.equal(getTemporalLayerAdapter("cube-1"), adapter);
    detach();
    assert.equal(getTemporalLayerAdapter("cube-1"), undefined);
  });

  it("notifies subscribers and advances the version on every change", () => {
    let calls = 0;
    const unsubscribe = subscribeTemporalLayers(() => {
      calls += 1;
    });
    const before = getTemporalLayersVersion();
    const detach = registerTemporalLayer("cube-1", stubAdapter([Date.UTC(2020, 0, 1)]));
    assert.equal(calls, 1);
    detach();
    assert.equal(calls, 2);
    assert.ok(getTemporalLayersVersion() > before);
    unsubscribe();
    registerTemporalLayer("cube-2", stubAdapter([Date.UTC(2020, 0, 1)]));
    assert.equal(calls, 2, "expected no further calls after unsubscribing");
  });

  it("does not let a stale detacher remove a re-registered adapter", () => {
    // A layer re-added under the same id would otherwise lose its adapter when
    // the previous registration's detacher finally ran.
    const first = stubAdapter([Date.UTC(2020, 0, 1)]);
    const second = stubAdapter([Date.UTC(2021, 0, 1)]);
    const detachFirst = registerTemporalLayer("cube-1", first);
    registerTemporalLayer("cube-1", second);
    detachFirst();
    assert.equal(getTemporalLayerAdapter("cube-1"), second);
  });
});
