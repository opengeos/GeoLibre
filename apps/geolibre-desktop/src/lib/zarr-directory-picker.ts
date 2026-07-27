// Picking a Zarr store that lives in a folder on disk.
//
// A Zarr store is a directory tree, so opening one locally means read access to
// a folder rather than to a file. Two platforms offer that, and this module
// hides the difference behind `@geolibre/plugins`' `ZarrDirectoryReader`:
//
// - the desktop app, through the Tauri folder dialog, whose `recursive: true`
//   grant extends the `fs` scope to the picked folder's whole subtree;
// - a Chromium browser, through the File System Access API's
//   `showDirectoryPicker()`, which hands back a handle the page may walk.
//
// Firefox and Safari implement neither, so `zarrDirectoryPickerSupported()`
// reports the feature as unavailable there rather than opening a dialog that
// cannot deliver.

import { open } from "@tauri-apps/plugin-dialog";
import { readDir, readFile } from "@tauri-apps/plugin-fs";
import type { ZarrDirectoryReader } from "@geolibre/plugins";
import { isTauri } from "./is-tauri";

/** The subset of `FileSystemDirectoryHandle` this module uses. */
interface DirectoryHandle {
  name: string;
  kind: "directory";
  getDirectoryHandle(name: string): Promise<DirectoryHandle>;
  getFileHandle(name: string): Promise<{ getFile(): Promise<Blob> }>;
  values(): AsyncIterable<{ name: string; kind: "file" | "directory" }>;
}

interface DirectoryPickerWindow extends Window {
  showDirectoryPicker?: (options?: { mode?: "read" | "readwrite" }) => Promise<DirectoryHandle>;
}

/**
 * Whether this build can open a Zarr store from a local folder: always on
 * desktop, and in a browser only where the File System Access API exists.
 *
 * @returns True when {@link pickZarrDirectory} can present a folder dialog.
 */
export function zarrDirectoryPickerSupported(): boolean {
  if (isTauri()) return true;
  return typeof (window as DirectoryPickerWindow).showDirectoryPicker === "function";
}

/**
 * Open the folder dialog and return read access to the chosen folder.
 *
 * @returns A reader over the picked folder, or null when the dialog was
 *   dismissed or no folder picker is available.
 */
export async function pickZarrDirectory(): Promise<ZarrDirectoryReader | null> {
  if (isTauri()) {
    const selected = await open({ directory: true, multiple: false, recursive: true });
    return typeof selected === "string" ? createTauriDirectoryReader(selected) : null;
  }

  const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
  if (!picker) return null;
  try {
    const handle = await picker.call(window, { mode: "read" });
    return handle ? createHandleDirectoryReader(handle) : null;
  } catch (error) {
    // Dismissing the dialog rejects with AbortError; that is not a failure.
    if (error instanceof DOMException && error.name === "AbortError") return null;
    throw error;
  }
}

/** The last segment of a local path, used as the store's display name. */
function directoryName(path: string): string {
  return (
    path
      .replace(/[/\\]+$/, "")
      .split(/[/\\]/)
      .pop() || path
  );
}

/** Read a picked folder through Tauri's `fs` plugin. */
function createTauriDirectoryReader(root: string): ZarrDirectoryReader {
  // Join with the folder's own separator style so a Windows path stays
  // all-backslash; store keys always arrive with `/`.
  const separator = root.includes("\\") ? "\\" : "/";
  const base = /[/\\]$/.test(root) ? root.slice(0, -1) : root;
  const resolve = (path: string) =>
    path ? `${base}${separator}${path.split("/").join(separator)}` : base;

  return {
    name: directoryName(root),
    async readFile(path: string) {
      try {
        return await readFile(resolve(path));
      } catch {
        // A Zarr store writes no file for an all-fill chunk, so a missing key
        // is ordinary rather than an error worth surfacing.
        return undefined;
      }
    },
    async listEntries(path: string) {
      try {
        const entries = await readDir(resolve(path));
        return entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory }));
      } catch {
        return [];
      }
    },
  };
}

/** Read a picked folder through a File System Access directory handle. */
function createHandleDirectoryReader(root: DirectoryHandle): ZarrDirectoryReader {
  const resolveDirectory = async (path: string): Promise<DirectoryHandle | null> => {
    let handle = root;
    for (const segment of path.split("/").filter(Boolean)) {
      handle = await handle.getDirectoryHandle(segment);
    }
    return handle;
  };

  return {
    name: root.name || "zarr",
    async readFile(path: string) {
      const segments = path.split("/").filter(Boolean);
      const fileName = segments.pop();
      if (!fileName) return undefined;
      try {
        const directory = await resolveDirectory(segments.join("/"));
        if (!directory) return undefined;
        const file = await directory.getFileHandle(fileName);
        return new Uint8Array(await (await file.getFile()).arrayBuffer());
      } catch {
        // As above: an absent key is how a store expresses an empty chunk.
        return undefined;
      }
    },
    async listEntries(path: string) {
      try {
        const directory = await resolveDirectory(path);
        if (!directory) return [];
        const entries: Array<{ name: string; isDirectory: boolean }> = [];
        for await (const entry of directory.values()) {
          entries.push({ name: entry.name, isDirectory: entry.kind === "directory" });
        }
        return entries;
      } catch {
        return [];
      }
    },
  };
}
