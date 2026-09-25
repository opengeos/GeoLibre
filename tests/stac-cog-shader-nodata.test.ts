import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toStacCogShaderNoData } from "../packages/plugins/src/plugins/components/stac-search";

// The STAC Search COG render pipeline skipped its FilterNoDataVal step because
// the nodata it passed was hard-coded to null (opengeos/GeoLibre#2643). The
// shader compares the sampled red channel, so the value has to be in the
// texture's sampled space.
describe("toStacCogShaderNoData", () => {
  it("normalizes an unsigned-integer nodata the way a unorm texture samples it", () => {
    assert.equal(toStacCogShaderNoData(255, [8, 8], [1, 1]), 1);
    assert.equal(toStacCogShaderNoData(0, [8, 8], [1, 1]), 0);
    assert.equal(toStacCogShaderNoData(65535, [16, 16], [1, 1]), 1);
    assert.equal(toStacCogShaderNoData(51, [8, 8], [1, 1]), 51 / 255);
  });

  it("passes float and signed-integer nodata through unchanged", () => {
    assert.equal(toStacCogShaderNoData(-9999, [32, 32], [3, 3]), -9999);
    assert.equal(toStacCogShaderNoData(-32768, [16, 16], [2, 2]), -32768);
    // No 32-bit unorm format exists, so a 32-bit uint texture is not normalized.
    assert.equal(toStacCogShaderNoData(4294967295, [32, 32], [1, 1]), 4294967295);
  });

  it("skips the step when there is no usable nodata", () => {
    assert.equal(toStacCogShaderNoData(null, [8], [1]), null);
    assert.equal(toStacCogShaderNoData(undefined, [8], [1]), null);
    assert.equal(toStacCogShaderNoData(Number.NaN, [32], [3]), null);
  });
});
