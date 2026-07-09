import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { exportCogSubset } from "@geolibre/processing";
import { fromArrayBuffer, writeArrayBuffer } from "geotiff";

/**
 * Encode a small EPSG:4326 GeoTIFF for tests. The raster is `width x height`
 * pixels of 1 unit each, north-up, with its north-west corner at
 * `(originX, originY)`. Pixel (row, col) holds value `row * width + col`.
 */
function makeGeoTiff(
  width: number,
  height: number,
  originX: number,
  originY: number,
  values: number[],
  extra: Record<string, unknown> = {},
): Promise<ArrayBuffer> {
  const array = Uint8Array.from(values);
  const metadata = {
    width,
    height,
    BitsPerSample: [8],
    SampleFormat: [1],
    ModelPixelScale: [1, 1, 0],
    ModelTiepoint: [0, 0, 0, originX, originY, 0],
    GTModelTypeGeoKey: 2,
    GTRasterTypeGeoKey: 1,
    GeographicTypeGeoKey: 4326,
    ...extra,
  };
  const written = writeArrayBuffer(
    array,
    metadata as Parameters<typeof writeArrayBuffer>[1],
  );
  const buffer = written instanceof ArrayBuffer ? written : written.buffer;
  return Promise.resolve(buffer as ArrayBuffer);
}

async function readBand(bytes: ArrayBuffer): Promise<{
  width: number;
  height: number;
  origin: number[];
  values: number[];
}> {
  const tiff = await fromArrayBuffer(bytes);
  const image = await tiff.getImage();
  const rasters = await image.readRasters();
  return {
    width: image.getWidth(),
    height: image.getHeight(),
    origin: image.getOrigin().slice(0, 2),
    values: Array.from(rasters[0] as ArrayLike<number>),
  };
}

describe("exportCogSubset", () => {
  it("clips a raster to the pixels inside the bbox and keeps georeferencing", async () => {
    // 4x4 raster, values 0..15, NW corner at (0, 4) so it spans [0,0]-[4,4].
    const source = await makeGeoTiff(
      4,
      4,
      0,
      4,
      Array.from({ length: 16 }, (_, i) => i),
    );

    // Window [1,1]-[3,3] selects the middle 2x2 block: rows 1-2, cols 1-2.
    const { bytes, width, height } = await exportCogSubset(source, [1, 1, 3, 3]);
    assert.equal(width, 2);
    assert.equal(height, 2);

    const out = await readBand(bytes);
    assert.equal(out.width, 2);
    assert.equal(out.height, 2);
    // NW corner shifts to (1, 3): originX + col0, originY - row0.
    assert.deepEqual(out.origin, [1, 3]);
    // Row-major values at (row, col) = row*4 + col for rows {1,2}, cols {1,2}.
    assert.deepEqual(out.values, [5, 6, 9, 10]);
  });

  it("clamps a bbox that extends past the raster to the overlapping pixels", async () => {
    const source = await makeGeoTiff(
      4,
      4,
      0,
      4,
      Array.from({ length: 16 }, (_, i) => i),
    );

    // bbox reaches beyond the eastern/southern edges; only cols 2-3, rows 2-3
    // exist and should come back.
    const { bytes, width, height } = await exportCogSubset(
      source,
      [2, -5, 9, 2],
    );
    assert.equal(width, 2);
    assert.equal(height, 2);
    const out = await readBand(bytes);
    assert.deepEqual(out.values, [10, 11, 14, 15]);
  });

  it("preserves the source nodata value in the subset", async () => {
    const source = await makeGeoTiff(
      4,
      4,
      0,
      4,
      Array.from({ length: 16 }, (_, i) => i),
      { GDAL_NODATA: "7" },
    );
    const { bytes } = await exportCogSubset(source, [0, 0, 2, 2]);
    const tiff = await fromArrayBuffer(bytes);
    const image = await tiff.getImage();
    assert.equal(image.getGDALNoData(), 7);
  });

  it("throws when the bbox does not overlap the raster", async () => {
    const source = await makeGeoTiff(
      4,
      4,
      0,
      4,
      Array.from({ length: 16 }, (_, i) => i),
    );
    await assert.rejects(
      () => exportCogSubset(source, [100, 100, 101, 101]),
      /does not overlap/,
    );
  });
});
