/**
 * Persistence for the folders the user has pinned into the Browser panel's Files
 * section — a small localStorage-backed, most-recently-added-first list. Global
 * (not per-project), mirroring `saved-postgres-connections.ts`. UI-free so it
 * unit-tests in isolation.
 */

export const PINNED_FOLDERS_STORAGE_KEY = "geolibre.browser.pinnedFolders";
export const MAX_PINNED_FOLDERS = 20;

/**
 * Fired on `window` after the pinned-folders list is written, so the Browser
 * panel can re-read it in the same tab (the native `storage` event is cross-tab
 * only), mirroring the saved-connections change event.
 */
export const PINNED_FOLDERS_CHANGED_EVENT = "geolibre:pinned-folders-changed";

function uniquePaths(paths: string[]): string[] {
  return Array.from(new Set(paths));
}

/** The trailing path segment (folder name) of an absolute path, for the label. */
export function folderLabel(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const segments = trimmed.split(/[/\\]/);
  return segments[segments.length - 1] || trimmed || path;
}

/**
 * The parent directory of an absolute path (the text before its last path
 * separator), used to derive the Browser panel's "Project Home" from the open
 * project file's path. Kept here (with folderLabel) so the path string-logic is
 * pure and unit-tested.
 *
 * @param path - An absolute file path.
 * @returns The containing directory (the filesystem root for a top-level file).
 */
export function parentDirectory(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (index > 0) {
    const parent = trimmed.slice(0, index);
    // Restore the separator on a Windows drive root ("C:" -> "C:\"), matching
    // the POSIX-root case below so the result stays an absolute path the Rust
    // `is_safe_absolute_path` guard accepts.
    return /^[a-zA-Z]:$/.test(parent) ? `${parent}\\` : parent;
  }
  return index === 0 ? "/" : trimmed;
}

export function readPinnedFolders(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const value = window.localStorage.getItem(PINNED_FOLDERS_STORAGE_KEY);
    if (!value) return [];
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? uniquePaths(
          parsed.filter((item): item is string => typeof item === "string"),
        )
      : [];
  } catch {
    return [];
  }
}

function writePinnedFolders(paths: string[]): string[] {
  const next = uniquePaths(paths).slice(0, MAX_PINNED_FOLDERS);
  if (typeof window === "undefined") return next;
  try {
    window.localStorage.setItem(
      PINNED_FOLDERS_STORAGE_KEY,
      JSON.stringify(next),
    );
    window.dispatchEvent(new Event(PINNED_FOLDERS_CHANGED_EVENT));
  } catch {
    // Best-effort persistence: a quota/private-mode failure must not throw
    // (mirrors readPinnedFolders' guard and rememberPostgresConnection).
  }
  return next;
}

/** Add a folder to the front of the pinned list (deduped, capped). */
export function pinFolder(path: string): string[] {
  const trimmed = path.trim();
  if (!trimmed) return readPinnedFolders();
  return writePinnedFolders([
    trimmed,
    ...readPinnedFolders().filter((value) => value !== trimmed),
  ]);
}

/** Remove a folder from the pinned list. */
export function unpinFolder(path: string): string[] {
  return writePinnedFolders(
    readPinnedFolders().filter((value) => value !== path),
  );
}
