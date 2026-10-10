import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { withJpegTablesPatch } from "../packages/core/src/cog-jpeg-tables";

describe("withJpegTablesPatch", () => {
  /** A cog-tiler source double with the internals the patch reads. */
  function source(compression: string) {
    return {
      levels: [{ compression }],
      tiff: {},
      _tiffImage: async () => ({
        fileDirectory: { PhotometricInterpretation: 2 },
        readRasters: async () => [
          [1, 2],
          [3, 4],
          [5, 6],
        ],
      }),
      _assembleWindow: async (..._args: number[]): Promise<ArrayLike<number>> => [0, 0],
    };
  }

  /** A tiler module double whose `openCog` resolves `cog`, typed as the real one is. */
  const tiler = <T>(cog: T, extra: Record<string, unknown> = {}) =>
    withJpegTablesPatch({ openCog: async (_input: unknown) => cog, ...extra });

  it("routes abbreviated-JPEG tile windows through geotiff.js, once per source", async () => {
    const jpeg = source("Jpeg");
    const original = jpeg._assembleWindow;
    const module = tiler(jpeg, { other: 1 });
    assert.equal((module as { other?: number }).other, 1, "the rest of the module passes through");
    const opened = (await module.openCog(undefined)) as typeof jpeg;
    assert.notEqual(opened._assembleWindow, original);
    assert.deepEqual(await opened._assembleWindow(0, 0, 0, 2, 1, 1), [3, 4]);
    // Opening it again does not wrap twice.
    const patched = opened._assembleWindow;
    await module.openCog(undefined);
    assert.equal(opened._assembleWindow, patched);
  });

  it("leaves every other codec untouched", async () => {
    for (const compression of ["Deflate", "JpegXl", "Lerc"]) {
      const other = source(compression);
      const original = other._assembleWindow;
      const opened = (await tiler(other).openCog(undefined)) as typeof other;
      assert.equal(opened._assembleWindow, original, compression);
    }
  });
});
