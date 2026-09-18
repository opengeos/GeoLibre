import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  rasterIdentifyProperties,
  rasterPixelIdentifyProperties,
} from "../apps/geolibre-desktop/src/lib/global-raster-identify";
import { formatPixelValue } from "../packages/core/src/pixel-format";

const labels = {
  band: (index: number) => `Band ${index}`,
  nodata: "No data",
  coordinates: "Coordinates",
  row: "Row",
  column: "Column",
};

describe("formatPixelValue", () => {
  it("keeps integers and rounds floating-point noise", () => {
    assert.equal(formatPixelValue(42), "42");
    assert.equal(formatPixelValue(1.23456789), "1.23457");
  });
});

describe("rasterPixelIdentifyProperties", () => {
  it("formats named and unnamed bands with pixel coordinates", () => {
    const properties = rasterPixelIdentifyProperties(
      {
        lngLat: [-122.123456, 47.987654],
        row: 12,
        col: 34,
        bands: [
          { index: 1, value: 123.456789, isNodata: false, name: "Elevation" },
          { index: 2, value: -9999, isNodata: true, name: null },
        ],
      },
      labels,
    );

    assert.deepEqual(properties, {
      Elevation: "123.457",
      "Band 2": "-9999 (No data)",
      Coordinates: "-122.12346, 47.98765",
      Row: 12,
      Column: 34,
    });
  });

  it("keeps every band when display labels collide", () => {
    const properties = rasterPixelIdentifyProperties(
      {
        lngLat: [-122.123456, 47.987654],
        row: 12,
        col: 34,
        bands: [
          { index: 1, value: 1, isNodata: false, name: "Reflectance" },
          { index: 2, value: 2, isNodata: false, name: "Reflectance" },
          { index: 3, value: 3, isNodata: false, name: "Row" },
        ],
      },
      labels,
    );

    assert.deepEqual(properties, {
      Reflectance: "1",
      "Reflectance (2)": "2",
      Row: "3",
      Coordinates: "-122.12346, 47.98765",
      "Row (2)": 12,
      Column: 34,
    });
  });
});

describe("rasterIdentifyProperties", () => {
  it("suffixes repeated labels instead of overwriting them", () => {
    assert.deepEqual(
      rasterIdentifyProperties([
        ["Temperature", "1"],
        ["Temperature", "2"],
        ["Temperature", "3"],
      ]),
      { Temperature: "1", "Temperature (2)": "2", "Temperature (3)": "3" },
    );
  });
});
