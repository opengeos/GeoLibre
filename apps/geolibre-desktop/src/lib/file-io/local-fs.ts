/**
 * Direct reads and writes of local filesystem paths (desktop only), with the
 * `read_local_file` command fallback for paths outside the `fs` plugin scope.
 */

import { invoke } from "@tauri-apps/api/core";
import { readDir, readFile, readTextFile, stat, writeTextFile } from "@tauri-apps/plugin-fs";
import { isTauri } from "../is-tauri";
import { joinLocalPath } from "./paths";

/** One entry of a local directory listing (from {@link listDirectory}). */
export interface LocalDirectoryEntry {
  name: string;
  /** Absolute path of the entry. */
  path: string;
  isDirectory: boolean;
}

/**
 * List a local directory's immediate entries via the `fs` plugin's `readDir`
 * (desktop only; resolves to `[]` off-desktop). This works only within the fs
 * scope the OS folder dialog grants for a picked directory (and its subtree),
 * so the Browser panel only lists folders the user added via the picker — no
 * new unbounded filesystem-read primitive. `readDir` returns names + type flags
 * only, so the absolute path of each entry is joined here. Filtering to loadable
 * file types is the caller's job.
 *
 * @param path - Absolute directory path to list (a picker-granted folder or a
 *   descendant of one).
 * @returns The directory's entries (folders and files).
 */
export async function listDirectory(path: string): Promise<LocalDirectoryEntry[]> {
  if (!isTauri()) return [];
  const entries = await readDir(path);
  // readDir returns names only, so join with the parent's own separator style
  // (see joinLocalPath: `\\` is a separator only on Windows-style paths).
  return entries.map((entry) => ({
    name: entry.name,
    path: joinLocalPath(path, entry.name),
    isDirectory: entry.isDirectory,
  }));
}

/**
 * Read a local file's bytes, falling back to the `read_local_file` Tauri command
 * when the JS `fs` plugin denies the path.
 *
 * When a project is reopened, its file-referenced layer paths come from the
 * saved `.geolibre.json` rather than from a picker or drag-drop, so they sit
 * outside the `fs` plugin's runtime scope and `readFile` rejects them. The
 * command reads the file directly, so a referenced layer reloads after a fresh
 * launch instead of failing with a misleading "Could not convert this vector
 * file with DuckDB-WASM" error.
 *
 * The fall-through is deliberately broad: it covers every `readFile` rejection,
 * not just scope denials. The fs plugin does not expose a stable discriminant
 * for an out-of-scope path (only a message we would have to substring-match, and
 * a wrong guess would silently re-break the reload this fixes), so narrowing is
 * not worth the fragility. The cost is one extra IPC round-trip on a genuine
 * read failure (e.g. a moved file), where `read_local_file` fails too and its
 * error surfaces instead of the plugin's. The command validates the path on the
 * Rust side, so routing the read through it cannot widen what is readable.
 *
 * @param path - Absolute local path to read.
 * @returns The file's raw bytes.
 */
export async function readLocalFileBytes(path: string): Promise<Uint8Array<ArrayBuffer>> {
  try {
    return await readFile(path);
  } catch (error) {
    if (!isTauri()) throw error;
    // Log the original fs-plugin error before retrying so a genuine read
    // failure (a moved/deleted file, not a scope denial) is still diagnosable
    // even though the command's "Could not read local file" error is what
    // ultimately surfaces.
    console.debug(`[GeoLibre] fs read of "${path}" failed; retrying via read_local_file.`, error);
    const buffer = await invoke<ArrayBuffer>("read_local_file", { path });
    return new Uint8Array(buffer);
  }
}

/**
 * Text counterpart to {@link readLocalFileBytes}: read a local file as UTF-8,
 * falling back to the `read_local_file` Tauri command when the `fs` plugin
 * denies the path (e.g. a project-referenced layer after a fresh launch). See
 * {@link readLocalFileBytes} for why the fall-through catches every rejection.
 *
 * @param path - Absolute local path to read.
 * @returns The file's decoded UTF-8 text.
 */
export async function readLocalFileText(path: string): Promise<string> {
  try {
    return await readTextFile(path);
  } catch (error) {
    if (!isTauri()) throw error;
    console.debug(`[GeoLibre] fs read of "${path}" failed; retrying via read_local_file.`, error);
    const buffer = await invoke<ArrayBuffer>("read_local_file", { path });
    // `fatal: true` matches `readTextFile`, which rejects on malformed UTF-8
    // rather than silently substituting U+FFFD: a corrupt KML/GPX/GeoJSON
    // should surface a clear read error, not parse as garbled-but-valid text.
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  }
}

/**
 * A local file's size in bytes, read from filesystem metadata so the size is
 * known *before* the file is read into memory. Returns undefined outside Tauri
 * (the browser has no path-based `stat`; those callers use `File.size`) or when
 * the `stat` fails — an unreadable path surfaces its own error at read time, so
 * a metadata failure must not block the load.
 */
export async function localFileSizeBytes(path: string): Promise<number | undefined> {
  if (!isTauri()) return undefined;
  try {
    return (await stat(path)).size;
  } catch (error) {
    console.debug(`[GeoLibre] Could not stat "${path}" for the large-file guard.`, error);
    return undefined;
  }
}

/**
 * Write text directly to a known local path without prompting. Desktop-only —
 * the browser has no writable filesystem path — so callers must gate on
 * {@link isTauri} and a real (non-URL) path; the Python Editor's in-place Save
 * uses this and falls back to a save dialog otherwise.
 */
export async function writeTextFileToPath(path: string, content: string): Promise<void> {
  await writeTextFile(path, content);
}
