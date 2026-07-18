/**
 * Import a set of geotagged photos as a GeoJSON point layer.
 *
 * Each image is placed from its EXIF GPS coordinates (read client-side with
 * `exifr`); a downscaled thumbnail (a JPEG data URL stored inline) and the
 * available EXIF metadata (timestamp, altitude, image direction, camera) ride
 * along as feature properties. Photos without usable GPS are skipped and
 * reported via the returned counts.
 *
 * Browsers cannot decode HEIC/HEIF on a `<canvas>`, so those images are still
 * located from their GPS tags but carry no thumbnail. Any image the browser
 * cannot decode (e.g. some TIFFs) is handled the same way: the point is placed,
 * the thumbnail is skipped.
 *
 * A second, full-resolution image (the original bytes, un-re-encoded) rides
 * along under {@link PHOTO_FULL_PROPERTY} for formats a browser can display so
 * the enlarged/fullscreen viewer and a right-click "Save image" keep the native
 * detail (and PNG/WebP transparency) rather than the downscaled, re-encoded
 * thumbnail. It is omitted only for formats a browser can't show at native size
 * (TIFF/HEIC), mislabeled bytes, or originals past the size ceiling.
 *
 * The thumbnail and feature-shaping helpers live here (UI-free) so the Add Data
 * dialog and the map drag-and-drop handler share one implementation.
 */

import type { Feature, FeatureCollection, Point } from "geojson";
import { PHOTO_FULL_PROPERTY, PHOTO_PROPERTY } from "./field-collection";

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

/** Extensions the browser cannot decode on a canvas (thumbnail is skipped). */
const HEIC_EXTENSIONS = new Set(["heic", "heif"]);

/**
 * Longest edge (px) of the inline JPEG thumbnail generated for each photo. This
 * thumbnail is what the map marker/popup shows; for JPEG/PNG/WebP sources larger
 * than the cap the original is also retained (see {@link PHOTO_FULL_PROPERTY})
 * for the enlarged view, but the thumbnail stays this small so the marker/popup
 * render fast. It is sized so the resizable photo popup stays sharp when
 * enlarged (the popup display caps near 900px, doubled here for high-DPI
 * screens) while keeping the inline data URL a few hundred KB rather than the
 * multi-MB source. Budget ~250-500 KB per photo at this size/quality; since the
 * data URL is held in the store and serialized into the project file, raising it
 * further trades sharpness for project size on photo-heavy imports.
 */
const PHOTO_MAX_DIMENSION = 1600;
/** JPEG quality for the generated photo image. */
const PHOTO_JPEG_QUALITY = 0.82;

/**
 * Image MIME type, keyed by extension, for the formats a browser can render at
 * native size directly from a data URL. Only these get a full-resolution image
 * embedded alongside the thumbnail; TIFF/HEIC decode to a canvas thumbnail but
 * cannot be shown natively in an `<img>`, so they fall back to the thumbnail.
 */
const FULL_RESOLUTION_IMAGE_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

/**
 * Upper bound (bytes) on a single embedded full-resolution original. Normal
 * high-resolution phone/DSLR photos (the reporter's are ~7 MB; 20-30 MB is
 * typical for the largest) stay well under this and embed as intended; a
 * pathologically large file (a giant panorama, an uncompressed original) falls
 * back to thumbnail-only rather than adding hundreds of MB to the project from a
 * single photo. This is a per-photo sanity ceiling, not a per-project one: many
 * ordinary photos still grow the project roughly with their total size, which is
 * the intended trade-off for native resolution.
 */
export const MAX_FULL_RESOLUTION_BYTES = 64 * 1024 * 1024;

/**
 * Detect an image's MIME type from its leading magic bytes, so a mislabeled
 * file (e.g. a `.png` that is actually JPEG data) still gets a data URL a
 * browser can decode. Returns null when the signature is not one of the
 * natively displayable formats (JPEG/PNG/WebP); the caller then skips embedding
 * the original, since trusting the extension could yield an undecodable data URL.
 */
function sniffImageMime(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

/**
 * Read a Blob as a base64 data URL. Prefers `FileReader.readAsDataURL`, which
 * runs off the main thread and streams the base64 without the ~2x intermediate
 * UTF-16 string {@link base64FromBytes} builds, so a near-cap (tens of MB) photo
 * doesn't spike memory or freeze the UI. Falls back to `arrayBuffer()` + manual
 * base64 under Node (tests), where `FileReader` is unavailable.
 */
async function blobToDataUrl(blob: Blob): Promise<string> {
  if (typeof FileReader === "function") {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error ?? new Error("read failed"));
      reader.readAsDataURL(blob);
    });
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return `data:${blob.type};base64,${base64FromBytes(bytes)}`;
}

/** Base64-encode raw bytes in chunks so large images don't overflow the call
 * stack (`btoa(String.fromCharCode(...allBytes))` throws on multi-MB inputs).
 * Exported for direct testing (the DOM decode path is unavailable under Node). */
export function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function fileExtension(name: string): string {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

/** Whether a filename looks like an image the photo importer can read. */
export function isPhotoFileName(name: string): boolean {
  return (PHOTO_IMAGE_EXTENSIONS as readonly string[]).includes(fileExtension(name));
}

/**
 * Whether a dropped filename should be auto-imported as a geotagged photo.
 * Narrower than {@link isPhotoFileName}: it omits TIFF so dropping a GeoTIFF
 * still loads as a raster.
 */
export function isPhotoDropFileName(name: string): boolean {
  return PHOTO_DROP_EXTENSIONS.has(fileExtension(name));
}

function isHeicFileName(name: string): boolean {
  return HEIC_EXTENSIONS.has(fileExtension(name));
}

/** The EXIF fields the importer reads off each photo. */
interface PhotoExif {
  /** WGS84 latitude exifr derives from the GPS block. */
  latitude?: number;
  /** WGS84 longitude exifr derives from the GPS block. */
  longitude?: number;
  GPSAltitude?: number;
  /** 0 = above sea level, 1 = below; exifr leaves it for us to apply. May come
   * back as a number or a single-element byte array. */
  GPSAltitudeRef?: number | Uint8Array;
  GPSImgDirection?: number;
  DateTimeOriginal?: Date | string;
  CreateDate?: Date | string;
  Make?: string;
  Model?: string;
}

/**
 * Validate a coordinate pair, returning the narrowed `{ lng, lat }` on success
 * and `false` otherwise. Returning the pair (rather than a single-argument type
 * predicate) lets callers use both values without a cast.
 */
export function isValidLngLat(lng: unknown, lat: unknown): { lng: number; lat: number } | false {
  if (
    typeof lng === "number" &&
    typeof lat === "number" &&
    Number.isFinite(lng) &&
    Number.isFinite(lat) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180 &&
    // Treat exact 0,0 as a zeroed/absent fix rather than a real Gulf-of-Guinea
    // photo: cameras write 0,0 far more often than anyone shoots the equator.
    !(lng === 0 && lat === 0)
  ) {
    return { lng, lat };
  }
  return false;
}

/** Whether the GPS altitude reference marks a below-sea-level position. */
function isBelowSeaLevel(ref: number | Uint8Array | undefined): boolean {
  if (typeof ref === "number") return ref === 1;
  if (ArrayBuffer.isView(ref)) return (ref as Uint8Array)[0] === 1;
  return false;
}

/** Round to a fixed number of decimals, dropping non-finite inputs. */
function roundTo(value: unknown, decimals: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Normalize an EXIF date (a Date with `reviveValues`, or a raw string) to ISO. */
function toIsoTimestamp(value: Date | string | undefined): string | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === "string" && value.trim()) return value.trim();
  return undefined;
}

/**
 * Build the feature properties for one photo: its filename, the inline
 * thumbnail (when one could be generated), and any available EXIF metadata.
 * Absent fields are omitted so the attribute table stays uncluttered.
 *
 * @param fileName - The source image's filename, stored as `name`.
 * @param exif - The parsed EXIF fields for the image.
 * @param thumbnail - A JPEG data URL thumbnail, or null when none was made.
 * @param fullResolution - A data URL of the original, native-resolution image
 *   for the enlarged/fullscreen viewer, or null when the thumbnail is already
 *   native (or the format can't be shown at full size). Defaults to null.
 * @returns The GeoJSON feature properties for the photo point.
 */
export function buildPhotoProperties(
  fileName: string,
  exif: PhotoExif,
  thumbnail: string | null,
  fullResolution: string | null = null,
): Record<string, unknown> {
  const properties: Record<string, unknown> = { name: fileName };
  if (thumbnail) properties[PHOTO_PROPERTY] = thumbnail;
  if (fullResolution) properties[PHOTO_FULL_PROPERTY] = fullResolution;

  const timestamp = toIsoTimestamp(exif.DateTimeOriginal ?? exif.CreateDate);
  if (timestamp) properties.timestamp = timestamp;

  const rawAltitude = roundTo(exif.GPSAltitude, 2);
  const altitude =
    rawAltitude !== undefined && isBelowSeaLevel(exif.GPSAltitudeRef) ? -rawAltitude : rawAltitude;
  if (altitude !== undefined) properties.altitude = altitude;

  const direction = roundTo(exif.GPSImgDirection, 1);
  if (direction !== undefined) properties.direction = direction;

  const camera = [exif.Make, exif.Model]
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter(Boolean)
    .join(" ");
  if (camera) properties.camera = camera;

  return properties;
}

async function readPhotoExif(file: Blob): Promise<PhotoExif | null> {
  try {
    // Lazy-loaded so importing the lightweight `isPhotoFileName` filter (used by
    // the drag-and-drop router) doesn't pull the EXIF parser into that chunk.
    const { default: exifr } = await import("exifr");
    // Default segment selection parses the TIFF block (IFD0 + EXIF + GPS), which
    // yields Make/Model/DateTimeOriginal and the computed latitude/longitude;
    // reviveValues turns EXIF dates into Date objects for toIsoTimestamp.
    return (await exifr.parse(file, {
      reviveValues: true,
    })) as PhotoExif | null;
  } catch {
    // A corrupt or unsupported file shouldn't abort the rest of the batch.
    return null;
  }
}

/** The image data URLs generated for one photo. */
interface PhotoImages {
  /** Downscaled JPEG thumbnail (data URL) for the map marker/popup, or null. */
  thumbnail: string | null;
  /**
   * Full-resolution image (data URL of the original bytes) for the enlarged
   * viewer, or null when the format can't be shown at full size (TIFF/HEIC), the
   * bytes are mislabeled, or the original exceeds the size ceiling.
   */
  fullResolution: string | null;
}

/**
 * Embed the original image bytes unchanged as a data URL so the enlarged viewer
 * and "Save image" get native resolution. Returns null for formats a browser
 * cannot render in an `<img>` (TIFF/HEIC), where the viewer falls back to the
 * thumbnail. The bytes are not re-encoded, so there is no quality loss; the
 * trade-off is project-file size, since this is serialized into the project.
 * Exported for testing.
 */
export async function createFullResolutionDataUrl(
  file: Blob,
  fileName: string,
): Promise<string | null> {
  // Gate on the extension so TIFF/HEIC (which a browser can't show at full size)
  // are never embedded.
  if (!FULL_RESOLUTION_IMAGE_MIME[fileExtension(fileName)]) return null;
  // A pathologically large original falls back to thumbnail-only so one photo
  // can't add hundreds of MB to the project.
  if (file.size > MAX_FULL_RESOLUTION_BYTES) return null;
  try {
    // Derive the MIME from the actual magic bytes, not the extension: a genuine
    // JPEG/PNG/WebP always has a recognizable signature, so a failed sniff means
    // the file is mislabeled (e.g. a GIF/BMP named .jpg), and tagging its bytes
    // as image/jpeg would be undecodable — skip full-res (the canvas thumbnail
    // still works). Blob.slice is a view, so retagging the type doesn't copy the
    // image bytes.
    const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const mime = sniffImageMime(header);
    if (!mime) return null;
    return await blobToDataUrl(file.slice(0, file.size, mime));
  } catch {
    return null;
  }
}

/**
 * Generate the thumbnail (a downscaled JPEG capped at {@link PHOTO_MAX_DIMENSION}
 * on its longest edge) and, for formats a browser can show natively, the
 * full-resolution image (the original bytes, regardless of the source's size).
 * Returns both as null for HEIC/HEIF (no canvas decoder) and for any image the
 * browser fails to decode, so the caller still places the point without an
 * inline image; the full-resolution image alone is null when the format can't be
 * shown natively, the bytes are mislabeled, or the original is over the ceiling.
 */
async function createPhotoImages(file: Blob, fileName: string): Promise<PhotoImages> {
  const empty: PhotoImages = { thumbnail: null, fullResolution: null };
  if (isHeicFileName(fileName)) return empty;
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") {
    return empty;
  }

  let bitmap: ImageBitmap;
  try {
    // `from-image` bakes the EXIF orientation in so thumbnails aren't sideways.
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return empty;
  }

  const longestEdge = Math.max(bitmap.width, bitmap.height);
  try {
    const scale = Math.min(1, PHOTO_MAX_DIMENSION / longestEdge);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return empty;
    context.drawImage(bitmap, 0, 0, width, height);
    const thumbnail = canvas.toDataURL("image/jpeg", PHOTO_JPEG_QUALITY);
    // Release the decoded bitmap (a raw RGBA buffer, ~194 MB for an 8064×6048
    // source) before reading the original bytes and building the base64 string,
    // where peak memory is highest; the full-res encode reads `file`, not the
    // bitmap. The `finally` close is a safe no-op on an already-closed bitmap.
    bitmap.close();
    // Embed the original whenever the format allows, even when it is at/below the
    // thumbnail cap: the thumbnail is a re-encoded, quality-0.82 JPEG (opaque,
    // with compression artifacts), so it is not the original even at matching
    // dimensions. This keeps the true bytes for the viewer/save and preserves
    // PNG/WebP transparency.
    const fullResolution = await createFullResolutionDataUrl(file, fileName);
    return { thumbnail, fullResolution };
  } catch {
    return empty;
  } finally {
    bitmap.close();
  }
}

/** Outcome of importing a batch of photos. */
export interface GeotaggedPhotoResult {
  /** One point feature per photo that carried usable GPS coordinates. */
  featureCollection: FeatureCollection<Point>;
  /** Images examined. */
  total: number;
  /** Images placed from GPS (the feature count). */
  located: number;
  /** Images skipped because they had no usable GPS. */
  skipped: number;
  /** Located images that could not be given a thumbnail (e.g. HEIC). */
  withoutThumbnail: number;
}

/**
 * Parse a batch of image files into a point FeatureCollection from their EXIF
 * GPS tags. Files without usable coordinates are skipped and counted; the order
 * of the resulting features follows the input order.
 *
 * @param files - The image files to import (any non-image is simply skipped).
 * @returns The point layer plus per-batch counts for the caller's summary.
 */
export async function loadGeotaggedPhotos(files: File[]): Promise<GeotaggedPhotoResult> {
  const features: Feature<Point>[] = [];
  let withoutThumbnail = 0;

  for (const file of files) {
    const fileName = file.name || "photo";
    const exif = await readPhotoExif(file);
    const coord = exif && isValidLngLat(exif.longitude, exif.latitude);
    if (!exif || !coord) continue;

    const { thumbnail, fullResolution } = await createPhotoImages(file, fileName);
    if (!thumbnail) withoutThumbnail += 1;

    features.push({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [coord.lng, coord.lat],
      },
      properties: buildPhotoProperties(fileName, exif, thumbnail, fullResolution),
    });
  }

  return {
    featureCollection: { type: "FeatureCollection", features },
    total: files.length,
    located: features.length,
    skipped: files.length - features.length,
    withoutThumbnail,
  };
}

/**
 * Build a point layer for photos that carry no usable GPS by placing every one
 * at `center` (typically the current map view center). EXIF metadata and inline
 * thumbnails are still read so a manually placed photo carries the same feature
 * properties as a GPS-located one; the caller then lets the user drag the point
 * into its final position.
 *
 * @param files - The image files to place. Anything the EXIF/thumbnail readers
 *   cannot parse is still placed at the center with whatever could be read.
 * @param center - The `[lng, lat]` to drop every photo at.
 * @returns The point layer plus counts shaped like {@link loadGeotaggedPhotos}
 *   (`skipped` is always 0 because manual placement never drops a photo).
 */
export async function loadPhotosAtLocation(
  files: File[],
  center: [number, number],
): Promise<GeotaggedPhotoResult> {
  const features: Feature<Point>[] = [];
  let withoutThumbnail = 0;

  for (const file of files) {
    const fileName = file.name || "photo";
    const exif = (await readPhotoExif(file)) ?? {};
    const { thumbnail, fullResolution } = await createPhotoImages(file, fileName);
    if (!thumbnail) withoutThumbnail += 1;

    features.push({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [center[0], center[1]],
      },
      properties: buildPhotoProperties(fileName, exif, thumbnail, fullResolution),
    });
  }

  return {
    featureCollection: { type: "FeatureCollection", features },
    total: files.length,
    located: features.length,
    skipped: 0,
    withoutThumbnail,
  };
}

/**
 * Return a copy of a photo point collection with every feature moved to
 * `[lng, lat]`. Used while the user drags the manual-placement handle so the
 * rendered points follow the marker; feature properties (thumbnail, EXIF) are
 * preserved. The per-feature spread is shallow, so the (potentially large)
 * inline image string is shared by reference, not duplicated, on each drag
 * frame.
 *
 * @param collection - The photo point collection to relocate.
 * @param position - The `[lng, lat]` to move every feature to.
 * @returns A new collection with the same features at the new position.
 */
export function relocatePhotoFeatures(
  collection: FeatureCollection<Point>,
  [lng, lat]: [number, number],
): FeatureCollection<Point> {
  return {
    type: "FeatureCollection",
    features: collection.features.map((feature) => ({
      ...feature,
      geometry: { type: "Point", coordinates: [lng, lat] },
    })),
  };
}
