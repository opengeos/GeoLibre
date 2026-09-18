import assert from "node:assert/strict";
import test from "node:test";

import {
  exceedsBrowserCogConversionLimit,
  geoTiffSampleCount,
  LARGE_BROWSER_COG_CONVERSION_SAMPLES,
  MAX_BROWSER_COG_CONVERSION_SAMPLES,
} from "../packages/processing/src/cog-convert";

test("counts raster samples across bands", () => {
  assert.equal(geoTiffSampleCount({ width: 10_000, height: 5_000, bands: 3 }), 150_000_000);
  assert.equal(geoTiffSampleCount({ width: 10, height: 20, bands: 0 }), 200);
});

test("allows the ceiling and rejects larger conversions", () => {
  assert.ok(LARGE_BROWSER_COG_CONVERSION_SAMPLES < MAX_BROWSER_COG_CONVERSION_SAMPLES);
  assert.equal(exceedsBrowserCogConversionLimit(MAX_BROWSER_COG_CONVERSION_SAMPLES), false);
  assert.equal(exceedsBrowserCogConversionLimit(MAX_BROWSER_COG_CONVERSION_SAMPLES + 1), true);
});

test("rejects sample counts outside JavaScript's safe integer range", () => {
  assert.equal(exceedsBrowserCogConversionLimit(Number.MAX_SAFE_INTEGER * 2), true);
});
