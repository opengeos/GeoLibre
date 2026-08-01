import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { writeArrayBuffer } from "geotiff";
import { decodeTiffToRgba } from "../apps/geolibre-desktop/src/lib/tiff-image";

/** Write a tiny uncompressed TIFF with `samplesPerPixel` interleaved bands. */
async function tiffBytes(
  values: number[],
  width: number,
  height: number,
  samplesPerPixel: number,
  extra: Record<string, unknown> = {},
): Promise<Uint8Array> {
  const buffer = await writeArrayBuffer(new Uint8Array(values), {
    width,
    height,
    SamplesPerPixel: samplesPerPixel,
    BitsPerSample: Array.from({ length: samplesPerPixel }, () => 8),
    PhotometricInterpretation: samplesPerPixel >= 3 ? 2 : 1,
    ...extra,
  });
  return new Uint8Array(buffer as ArrayBuffer);
}

/** The RGBA quadruple at a pixel index. */
function pixel(image: { data: Uint8ClampedArray }, index: number): number[] {
  return Array.from(image.data.slice(index * 4, index * 4 + 4));
}

describe("decodeTiffToRgba", () => {
  it("decodes an RGB TIFF, filling in an opaque alpha channel", async () => {
    // 2x2: red, green, blue, yellow.
    const image = await decodeTiffToRgba(
      await tiffBytes([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0], 2, 2, 3),
    );
    assert.equal(image.width, 2);
    assert.equal(image.height, 2);
    assert.equal(image.data.length, 2 * 2 * 4);
    assert.deepEqual(pixel(image, 0), [255, 0, 0, 255]);
    assert.deepEqual(pixel(image, 1), [0, 255, 0, 255]);
    assert.deepEqual(pixel(image, 2), [0, 0, 255, 255]);
    assert.deepEqual(pixel(image, 3), [255, 255, 0, 255]);
  });

  it("keeps the alpha band of an RGBA TIFF", async () => {
    // Global Mapper writes its KML ground overlays this way: RGB plus an
    // unassociated alpha extra sample that makes the area outside the imagery
    // transparent. Dropping it would paint an opaque box over the basemap.
    const image = await decodeTiffToRgba(
      await tiffBytes(
        [10, 20, 30, 0, 40, 50, 60, 128, 70, 80, 90, 255, 100, 110, 120, 255],
        2,
        2,
        4,
        { ExtraSamples: [2] },
      ),
    );
    assert.deepEqual(pixel(image, 0), [10, 20, 30, 0]);
    assert.deepEqual(pixel(image, 1), [40, 50, 60, 128]);
    assert.deepEqual(pixel(image, 2), [70, 80, 90, 255]);
  });

  it("expands a single-band grayscale TIFF to gray RGBA", async () => {
    const image = await decodeTiffToRgba(await tiffBytes([0, 64, 128, 255], 2, 2, 1));
    assert.deepEqual(pixel(image, 0), [0, 0, 0, 255]);
    assert.deepEqual(pixel(image, 1), [64, 64, 64, 255]);
    assert.deepEqual(pixel(image, 3), [255, 255, 255, 255]);
  });

  it("decodes bytes held in a view over a larger buffer", async () => {
    // The KMZ unzipper hands out views into a pooled buffer, so a decoder that
    // reached for `bytes.buffer` would read the neighbouring entries instead.
    const tiff = await tiffBytes([1, 2, 3], 1, 1, 3);
    const padded = new Uint8Array(tiff.length + 16);
    padded.set(tiff, 8);
    const image = await decodeTiffToRgba(padded.subarray(8, 8 + tiff.length));
    assert.deepEqual(pixel(image, 0), [1, 2, 3, 255]);
  });

  it("rejects bytes that are not a TIFF", async () => {
    await assert.rejects(() => decodeTiffToRgba(new TextEncoder().encode("not a tiff at all")));
  });
});
