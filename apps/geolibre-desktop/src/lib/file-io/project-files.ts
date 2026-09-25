/**
 * Open, save and reopen GeoLibre projects (plus the QGIS / ArcGIS Pro project
 * pickers), including the Android startup-project snapshot.
 */

import { parseProject, type GeoLibreProject } from "@geolibre/core";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { BaseDirectory, mkdir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import type { StartupSettings } from "../../hooks/useDesktopSettings";
import { isAndroidContentUri, writeInPlaceWithAndroidFallback } from "../android-content-uri";
import { isTauri } from "../is-tauri";
import { startupProjectPath } from "../startup-project";
import {
  readStartupSnapshot,
  STARTUP_SNAPSHOT_DIR,
  writeStartupSnapshot,
  type StartupSnapshotIo,
  type StartupSnapshotSlot,
} from "../startup-project-snapshot";
import {
  openLocalDataFileWithFallback,
  type BrowserFilePickerType,
  type BrowserFilePickerWindow,
} from "./file-dialogs";
import { browserSafeFileName, isHttpUrl } from "./paths";
import { isAbortError } from "./shared";

const GEOLIBRE_PROJECT_FILE_TYPES: BrowserFilePickerType[] = [
  {
    description: "GeoLibre Project",
    accept: {
      "application/json": [".geolibre", ".json"],
    },
  },
];

async function openProjectFileBrowser(): Promise<{
  project: GeoLibreProject;
  path: string;
  text: string;
} | null> {
  const pickerWindow = window as BrowserFilePickerWindow;
  if (pickerWindow.showOpenFilePicker) {
    try {
      const [handle] = await pickerWindow.showOpenFilePicker({
        multiple: false,
        types: GEOLIBRE_PROJECT_FILE_TYPES,
        excludeAcceptAllOption: false,
      });
      if (!handle) return null;
      const file = await handle.getFile();
      const text = await file.text();
      return {
        project: parseProject(text),
        path: handle.name || file.name,
        text,
      };
    } catch (error) {
      if (isAbortError(error)) return null;
      console.warn("Browser project file picker failed", error);
    }
  }

  const result = await openLocalDataFileWithFallback({
    filters: [{ name: "GeoLibre Project", extensions: ["geolibre", "json"] }],
    accept: ".geolibre,.json,.geolibre.json",
    readText: true,
  });
  if (!result?.text) return null;
  return {
    project: parseProject(result.text),
    path: result.path,
    text: result.text,
  };
}

async function saveProjectFileBrowser(
  content: string,
  defaultName?: string,
): Promise<string | null> {
  const fileName = browserSafeFileName(defaultName ?? "project.geolibre");
  const pickerWindow = window as BrowserFilePickerWindow;

  if (pickerWindow.showSaveFilePicker) {
    try {
      const handle = await pickerWindow.showSaveFilePicker({
        suggestedName: fileName,
        types: GEOLIBRE_PROJECT_FILE_TYPES,
        excludeAcceptAllOption: false,
      });
      const writable = await handle.createWritable();
      await writable.write(content);
      await writable.close();
      return handle.name || fileName;
    } catch (error) {
      if (isAbortError(error)) return null;
      console.warn("Browser project save picker failed", error);
    }
  }

  const blob = new Blob([content], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  return fileName;
}

/**
 * Pick a GeoLibre project and parse it.
 *
 * @returns The parsed project, the path it came from, and the raw text — which
 *   {@link saveStartupProjectSnapshot} copies verbatim rather than re-serializing
 *   the parsed form. Null if the picker was cancelled.
 */
export async function openProjectFile(): Promise<{
  project: GeoLibreProject;
  path: string;
  text: string;
} | null> {
  if (!isTauri()) {
    return openProjectFileBrowser();
  }

  const selected = await open({
    multiple: false,
    filters: [{ name: "GeoLibre Project", extensions: ["geolibre", "json"] }],
  });
  if (!selected || typeof selected !== "string") return null;
  const text = await readTextFile(selected);
  const project = parseProject(text);
  return { project, path: selected, text };
}

/** Pick a QGIS project and return its raw bytes for the import converter. */
export async function openQgisProjectFile(): Promise<{
  data: ArrayBuffer;
  path: string;
} | null> {
  const result = await openLocalDataFileWithFallback({
    filters: [{ name: "QGIS Project", extensions: ["qgz", "qgs"] }],
    accept: ".qgz,.qgs",
    readBinary: true,
  });
  if (!result?.data) return null;
  return { data: result.data, path: result.path };
}

/** Pick an ArcGIS Pro project/map and return its raw bytes for the CIM converter. */
export async function openArcgisProjectFile(): Promise<{
  data: ArrayBuffer;
  path: string;
} | null> {
  const result = await openLocalDataFileWithFallback({
    filters: [{ name: "ArcGIS Pro Project", extensions: ["aprx", "mapx"] }],
    accept: ".aprx,.mapx",
    readBinary: true,
  });
  if (!result?.data) return null;
  return { data: result.data, path: result.path };
}

/**
 * Thrown when a recent project is permanently gone (HTTP 404/410 or a local
 * file that no longer exists), signalling the caller that the entry can be
 * safely forgotten. Transient failures throw a plain `Error` instead so the
 * entry is preserved for a retry.
 */
export class RecentProjectGoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecentProjectGoneError";
  }
}

/**
 * Snapshot files live in the app's private data directory, the one place the
 * `fs` plugin's default scope allows without a dialog having handed us the path
 * — and on Android the one place still readable after the process restart that
 * kills a `content://` grant.
 */
const startupSnapshotIo: StartupSnapshotIo = {
  write: async (file, content) => {
    await mkdir(STARTUP_SNAPSHOT_DIR, {
      baseDir: BaseDirectory.AppLocalData,
      recursive: true,
    });
    await writeTextFile(`${STARTUP_SNAPSHOT_DIR}/${file}`, content, {
      baseDir: BaseDirectory.AppLocalData,
    });
  },
  read: (file) =>
    readTextFile(`${STARTUP_SNAPSHOT_DIR}/${file}`, {
      baseDir: BaseDirectory.AppLocalData,
    }),
};

/**
 * Keep a restorable copy of a project the startup preference will reopen
 * (GeoLibre#1948). A no-op unless the path is an Android `content://` URI, whose
 * read grant does not survive the process — every other path can simply be
 * re-read.
 *
 * @param path - The path or content URI the project was opened from or saved to.
 * @param text - The serialized project.
 * @param settings - The committed startup preference.
 * @returns The slot written, or null when nothing was.
 */
export async function saveStartupProjectSnapshot(
  path: string,
  text: string,
  settings: StartupSettings,
): Promise<StartupSnapshotSlot | null> {
  if (!isTauri()) return null;
  return writeStartupSnapshot(path, text, settings, startupSnapshotIo);
}

/**
 * Make sure the project a *newly saved* startup preference points at has a
 * restorable copy, reading it now rather than waiting for the next open or save.
 *
 * This is the moment the user's own steps land on: open a project from device
 * storage, then go to Settings and ask for it back on the next launch. Nothing
 * re-reads the project in between, so without this the preference would be
 * saved with no copy behind it and the next launch would still come up empty.
 * Reading works here and only here, because the picker's `content://` grant is
 * alive until this process ends -- which is exactly what the copy outlives.
 *
 * @param settings - The startup preference being committed.
 * @param recentProjects - Recent projects, to resolve "reopen the last project".
 * @returns The slot written, or null when there was nothing to copy.
 */
export async function ensureStartupProjectSnapshot(
  settings: StartupSettings,
  recentProjects: readonly { path: string }[],
): Promise<StartupSnapshotSlot | null> {
  if (!isTauri()) return null;
  const path = startupProjectPath(settings, recentProjects);
  // Only a content URI needs a copy; every other path can be re-read on its own.
  if (!path || !isAndroidContentUri(path)) return null;
  let text: string;
  try {
    text = await readTextFile(path);
  } catch (error) {
    // The grant is already gone -- the project was opened in an earlier session
    // and only reopened from the recent list, say. Nothing to copy, so the next
    // launch reports the unavailable-project banner and the copy is made the
    // next time the project is actually opened or saved.
    console.warn("Could not read the startup project to keep a restorable copy.", error);
    return null;
  }
  return writeStartupSnapshot(path, text, settings, startupSnapshotIo);
}

// Refuse to buffer absurdly large responses into memory (25 MB).
const MAX_PROJECT_URL_BYTES = 25 * 1024 * 1024;

function isFileMissingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  // Match filesystem "missing file" signals only. Avoid broad substrings like
  // "not found" / "cannot find" that also appear in transient IPC errors
  // (e.g. "Command not found", Windows os error 3 for a disconnected drive).
  return /no such file|os error 2|\benoent\b|cannot find the file|file not found|does not exist/i.test(
    message,
  );
}

/**
 * Reopen a project from a remembered path, URL, or Android content URI.
 *
 * @param path - The remembered location.
 * @param signal - Abort signal for the URL branch's fetch.
 * @returns The parsed project, the path it came from, and the raw text -- which
 *   callers hand to {@link saveStartupProjectSnapshot} so reopening from Open
 *   Recent keeps the restorable copy pointing at the project that is now the
 *   most recent one.
 */
export async function openRecentProjectFile(
  path: string,
  signal?: AbortSignal,
): Promise<{
  project: GeoLibreProject;
  path: string;
  text: string;
}> {
  if (isHttpUrl(path)) {
    const response = await fetch(path, {
      headers: { Accept: "application/json, text/plain;q=0.9, */*;q=0.8" },
      signal,
    });
    if (!response.ok) {
      const message = `Could not load project URL: HTTP ${response.status} ${response.statusText}`;
      if (response.status === 404 || response.status === 410) {
        throw new RecentProjectGoneError(message);
      }
      throw new Error(message);
    }

    // Only a present Content-Length lets us guard up front. `Number(null)` is
    // 0, which would silently pass for chunked/CDN responses that omit it.
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null && Number(contentLength) > MAX_PROJECT_URL_BYTES) {
      throw new Error("Project file is too large to load (over 25 MB).");
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (/\bhtml\b/i.test(contentType)) {
      throw new Error(
        `Unexpected content type "${contentType}" - the URL does not appear to be a project file.`,
      );
    }

    const body = await response.text();
    return { project: parseProject(body), path, text: body };
  }

  if (!isTauri()) {
    throw new Error("Recent local projects can only be reopened in GeoLibre Desktop.");
  }

  let text: string;
  try {
    // A content URI is not a filesystem path, so `read_project_file` refuses it
    // outright; the `fs` plugin resolves it through Android's ContentResolver
    // instead. That succeeds while the picker's read grant is still alive —
    // reopening from Open Recent in the same session — and fails once the
    // process has restarted, which the stored copy below covers.
    text = isAndroidContentUri(path)
      ? await readTextFile(path)
      : await invoke<string>("read_project_file", { path });
  } catch (error) {
    // Fall back to the copy kept for exactly this project, if there is one
    // (GeoLibre#1948). Only Android content URIs ever have one, and the source
    // path has to match, so this can never substitute a different project.
    //
    // Deliberately ahead of the missing-file check. On a real filesystem "no
    // such file" means the project is gone and the entry can be dropped; on a
    // dead SAF grant it means nothing reliable, because content providers differ
    // in how they report one -- the emulator's ExternalStorageProvider raises a
    // SecurityException, but Drive, Downloads and some OEM file managers are
    // known to report a revoked URI as a FileNotFoundException. Treating that as
    // "gone" would make `useStartupProject` forget the recent entry and reset a
    // "specific" preference to the default, silently wiping the user's chosen
    // startup project on exactly the failure this copy exists to survive.
    const snapshot = await readStartupSnapshot(path, startupSnapshotIo);
    if (snapshot !== null) {
      console.warn(
        `Reopening the stored copy of "${path}"; the original could not be read.`,
        error,
      );
      return { project: parseProject(snapshot), path, text: snapshot };
    }
    if (isFileMissingError(error)) {
      throw new RecentProjectGoneError(`Project file no longer exists: ${path}`);
    }
    throw error;
  }

  return { project: parseProject(text), path, text };
}

export async function saveProjectFile(
  content: string,
  defaultName?: string,
): Promise<string | null> {
  if (!isTauri()) {
    return saveProjectFileBrowser(content, defaultName);
  }

  const path = await save({
    filters: [{ name: "GeoLibre Project", extensions: ["geolibre", "json"] }],
    defaultPath: defaultName ?? "project.geolibre",
  });
  if (!path) return null;
  await writeTextFile(path, content);
  return path;
}

/**
 * Save a project directly to an already-known local path without prompting.
 * Falls back to the save dialog when not running in Tauri (the browser never
 * has a writable filesystem path) or when the path is an HTTP(S) URL.
 *
 * @param content - The serialized project to write.
 * @param path - The path the project was opened from or last saved to.
 * @param fallbackName - File name for the save dialog when an attempted
 *   in-place write is refused, and only when the path carries no usable name of
 *   its own. The two branches below never attempt one, so they pass the path
 *   itself as the dialog's name and ignore this.
 * @returns The path actually written, or null if a fallback dialog was
 *   cancelled.
 */
export async function saveProjectFileToPath(
  content: string,
  path: string,
  fallbackName?: string,
): Promise<string | null> {
  if (!isTauri() || isHttpUrl(path)) {
    return saveProjectFile(content, path);
  }
  // On Android a project opened through the document picker carries a read-only
  // `content://` grant, so writing back to it is refused and Save fails outright
  // (GeoLibre#1833). The save dialog asks Android to *create* the document,
  // which does grant write, so the fallback below recovers; see
  // `writeInPlaceWithAndroidFallback` for why it cannot lose data.
  return writeInPlaceWithAndroidFallback(content, path, fallbackName, {
    write: writeTextFile,
    saveAs: saveProjectFile,
  });
}
