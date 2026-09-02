import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GeoTIFF } from "@developmentseed/geotiff";
import { DOMParser } from "linkedom";

Object.assign(globalThis, { DOMParser });

const LARGE_METADATA_LENGTH = 200_000;

/** Build a minimal one-pixel TIFF carrying a large GDAL_METADATA ASCII tag. */
function tiffWithLargeMetadata(): ArrayBuffer {
  const metadata = `<GDALMetadata>${"x".repeat(LARGE_METADATA_LENGTH)}</GDALMetadata>\0`;
  const entries = 10;
  const ifdOffset = 8;
  const metadataOffset = ifdOffset + 2 + entries * 12 + 4;
  const pixelOffset = metadataOffset + metadata.length;
  const buffer = new ArrayBuffer(pixelOffset + 1);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  bytes.set([0x49, 0x49]);
  view.setUint16(2, 42, true);
  view.setUint32(4, ifdOffset, true);
  view.setUint16(ifdOffset, entries, true);

  const entry = (index: number, tag: number, type: number, count: number, value: number) => {
    const offset = ifdOffset + 2 + index * 12;
    view.setUint16(offset, tag, true);
    view.setUint16(offset + 2, type, true);
    view.setUint32(offset + 4, count, true);
    view.setUint32(offset + 8, value, true);
  };
  entry(0, 256, 4, 1, 1); // ImageWidth
  entry(1, 257, 4, 1, 1); // ImageLength
  entry(2, 258, 3, 1, 8); // BitsPerSample
  entry(3, 259, 3, 1, 1); // Compression
  entry(4, 262, 3, 1, 1); // PhotometricInterpretation
  entry(5, 273, 4, 1, pixelOffset); // StripOffsets
  entry(6, 277, 3, 1, 1); // SamplesPerPixel
  entry(7, 278, 4, 1, 1); // RowsPerStrip
  entry(8, 279, 4, 1, 1); // StripByteCounts
  entry(9, 42112, 2, metadata.length, metadataOffset); // GDAL_METADATA
  bytes.set(new TextEncoder().encode(metadata), metadataOffset);
  bytes[pixelOffset] = 1;
  return buffer;
}

describe("@cogeotiff/core dependency patch", () => {
  it("decodes TIFF ASCII metadata larger than the JavaScript argument limit", async () => {
    const tiff = await GeoTIFF.fromArrayBuffer(tiffWithLargeMetadata());
    assert.equal(tiff.cachedTags.gdalMetadata?.length, LARGE_METADATA_LENGTH + 29);
  });
});
