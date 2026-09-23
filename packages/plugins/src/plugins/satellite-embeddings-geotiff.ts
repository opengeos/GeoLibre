/**
 * A minimal GeoTIFF encoder for embedding downloads.
 *
 * geotiff.js ships a writer, but it copies values one DataView at a time and
 * silently writes zeros for `Int8Array` input, which is exactly what quantized
 * embeddings are. This encoder writes an uncompressed, band-separate
 * (PlanarConfiguration 2) classic TIFF with one strip per band, so each band's
 * typed array is emitted as-is: the result is a list of blob parts rather than
 * one concatenated buffer, which keeps a large download from being copied a
 * second time in memory.
 */

/** Pixel type of the encoded bands. */
export type GeoTiffSampleType = "int8" | "float32";

/** Input for {@link encodeGeoTiff}. */
export interface GeoTiffEncodeOptions {
  width: number;
  height: number;
  /** One array per band, row-major with the first row at the north edge. */
  bands: (Int8Array | Float32Array)[];
  sampleType: GeoTiffSampleType;
  /** EPSG code of a projected CRS (e.g. 32617) or 4326 for lon/lat. */
  epsg: number;
  /** X of the west edge and Y of the north edge, in CRS units. */
  originX: number;
  originY: number;
  /** Pixel width and height in CRS units (positive). */
  pixelSizeX: number;
  pixelSizeY: number;
  /** NoData value written to the `GDAL_NODATA` tag, e.g. `"-128"` or `"nan"`. */
  nodata?: string;
  /** Band descriptions written to `GDAL_METADATA`, e.g. `["A00", "A01"]`. */
  bandNames?: string[];
}

/** Classic TIFF offsets are 32-bit, so a file must stay under 4 GiB. */
export const MAX_CLASSIC_TIFF_BYTES = 0xffff_ffff;

// TIFF field types.
const SHORT = 3;
const LONG = 4;
const ASCII = 2;
const DOUBLE = 12;
const TYPE_SIZE: Record<number, number> = { [ASCII]: 1, [SHORT]: 2, [LONG]: 4, [DOUBLE]: 8 };

interface Tag {
  code: number;
  type: number;
  values: number[] | string;
}

/** Escapes text for an XML element body. */
function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Encodes bands as a GeoTIFF. Returns the file as blob parts: a header (the
 * TIFF header, IFD and tag data) followed by each band's bytes.
 */
export function encodeGeoTiff(options: GeoTiffEncodeOptions): BlobPart[] {
  const { width, height, bands, sampleType, epsg } = options;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error("GeoTIFF width and height must be positive integers");
  }
  if (bands.length === 0) throw new Error("GeoTIFF needs at least one band");
  const bytesPerSample = sampleType === "int8" ? 1 : 4;
  const bandBytes = width * height * bytesPerSample;
  for (const band of bands) {
    if (band.byteLength !== bandBytes) {
      throw new Error("Every GeoTIFF band must hold width × height samples of the sample type");
    }
  }
  const samples = bands.length;
  const geographic = epsg === 4326;
  const geoKeys = geographic
    ? [1, 1, 0, 3, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326]
    : [1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, epsg];

  const tags: Tag[] = [
    { code: 256, type: LONG, values: [width] },
    { code: 257, type: LONG, values: [height] },
    { code: 258, type: SHORT, values: new Array(samples).fill(bytesPerSample * 8) },
    { code: 259, type: SHORT, values: [1] }, // no compression
    { code: 262, type: SHORT, values: [1] }, // BlackIsZero
    { code: 273, type: LONG, values: new Array(samples).fill(0) }, // patched below
    { code: 277, type: SHORT, values: [samples] },
    { code: 278, type: LONG, values: [height] },
    { code: 279, type: LONG, values: new Array(samples).fill(bandBytes) },
    { code: 284, type: SHORT, values: [2] }, // band-separate
    ...(samples > 1 ? [{ code: 338, type: SHORT, values: new Array(samples - 1).fill(0) }] : []),
    { code: 339, type: SHORT, values: new Array(samples).fill(sampleType === "int8" ? 2 : 3) },
    { code: 33550, type: DOUBLE, values: [options.pixelSizeX, options.pixelSizeY, 0] },
    { code: 33922, type: DOUBLE, values: [0, 0, 0, options.originX, options.originY, 0] },
    { code: 34735, type: SHORT, values: geoKeys },
  ];
  if (options.bandNames?.length) {
    const items = options.bandNames
      .slice(0, samples)
      .map(
        (name, index) =>
          `<Item name="DESCRIPTION" sample="${index}" role="description">${escapeXml(name)}</Item>`,
      )
      .join("");
    tags.push({ code: 42112, type: ASCII, values: `<GDALMetadata>${items}</GDALMetadata>` });
  }
  if (options.nodata !== undefined) {
    tags.push({ code: 42113, type: ASCII, values: options.nodata });
  }

  // Layout: 8-byte header, the IFD, then out-of-line tag values, then bands.
  const ifdOffset = 8;
  const ifdSize = 2 + tags.length * 12 + 4;
  const valueSize = (tag: Tag): number =>
    typeof tag.values === "string"
      ? tag.values.length + 1
      : tag.values.length * TYPE_SIZE[tag.type];
  let extraOffset = ifdOffset + ifdSize;
  const extraOffsets = new Map<Tag, number>();
  for (const tag of tags) {
    const size = valueSize(tag);
    if (size > 4) {
      extraOffsets.set(tag, extraOffset);
      extraOffset += size + (size % 2); // keep word alignment
    }
  }
  const headerSize = extraOffset;
  const total = headerSize + bandBytes * samples;
  if (total > MAX_CLASSIC_TIFF_BYTES) {
    throw new Error("The GeoTIFF would exceed the 4 GiB classic TIFF limit");
  }
  const stripOffsets = tags.find((tag) => tag.code === 273)!;
  stripOffsets.values = bands.map((_, index) => headerSize + index * bandBytes);

  const header = new ArrayBuffer(headerSize);
  const view = new DataView(header);
  const bytes = new Uint8Array(header);
  bytes[0] = 0x49; // "II": little-endian
  bytes[1] = 0x49;
  view.setUint16(2, 42, true);
  view.setUint32(4, ifdOffset, true);

  const writeValues = (tag: Tag, offset: number): void => {
    if (typeof tag.values === "string") {
      for (let index = 0; index < tag.values.length; index += 1) {
        bytes[offset + index] = tag.values.charCodeAt(index) & 0x7f;
      }
      bytes[offset + tag.values.length] = 0;
      return;
    }
    tag.values.forEach((value, index) => {
      const at = offset + index * TYPE_SIZE[tag.type];
      if (tag.type === SHORT) view.setUint16(at, value, true);
      else if (tag.type === LONG) view.setUint32(at, value, true);
      else view.setFloat64(at, value, true);
    });
  };

  view.setUint16(ifdOffset, tags.length, true);
  tags.forEach((tag, index) => {
    const entry = ifdOffset + 2 + index * 12;
    const count = typeof tag.values === "string" ? tag.values.length + 1 : tag.values.length;
    view.setUint16(entry, tag.code, true);
    view.setUint16(entry + 2, tag.type, true);
    view.setUint32(entry + 4, count, true);
    const outOfLine = extraOffsets.get(tag);
    if (outOfLine === undefined) writeValues(tag, entry + 8);
    else {
      view.setUint32(entry + 8, outOfLine, true);
      writeValues(tag, outOfLine);
    }
  });
  view.setUint32(ifdOffset + 2 + tags.length * 12, 0, true); // no next IFD

  // Typed arrays hold native-endian values, and every platform a browser runs
  // on is little-endian, matching the "II" byte order declared above.
  return [header, ...bands.map((band) => band as unknown as ArrayBufferView<ArrayBuffer>)];
}
