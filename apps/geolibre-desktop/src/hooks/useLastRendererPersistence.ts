import { useAppStore } from "@geolibre/core";
import { useLayoutEffect } from "react";
import { readLastRenderer, writeLastRenderer } from "../lib/last-renderer";

/** Restore the last rendering engine into the empty startup workspace and track changes. */
export function useLastRendererPersistence(): void {
  useLayoutEffect(() => {
    const state = useAppStore.getState();
    const storedRenderer = readLastRenderer();

    // Never replace the renderer saved by a project that another startup source
    // already loaded. Direct state replacement also keeps this preference from
    // making a pristine startup workspace dirty.
    if (
      storedRenderer !== null &&
      state.projectGeneration === 0 &&
      state.projectPath === null &&
      !state.isDirty
    ) {
      useAppStore.setState({ primaryRenderer: storedRenderer });
    }

    writeLastRenderer(useAppStore.getState().primaryRenderer);
    return useAppStore.subscribe((next, previous) => {
      if (next.primaryRenderer !== previous.primaryRenderer) {
        writeLastRenderer(next.primaryRenderer);
      }
    });
  }, []);
}
