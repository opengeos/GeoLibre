import { normalizeStyleLibraryEntries, useAppStore } from "@geolibre/core";
import { useEffect } from "react";
import {
  loadStyleLibraryEntries,
  persistStyleLibraryEntries,
} from "../lib/style-library-store";

/**
 * Load the app-level Style Manager library from IndexedDB into the store on
 * startup and write every subsequent library change back (issue #1294).
 * Project-scoped entries are excluded: they live in the project file and flow
 * through the normal save/load path.
 */
export function useStyleLibraryPersistence() {
  useEffect(() => {
    let loaded = false;
    let cancelled = false;

    void loadStyleLibraryEntries()
      .then((entries) => {
        if (cancelled) return;
        // Normalize on the way in so a hand-edited or older-version record
        // can never crash the dialog; the next write persists the clean form.
        const stored = normalizeStyleLibraryEntries(entries);
        // Merge under any entry saved before this load resolved (in-memory
        // wins by id), so a fast first save is never wiped by the load.
        const current = useAppStore.getState().styleLibrary;
        const merged = [
          ...stored.filter((e) => !current.some((c) => c.id === e.id)),
          ...current,
        ];
        // Enable persistence before the set so the merged result (and any
        // dedup done above) is written back immediately.
        loaded = true;
        useAppStore.getState().setStyleLibrary(merged);
      })
      .catch((error) => {
        console.error("Failed to load the style library", error);
        // Leave the in-memory library usable for this session even when
        // IndexedDB is broken; saves below stay best-effort.
        loaded = true;
        // A save made while the failed load was pending was skipped by the
        // subscriber (loaded was false); flush the current state now so that
        // entry is not silently lost on restart if the store recovered.
        const current = useAppStore.getState().styleLibrary;
        if (current.length > 0) {
          persistStyleLibraryEntries(current).catch(() => {
            // The load already failed; a failing flush here is expected when
            // IndexedDB is genuinely unavailable.
          });
        }
      });

    const unsubscribe = useAppStore.subscribe((state, previous) => {
      // Don't persist until the initial load finished, otherwise the empty
      // startup state could race the load and wipe the stored library.
      if (!loaded || state.styleLibrary === previous.styleLibrary) return;
      persistStyleLibraryEntries(state.styleLibrary).catch((error) => {
        console.error("Failed to persist the style library", error);
      });
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);
}
