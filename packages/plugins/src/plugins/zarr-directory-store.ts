// A Zarr store that lives in a folder on disk rather than behind a URL.
//
// A Zarr store *is* a directory tree: `.zmetadata`, `<array>/.zarray`, and one
// file per chunk. `@carbonplan/zarr-layer` will read any zarrita `Readable`
// (that is how Cloud-Optimized NetCDF renders here, via a kerchunk store), so
// reading a local store needs nothing more than a `get(key)` that maps the key
// onto a path under the chosen folder.
//
// The folder access itself is the host's, not this module's: the desktop app
// reads through Tauri's fs plugin and the browser through a
// `FileSystemDirectoryHandle`. Both are expressed as a
// {@link ZarrDirectoryReader}, so everything below is platform-free.

import { createZarrMetadataReader, type ZarrMetadataReader } from "./zarr-metadata-reader";

/** Read access to one local folder holding a Zarr store. */
export interface ZarrDirectoryReader {
  /** Display name of the folder, used to name the layer. */
  name: string;
  /**
   * Read one file below the folder.
   *
   * @param path - Folder-relative path with `/` separators, e.g.
   *   `climate/0.0.1.1`.
   * @returns The file's bytes, or undefined when it does not exist.
   */
  readFile(path: string): Promise<Uint8Array | undefined>;
}

// Re-exported so the existing importers of this module — and the plugin API surface — keep the
// name they had when a folder was the only store read this way.
export type { ZarrMetadataReader };

/**
 * Strip the leading slash zarrita may put on a key and reject anything that
 * could climb out of the chosen folder.
 *
 * The keys come from the renderer, not from the user, so traversal is not a
 * live threat; the guard is here because this is the one place a store key
 * becomes a filesystem path, and the picker's grant covers exactly one subtree.
 *
 * @param key - A Zarr store key.
 * @returns The normalized folder-relative path, or null when it escapes.
 */
export function normalizeZarrKey(key: string): string | null {
  const trimmed = key.replace(/^\/+/, "");
  if (!trimmed) return null;
  if (trimmed.includes("\\")) return null;
  const segments = trimmed.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return null;
  }
  return segments.join("/");
}

/**
 * A zarrita-compatible `Readable` over a local folder. Hand it to
 * `ZarrLayerControl.addLayer(url, variable, { store })` and the renderer draws a
 * store that never leaves the machine.
 */
export class ZarrDirectoryStore {
  private readonly reader: ZarrDirectoryReader;

  constructor(reader: ZarrDirectoryReader) {
    this.reader = reader;
  }

  /**
   * Resolve a Zarr key to its bytes.
   *
   * @param key - Zarr key, with or without a leading slash (e.g.
   *   `/climate/0.0.1.1`).
   * @returns The bytes, or undefined when the key is not in the store. A
   *   missing chunk is normal (Zarr writes none for an all-fill chunk), so a
   *   read failure is reported as absence rather than thrown.
   */
  async get(key: string): Promise<Uint8Array | undefined> {
    const path = normalizeZarrKey(key);
    if (!path) return undefined;
    try {
      return await this.reader.readFile(path);
    } catch {
      return undefined;
    }
  }
}

/**
 * Build a {@link ZarrMetadataReader} over a local folder.
 *
 * Used to read a local cube's CF `units`/`calendar` so it can still be bound to
 * the Time Slider: its URL is only an identifier, so the usual metadata walk
 * over HTTP has nothing to fetch.
 *
 * @param reader - Read access to the folder.
 * @returns A reader resolving each metadata key to its parsed JSON document.
 */
export function createDirectoryZarrMetadataReader(reader: ZarrDirectoryReader): ZarrMetadataReader {
  // Only the key handling is this store's own: a folder cannot be asked for the leading slash
  // zarrita adds, nor for a path that climbs out of it. The decode is shared.
  return createZarrMetadataReader(async (key: string) => {
    const path = normalizeZarrKey(key);
    return path ? reader.readFile(path) : undefined;
  });
}

// Distinguishes one picked folder from the next; see localZarrStoreUrl.
let localZarrStoreSequence = 0;

/**
 * The pseudo-URL a local store is added under.
 *
 * The Zarr control keys per-layer state by URL and derives the layer name from
 * the last path segment, so a local store needs *some* URL-shaped identifier.
 * `local-zarr:` marks it as one that must not be fetched, and the folder name
 * is encoded so a name with URL-special characters survives the round trip.
 *
 * The name alone will not do: two folders both called `data.zarr` would collide
 * and the second add could patch the first layer. A per-call sequence number in
 * the query string keeps them apart while leaving the path — which is what the
 * layer is *named* from — as the folder name.
 *
 * GeoLibre mints this itself rather than letting the control derive one, so the
 * app can key its own per-store bookkeeping (the Time Slider's attribute
 * reader) by the same string.
 *
 * @param name - The chosen folder's display name.
 * @returns A unique identifier to add the layer under.
 */
export function localZarrStoreUrl(name: string): string {
  localZarrStoreSequence += 1;
  return `local-zarr:${encodeURIComponent(name || "zarr")}?${localZarrStoreSequence}`;
}
