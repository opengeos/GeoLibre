import assert from "node:assert/strict";
import test from "node:test";

import {
  exceedsBrowserCogConversionLimit,
  geoTiffSampleCount,
  MAX_BROWSER_COG_CONVERSION_SAMPLES,
} from "../apps/geolibre-desktop/src/lib/cog-conversion-limits";

test("counts raster samples across bands", () => {
  assert.equal(geoTiffSampleCount({ width: 10_000, height: 5_000, bands: 3 }), 150_000_000);
  assert.equal(geoTiffSampleCount({ width: 10, height: 20, bands: 0 }), 200);
});

test("allows the ceiling and rejects larger conversions", () => {
  assert.equal(
    exceedsBrowserCogConversionLimit({
      width: MAX_BROWSER_COG_CONVERSION_SAMPLES,
      height: 1,
      bands: 1,
    }),
    false,
  );
  assert.equal(
    exceedsBrowserCogConversionLimit({
      width: MAX_BROWSER_COG_CONVERSION_SAMPLES + 1,
      height: 1,
      bands: 1,
    }),
    true,
  );
});

test("rejects sample counts outside JavaScript's safe integer range", () => {
  assert.equal(
    exceedsBrowserCogConversionLimit({ width: Number.MAX_SAFE_INTEGER, height: 2, bands: 1 }),
    true,
  );
});
