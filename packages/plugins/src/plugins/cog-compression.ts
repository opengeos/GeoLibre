/**
 * Whether a cog-tiler-wasm level's `compression` is baseline JPEG, the only
 * codec whose tiles may omit their tables (TIFF tag 347) and so need the
 * geotiff.js window read in maplibre-raster.ts. The string is whitebox-wasm's
 * enum name, so match `Jpeg`/`OldJpeg` exactly: a looser `/jpeg/i` would also
 * catch `JpegXl`, which the wasm decoder handles and geotiff.js cannot decode
 * at all (#2339). Kept in a leaf module so it can be unit-tested without
 * importing the whole raster plugin.
 */
export function isAbbreviatedJpegCompression(compression: string | undefined): boolean {
  return /^(old)?jpeg$/i.test(compression ?? "");
}
