import type { StartupSettings } from "../hooks/useDesktopSettings";

/**
 * The subset of a recent-projects entry this module needs. Structural so the
 * helper stays importable from a plain Node test without pulling in the store.
 */
interface RecentPath {
  path: string;
}

function isRemotePath(path: string): boolean {
  try {
    const url = new URL(path);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    // Not a URL at all, so a local filesystem path.
    return false;
  }
}

/**
 * The project a startup restore should open, or `null` when nothing applies.
 *
 * Lives here rather than in `useStartupProject` so it is reachable from a test
 * without loading that hook's Tauri I/O dependencies.
 */
export function startupProjectPath(
  settings: StartupSettings,
  recentProjects: readonly RecentPath[],
): string | null {
  if (settings.mode === "default") return null;
  if (settings.mode === "specific") return settings.projectPath;
  // "Reopen the last project" is documented as the most recently used *local*
  // project, so skip remote entries. Opening a share link also records it in
  // `recentProjects` (by its `https://` URL, since `loadProject` remembers
  // whatever path it was given), and replaying that on every launch would turn
  // a startup preference into a background request to a third-party host --
  // plus the failure banner on any launch where that host is unreachable.
  return recentProjects.find((entry) => !isRemotePath(entry.path))?.path ?? null;
}

/**
 * Follow a pinned startup project to the new path an ordinary Save landed on,
 * or null when the preference should stay as it is.
 *
 * This only ever happens on Android. A project opened through the document
 * picker carries a read-only `content://` grant, so the first in-place Save is
 * refused and falls back to the save dialog (GeoLibre#1833), and the document
 * the dialog *creates* has a different URI -- on the emulator, saving over
 * `General_Project.geolibre.json` yields a URI ending
 * `General_Project.geolibre.json (1)`. The user asked to save the project they
 * pinned, so the preference has to follow it there; left pinned to the old URI
 * it would name a document nothing can open again, and restore the copy taken
 * when it was pinned for as long as the preference lasts.
 *
 * Narrow on purpose. It applies only when a plain Save changed the path by
 * itself, which is the signature of that forced fallback: an explicit Save As is
 * the user deliberately writing a *different* file, and must not silently
 * re-point a preference at it. On desktop a plain Save never changes the path,
 * so this never fires there.
 *
 * @param settings - The current startup preference.
 * @param previousPath - The path the project was saved from, if any.
 * @param newPath - The path the save actually landed on.
 * @returns The updated preference, or null to leave it unchanged.
 */
export function startupSettingsAfterForcedSaveAs(
  settings: StartupSettings,
  previousPath: string | null,
  newPath: string,
): StartupSettings | null {
  if (settings.mode !== "specific") return null;
  if (!previousPath || previousPath === newPath) return null;
  if (settings.projectPath !== previousPath) return null;
  return { ...settings, projectPath: newPath };
}
