/**
 * Pure, DOM-free helpers for resolving KML/KMZ `<GroundOverlay>` images. These
 * are split out of `tauri-io.ts` (which pulls in Tauri APIs) so the path- and
 * href-matching logic can be unit tested without a browser or the Tauri host.
 */

// Image MIME types for the formats KML ground overlays reference, keyed by
// lower-case file extension. Anything else falls back to a generic binary type,
// which browsers still content-sniff for the common image formats.
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  webp: "image/webp",
  tif: "image/tiff",
  tiff: "image/tiff",
};

/**
 * Pick an image MIME type from a file name or href by its extension.
 *
 * @param name - A file name, archive entry name, or href.
 * @returns The matching image MIME type, or `application/octet-stream`.
 */
export function imageMimeFromName(name: string): string {
  const extension = name.split(/[?#]/)[0].split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}

/**
 * Normalize a KMZ archive path (or a GroundOverlay href) for matching: drop any
 * query/fragment, decode `%XX` escapes, collapse backslashes, strip a leading
 * `./` or `/`, and lower-case it.
 *
 * @param value - An archive entry name or href.
 * @returns The normalized path.
 */
export function normalizeArchivePath(value: string): string {
  let path = value.split(/[?#]/)[0].replace(/\\/g, "/").replace(/^\.\//, "");
  try {
    path = decodeURIComponent(path);
  } catch {
    // Keep the raw value when it is not valid percent-encoding.
  }
  return path.replace(/^\/+/, "").toLowerCase();
}

/**
 * Find the archive entry a GroundOverlay's href points at. Hrefs are written
 * relative to the archive root, but authors nest images inconsistently, so this
 * tries an exact match, then a normalized-path match, then a unique basename.
 *
 * @param entries - The unzipped archive entries, keyed by entry name.
 * @param href - The overlay's `<Icon><href>` value.
 * @returns The matching entry's bytes, or undefined when none is found.
 */
export function findArchiveEntry(
  entries: Record<string, Uint8Array>,
  href: string,
): Uint8Array | undefined {
  // `Object.hasOwn`, not a truthy `entries[href]`, so an href like "__proto__"
  // or "constructor" cannot resolve an inherited prototype member instead of a
  // real archive entry.
  if (Object.hasOwn(entries, href)) return entries[href];

  const target = normalizeArchivePath(href);
  for (const [name, data] of Object.entries(entries)) {
    if (normalizeArchivePath(name) === target) return data;
  }

  const base = target.split("/").pop();
  if (base) {
    const matches = Object.entries(entries).filter(
      ([name]) => normalizeArchivePath(name).split("/").pop() === base,
    );
    if (matches.length === 1) return matches[0][1];
  }
  return undefined;
}
