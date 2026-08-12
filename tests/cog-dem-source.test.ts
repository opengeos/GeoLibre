import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeTerrariumDem } from "../packages/map/src/cog-dem-source";

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
