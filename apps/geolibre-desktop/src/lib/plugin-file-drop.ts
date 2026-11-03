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
/** General purpose flag bit 11: the entry name is UTF-8 rather than CP437. */
const UTF8_NAME_FLAG = 0x0800;
/** The upper half (0x80-0xff) of code page 437, the zip default for names. */
const CP437_HIGH =
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0";
/** Longest possible zip comment plus the record that precedes it. */
const MAX_EOCD_SEARCH = 0xffff + EOCD_SIZE;
/**
 * Range reads, beyond the tail, spent checking end-record candidates. It bounds
 * reads, not candidates: a check that fits in the tail costs none.
 */
const MAX_CANDIDATE_READS = 16;
const SIGNATURE_RECORD_SIGNATURE = 0x05054b50;
const UTF8_DECODER = new TextDecoder();
const STRICT_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
/** A central directory beyond this is not a file a handler should inspect. */
const MAX_CENTRAL_DIRECTORY_BYTES = 16 * 1024 * 1024;

/** Walk limits for a dropped folder, so dropping a home directory cannot hang the app. */
const MAX_FOLDER_DEPTH = 16;
const MAX_FOLDER_ENTRIES = 20_000;

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function decodeCp437(bytes: Uint8Array): string {
  let name = "";
  for (const byte of bytes)
    name += byte < 0x80 ? String.fromCharCode(byte) : CP437_HIGH[byte - 0x80];
  return name;
}

/**
 * Decode an entry name. Flag bit 11 says UTF-8. Without it the zip default is
 * CP437, but some writers (macOS "Compress") store UTF-8 without the flag, so
 * a name that is valid UTF-8 is read as such before falling back to CP437.
 */
function decodeEntryName(name: Uint8Array, flags: number): string {
  if (flags & UTF8_NAME_FLAG) return UTF8_DECODER.decode(name);
  if (name.some((byte) => byte >= 0x80)) {
    try {
      return STRICT_UTF8_DECODER.decode(name);
    } catch {
      return decodeCp437(name);
    }
  }
  return decodeCp437(name);
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
  let reads = 0;
  const countedRead: ReadRange = (offset, length) => {
    reads += 1;
    return readRange(offset, length);
  };
  /** Whether a central directory entry starts at `offset`, with `length` bytes in range. */
  const startsDirectory = async (offset: number, length: number): Promise<boolean> => {
    if (offset < 0 || offset + Math.max(length, 4) > size) return false;
    // Most directories lie in the tail that is already read.
    if (offset >= tailOffset) {
      return tailView.getUint32(offset - tailOffset, true) === CENTRAL_ENTRY_SIGNATURE;
    }
    const head = await countedRead(offset, 4);
    return head.byteLength === 4 && viewOf(head).getUint32(0, true) === CENTRAL_ENTRY_SIGNATURE;
  };
  // Digital signature records (0x05054b50, a 2-byte size, the data) can sit
  // between the directory and the end record. Index every one in the tail by
  // where it ends; data bytes can hold a second signature-like record.
  const signatureStartsByEnd = new Map<number, number[]>();
  for (let at = 0; at + 6 <= tail.byteLength; at += 1) {
    if (tailView.getUint32(at, true) === SIGNATURE_RECORD_SIGNATURE) {
      const end = at + 6 + tailView.getUint16(at + 4, true);
      signatureStartsByEnd.set(end, [...(signatureStartsByEnd.get(end) ?? []), at]);
    }
  }
  /** Absolute starts of signature records ending at the end record at `eocd`. */
  const signatureStarts = async function* (eocd: number): AsyncGenerator<number> {
    for (const at of signatureStartsByEnd.get(eocd) ?? []) yield tailOffset + at;
    // A record with a long data part can begin before the tail: one bounded read.
    const eocdOffset = tailOffset + eocd;
    const earliest = Math.max(0, eocdOffset - 6 - 0xffff);
    if (earliest >= tailOffset || reads >= MAX_CANDIDATE_READS) return;
    const head = await countedRead(earliest, tailOffset - earliest);
    const window = new Uint8Array(head.byteLength + 6);
    window.set(head);
    window.set(tail.subarray(0, 6), head.byteLength);
    const view = viewOf(window);
    for (let at = 0; at < head.byteLength; at += 1) {
      if (
        view.getUint32(at, true) === SIGNATURE_RECORD_SIGNATURE &&
        earliest + at + 6 + view.getUint16(at + 4, true) === eocdOffset
      ) {
        yield earliest + at;
      }
    }
  };
  /**
   * Where the directory of the end record at `eocd` really is, and how far the
   * archive's own layout backs it: 3 = the directory also ends where the record
   * (or the ZIP64 record) begins, 2 = an entry starts at the declared offset or
   * at the offset the size implies, 1 = an empty archive with shifted offsets.
   */
  const checkRecord = async (
    eocd: number,
  ): Promise<{ tier: number; offset: number; length: number } | undefined> => {
    const eocdOffset = tailOffset + eocd;
    // A spanned archive cannot be unpacked by a handler, so it is not listed.
    if (tailView.getUint16(eocd + 4, true) !== 0 || tailView.getUint16(eocd + 6, true) !== 0) {
      return undefined;
    }
    let length = tailView.getUint32(eocd + 12, true);
    let offset = tailView.getUint32(eocd + 16, true);
    if (length === 0xffffffff || offset === 0xffffffff) {
      // ZIP64 archives with bytes in front of them are not listed.
      const locator = eocd - ZIP64_LOCATOR_SIZE;
      if (locator < 0 || tailView.getUint32(locator, true) !== ZIP64_LOCATOR_SIGNATURE) {
        return undefined;
      }
      // The locator names the disk of the ZIP64 record and the disk count.
      if (tailView.getUint32(locator + 4, true) !== 0) return undefined;
      if (tailView.getUint32(locator + 16, true) > 1) return undefined;
      const zip64Offset = Number(tailView.getBigUint64(locator + 8, true));
      if (zip64Offset + ZIP64_EOCD_SIZE > size) return undefined;
      const zip64 = viewOf(await countedRead(zip64Offset, ZIP64_EOCD_SIZE));
      if (zip64.getUint32(0, true) !== ZIP64_EOCD_SIGNATURE) return undefined;
      if (zip64.getUint32(16, true) !== 0 || zip64.getUint32(20, true) !== 0) return undefined;
      length = Number(zip64.getBigUint64(40, true));
      offset = Number(zip64.getBigUint64(48, true));
      if (length === 0) return offset === zip64Offset ? { tier: 3, offset, length } : undefined;
      if (!(await startsDirectory(offset, length))) return undefined;
      return { tier: offset + length === zip64Offset ? 3 : 2, offset, length };
    }
    if (length === 0) {
      if (tailView.getUint16(eocd + 10, true) !== 0) return undefined;
      return { tier: offset === eocdOffset ? 3 : 1, offset, length };
    }
    if (await startsDirectory(offset, length)) {
      return { tier: offset + length === eocdOffset ? 3 : 2, offset, length };
    }
    // Bytes before the archive (a self-extractor stub) shift every offset the
    // record holds, but the directory still ends where the record begins.
    const shifted = eocdOffset - length;
    if (await startsDirectory(shifted, length)) return { tier: 2, offset: shifted, length };
    for await (const signature of signatureStarts(eocd)) {
      const shiftedPastSignature = signature - length;
      if (await startsDirectory(shiftedPastSignature, length)) {
        return { tier: 2, offset: shiftedPastSignature, length };
      }
    }
    return undefined;
  };
  // Collect the end-record signatures. A signature inside the archive comment is
  // only a candidate: it has to point at a real directory, and the best-backed
  // candidate wins (the earlier one on a tie). The order needs no read, so it
  // costs nothing: first records whose directory visibly ends where they begin,
  // then the record whose declared comment ends exactly at the end of the file
  // (the real one in a well-formed zip), then other records whose comment fits,
  // and last the ones that overrun the file (a truncated comment). A tier 3 hit
  // ends the search; only the range reads a check needs are capped.
  const buckets: number[][] = [[], [], [], []];
  for (let eocd = tail.byteLength - EOCD_SIZE; eocd >= 0; eocd -= 1) {
    if (tailView.getUint32(eocd, true) !== EOCD_SIGNATURE) continue;
    const commentEnd = eocd + EOCD_SIZE + tailView.getUint16(eocd + 20, true);
    const directoryEnd = tailView.getUint32(eocd + 12, true) + tailView.getUint32(eocd + 16, true);
    if (directoryEnd === tailOffset + eocd) buckets[0]!.push(eocd);
    else if (commentEnd === tail.byteLength) buckets[1]!.push(eocd);
    else buckets[commentEnd < tail.byteLength ? 2 : 3]!.push(eocd);
  }
  let best: { tier: number; offset: number; length: number } | undefined;
  for (const eocd of buckets.flat()) {
    if (reads >= MAX_CANDIDATE_READS || best?.tier === 3) break;
    const record = await checkRecord(eocd);
    if (record && (!best || record.tier > best.tier)) best = record;
  }
  if (!best) return undefined;
  const directoryOffset = best.offset;
  const directorySize = best.length;
  if (directorySize > MAX_CENTRAL_DIRECTORY_BYTES) return undefined;

  const directory = await readRange(directoryOffset, directorySize);
  const view = viewOf(directory);
  const paths: string[] = [];
  let cursor = 0;
  while (cursor + CENTRAL_ENTRY_SIZE <= directory.byteLength) {
    if (view.getUint32(cursor, true) !== CENTRAL_ENTRY_SIGNATURE) return undefined;
    const flags = view.getUint16(cursor + 8, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const nameStart = cursor + CENTRAL_ENTRY_SIZE;
    if (nameStart + nameLength > directory.byteLength) return undefined;
    const name = directory.subarray(nameStart, nameStart + nameLength);
    paths.push(decodeEntryName(name, flags));
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
  const taken = new Set<DropLeaf<T>>();
  const unmatchedByKey = new Map<string, DropLeaf<T>[]>();
  const given = new Set<GeoLibreDroppedFileInfo>();
  for (const leaf of offered) {
    const file = files.get(leaf)!;
    given.add(file);
    if (returned.has(file)) {
      taken.add(leaf);
    } else {
      const key = fileKey(file);
      unmatchedByKey.set(key, [...(unmatchedByKey.get(key) ?? []), leaf]);
    }
  }
  for (const copy of claimed) {
    if (given.has(copy)) continue;
    const match = unmatchedByKey.get(fileKey(copy))?.shift();
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

    let taken: DropLeaf<T>[];
    try {
      const result = await handler.claim(offered.map((leaf) => files.get(leaf)!));
      taken = takenLeaves(offered, files, Array.isArray(result) ? result : []);
    } catch (error) {
      console.warn(`[GeoLibre] File handler "${handler.id}" failed to claim a drop.`, error);
      continue;
    }
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
      // One unreadable entry must not cost the handler the rest of the folder.
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileSystemFileEntry).file(resolve, reject),
      ).catch(() => null);
      if (file) leaves.push(fileLeaf(origin, file, path));
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
      // One unreadable entry must not cost the handler the rest of the folder.
      const info = await stat(entry.path).catch(() => null);
      if (info) leaves.push(pathLeaf(origin, entry.path, info.size, path));
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
