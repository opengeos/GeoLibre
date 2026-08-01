import { normalizeLayerLibraryEntries, useAppStore } from "@geolibre/core";
import { useEffect } from "react";
import {
  loadLayerLibraryEntries,
  persistLayerLibraryEntries,
  sortLayerLibraryEntriesByStoredOrder,
} from "../lib/layer-library-store";

/**
 * Load the app-level Layer Library (issue #1520) from IndexedDB into the store
 * on startup and write every subsequent change back, so a layer saved to My
 * Data is there in every later project and after a restart.
 *
 * Mirrors {@link useStyleLibraryPersistence}, including its retry-then-stay-
 * unarmed behavior on a failed load: without the stored entries in memory, a
 * later save would clear-and-rewrite the database from an incomplete list and
 * destroy entries that survived the failure.
 */
export function useLayerLibraryPersistence() {
  useEffect(() => {
    let loaded = false;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const RETRY_DELAYS_MS = [1_000, 4_000];

    const attemptLoad = (attempt: number) => {
      void loadLayerLibraryEntries()
        .then((entries) => {
          if (cancelled) return;
          // Restore the persisted display order first (getAll returns key
          // order), then normalize so a hand-edited or older-version record can
          // never crash the panel; the next write persists the clean form.
          const stored = normalizeLayerLibraryEntries(
            sortLayerLibraryEntriesByStoredOrder(entries),
          );
          // Merge under any entry saved before this load resolved (in-memory
          // wins by id), so a fast first save is never wiped by the load.
          const current = useAppStore.getState().layerLibrary;
          const merged = [...current, ...stored.filter((e) => !current.some((c) => c.id === e.id))];
          // Enable persistence before the set so the merged result is written
          // back immediately.
          loaded = true;
          useAppStore.getState().setLayerLibrary(merged);
        })
        .catch((error) => {
          console.error("Failed to load the layer library", error);
          const delay = RETRY_DELAYS_MS[attempt];
          if (delay !== undefined && !cancelled) {
            retryTimer = setTimeout(() => attemptLoad(attempt + 1), delay);
          }
        });
    };
    attemptLoad(0);

    const unsubscribe = useAppStore.subscribe((state, previous) => {
      // Don't persist until the initial load finished, otherwise the empty
      // startup state could race the load and wipe the stored library.
      if (!loaded || state.layerLibrary === previous.layerLibrary) return;
      persistLayerLibraryEntries(state.layerLibrary).catch((error) => {
        console.error("Failed to persist the layer library", error);
      });
    });

    return () => {
      cancelled = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      unsubscribe();
    };
  }, []);
}
