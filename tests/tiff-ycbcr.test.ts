import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { convertTiffYCbCrToRgb } from "../packages/plugins/src/plugins/tiff-ycbcr";

function rounded(planes: [Float64Array, Float64Array, Float64Array]): number[] {
  return planes.map((plane) => Math.round(plane[0] * 1_000) / 1_000);
}

describe("TIFF YCbCr conversion", () => {
  it("uses the TIFF defaults when color metadata is absent", () => {
    assert.deepEqual(
      rounded(convertTiffYCbCrToRgb([100], [150], [200])),
      [200.944, 41.011, 138.984],
    );
  });

  it("honors non-default coefficients and reference ranges", () => {
    // Fixture equivalent to tags YCbCrCoefficients=0.25,0.5,0.25 and
    // ReferenceBlackWhite=16,235,128,240,128,240.
    assert.deepEqual(
      rounded(
        convertTiffYCbCrToRgb(
          [100],
          [150],
          [200],
          [0.25, 0.5, 0.25],
          [16, 235, 128, 240, 128, 240],
        ),
      ),
      [220.273, 17.866, 135.228],
    );
  });

  it("falls back to defaults for malformed color metadata", () => {
    const expected = rounded(convertTiffYCbCrToRgb([100], [150], [200]));
    assert.deepEqual(
      rounded(
        convertTiffYCbCrToRgb([100], [150], [200], [0.5, 0, 0.5], [255, 0, 128, 128, 255, 128]),
      ),
      expected,
    );
  });
});
