import { useAppStore } from "@geolibre/core";
import i18next from "i18next";
import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "../lib/is-tauri";
import { notify } from "../lib/notify";

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
  // The project the prompt was raised for. Another project can arrive while it
  // is up (Open from URL, a dropped file), and Discard must not then throw that
  // one away unasked.
  const promptGenerationRef = useRef<number | null>(null);
  // Mirrors the prompt state for the once-registered listener, so a second
  // close while the prompt is up cannot rebind it to a replacement project.
  const promptOpenRef = useRef(false);

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
          if (savingRef.current || promptOpenRef.current) return;
          promptOpenRef.current = true;
          promptGenerationRef.current = useAppStore.getState().projectGeneration;
          setWindowClosePromptOpen(true);
        }),
      )
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((error) => {
        console.error("[GeoLibre] Could not guard the window close", error);
        // Closing the window would then drop unsaved work without asking.
        notify.warning(i18next.t("notifications.windowCloseGuardFailed"), {
          dedupeKey: "window-close-guard",
          durationMs: null,
        });
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const resolveWindowClosePrompt = useCallback(async (choice: WindowCloseChoice) => {
    if (savingRef.current) return;
    promptOpenRef.current = false;
    setWindowClosePromptOpen(false);
    const promptGeneration = promptGenerationRef.current;
    promptGenerationRef.current = null;
    if (choice === "cancel") return;
    // The project changed under the prompt; the next close asks about it.
    if (useAppStore.getState().projectGeneration !== promptGeneration) return;
    if (choice === "save") {
      savingRef.current = true;
      setWindowCloseSaving(true);
      let saved = false;
      try {
        // The prompt is hidden while saving so the save flow's own dialogs
        // (file name, embed-data, credential strip) are not stacked under it.
        saved = await saveProjectRef.current();
      } catch (error) {
        // A save that fails cleanly resolves false and shows its own dialog;
        // only an unexpected throw lands here, with nothing else on screen.
        console.error("Failed to save project before closing", error);
        notify.error(i18next.t("notifications.windowCloseSaveFailed"), {
          dedupeKey: "window-close-save",
          error,
        });
      } finally {
        savingRef.current = false;
        setWindowCloseSaving(false);
      }
      // A cancelled or failed save leaves the project unsaved, so keep the
      // window. The prompt is not reopened: a failed save shows its own error
      // dialog, which the prompt would cover. Closing again asks again. A save
      // can also succeed and still leave the project dirty (an edit that landed
      // while it was writing), so check the flag too.
      if (!saved || useAppStore.getState().isDirty) return;
    }
    try {
      await destroyCurrentWindow();
    } catch (error) {
      console.error("[GeoLibre] Could not close the window", error);
      notify.error(i18next.t("notifications.windowCloseFailed"), {
        dedupeKey: "window-close",
        error,
      });
    }
  }, []);

  return { windowClosePromptOpen, windowCloseSaving, resolveWindowClosePrompt };
}
