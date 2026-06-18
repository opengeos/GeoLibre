import { useAppStore } from "@geolibre/core";
import { useEffect } from "react";
import { isEmbedded } from "./embedHost";
import { isTauri } from "../lib/is-tauri";

/**
 * Warn before the browser tab is closed or reloaded while the project has
 * unsaved changes, so map work is not lost by accident. The native
 * `beforeunload` prompt only appears when {@link useAppStore} reports
 * `isDirty`; an unchanged project closes without interruption.
 *
 * Mount once at the app root. The guard is a no-op under Tauri (a desktop
 * window close is a separate flow and does not raise a useful web prompt) and
 * in the Jupyter/embedded build (the host owns the page lifecycle, and a
 * confirm dialog inside an iframe is undesirable).
 */
export function useBeforeUnloadGuard(): void {
  useEffect(() => {
    if (isTauri() || isEmbedded()) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      // Read the latest value on each event rather than closing over a
      // render-time snapshot, so the listener never needs to be re-registered.
      if (!useAppStore.getState().isDirty) return;
      // preventDefault + a non-empty returnValue is what triggers the browser's
      // built-in "Leave site?" confirmation. Modern browsers honour
      // preventDefault alone and ignore the string, but Safari and older
      // Firefox still require a truthy returnValue, so set a non-empty sentinel
      // (its text is never shown).
      event.preventDefault();
      event.returnValue = "unsaved";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);
}
