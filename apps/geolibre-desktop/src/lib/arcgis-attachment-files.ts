/**
 * File handling for ArcGIS service attachments: names, previews and sizes.
 * Attachment names and content come from the service and are untrusted.
 */

/**
 * Raster image types an `<img>` can show without running anything. SVG is
 * excluded: it can carry script, and the preview would load it in the app.
 */
const PREVIEWABLE_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/pjpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/avif",
]);

/**
 * Whether an attachment can be previewed inline.
 *
 * @param contentType - The type the service reports for the attachment.
 * @returns True for raster images the browser decodes itself.
 */
export function isPreviewableAttachment(contentType: string): boolean {
  return PREVIEWABLE_IMAGE_TYPES.has(contentType.split(";")[0].trim().toLowerCase());
}

/**
 * A file name safe to offer in a save dialog: the leaf name only, without
 * control characters or characters Windows rejects, and never empty or a
 * relative path component.
 *
 * @param name - The attachment's stored name.
 * @param fallback - The name to use when nothing usable remains.
 * @returns The sanitized name.
 */
export function attachmentSaveName(name: string, fallback = "attachment"): string {
  const leaf = name.split(/[\\/]/).pop() ?? "";
  const cleaned = leaf
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_")
    .replace(/^[\s.]+|[\s.]+$/g, "")
    .slice(0, 200);
  return cleaned || fallback;
}

/**
 * The extension of a file name, lowercased and without the dot.
 *
 * @param name - A file name.
 * @returns The extension, or an empty string.
 */
export function attachmentExtension(name: string): string {
  const match = /\.([a-z0-9]{1,10})$/i.exec(name);
  return match ? match[1].toLowerCase() : "";
}

/**
 * A byte count in the largest whole unit, formatted for the active locale.
 *
 * @param bytes - The size in bytes.
 * @param locale - The locale to format for; the runtime default when omitted.
 * @returns The formatted size, such as "1.2 MB".
 */
export function formatAttachmentSize(bytes: number, locale?: string): string {
  const units = ["byte", "kilobyte", "megabyte", "gigabyte"] as const;
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: units[unit],
    // "256 bytes" rather than the short form's "256 byte".
    unitDisplay: unit === 0 ? "long" : "short",
    maximumFractionDigits: unit === 0 ? 0 : 1,
  }).format(value);
}
