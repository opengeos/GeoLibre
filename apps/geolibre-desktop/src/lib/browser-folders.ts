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

/**
 * Normalize a folder path for storage/dedupe: trim, then strip trailing path
 * separators so `/data/gis` and `/data/gis/` are the same pin — but preserve a
 * POSIX root (`/`) and a Windows drive root (`C:\`), since a bare `C:` is not a
 * valid absolute path. (Case-insensitive Windows paths are left as-is; the
 * native picker returns a consistent form.)
 */
export function normalizeFolderPath(path: string): string {
  const stripped = path.trim().replace(/[/\\]+$/, "");
  if (stripped === "") return "/";
  if (/^[a-zA-Z]:$/.test(stripped)) return `${stripped}\\`;
  return stripped;
}

/** The trailing path segment (folder name) of an absolute path, for the label. */
export function folderLabel(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const segments = trimmed.split(/[/\\]/);
  return segments[segments.length - 1] || trimmed || path;
}

export function readPinnedFolders(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const value = window.localStorage.getItem(PINNED_FOLDERS_STORAGE_KEY);
    if (!value) return [];
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? uniquePaths(
          parsed
            .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
            // Normalize on read too, so a legacy entry stored un-normalized
            // (e.g. a trailing separator) dedupes against a normalized pin.
            .map(normalizeFolderPath),
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
    window.localStorage.setItem(PINNED_FOLDERS_STORAGE_KEY, JSON.stringify(next));
    window.dispatchEvent(new Event(PINNED_FOLDERS_CHANGED_EVENT));
  } catch {
    // Best-effort persistence: a quota/private-mode failure must not throw
    // (mirrors readPinnedFolders' guard and rememberPostgresConnection).
  }
  return next;
}

/** Add a folder to the front of the pinned list (normalized, deduped, capped). */
export function pinFolder(path: string): string[] {
  if (!path.trim()) return readPinnedFolders();
  const normalized = normalizeFolderPath(path);
  return writePinnedFolders([
    normalized,
    ...readPinnedFolders().filter((value) => value !== normalized),
  ]);
}

/** Remove a folder from the pinned list. */
export function unpinFolder(path: string): string[] {
  const normalized = normalizeFolderPath(path);
  return writePinnedFolders(readPinnedFolders().filter((value) => value !== normalized));
}
