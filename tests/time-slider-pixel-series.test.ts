import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  downsampleSteps,
  pickBand,
  type PixelTimeSeriesResult,
  seriesToFeatureCollection,
} from "../packages/plugins/src/plugins/time-slider-pixel-series";

describe("downsampleSteps", () => {
  it("keeps every step when under the cap", () => {
    const steps = [new Date("2000-01-01"), new Date("2001-01-01")];
    const result = downsampleSteps(steps, 10);
    assert.equal(result.truncated, false);
    assert.deepEqual(result.steps, steps);
  });

  it("downsamples to the cap, preserving the endpoints", () => {
    const steps = Array.from(
      { length: 100 },
      (_, i) => new Date(2000 + i, 0, 1),
    );
    const result = downsampleSteps(steps, 5);
    assert.equal(result.truncated, true);
    assert.equal(result.steps.length, 5);
    assert.equal(result.steps[0].getTime(), steps[0].getTime());
    assert.equal(
      result.steps[result.steps.length - 1].getTime(),
      steps[steps.length - 1].getTime(),
    );
  });

  it("coerces a non-positive cap to one step", () => {
    const steps = [new Date("2000-01-01"), new Date("2001-01-01")];
    const result = downsampleSteps(steps, 0);
    assert.equal(result.steps.length, 1);
    assert.equal(result.truncated, true);
  });
});

describe("pickBand", () => {
  const reading = {
    lngLat: [0, 0] as [number, number],
    col: 1,
    row: 1,
    bands: [
      { index: 1, name: "red", value: 10, isNodata: false },
      { index: 2, name: "nir", value: 20, isNodata: false },
    ],
  };

  it("selects the first configured band index", () => {
    assert.equal(pickBand(reading, [2])?.value, 20);
  });

  it("falls back to the first band when bidx is missing", () => {
    assert.equal(pickBand(reading, undefined)?.value, 10);
  });

  it("falls back to the first band when bidx does not match", () => {
    assert.equal(pickBand(reading, [9])?.value, 10);
  });

  it("returns null when there are no bands", () => {
    assert.equal(pickBand({ ...reading, bands: [] }, [1]), null);
  });
});

describe("seriesToFeatureCollection", () => {
  const result: PixelTimeSeriesResult = {
    lngLat: [-122.5, 45.5],
    stepCount: 2,
    truncated: false,
    series: [
      {
        sourceId: "landsat",
        sourceName: "Landsat",
        bandIndex: 1,
        bandName: "ndvi",
        points: [
          {
            date: "2000-01-01",
            timestamp: 946684800000,
            url: "https://x/2000.tif",
            value: 0.42,
            isNodata: false,
          },
          {
            date: "2001-01-01",
            timestamp: 978307200000,
            url: "https://x/2001.tif",
            value: null,
            isNodata: true,
          },
        ],
      },
    ],
  };

  it("emits one point feature per (source, timestep) at the clicked location", () => {
    const collection = seriesToFeatureCollection(result);
    assert.equal(collection.features.length, 2);
    for (const feature of collection.features) {
      assert.equal(feature.geometry.type, "Point");
      assert.deepEqual(feature.geometry.coordinates, [-122.5, 45.5]);
    }
  });

  it("carries the date, source, band, value, and nodata flag as attributes", () => {
    const collection = seriesToFeatureCollection(result);
    assert.deepEqual(collection.features[0].properties, {
      date: "2000-01-01",
      source: "Landsat",
      band: 1,
      band_name: "ndvi",
      value: 0.42,
      is_nodata: false,
    });
    assert.equal(collection.features[1].properties?.value, null);
    assert.equal(collection.features[1].properties?.is_nodata, true);
  });
});
