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
