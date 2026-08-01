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

/**
 * Rewrite a TIFF's declared width/height without writing any more pixels, the
 * way a "decompression bomb" is built: a few hundred bytes on disk claiming a
 * raster of billions of pixels.
 */
function declareDimensions(tiff: Uint8Array, width: number, height: number): Uint8Array {
  const bytes = tiff.slice();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const littleEndian = view.getUint16(0, true) === 0x4949;
  const ifd = view.getUint32(4, littleEndian);
  const entries = view.getUint16(ifd, littleEndian);
  for (let entry = 0; entry < entries; entry++) {
    const at = ifd + 2 + entry * 12;
    const tag = view.getUint16(at, littleEndian);
    if (tag !== 256 && tag !== 257) continue;
    // Widen the tag to LONG so the value field can hold a number a SHORT could
    // not, then write the fabricated dimension inline.
    view.setUint16(at + 2, 4, littleEndian);
    view.setUint32(at + 4, 1, littleEndian);
    view.setUint32(at + 8, tag === 256 ? width : height, littleEndian);
  }
  return bytes;
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

  it("rejects a TIFF declaring more pixels than the decode limit", async () => {
    // The dimensions are IFD tags, so a KMZ can carry a tiny file claiming a
    // 50000x50000 raster. Decoding it would allocate ~10 GB on the main thread,
    // so it has to be refused before any pixel buffer is created.
    const bomb = declareDimensions(await tiffBytes([1, 2, 3], 1, 1, 3), 50000, 50000);
    assert.ok(bomb.length < 1024);
    await assert.rejects(() => decodeTiffToRgba(bomb), /megapixel decode limit/);
  });
});
