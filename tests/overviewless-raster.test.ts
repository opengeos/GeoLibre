import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  needsOverviewsToDrawZoomedOut,
  readRasterPyramidShape,
  TILER_WINDOW_SAMPLES,
} from "../packages/plugins/src/plugins/overviewless-raster";

/** A geotiff.js stand-in exposing only the directory fields the probe reads. */
function fakeTiff(
  images: Array<{ width: number; height: number; bands?: number; tiled?: boolean }>,
) {
  const reads: number[] = [];
  return {
    reads,
    getImage: async (index: number) => {
      reads.push(index);
      const image = images[index];
      if (!image) throw new Error(`No image at index ${index}`);
      return {
        getWidth: () => image.width,
        getHeight: () => image.height,
        getSamplesPerPixel: () => image.bands ?? 1,
        isTiled: image.tiled ?? true,
      };
    },
  };
}

describe("overview-less raster detection", () => {
  it("flags the 4-band NAIP tile that stayed blank zoomed out", async () => {
    const shape = await readRasterPyramidShape(fakeTiff([{ width: 4350, height: 6170, bands: 4 }]));
    assert.deepEqual(shape, {
      width: 4350,
      height: 6170,
      bands: 4,
      tiled: true,
      hasOverviews: false,
    });
    assert.equal(needsOverviewsToDrawZoomedOut(shape), true);
  });

  it("does not flag a COG whose later images are overviews", async () => {
    const tiff = fakeTiff([
      { width: 4350, height: 6170, bands: 4 },
      { width: 2175, height: 3085, bands: 4 },
      { width: 1088, height: 1543, bands: 4 },
    ]);
    const shape = await readRasterPyramidShape(tiff);
    assert.equal(shape.hasOverviews, true);
    assert.equal(needsOverviewsToDrawZoomedOut(shape), false);
    // Stops at the first overview instead of reading every directory.
    assert.deepEqual(tiff.reads, [0, 1]);
  });

  it("reads only the first directory when it alone rules the raster out", async () => {
    const small = fakeTiff([
      { width: 512, height: 512, bands: 3 },
      { width: 512, height: 512 },
    ]);
    await readRasterPyramidShape(small);
    assert.deepEqual(small.reads, [0]);
    const striped = fakeTiff([{ width: 9000, height: 9000, bands: 3, tiled: false }]);
    await readRasterPyramidShape(striped);
    assert.deepEqual(striped.reads, [0]);
  });

  it("treats a full-size internal mask as no overview", async () => {
    const shape = await readRasterPyramidShape(
      fakeTiff([
        { width: 4350, height: 6170, bands: 3 },
        { width: 4350, height: 6170, bands: 1 },
      ]),
    );
    assert.equal(shape.hasOverviews, false);
  });

  it("counts the bands the tiler actually reads", () => {
    // 3000x3000 = 9M px: over the ceiling as an RGB composite (27M samples),
    // under it as a single band.
    const base = { width: 3000, height: 3000, tiled: true, hasOverviews: false };
    assert.equal(needsOverviewsToDrawZoomedOut({ ...base, bands: 3 }), true);
    assert.equal(needsOverviewsToDrawZoomedOut({ ...base, bands: 1 }), false);
    assert.equal(needsOverviewsToDrawZoomedOut({ ...base, bands: 2 }), false);
    assert.ok(3000 * 3000 < TILER_WINDOW_SAMPLES);
  });

  it("leaves striped files to the non-tiled flow", () => {
    assert.equal(
      needsOverviewsToDrawZoomedOut({
        width: 10000,
        height: 10000,
        bands: 3,
        tiled: false,
        hasOverviews: false,
      }),
      false,
    );
  });
});
