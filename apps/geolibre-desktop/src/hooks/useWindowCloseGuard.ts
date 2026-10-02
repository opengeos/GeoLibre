import { useAppStore } from "@geolibre/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "../lib/is-tauri";

/** How the user answered the unsaved-changes prompt raised by a window close. */
export type WindowCloseChoice = "save" | "discard" | "cancel";

export interface WindowCloseGuard {
  /** Whether the "save before closing?" prompt is showing. */
  windowClosePromptOpen: boolean;
  /** True while the prompt's Save runs, so its buttons stay disabled. */
  windowCloseSaving: boolean;
  /** Settle the prompt: save then close, close without saving, or keep the window open. */
  resolveWindowClosePrompt: (choice: WindowCloseChoice) => Promise<void>;
}

/**
 * Close the desktop window for good. Once a close-requested listener exists,
 * Tauri no longer closes the window itself, so the guard has to destroy it.
 */
async function destroyCurrentWindow(): Promise<void> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().destroy();
}

/**
 * The desktop counterpart of {@link useBeforeUnloadGuard} (GeoLibre#2809).
 * Closing the Tauri window with the title-bar X raises no `beforeunload`
 * prompt, so without this a dirty project was dropped on the floor. The guard
 * intercepts the window's close request and, only when the store reports
 * `isDirty`, holds the window open and asks whether to save, discard, or
 * cancel. A clean project closes at once.
 *
 * A no-op outside Tauri, where the browser guard covers the same case.
 *
 * @param saveProject - Saves the current project; resolves true once it is
 *   written, false when the user cancels the save or it fails.
 * @returns The prompt state and its resolver, for the dialog that renders it.
 */
export function useWindowCloseGuard(saveProject: () => Promise<boolean>): WindowCloseGuard {
  const [windowClosePromptOpen, setWindowClosePromptOpen] = useState(false);
  const [windowCloseSaving, setWindowCloseSaving] = useState(false);
  // The save action is rebuilt every render; read the latest one at click time.
  const saveProjectRef = useRef(saveProject);
  saveProjectRef.current = saveProject;
  // A ref rather than the state above so the native listener, registered once,
  // sees an in-flight save and does not reopen the prompt over its dialogs.
  const savingRef = useRef(false);

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | null = null;
    let disposed = false;
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) =>
        getCurrentWindow().onCloseRequested((event) => {
          // Not prevented: the API destroys the window after this returns.
          if (!useAppStore.getState().isDirty) return;
          event.preventDefault();
          if (!savingRef.current) setWindowClosePromptOpen(true);
        }),
      )
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((error) => {
        console.error("[GeoLibre] Could not guard the window close", error);
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const resolveWindowClosePrompt = useCallback(async (choice: WindowCloseChoice) => {
    if (savingRef.current) return;
    setWindowClosePromptOpen(false);
    if (choice === "cancel") return;
    if (choice === "save") {
      savingRef.current = true;
      setWindowCloseSaving(true);
      let saved = false;
      try {
        // The prompt is hidden while saving so the save flow's own dialogs
        // (file name, embed-data, credential strip) are not stacked under it.
        saved = await saveProjectRef.current();
      } catch (error) {
        console.error("Failed to save project before closing", error);
      } finally {
        savingRef.current = false;
        setWindowCloseSaving(false);
      }
      // A cancelled or failed save leaves the project unsaved, so keep the
      // window. The prompt is not reopened: a failed save shows its own error
      // dialog, which the prompt would cover. Closing again asks again.
      if (!saved) return;
    }
    try {
      await destroyCurrentWindow();
    } catch (error) {
      console.error("[GeoLibre] Could not close the window", error);
    }
  }, []);

  return { windowClosePromptOpen, windowCloseSaving, resolveWindowClosePrompt };
}
