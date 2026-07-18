import { normalizeStyleLibraryEntries, useAppStore } from "@geolibre/core";
import { useEffect } from "react";
import { loadStyleLibraryEntries, persistStyleLibraryEntries } from "../lib/style-library-store";

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
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    // Retry a transient load failure (momentary IndexedDB lock from another
    // tab, etc.) with backoff before giving up, so one hiccup does not leave
    // the whole session unpersisted.
    const RETRY_DELAYS_MS = [1_000, 4_000];

    const attemptLoad = (attempt: number) => {
      void loadStyleLibraryEntries()
        .then((entries) => {
          if (cancelled) return;
          // Normalize on the way in so a hand-edited or older-version record
          // can never crash the dialog; the next write persists the clean form.
          const stored = normalizeStyleLibraryEntries(entries);
          // Merge under any entry saved before this load resolved (in-memory
          // wins by id), so a fast first save is never wiped by the load.
          const current = useAppStore.getState().styleLibrary;
          const merged = [...stored.filter((e) => !current.some((c) => c.id === e.id)), ...current];
          // Enable persistence before the set so the merged result (and any
          // dedup done above) is written back immediately.
          loaded = true;
          useAppStore.getState().setStyleLibrary(merged);
        })
        .catch((error) => {
          console.error("Failed to load the style library", error);
          const delay = RETRY_DELAYS_MS[attempt];
          if (delay !== undefined && !cancelled) {
            retryTimer = setTimeout(() => attemptLoad(attempt + 1), delay);
            return;
          }
          // After the retries, deliberately leave `loaded` false: the
          // persisted entries were never read into memory, so arming the
          // subscriber would let the next save clear-and-rewrite the database
          // from an incomplete in-memory state, destroying entries that may
          // have survived the failure. The library stays fully usable in
          // memory for this session; if the database is genuinely broken,
          // writes would have failed anyway.
        });
    };
    attemptLoad(0);

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
      if (retryTimer !== null) clearTimeout(retryTimer);
      unsubscribe();
    };
  }, []);
}
