import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeTerrariumDem, normalizeNoData } from "../packages/map/src/cog-dem-source";

describe("COG DEM terrain encoding", () => {
  it("encodes metre and sub-metre elevations as Terrarium RGB", () => {
    assert.deepEqual(
      Array.from(encodeTerrariumDem([-32_768, 0, 1.5, 8_848])),
      [0, 0, 0, 255, 128, 0, 0, 255, 128, 1, 128, 255, 162, 144, 0, 255],
    );
  });

  it("fills nodata and non-finite cells with zero metres", () => {
    assert.deepEqual(
      Array.from(encodeTerrariumDem([-9999, Number.NaN, Number.POSITIVE_INFINITY], -9999)),
      [128, 0, 0, 255, 128, 0, 0, 255, 128, 0, 0, 255],
    );
  });

  it("clamps elevations to the representable Terrarium range", () => {
    assert.deepEqual(
      Array.from(encodeTerrariumDem([-100_000, 100_000])),
      [0, 0, 0, 255, 255, 255, 255, 255],
    );
  });
});

describe("GDAL_NODATA parsing", () => {
  it("reads the NUL-terminated ASCII tag GDAL actually writes", () => {
    // Number() returns NaN for this, which would silently disable nodata.
    assert.equal(normalizeNoData(`-9999${String.fromCharCode(0)}`), -9999);
  });

  it("reads a plain string and a numeric tag", () => {
    assert.equal(normalizeNoData("-3.4028235e+38"), -3.4028235e38);
    assert.equal(normalizeNoData(0), 0);
  });

  it("reports no sentinel for absent or unparsable tags", () => {
    assert.equal(normalizeNoData(undefined), null);
    assert.equal(normalizeNoData("nan"), null);
    assert.equal(normalizeNoData(Number.NaN), null);
  });
});
