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
 * The thumbnail and feature-shaping helpers live here (UI-free) so the Add Data
 * dialog and the map drag-and-drop handler share one implementation.
 */

import type { Feature, FeatureCollection, Point } from "geojson";
import { PHOTO_PROPERTY } from "./field-collection";

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
const PHOTO_DROP_EXTENSIONS = new Set([
  "jpg",
  "jpeg",
  "png",
  "webp",
  "heic",
  "heif",
]);

/** Extensions the browser cannot decode on a canvas (thumbnail is skipped). */
const HEIC_EXTENSIONS = new Set(["heic", "heif"]);

/**
 * Longest edge (px) of the inline JPEG generated for each photo. The original
 * file is not retained after import, so this is the only resolution available
 * later: it is sized so the resizable photo popup stays sharp when enlarged
 * (the popup display caps near 900px, doubled here for high-DPI screens) while
 * keeping the inline data URL a few hundred KB rather than the multi-MB source.
 * Budget ~250-500 KB per photo at this size/quality; since the data URL is held
 * in the store and serialized into the project file, raising it further trades
 * sharpness for project size on photo-heavy imports.
 */
const PHOTO_MAX_DIMENSION = 1600;
/** JPEG quality for the generated photo image. */
const PHOTO_JPEG_QUALITY = 0.82;

function fileExtension(name: string): string {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

/** Whether a filename looks like an image the photo importer can read. */
export function isPhotoFileName(name: string): boolean {
  return (PHOTO_IMAGE_EXTENSIONS as readonly string[]).includes(
    fileExtension(name),
  );
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
export function isValidLngLat(
  lng: unknown,
  lat: unknown,
): { lng: number; lat: number } | false {
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
 * @returns The GeoJSON feature properties for the photo point.
 */
export function buildPhotoProperties(
  fileName: string,
  exif: PhotoExif,
  thumbnail: string | null,
): Record<string, unknown> {
  const properties: Record<string, unknown> = { name: fileName };
  if (thumbnail) properties[PHOTO_PROPERTY] = thumbnail;

  const timestamp = toIsoTimestamp(exif.DateTimeOriginal ?? exif.CreateDate);
  if (timestamp) properties.timestamp = timestamp;

  const rawAltitude = roundTo(exif.GPSAltitude, 2);
  const altitude =
    rawAltitude !== undefined && isBelowSeaLevel(exif.GPSAltitudeRef)
      ? -rawAltitude
      : rawAltitude;
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

/**
 * Generate a downscaled JPEG (a data URL) for an image the browser can decode,
 * capped at {@link PHOTO_MAX_DIMENSION} on its longest edge. Returns null for
 * HEIC/HEIF (no canvas decoder) and for any image the browser fails to decode,
 * so the caller still places the point without an inline image.
 */
async function createThumbnailDataUrl(
  file: Blob,
  fileName: string,
): Promise<string | null> {
  if (isHeicFileName(fileName)) return null;
  if (
    typeof createImageBitmap !== "function" ||
    typeof document === "undefined"
  ) {
    return null;
  }

  let bitmap: ImageBitmap;
  try {
    // `from-image` bakes the EXIF orientation in so thumbnails aren't sideways.
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return null;
  }

  try {
    const scale = Math.min(
      1,
      PHOTO_MAX_DIMENSION / Math.max(bitmap.width, bitmap.height),
    );
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, width, height);
    return canvas.toDataURL("image/jpeg", PHOTO_JPEG_QUALITY);
  } catch {
    return null;
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
export async function loadGeotaggedPhotos(
  files: File[],
): Promise<GeotaggedPhotoResult> {
  const features: Feature<Point>[] = [];
  let withoutThumbnail = 0;

  for (const file of files) {
    const fileName = file.name || "photo";
    const exif = await readPhotoExif(file);
    const coord = exif && isValidLngLat(exif.longitude, exif.latitude);
    if (!exif || !coord) continue;

    const thumbnail = await createThumbnailDataUrl(file, fileName);
    if (!thumbnail) withoutThumbnail += 1;

    features.push({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [coord.lng, coord.lat],
      },
      properties: buildPhotoProperties(fileName, exif, thumbnail),
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
    const thumbnail = await createThumbnailDataUrl(file, fileName);
    if (!thumbnail) withoutThumbnail += 1;

    features.push({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [center[0], center[1]],
      },
      properties: buildPhotoProperties(fileName, exif, thumbnail),
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
