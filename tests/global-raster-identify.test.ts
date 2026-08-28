import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatRasterIdentifyValue,
  rasterPixelIdentifyProperties,
} from "../apps/geolibre-desktop/src/lib/global-raster-identify";

const labels = {
  band: (index: number) => `Band ${index}`,
  nodata: "No data",
  coordinates: "Coordinates",
  row: "Row",
  column: "Column",
};

describe("formatRasterIdentifyValue", () => {
  it("keeps integers and rounds floating-point noise", () => {
    assert.equal(formatRasterIdentifyValue(42), "42");
    assert.equal(formatRasterIdentifyValue(1.23456789), "1.23457");
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
});
