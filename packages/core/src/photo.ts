/**
 * Feature-property keys for inline photo images, shared by the app and the map
 * package so neither hardcodes a second copy that could drift. These keys are
 * part of the project schema: they are serialized into `.geolibre.json` on a
 * geotagged-photo or field-collection layer.
 */

/** Property key under which a photo's downscaled thumbnail (data URL) is stored. */
export const PHOTO_PROPERTY = "photo";

/**
 * Property key under which a geotagged photo's full-resolution image (a data URL
 * of the original, un-re-encoded bytes) is stored. {@link PHOTO_PROPERTY} holds
 * the small thumbnail shown on the map marker/popup; this holds the
 * native-resolution original used by the enlarged/fullscreen viewer and a "Save
 * image". Absent when the source is already at or below the thumbnail cap, or a
 * format a browser cannot display at native size (TIFF/HEIC).
 */
export const PHOTO_FULL_PROPERTY = "photo_full";
