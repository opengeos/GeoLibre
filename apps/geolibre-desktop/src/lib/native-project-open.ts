import { isTauri } from "./is-tauri";

const OPEN_PROJECT_FILES_EVENT = "open-project-files";

let startupPaths: string[] = [];
let deferredPaths: string[] = [];

async function takePendingProjectPaths(): Promise<string[]> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string[]>("take_pending_project_paths");
}

/** Capture launch-time file paths before React chooses the startup workspace. */
export async function initializeNativeProjectOpen(): Promise<void> {
  if (!isTauri()) return;
  try {
    const paths = await takePendingProjectPaths();
    startupPaths = paths.slice(0, 1);
    deferredPaths.push(...paths.slice(1));
  } catch (error) {
    console.error("[GeoLibre] Could not read project paths supplied at launch", error);
  }
}

/** Return the first OS-opened project selected for this launch. */
export function initialNativeProjectPath(): string | null {
  return startupPaths[0] ?? null;
}

/**
 * Listen for project files opened after the desktop shell has mounted.
 *
 * Registering the event listener before draining the native queue closes both
 * startup races: a path delivered just before registration remains queued, and
 * one delivered just after registration triggers another drain.
 */
export async function listenForNativeProjectOpen(
  openPath: (path: string) => Promise<unknown>,
): Promise<() => void> {
  if (!isTauri()) return () => undefined;

  const { listen } = await import("@tauri-apps/api/event");
  let disposed = false;
  let draining = false;
  let drainRequested = false;

  const drain = async (): Promise<void> => {
    drainRequested = true;
    if (draining) return;
    draining = true;
    try {
      while (drainRequested && !disposed) {
        drainRequested = false;
        const paths = deferredPaths.splice(0);
        try {
          paths.push(...(await takePendingProjectPaths()));
        } catch (error) {
          console.error("[GeoLibre] Could not read an opened project path", error);
        }
        for (const path of paths) {
          if (disposed) return;
          try {
            await openPath(path);
          } catch (error) {
            console.error(`[GeoLibre] Could not open project "${path}"`, error);
          }
        }
      }
    } finally {
      draining = false;
    }
  };

  const unlisten = await listen<void>(OPEN_PROJECT_FILES_EVENT, () => {
    void drain();
  });
  await drain();

  return () => {
    disposed = true;
    unlisten();
  };
}
