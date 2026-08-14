import { useAppStore } from "@geolibre/core";
import { useEffect } from "react";
import {
  loadTemplateLibraryEntries,
  persistTemplateLibraryEntries,
} from "../lib/template-library-store";

/**
 * Load the app-level Template Library from IndexedDB into the store on startup
 * and write every subsequent template library change back.
 */
export function useTemplateLibraryPersistence() {
  useEffect(() => {
    let loaded = false;
    let cancelled = false;

    loadTemplateLibraryEntries()
      .then((entries) => {
        if (cancelled) return;
        const current = useAppStore.getState().templateLibrary;
        const merged = [...entries.filter((e) => !current.some((c) => c.id === e.id)), ...current];
        loaded = true;
        useAppStore.getState().setTemplateLibrary(merged);
      })
      .catch((error) => {
        console.error("Failed to load the template library", error);
      });

    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (!loaded || state.templateLibrary === previous.templateLibrary) return;
      persistTemplateLibraryEntries(state.templateLibrary).catch((error) => {
        console.error("Failed to persist the template library", error);
      });
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);
}
