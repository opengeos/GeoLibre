import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isAbbreviatedJpegCompression } from "../packages/plugins/src/plugins/cog-compression";

describe("isAbbreviatedJpegCompression", () => {
  it("matches whitebox-wasm's baseline JPEG variant names", () => {
    assert.equal(isAbbreviatedJpegCompression("Jpeg"), true);
    assert.equal(isAbbreviatedJpegCompression("OldJpeg"), true);
    assert.equal(isAbbreviatedJpegCompression("JPEG"), true);
  });

  it("does not reroute JPEG-XL, which geotiff.js cannot decode (#2339)", () => {
    assert.equal(isAbbreviatedJpegCompression("JpegXl"), false);
  });

  it("ignores every other codec, including the Other(code) form", () => {
    for (const value of [
      "Deflate",
      "Lzw",
      "WebP",
      "PackBits",
      "Other(34887)",
      "Other(50000)",
      "",
      undefined,
    ]) {
      assert.equal(isAbbreviatedJpegCompression(value), false, String(value));
    }
  });
});
