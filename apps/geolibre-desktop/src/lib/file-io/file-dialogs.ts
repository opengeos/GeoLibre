/**
 * Open and save pickers that use the native Tauri dialog on desktop and fall
 * back to the File System Access API, an `<input type="file">` or an anchor
 * download in the browser.
 */

import { open, save } from "@tauri-apps/plugin-dialog";
import { readFile, readTextFile, writeFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { nativeFileDialogFilters, type FileDialogFilter } from "../file-dialog-filters";
import { isTauri } from "../is-tauri";
import { browserSafeFileName } from "./paths";
import { isAbortError, toArrayBuffer } from "./shared";

interface PickLocalPathOptions {
  accept?: string;
  directory?: boolean;
  filters?: FileDialogFilter[];
}

interface PickSavePathOptions {
  browserTypes?: BrowserFilePickerType[];
  defaultName: string;
  filters?: FileDialogFilter[];
}

interface LocalDataFileOptions {
  filters: FileDialogFilter[];
  androidFilters?: FileDialogFilter[];
  accept: string;
  /** Extensions that should be read as bytes instead of text when readText is set. */
  binaryExtensions?: string[];
  readBinary?: boolean;
  readText?: boolean;
}

export interface BrowserFilePickerType {
  description: string;
  accept: Record<string, string[]>;
}

interface BrowserOpenFileHandle {
  name: string;
  getFile: () => Promise<File>;
}

interface BrowserWritableFileStream {
  write: (data: string | Blob) => Promise<void>;
  close: () => Promise<void>;
}

interface BrowserSaveFileHandle {
  name: string;
  createWritable: () => Promise<BrowserWritableFileStream>;
}

export interface BrowserFilePickerWindow extends Window {
  showOpenFilePicker?: (options: {
    multiple?: boolean;
    types?: BrowserFilePickerType[];
    excludeAcceptAllOption?: boolean;
  }) => Promise<BrowserOpenFileHandle[]>;
  showSaveFilePicker?: (options: {
    suggestedName?: string;
    types?: BrowserFilePickerType[];
    excludeAcceptAllOption?: boolean;
  }) => Promise<BrowserSaveFileHandle>;
}

interface SaveTextFileOptions {
  defaultName: string;
  filters: FileDialogFilter[];
  browserTypes: BrowserFilePickerType[];
  mimeType: string;
}

interface SaveBinaryFileOptions extends SaveTextFileOptions {}

/**
 * Whether saving a project in the current environment would silently fall back
 * to an anchor download under a fixed name — i.e. a browser (not Tauri) that
 * lacks the File System Access save picker (`window.showSaveFilePicker`).
 * Chromium browsers expose the picker and let the user name the file; Firefox
 * and Safari do not, so callers prompt for a file name themselves before saving.
 *
 * @returns True only in a browser without the save picker; false under Tauri
 *   (which uses the native save dialog) or when the picker is available.
 */
export function browserSaveFallsBackToDownload(): boolean {
  if (isTauri()) return false;
  if (typeof window === "undefined") return false;
  return typeof (window as BrowserFilePickerWindow).showSaveFilePicker !== "function";
}

async function saveTextFileBrowser(
  content: string,
  options: SaveTextFileOptions,
): Promise<string | null> {
  const fileName = browserSafeFileName(options.defaultName);
  const pickerWindow = window as BrowserFilePickerWindow;

  if (pickerWindow.showSaveFilePicker) {
    try {
      const handle = await pickerWindow.showSaveFilePicker({
        suggestedName: fileName,
        types: options.browserTypes,
        excludeAcceptAllOption: false,
      });
      const writable = await handle.createWritable();
      await writable.write(content);
      await writable.close();
      return handle.name || fileName;
    } catch (error) {
      if (isAbortError(error)) return null;
      console.warn("Browser file save picker failed", error);
    }
  }

  const blob = new Blob([content], { type: options.mimeType });
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

async function saveBinaryFileBrowser(
  content: Uint8Array | Blob,
  options: SaveBinaryFileOptions,
): Promise<string | null> {
  const fileName = browserSafeFileName(options.defaultName);
  const pickerWindow = window as BrowserFilePickerWindow;
  // A Blob (e.g. a recorded video) is written straight through; only raw bytes
  // need wrapping, so large callers can avoid an extra full-size copy.
  // Note: a Blob's own .type is used as-is; options.mimeType applies only when
  // wrapping a Uint8Array, so pass a Blob that already carries the right type.
  const blob =
    content instanceof Blob
      ? content
      : new Blob([toArrayBuffer(content)], { type: options.mimeType });

  if (pickerWindow.showSaveFilePicker) {
    try {
      const handle = await pickerWindow.showSaveFilePicker({
        suggestedName: fileName,
        types: options.browserTypes,
        excludeAcceptAllOption: false,
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return handle.name || fileName;
    } catch (error) {
      if (isAbortError(error)) return null;
      console.warn("Browser binary file save picker failed", error);
    }
  }

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

export async function openLocalDataFileWithFallback(options: LocalDataFileOptions): Promise<{
  data?: ArrayBuffer;
  path: string;
  text?: string;
} | null> {
  const shouldReadBinaryByExtension = (path: string) => {
    const extension = path.split(".").pop()?.toLowerCase();
    return Boolean(
      extension && options.binaryExtensions?.some((item) => item.toLowerCase() === extension),
    );
  };

  if (isTauri()) {
    const selected = await open({
      multiple: false,
      filters: nativeFileDialogFilters(options.filters, options.androidFilters),
    });
    if (!selected || typeof selected !== "string") return null;
    const binaryByExtension = shouldReadBinaryByExtension(selected);
    const data =
      options.readBinary || binaryByExtension ? toArrayBuffer(await readFile(selected)) : undefined;
    const text = options.readText && !binaryByExtension ? await readTextFile(selected) : undefined;
    return { data, path: selected, text };
  }

  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = options.accept;
    input.onchange = async () => {
      try {
        const file = input.files?.[0];
        if (!file) {
          resolve(null);
          return;
        }
        const binaryByExtension = shouldReadBinaryByExtension(file.name);
        const data = options.readBinary || binaryByExtension ? await file.arrayBuffer() : undefined;
        const text = options.readText && !binaryByExtension ? await file.text() : undefined;
        resolve({ data, path: file.name, text });
      } catch (error) {
        reject(error);
      }
    };
    // Resolve (rather than hang) when the dialog is dismissed without a pick;
    // `change` never fires on cancel, so without this the Promise never settles.
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}

/** Open a multi-file picker and read every selected file as bytes. */
export async function openLocalDataFilesWithFallback(
  options: LocalDataFileOptions,
): Promise<Array<{ data: ArrayBuffer; path: string }>> {
  if (isTauri()) {
    const selected = await open({
      multiple: true,
      filters: nativeFileDialogFilters(options.filters, options.androidFilters),
    });
    const paths = Array.isArray(selected) ? selected : selected ? [selected] : [];
    return Promise.all(
      paths.map(async (path) => ({
        data: toArrayBuffer(await readFile(path)),
        path,
      })),
    );
  }

  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = options.accept;
    input.onchange = async () => {
      try {
        const files = Array.from(input.files ?? []);
        resolve(
          await Promise.all(
            files.map(async (file) => ({
              data: await file.arrayBuffer(),
              path: file.name,
            })),
          ),
        );
      } catch (error) {
        reject(error);
      }
    };
    input.addEventListener("cancel", () => resolve([]));
    input.click();
  });
}

export async function pickLocalPathWithFallback(
  options: PickLocalPathOptions = {},
): Promise<string | null> {
  if (isTauri()) {
    const selected = await open({
      directory: options.directory ?? false,
      filters: options.filters,
      multiple: false,
    });
    return typeof selected === "string" ? selected : null;
  }

  // Browsers cannot expose absolute filesystem paths, and Whitebox parameters
  // require a real path. Return null so callers surface the desktop-only
  // message rather than passing a non-resolvable bare file name.
  return null;
}

/** Pick several native filesystem paths (desktop only). */
export async function pickLocalPathsWithFallback(
  options: PickLocalPathOptions = {},
): Promise<string[]> {
  if (!isTauri()) return [];
  const selected = await open({
    directory: options.directory ?? false,
    filters: options.filters,
    multiple: true,
  });
  return Array.isArray(selected) ? selected : selected ? [selected] : [];
}

/**
 * Open the native folder picker and return the chosen directory (desktop only;
 * null off-desktop or on cancel). `recursive: true` extends the granted fs scope
 * to the picked directory's subtree, so the Browser panel can lazily {@link
 * listDirectory} subfolders within it — not just its top level.
 *
 * @returns The picked absolute directory path, or null.
 */
export async function pickLocalDirectory(): Promise<string | null> {
  if (!isTauri()) return null;
  const selected = await open({
    directory: true,
    multiple: false,
    recursive: true,
  });
  return typeof selected === "string" ? selected : null;
}

export async function pickSavePathWithFallback(
  options: PickSavePathOptions,
): Promise<string | null> {
  if (isTauri()) {
    return save({
      defaultPath: options.defaultName,
      filters: options.filters,
    });
  }

  const pickerWindow = window as BrowserFilePickerWindow;
  if (pickerWindow.showSaveFilePicker) {
    try {
      await pickerWindow.showSaveFilePicker({
        suggestedName: options.defaultName,
        types: options.browserTypes,
        excludeAcceptAllOption: false,
      });
    } catch (error) {
      if (isAbortError(error)) return null;
      console.warn("Browser save path picker failed", error);
    }
  }

  // The browser only exposes a leaf file name, never a real filesystem path,
  // so return null (matching pickLocalPathWithFallback) rather than handing a
  // non-resolvable name to a Whitebox path parameter.
  return null;
}

export async function saveTextFileWithFallback(
  content: string,
  options: SaveTextFileOptions,
): Promise<string | null> {
  if (!isTauri()) {
    return saveTextFileBrowser(content, options);
  }

  const path = await save({
    filters: options.filters,
    defaultPath: options.defaultName,
  });
  if (!path) return null;
  await writeTextFile(path, content);
  return path;
}

export async function saveBinaryFileWithFallback(
  content: Uint8Array | Blob,
  options: SaveBinaryFileOptions,
): Promise<string | null> {
  if (!isTauri()) {
    return saveBinaryFileBrowser(content, options);
  }

  const path = await save({
    filters: options.filters,
    defaultPath: options.defaultName,
  });
  if (!path) return null;
  // The Tauri write needs raw bytes, so convert a Blob only here (after the
  // dialog is confirmed), not on every cancelled attempt. arrayBuffer() can
  // reject (e.g. OOM, or an unavailable backing store); that propagates to the
  // caller's catch.
  const bytes = content instanceof Blob ? new Uint8Array(await content.arrayBuffer()) : content;
  await writeFile(path, bytes);
  return path;
}
