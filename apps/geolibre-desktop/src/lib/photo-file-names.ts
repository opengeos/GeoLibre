/**
 * Filename predicates for the geotagged-photo importer, kept apart from
 * `geotagged-photos.ts` so the drag-and-drop router and the file pickers can
 * classify files without pulling the importer itself onto the boot path; the
 * importer is loaded with `import()` only when photos are actually imported.
 */

/** Image extensions the photo importer recognizes. */
export const PHOTO_IMAGE_EXTENSIONS = [
  "jpg",
  "jpeg",
  "png",
  "tif",
  "tiff",
  "webp",
  "heic",
  "heif",
] as const;

/**
 * Image extensions safe to auto-detect on drag-and-drop. Excludes tif/tiff,
 * which the map already routes to the GeoTIFF raster loader; a geotagged TIFF
 * photo can still be imported through the explicit Add Data > Photos dialog.
 */
const PHOTO_DROP_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "heic", "heif"]);

/**
 * The lowercased text after a filename's last dot.
 *
 * @param name - A file name or path.
 * @returns The lowercased extension, or the whole lowercased name when it has no dot.
 */
export function photoFileExtension(name: string): string {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

/** Whether a filename looks like an image the photo importer can read. */
export function isPhotoFileName(name: string): boolean {
  return (PHOTO_IMAGE_EXTENSIONS as readonly string[]).includes(photoFileExtension(name));
}

/**
 * Whether a dropped filename should be auto-imported as a geotagged photo.
 * Narrower than {@link isPhotoFileName}: it omits TIFF so dropping a GeoTIFF
 * still loads as a raster.
 */
export function isPhotoDropFileName(name: string): boolean {
  return PHOTO_DROP_EXTENSIONS.has(photoFileExtension(name));
}
