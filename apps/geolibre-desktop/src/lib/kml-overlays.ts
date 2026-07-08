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
 * Find the *key* of the archive entry an href points at. Hrefs are written
 * relative to the archive root, but authors nest files inconsistently, so this
 * tries an exact match, then a normalized-path match, then a unique basename.
 *
 * Callers that need to resolve sibling files (e.g. a `.dae`'s textures relative
 * to where it was actually found) use the returned key rather than the guessed
 * href, since the basename tier can match a differently-nested entry.
 *
 * @param entries - The unzipped archive entries, keyed by entry name.
 * @param href - The href value to resolve.
 * @returns The matching entry's key, or undefined when none is found.
 */
export function findArchiveEntryKey(
  entries: Record<string, Uint8Array>,
  href: string,
): string | undefined {
  // `Object.hasOwn`, not a truthy `entries[href]`, so an href like "__proto__"
  // or "constructor" cannot resolve an inherited prototype member instead of a
  // real archive entry.
  if (Object.hasOwn(entries, href)) return href;

  const target = normalizeArchivePath(href);
  for (const name of Object.keys(entries)) {
    if (normalizeArchivePath(name) === target) return name;
  }

  const base = target.split("/").pop();
  if (base) {
    const matches = Object.keys(entries).filter(
      (name) => normalizeArchivePath(name).split("/").pop() === base,
    );
    if (matches.length === 1) return matches[0];
  }
  return undefined;
}

/**
 * Find the archive entry an href points at (see {@link findArchiveEntryKey}).
 *
 * @param entries - The unzipped archive entries, keyed by entry name.
 * @param href - The href value to resolve.
 * @returns The matching entry's bytes, or undefined when none is found.
 */
export function findArchiveEntry(
  entries: Record<string, Uint8Array>,
  href: string,
): Uint8Array | undefined {
  const key = findArchiveEntryKey(entries, href);
  return key === undefined ? undefined : entries[key];
}
