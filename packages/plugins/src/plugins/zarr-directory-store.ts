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

import type { ZarrDirectoryLister, ZarrMetadataReader } from "./zarr-store-metadata";

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
  /**
   * List the immediate children of a folder-relative directory.
   *
   * @param path - Folder-relative directory path (`""` for the store root).
   * @returns The entries, or an empty list when the path is not a directory.
   */
  listEntries(path: string): Promise<Array<{ name: string; isDirectory: boolean }>>;
}

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
 * Build a {@link ZarrMetadataReader} over a local folder, for
 * `readZarrStoreMetadata`.
 *
 * @param reader - Read access to the folder.
 * @returns A reader resolving each metadata key to its parsed JSON document.
 */
export function createDirectoryZarrMetadataReader(reader: ZarrDirectoryReader): ZarrMetadataReader {
  return async (key: string) => {
    const path = normalizeZarrKey(key);
    if (!path) return undefined;
    let bytes: Uint8Array | undefined;
    try {
      bytes = await reader.readFile(path);
    } catch {
      return undefined;
    }
    if (!bytes) return undefined;
    try {
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch {
      // A key that exists but is not JSON is not a metadata document.
      return undefined;
    }
  };
}

/**
 * Build a {@link ZarrDirectoryLister} over a local folder, enabling
 * `readZarrStoreMetadata`'s node walk for a store with no consolidated
 * metadata.
 *
 * @param reader - Read access to the folder.
 * @returns A lister over that folder, resolving to `[]` for an unreadable path.
 */
export function createDirectoryZarrLister(reader: ZarrDirectoryReader): ZarrDirectoryLister {
  return async (path: string) => {
    const relative = path ? normalizeZarrKey(path) : "";
    if (relative === null) return [];
    try {
      return await reader.listEntries(relative);
    } catch {
      return [];
    }
  };
}

// Distinguishes one picked folder from the next; see localZarrStoreUrl.
let localZarrStoreSequence = 0;

/**
 * The pseudo-URL a local store is added under.
 *
 * The Zarr control keys its state and its layer names by URL, and the layer
 * name is derived from the last path segment, so a local store needs *some*
 * URL-shaped identifier. `local-zarr:` marks it as one that must not be
 * fetched, and the folder name is encoded so a name with URL-special
 * characters survives the round trip.
 *
 * The name alone will not do: the control keys per-URL state (and the host
 * refcounts in-flight adds) by this string, so two folders both called
 * `data.zarr` would collide and the second add could patch the first layer. A
 * per-call sequence number in the query string keeps them apart while leaving
 * the path — which is what the layer is *named* from — as the folder name.
 *
 * @param name - The chosen folder's display name.
 * @returns A unique identifier to add the layer under.
 */
export function localZarrStoreUrl(name: string): string {
  localZarrStoreSequence += 1;
  return `local-zarr:${encodeURIComponent(name || "zarr")}?${localZarrStoreSequence}`;
}
