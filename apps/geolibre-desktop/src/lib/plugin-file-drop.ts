/**
 * Offers a file drop to plugin file handlers before the built-in groups see it
 * (GeoLibre#3283). The shell has two drop paths, browser `File`s and Tauri
 * paths; each is adapted here to one {@link GeoLibreDroppedFile} shape, so a
 * handler works the same on web and desktop.
 */

import type { TFunction } from "i18next";
import { open as openLocalFile, SeekMode, stat } from "@tauri-apps/plugin-fs";
import type {
  GeoLibreDroppedFile,
  GeoLibreDroppedFileInfo,
  GeoLibreFileHandler,
} from "@geolibre/plugins";
import { listDirectory, readLocalFileBytes } from "./file-io/local-fs";
import { browserSafeFileName } from "./file-io/paths";
import { toArrayBuffer } from "./file-io/shared";

/** Reads `length` bytes of a file from `offset`. */
type ReadRange = (offset: number, length: number) => Promise<Uint8Array>;

const EOCD_SIGNATURE = 0x06054b50;
const EOCD_SIZE = 22;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_LOCATOR_SIZE = 20;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_EOCD_SIZE = 56;
const CENTRAL_ENTRY_SIGNATURE = 0x02014b50;
const CENTRAL_ENTRY_SIZE = 46;
/** Longest possible zip comment plus the record that precedes it. */
const MAX_EOCD_SEARCH = 0xffff + EOCD_SIZE;
/** A central directory beyond this is not a file a handler should inspect. */
const MAX_CENTRAL_DIRECTORY_BYTES = 16 * 1024 * 1024;

/** Walk limits for a dropped folder, so dropping a home directory cannot hang the app. */
const MAX_FOLDER_DEPTH = 16;
const MAX_FOLDER_ENTRIES = 20_000;

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * List the paths inside a zip from its central directory, reading only the tail
 * of the archive rather than the whole file.
 *
 * @param size - The archive's size in bytes.
 * @param readRange - Reads a byte range of the archive.
 * @returns The entry paths in archive order, or undefined when the file has no
 *   readable central directory (not a zip, or truncated).
 */
export async function listZipEntryPaths(
  size: number,
  readRange: ReadRange,
): Promise<string[] | undefined> {
  if (size < EOCD_SIZE) return undefined;
  const tailLength = Math.min(size, MAX_EOCD_SEARCH);
  const tailOffset = size - tailLength;
  const tail = await readRange(tailOffset, tailLength);
  const tailView = viewOf(tail);
  let eocd = -1;
  for (let i = tail.byteLength - EOCD_SIZE; i >= 0; i -= 1) {
    if (tailView.getUint32(i, true) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return undefined;

  let directorySize = tailView.getUint32(eocd + 12, true);
  let directoryOffset = tailView.getUint32(eocd + 16, true);
  if (directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    const locator = eocd - ZIP64_LOCATOR_SIZE;
    if (locator < 0 || tailView.getUint32(locator, true) !== ZIP64_LOCATOR_SIGNATURE) {
      return undefined;
    }
    const zip64Offset = Number(tailView.getBigUint64(locator + 8, true));
    if (zip64Offset + ZIP64_EOCD_SIZE > size) return undefined;
    const zip64 = viewOf(await readRange(zip64Offset, ZIP64_EOCD_SIZE));
    if (zip64.getUint32(0, true) !== ZIP64_EOCD_SIGNATURE) return undefined;
    directorySize = Number(zip64.getBigUint64(40, true));
    directoryOffset = Number(zip64.getBigUint64(48, true));
  }
  if (directorySize > MAX_CENTRAL_DIRECTORY_BYTES || directoryOffset + directorySize > size) {
    return undefined;
  }

  const directory = await readRange(directoryOffset, directorySize);
  const view = viewOf(directory);
  const decoder = new TextDecoder();
  const paths: string[] = [];
  let cursor = 0;
  while (cursor + CENTRAL_ENTRY_SIZE <= directory.byteLength) {
    if (view.getUint32(cursor, true) !== CENTRAL_ENTRY_SIGNATURE) return undefined;
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const nameStart = cursor + CENTRAL_ENTRY_SIZE;
    if (nameStart + nameLength > directory.byteLength) return undefined;
    paths.push(decoder.decode(directory.subarray(nameStart, nameStart + nameLength)));
    cursor = nameStart + nameLength + extraLength + commentLength;
  }
  return paths;
}

/** Whether `name` ends in one of `extensions`, ignoring case and a missing dot. */
export function matchesFileHandlerExtensions(name: string, extensions: string[]): boolean {
  const lower = name.toLowerCase();
  return extensions.some((extension) => {
    const wanted = extension.toLowerCase();
    return lower.endsWith(wanted.startsWith(".") ? wanted : `.${wanted}`);
  });
}

/** Dot-entries and macOS archive metadata never hold a file a handler wants. */
function isSkippedFolderEntry(name: string): boolean {
  return name.startsWith(".") || name === "__MACOSX";
}

/** One file of a drop, plus the top-level item (file or folder) it came from. */
export interface DropLeaf<T> {
  origin: T;
  name: string;
  path?: string;
  size: number;
  read: () => Promise<ArrayBuffer>;
  readRange: ReadRange;
}

/** What is left of the drop, and how the handlers fared. */
export interface FileHandlerDropResult<T> {
  /** Top-level items no handler took anything from, for the built-in groups. */
  unclaimed: T[];
  /** Handlers that opened files, in the order they ran. */
  opened: GeoLibreFileHandler[];
  /** Handlers whose `open` rejected. Their files stay claimed. */
  failed: { handler: GeoLibreFileHandler; error: unknown }[];
}

function toDroppedFile<T>(leaf: DropLeaf<T>): GeoLibreDroppedFile {
  const file: GeoLibreDroppedFile = {
    name: leaf.name,
    size: leaf.size,
    arrayBuffer: leaf.read,
    text: async () => new TextDecoder().decode(await leaf.read()),
  };
  if (leaf.path !== undefined) file.path = leaf.path;
  return file;
}

/** The identity a claimed file is matched by, so a handler may return copies. */
function fileKey(file: GeoLibreDroppedFileInfo): string {
  return file.path ?? file.name;
}

/**
 * The offered files a `claim` result names. The objects `claim` was given match
 * exactly. A copy matches by key, one file per copy, since two dropped files can
 * share a key and returning one of them must not claim the other.
 */
function takenLeaves<T>(
  offered: DropLeaf<T>[],
  files: Map<DropLeaf<T>, GeoLibreDroppedFile>,
  claimed: GeoLibreDroppedFileInfo[],
): DropLeaf<T>[] {
  const returned = new Set(claimed);
  const taken = new Set(offered.filter((leaf) => returned.has(files.get(leaf)!)));
  const given = new Set<GeoLibreDroppedFileInfo>(offered.map((leaf) => files.get(leaf)!));
  for (const copy of claimed) {
    if (given.has(copy)) continue;
    const match = offered.find(
      (leaf) => !taken.has(leaf) && fileKey(files.get(leaf)!) === fileKey(copy),
    );
    if (match) taken.add(match);
  }
  return offered.filter((leaf) => taken.has(leaf));
}

/**
 * Run a drop past the handlers. Each handler, in registration order, gets the
 * still-unclaimed files matching its extensions and claims what it recognizes.
 *
 * A throwing `claim` counts as "not mine", so a broken plugin cannot break a
 * drop the core could load. A throwing `open` keeps its files claimed and is
 * reported: the handler said the file is its own, so loading it as a shapefile
 * would only add a misleading second error. A folder a handler took part of is
 * consumed whole, since a folder's other files were never drop items to load.
 *
 * @param items - Every dropped file, already expanded out of its folders.
 * @param origins - The top-level dropped items, in drop order.
 * @param handlers - The handlers to consult.
 * @returns The items left for the built-in groups, and the handler outcomes.
 */
export async function offerDropToFileHandlers<T>(
  items: DropLeaf<T>[],
  origins: T[],
  handlers: GeoLibreFileHandler[],
): Promise<FileHandlerDropResult<T>> {
  const files = new Map<DropLeaf<T>, GeoLibreDroppedFile>();
  const claimedOrigins = new Set<T>();
  const remaining = new Set(items);
  const opened: GeoLibreFileHandler[] = [];
  const failed: FileHandlerDropResult<T>["failed"] = [];

  for (const handler of handlers) {
    const offered = [...remaining].filter((leaf) =>
      matchesFileHandlerExtensions(leaf.name, handler.extensions),
    );
    if (offered.length === 0) continue;

    for (const leaf of offered) {
      if (files.has(leaf)) continue;
      const file = toDroppedFile(leaf);
      if (leaf.name.toLowerCase().endsWith(".zip")) {
        const entries = await listZipEntryPaths(leaf.size, leaf.readRange).catch((error) => {
          console.debug(`[GeoLibre] Could not list the entries of "${leaf.name}".`, error);
          return undefined;
        });
        if (entries) file.entries = entries;
      }
      files.set(leaf, file);
    }

    let claimed: GeoLibreDroppedFileInfo[];
    try {
      const result = await handler.claim(offered.map((leaf) => files.get(leaf)!));
      claimed = Array.isArray(result) ? result : [];
    } catch (error) {
      console.warn(`[GeoLibre] File handler "${handler.id}" failed to claim a drop.`, error);
      continue;
    }
    const taken = takenLeaves(offered, files, claimed);
    if (taken.length === 0) continue;

    for (const leaf of taken) {
      remaining.delete(leaf);
      claimedOrigins.add(leaf.origin);
    }
    try {
      await handler.open(taken.map((leaf) => files.get(leaf)!));
      opened.push(handler);
    } catch (error) {
      failed.push({ handler, error });
    }
  }

  return {
    unclaimed: origins.filter((origin) => !claimedOrigins.has(origin)),
    opened,
    failed,
  };
}

/**
 * Show the outcome of {@link offerDropToFileHandlers} in the drop status. A
 * built-in group that loads the rest of the drop may replace the message.
 *
 * @param result - The handler outcomes.
 * @param setMessage - Sets the drop status message.
 * @param setError - Sets the drop error.
 * @param t - The translation function.
 * @returns Whether any handler took files, so an empty rest is not an error.
 */
export function reportFileHandlerDrop(
  { opened, failed }: FileHandlerDropResult<unknown>,
  setMessage: (message: string | null) => void,
  setError: (error: string | null) => void,
  t: TFunction,
): boolean {
  if (failed.length > 0) {
    setMessage(null);
    setError(
      failed
        .map(({ handler, error }) =>
          t("toolbar.fileDrop.handlerFailed", {
            name: handler.name,
            message: error instanceof Error ? error.message : String(error),
          }),
        )
        .join(" "),
    );
  }
  // Last, since the production error setter dismisses the current status.
  if (opened.length > 0) {
    const name = opened.map((handler) => handler.name).join(", ");
    setMessage(t("toolbar.fileDrop.openedByHandler", { name }));
  }
  return opened.length + failed.length > 0;
}

function fileLeaf(origin: File, file: File, path?: string): DropLeaf<File> {
  return {
    origin,
    name: file.name,
    path,
    size: file.size,
    read: () => file.arrayBuffer(),
    readRange: async (offset, length) =>
      new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()),
  };
}

/** Read every entry of a browser directory; one `readEntries` call returns a batch. */
async function readDirectoryEntries(
  directory: FileSystemDirectoryEntry,
): Promise<FileSystemEntry[]> {
  const reader = directory.createReader();
  const entries: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    );
    if (batch.length === 0) return entries;
    entries.push(...batch);
  }
}

/** Mutable counter shared across a walk, enforcing {@link MAX_FOLDER_ENTRIES}. */
interface WalkBudget {
  visited: number;
}

async function walkBrowserDirectory(
  origin: File,
  directory: FileSystemDirectoryEntry,
  prefix: string,
  depth: number,
  budget: WalkBudget,
  wanted: (name: string) => boolean,
  leaves: DropLeaf<File>[],
): Promise<void> {
  if (depth > MAX_FOLDER_DEPTH) return;
  for (const entry of await readDirectoryEntries(directory)) {
    if (isSkippedFolderEntry(entry.name)) continue;
    budget.visited += 1;
    if (budget.visited > MAX_FOLDER_ENTRIES) return;
    const path = `${prefix}/${entry.name}`;
    if (entry.isDirectory) {
      await walkBrowserDirectory(
        origin,
        entry as FileSystemDirectoryEntry,
        path,
        depth + 1,
        budget,
        wanted,
        leaves,
      );
    } else if (wanted(entry.name)) {
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileSystemFileEntry).file(resolve, reject),
      );
      leaves.push(fileLeaf(origin, file, path));
    }
  }
}

/** Whether any handler could want a file of this name. */
function wantedByAnyHandler(handlers: GeoLibreFileHandler[]) {
  return (name: string) =>
    handlers.some((handler) => matchesFileHandlerExtensions(name, handler.extensions));
}

/**
 * Capture the folders in a browser drop. Must run synchronously in the drop
 * event: `DataTransfer` items are emptied as soon as the handler first yields.
 *
 * @param dataTransfer - The drop event's data.
 * @returns For each entry of `dataTransfer.files`, by index, its folder entry,
 *   or null for a plain file.
 */
export function captureDroppedDirectories(
  dataTransfer: DataTransfer,
): (FileSystemDirectoryEntry | null)[] {
  return Array.from(dataTransfer.items)
    .filter((item) => item.kind === "file")
    .map((item) => {
      const entry = item.webkitGetAsEntry?.();
      return entry?.isDirectory ? (entry as FileSystemDirectoryEntry) : null;
    });
}

/**
 * Offer a browser drop to the registered file handlers.
 *
 * @param files - The dropped `File`s (a folder appears as one placeholder `File`).
 * @param directories - The folders from {@link captureDroppedDirectories}.
 * @param handlers - The registered handlers.
 * @returns The files left for the built-in groups, and the handler outcomes.
 */
export async function offerBrowserDrop(
  files: File[],
  directories: (FileSystemDirectoryEntry | null)[],
  handlers: GeoLibreFileHandler[],
): Promise<FileHandlerDropResult<File>> {
  if (handlers.length === 0) return { unclaimed: files, opened: [], failed: [] };
  const wanted = wantedByAnyHandler(handlers);
  const leaves: DropLeaf<File>[] = [];
  const budget: WalkBudget = { visited: 0 };
  for (const [index, file] of files.entries()) {
    const directory = directories[index];
    if (directory) {
      try {
        await walkBrowserDirectory(file, directory, file.name, 0, budget, wanted, leaves);
      } catch (error) {
        // The built-in groups surface their own error for an unreadable folder.
        console.debug(`[GeoLibre] Could not read dropped folder "${file.name}".`, error);
      }
    } else {
      leaves.push(fileLeaf(file, file));
    }
  }
  return offerDropToFileHandlers(leaves, files, handlers);
}

/** Range-read a local file through the `fs` plugin, without loading all of it. */
async function readLocalFileRange(
  path: string,
  offset: number,
  length: number,
): Promise<Uint8Array> {
  const handle = await openLocalFile(path, { read: true });
  try {
    await handle.seek(offset, SeekMode.Start);
    const bytes = new Uint8Array(length);
    let filled = 0;
    while (filled < length) {
      const count = await handle.read(bytes.subarray(filled));
      if (!count) break;
      filled += count;
    }
    return bytes.subarray(0, filled);
  } finally {
    await handle.close();
  }
}

function pathLeaf(origin: string, absolutePath: string, size: number, path?: string) {
  const leaf: DropLeaf<string> = {
    origin,
    name: browserSafeFileName(absolutePath),
    path,
    size,
    read: async () => toArrayBuffer(await readLocalFileBytes(absolutePath)),
    readRange: (offset, length) => readLocalFileRange(absolutePath, offset, length),
  };
  return leaf;
}

async function walkLocalDirectory(
  origin: string,
  directory: string,
  prefix: string,
  depth: number,
  budget: WalkBudget,
  wanted: (name: string) => boolean,
  leaves: DropLeaf<string>[],
): Promise<void> {
  if (depth > MAX_FOLDER_DEPTH) return;
  for (const entry of await listDirectory(directory)) {
    if (isSkippedFolderEntry(entry.name)) continue;
    budget.visited += 1;
    if (budget.visited > MAX_FOLDER_ENTRIES) return;
    const path = `${prefix}/${entry.name}`;
    if (entry.isDirectory) {
      await walkLocalDirectory(origin, entry.path, path, depth + 1, budget, wanted, leaves);
    } else if (wanted(entry.name)) {
      const { size } = await stat(entry.path);
      leaves.push(pathLeaf(origin, entry.path, size, path));
    }
  }
}

/**
 * Offer a Tauri native drop to the registered file handlers.
 *
 * @param paths - The dropped absolute paths (files or folders).
 * @param handlers - The registered handlers.
 * @returns The paths left for the built-in groups, and the handler outcomes.
 */
export async function offerDesktopDrop(
  paths: string[],
  handlers: GeoLibreFileHandler[],
): Promise<FileHandlerDropResult<string>> {
  if (handlers.length === 0) return { unclaimed: paths, opened: [], failed: [] };
  const wanted = wantedByAnyHandler(handlers);
  const leaves: DropLeaf<string>[] = [];
  const budget: WalkBudget = { visited: 0 };
  for (const dropped of paths) {
    const name = browserSafeFileName(dropped);
    try {
      const info = await stat(dropped);
      if (info.isDirectory) {
        await walkLocalDirectory(dropped, dropped, name, 0, budget, wanted, leaves);
      } else if (wanted(name)) {
        leaves.push(pathLeaf(dropped, dropped, info.size));
      }
    } catch (error) {
      // The built-in groups surface their own error for an unreadable path.
      console.debug(`[GeoLibre] Could not inspect dropped path "${dropped}".`, error);
    }
  }
  return offerDropToFileHandlers(leaves, paths, handlers);
}
