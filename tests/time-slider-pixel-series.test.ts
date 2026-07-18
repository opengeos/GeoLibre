import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bandOptionsFromResults,
  downsampleSteps,
  type PixelTimeSeriesResult,
  seriesToFeatureCollection,
  valueAtBand,
} from "../packages/plugins/src/plugins/time-slider-pixel-series";

describe("downsampleSteps", () => {
  it("keeps every step when under the cap", () => {
    const steps = [new Date("2000-01-01"), new Date("2001-01-01")];
    const result = downsampleSteps(steps, 10);
    assert.equal(result.truncated, false);
    assert.deepEqual(result.steps, steps);
  });

  it("downsamples to the cap, preserving the endpoints", () => {
    const steps = Array.from({ length: 100 }, (_, i) => new Date(2000 + i, 0, 1));
    const result = downsampleSteps(steps, 5);
    assert.equal(result.truncated, true);
    assert.equal(result.steps.length, 5);
    assert.equal(result.steps[0].getTime(), steps[0].getTime());
    assert.equal(
      result.steps[result.steps.length - 1].getTime(),
      steps[steps.length - 1].getTime(),
    );
  });

  it("coerces a non-positive cap to the first step", () => {
    const steps = [new Date("2000-01-01"), new Date("2001-01-01")];
    const result = downsampleSteps(steps, 0);
    assert.equal(result.steps.length, 1);
    assert.equal(result.truncated, true);
    // Guards the cap===1 path: a NaN index would leave steps[0] undefined.
    assert.ok(result.steps[0] instanceof Date);
    assert.equal(result.steps[0].getTime(), steps[0].getTime());
  });
});

describe("valueAtBand", () => {
  const point = {
    date: "2000-01-01",
    timestamp: 946684800000,
    url: "https://x/2000.tif",
    bands: [
      { index: 1, name: "red", value: 10, isNodata: false },
      { index: 2, name: "nir", value: 20, isNodata: false },
      { index: 3, name: "qa", value: -9999, isNodata: true },
    ],
  };

  it("returns the value for the requested band", () => {
    assert.equal(valueAtBand(point, 2), 20);
  });

  it("returns null for a nodata band so it charts as a gap", () => {
    assert.equal(valueAtBand(point, 3), null);
  });

  it("returns null when the band is missing (failed read)", () => {
    assert.equal(valueAtBand({ ...point, bands: [] }, 1), null);
    assert.equal(valueAtBand(point, 9), null);
  });

  it("returns null for a non-finite value so it never blanks the chart", () => {
    const nan = {
      ...point,
      bands: [{ index: 1, name: "red", value: NaN, isNodata: false }],
    };
    assert.equal(valueAtBand(nan, 1), null);
  });
});

describe("bandOptionsFromResults", () => {
  const make = (bands: { index: number; name: string | null }[]) =>
    ({
      lngLat: [0, 0],
      series: [],
      bands,
      defaultBandIndex: bands[0]?.index ?? null,
      stepCount: 0,
      originalStepCount: 0,
      truncated: false,
    }) as PixelTimeSeriesResult;

  it("unions bands across results, ascending by index, filling names", () => {
    const options = bandOptionsFromResults([
      make([{ index: 2, name: null }]),
      make([
        { index: 1, name: "red" },
        { index: 2, name: "nir" },
      ]),
    ]);
    assert.deepEqual(options, [
      { index: 1, name: "red" },
      { index: 2, name: "nir" },
    ]);
  });

  it("keeps the first non-null name when both results supply one", () => {
    const options = bandOptionsFromResults([
      make([{ index: 1, name: "red" }]),
      make([{ index: 1, name: "nir" }]),
    ]);
    assert.deepEqual(options, [{ index: 1, name: "red" }]);
  });

  it("returns an empty list with no results", () => {
    assert.deepEqual(bandOptionsFromResults([]), []);
  });
});

describe("seriesToFeatureCollection", () => {
  const result: PixelTimeSeriesResult = {
    lngLat: [-122.5, 45.5],
    bands: [
      { index: 1, name: "red" },
      { index: 2, name: "nir" },
    ],
    defaultBandIndex: 1,
    stepCount: 2,
    originalStepCount: 2,
    truncated: false,
    series: [
      {
        sourceId: "landsat",
        sourceName: "Landsat",
        points: [
          {
            date: "2000-01-01",
            timestamp: 946684800000,
            url: "https://x/2000.tif",
            bands: [
              { index: 1, name: "red", value: 10, isNodata: false },
              { index: 2, name: "nir", value: 20, isNodata: false },
            ],
          },
          {
            date: "2001-01-01",
            timestamp: 978307200000,
            url: "https://x/2001.tif",
            bands: [],
          },
        ],
      },
    ],
  };

  it("emits one feature per (location, source, step, band) in long format", () => {
    const collection = seriesToFeatureCollection([{ label: "Point 1", result }]);
    // 2 bands for step 1, plus a single placeholder row for the empty step 2.
    assert.equal(collection.features.length, 3);
    for (const feature of collection.features) {
      assert.equal(feature.geometry.type, "Point");
      assert.deepEqual(feature.geometry.coordinates, [-122.5, 45.5]);
    }
  });

  it("carries the label, date, source, band, value, and nodata flag", () => {
    const collection = seriesToFeatureCollection([{ label: "Point 1", result }]);
    assert.deepEqual(collection.features[0].properties, {
      label: "Point 1",
      lng: -122.5,
      lat: 45.5,
      date: "2000-01-01",
      source: "Landsat",
      band: 1,
      band_name: "red",
      value: 10,
      is_nodata: false,
    });
    // The empty (failed) step still emits a row with null band/value and an
    // unknown (null) nodata flag.
    const last = collection.features[2].properties;
    assert.equal(last?.date, "2001-01-01");
    assert.equal(last?.band, null);
    assert.equal(last?.value, null);
    assert.equal(last?.is_nodata, null);
  });

  it("emits features for every labeled location", () => {
    const collection = seriesToFeatureCollection([
      { label: "Point 1", result },
      { label: "Point 2", result },
    ]);
    assert.equal(collection.features.length, 6);
    assert.equal(collection.features[3].properties?.label, "Point 2");
  });
});
