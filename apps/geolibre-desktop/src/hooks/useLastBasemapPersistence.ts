import {
  DEFAULT_ELLIPSOID_ID,
  getPlanetaryBasemapByStyleUrl,
  getRegionalBasemapByStyleUrl,
  useAppStore,
} from "@geolibre/core";
import { useLayoutEffect } from "react";
import { readLastBasemap, writeLastBasemap } from "../lib/last-basemap";

/** Restore the last basemap into the empty startup workspace and track changes. */
export function useLastBasemapPersistence(): void {
  useLayoutEffect(() => {
    const state = useAppStore.getState();
    const lastBasemap = readLastBasemap();
    // A regional basemap remembered from before the deployment disabled them
    // must not come back through the startup workspace.
    const storedBasemap =
      lastBasemap !== null &&
      state.regionalBasemapPolicy === "block" &&
      getRegionalBasemapByStyleUrl(lastBasemap)
        ? null
        : lastBasemap;

    // Never replace a project that another startup source already loaded.
    if (
      storedBasemap !== null &&
      state.projectGeneration === 0 &&
      state.projectPath === null &&
      !state.isDirty
    ) {
      const ellipsoidId =
        getPlanetaryBasemapByStyleUrl(storedBasemap)?.ellipsoidId ?? DEFAULT_ELLIPSOID_ID;
      useAppStore.setState({
        basemapStyleUrl: storedBasemap,
        preferences: {
          ...state.preferences,
          map: { ...state.preferences.map, ellipsoidId },
        },
      });
    }

    writeLastBasemap(useAppStore.getState().basemapStyleUrl);
    return useAppStore.subscribe((next, previous) => {
      if (next.basemapStyleUrl === previous.basemapStyleUrl) return;
      // The startup restore above applies the remembered basemap without a
      // prompt, so only remember a regional basemap the user picked or
      // accepted. One that arrived with data (a trusted embed host's project, a
      // collaboration snapshot, an undo step) keeps the previous value.
      if (
        next.basemapChoiceGeneration === previous.basemapChoiceGeneration &&
        getRegionalBasemapByStyleUrl(next.basemapStyleUrl)
      ) {
        return;
      }
      writeLastBasemap(next.basemapStyleUrl);
    });
  }, []);
}
