// Durable copies of the project a startup restore is meant to reopen, for the
// one platform where the stored path stops working: Android.
//
// `tauri-plugin-dialog`'s `open()` launches `ACTION_GET_CONTENT`, so a project
// picked from device storage is identified by a `content://` SAF URI rather
// than a filesystem path. That URI carries a one-off read grant tied to the
// activity that received it: it reads fine for the rest of the session, and is
// dead the moment the process is gone. Nothing in the app can renew it -- a
// persistable grant needs `ACTION_OPEN_DOCUMENT` plus
// `takePersistableUriPermission`, neither of which the plugin issues (see
// `android-content-uri.ts` for the write-side half of the same problem).
//
// So "Reopen the last project" and "Open a specific project" could never work
// on Android: the restore runs exactly once per cold start, which is exactly
// when the grant is gone (GeoLibre#1948). The fix is to keep our own copy. When
// a project that the startup preference will reopen is opened or saved from a
// content URI, its text is written to the app's private data directory --
// always readable, no grant involved -- and the restore falls back to that copy
// when the original URI can no longer be read.
//
// Kept free of Tauri and React imports so the rules can be unit-tested in Node;
// `tauri-io.ts` binds the two I/O calls to `@tauri-apps/plugin-fs`.

import type { StartupSettings } from "../hooks/useDesktopSettings";
import { isAndroidContentUri } from "./android-content-uri";
import { STARTUP_SNAPSHOTS_STORAGE_KEY } from "./storage-keys";

/**
 * Which startup preference a snapshot serves. One file per slot rather than one
 * per project: the preference can only ever restore two projects (the one named
 * by "specific" and whichever was used last), so a fixed pair needs no pruning
 * -- and pruning would need a `fs:allow-remove` scope the app deliberately does
 * not grant outside its own temp files.
 */
export type StartupSnapshotSlot = "specific" | "last";

/** Where a slot's copy came from, so a restore only uses a copy of *that* project. */
export interface StartupSnapshotEntry {
  /** The path or content URI the project was opened from. */
  sourcePath: string;
  /** Snapshot file, relative to {@link STARTUP_SNAPSHOT_DIR}. */
  file: string;
  /** When the copy was written, for diagnostics. */
  savedAt: string;
}

export type StartupSnapshotIndex = Partial<Record<StartupSnapshotSlot, StartupSnapshotEntry>>;

/**
 * Snapshot directory, relative to the app's private data directory.
 *
 * SYNC: the `fs:scope` entry in `src-tauri/capabilities/default.json` names this
 * path literally — the fs plugin refuses anything outside its scope, so renaming
 * the directory here alone makes every copy fail with "forbidden path".
 */
export const STARTUP_SNAPSHOT_DIR = "startup-projects";

/**
 * Above this the copy is skipped and the restore keeps today's behaviour (the
 * "startup project is unavailable" banner). A project with embedded vector data
 * can run to hundreds of megabytes, and silently doubling that on a phone's
 * internal storage would be a worse bug than the one being fixed.
 *
 * Its own limit, deliberately: `openRecentProjectFile` happens to cap a project
 * fetched by URL at the same number, but that one bounds a download buffered
 * into memory and this one bounds a file kept on disk. Neither has to move when
 * the other does.
 */
export const MAX_STARTUP_SNAPSHOT_BYTES = 25 * 1024 * 1024;

/** The subset of `Storage` this module uses, so tests can pass a plain fake. */
export interface SnapshotStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

/** The two file operations {@link writeStartupSnapshot} and {@link readStartupSnapshot} need. */
export interface StartupSnapshotIo {
  /** Write `content` to `file` under {@link STARTUP_SNAPSHOT_DIR}, creating the directory. */
  write: (file: string, content: string) => Promise<void>;
  /** Read `file` under {@link STARTUP_SNAPSHOT_DIR}. Rejects when it is not there. */
  read: (file: string) => Promise<string>;
}

/** The snapshot file name for a slot. `.geolibre.json` so the copy is recognizable on disk. */
export function startupSnapshotFile(slot: StartupSnapshotSlot): string {
  return `${slot}.geolibre.json`;
}

/**
 * Whether a project is too large to keep a copy of, measured as the UTF-8 bytes
 * the file would actually occupy.
 *
 * `text.length` counts UTF-16 code units, so a project full of non-ASCII (CJK
 * layer names, accented attribute values in embedded GeoJSON) can be up to three
 * times the size of the string that passed the check. The bounds below settle
 * most projects without encoding anything: the byte count is never below the
 * code-unit count and never above three times it, and encoding is a full second
 * copy of the text -- which for the very projects this guard exists to reject
 * would mean allocating hundreds of megabytes on a phone just to confirm they
 * are too big.
 *
 * @param text - The serialized project.
 * @returns True when the copy would exceed {@link MAX_STARTUP_SNAPSHOT_BYTES}.
 */
export function exceedsStartupSnapshotLimit(text: string): boolean {
  if (text.length > MAX_STARTUP_SNAPSHOT_BYTES) return true;
  if (text.length * 3 <= MAX_STARTUP_SNAPSHOT_BYTES) return false;
  return new TextEncoder().encode(text).byteLength > MAX_STARTUP_SNAPSHOT_BYTES;
}

function defaultStorage(): SnapshotStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    // Storage can throw outright when it is disabled (private browsing).
    return null;
  }
}

function isSnapshotEntry(value: unknown): value is StartupSnapshotEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<StartupSnapshotEntry>;
  return (
    typeof entry.sourcePath === "string" &&
    entry.sourcePath.length > 0 &&
    typeof entry.file === "string" &&
    entry.file.length > 0 &&
    typeof entry.savedAt === "string"
  );
}

/**
 * The persisted index of snapshots, dropping anything that does not parse.
 *
 * @param storage - Storage to read from; defaults to `window.localStorage`.
 * @returns The stored index, or an empty one.
 */
export function readStartupSnapshotIndex(
  storage: SnapshotStorage | null = defaultStorage(),
): StartupSnapshotIndex {
  if (!storage) return {};
  let parsed: unknown;
  try {
    const raw = storage.getItem(STARTUP_SNAPSHOTS_STORAGE_KEY);
    if (!raw) return {};
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};
  const candidate = parsed as Record<string, unknown>;
  const index: StartupSnapshotIndex = {};
  for (const slot of ["specific", "last"] as const) {
    if (isSnapshotEntry(candidate[slot])) index[slot] = candidate[slot];
  }
  return index;
}

function writeStartupSnapshotIndex(
  index: StartupSnapshotIndex,
  storage: SnapshotStorage | null,
): void {
  if (!storage) return;
  try {
    storage.setItem(STARTUP_SNAPSHOTS_STORAGE_KEY, JSON.stringify(index));
  } catch {
    // A full or disabled storage costs the fallback, not the save itself.
  }
}

/**
 * The copy in flight, so copies land in the order they were asked for.
 *
 * Callers fire these off without awaiting them, alongside opening or saving a
 * project, so two can overlap. Within a slot that decides which project wins
 * it: open one project, open another before the first copy has landed, and
 * whichever write finished last would take the slot -- while the recent list,
 * updated synchronously as each project opens, already points at the second. The
 * slot would hold a project the preference no longer resolves to, and the next
 * cold start would find no copy matching the path it asks for.
 *
 * One queue for both slots rather than one each, because the two share an index:
 * each write reads the whole index and writes it back after its own file write,
 * so a "last" copy and a "specific" copy in flight together could both read the
 * index before either stored it, and the one finishing last would drop the
 * other's entry -- leaving a perfectly good copy on disk that nothing points at.
 * Copies are small and rare enough that serializing them costs nothing.
 */
let pendingWrite: Promise<unknown> = Promise.resolve();

function queueSnapshotWrite<T>(task: () => Promise<T>): Promise<T> {
  const next = pendingWrite.then(task);
  // The stored link never rejects, so one failed copy cannot strand every later
  // one behind it; the caller still sees the real result through `next`.
  pendingWrite = next.catch(() => undefined);
  return next;
}

/**
 * The slot a project should be copied into, or null when it is not one the
 * startup preference would reopen.
 *
 * "specific" only ever holds the project the user named, so opening something
 * else must not overwrite it. "last" tracks whatever was opened or saved most
 * recently, which is what `startupProjectPath` resolves that mode to.
 *
 * @param path - The path or content URI the project was opened from or saved to.
 * @param settings - The committed startup preference.
 * @returns The slot to write, or null to write nothing.
 */
export function startupSnapshotSlot(
  path: string,
  settings: StartupSettings,
): StartupSnapshotSlot | null {
  if (!isAndroidContentUri(path)) return null;
  if (settings.mode === "specific") return settings.projectPath === path ? "specific" : null;
  if (settings.mode === "last") return "last";
  return null;
}

/**
 * Keep a durable copy of a project the startup preference will reopen.
 *
 * A failure is logged and swallowed: this runs alongside opening or saving a
 * project, and the copy is a fallback for a later launch, so it must never turn
 * a successful save into a visible error.
 *
 * @param path - The path or content URI the project was opened from or saved to.
 * @param text - The serialized project to copy.
 * @param settings - The committed startup preference.
 * @param io - Snapshot file access.
 * @param options - `storage` overrides where the index is kept.
 * @returns The slot written, or null when nothing was.
 */
export async function writeStartupSnapshot(
  path: string,
  text: string,
  settings: StartupSettings,
  io: StartupSnapshotIo,
  options?: { storage?: SnapshotStorage | null },
): Promise<StartupSnapshotSlot | null> {
  const slot = startupSnapshotSlot(path, settings);
  if (!slot) return null;
  if (exceedsStartupSnapshotLimit(text)) {
    console.warn(
      `Startup project is too large to keep a restorable copy (over ${MAX_STARTUP_SNAPSHOT_BYTES} bytes).`,
      path,
    );
    return null;
  }

  return queueSnapshotWrite(async () => {
    const file = startupSnapshotFile(slot);
    try {
      await io.write(file, text);
    } catch (error) {
      console.warn("Could not keep a restorable copy of the startup project.", error);
      return null;
    }

    const storage = options?.storage === undefined ? defaultStorage() : options.storage;
    writeStartupSnapshotIndex(
      {
        ...readStartupSnapshotIndex(storage),
        [slot]: { sourcePath: path, file, savedAt: new Date().toISOString() },
      },
      storage,
    );
    return slot;
  });
}

/**
 * The stored copy of the project at `path`, when there is one.
 *
 * The source path must match exactly: a copy of a different project is never a
 * stand-in for the one the user asked for, so a stale slot yields null and the
 * caller reports the original read failure.
 *
 * Both slots can hold the same project -- run in "specific" mode on project X
 * for a while, switch to "last" mode and keep working on X, and each mode only
 * ever refreshes its own slot -- so the newest copy is tried first, and an older
 * one is still tried when the newest slot's file has gone missing. Something
 * from the right project always beats the unavailable-project banner.
 *
 * @param path - The path or content URI the restore could not read.
 * @param io - Snapshot file access.
 * @param storage - Storage holding the index; defaults to `window.localStorage`.
 * @returns The copied project text, or null when there is none to use.
 */
export async function readStartupSnapshot(
  path: string,
  io: StartupSnapshotIo,
  storage: SnapshotStorage | null = defaultStorage(),
): Promise<string | null> {
  const index = readStartupSnapshotIndex(storage);
  const entries = Object.values(index)
    .filter((candidate) => candidate.sourcePath === path)
    // `savedAt` is an ISO-8601 UTC timestamp, so it sorts lexicographically.
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  for (const entry of entries) {
    try {
      return await io.read(entry.file);
    } catch (error) {
      // The index outlived its file (cleared app storage, a write that never
      // landed). Try the next copy of the same project, if there is one.
      console.warn("Could not read the stored copy of the startup project.", error);
    }
  }
  // Nothing to restore, so let the caller report the real failure.
  return null;
}
