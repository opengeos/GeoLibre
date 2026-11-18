import {
  DEFAULT_ELLIPSOID_ID,
  getPlanetaryBasemapByStyleUrl,
  getRegionalBasemapByStyleUrl,
  normalizeMapCrs,
  useAppStore,
} from "@geolibre/core";
import { useLayoutEffect } from "react";
import {
  readChosenRegionalBasemap,
  readLastBasemap,
  writeChosenRegionalBasemap,
  writeLastBasemap,
} from "../lib/last-basemap";

/**
 * Restore the last basemap into the empty startup workspace and track changes.
 *
 * The restore applies the remembered basemap without the regional-basemap
 * prompt, so a regional basemap (served from mainland China) is remembered and
 * restored only when the user chose it: picked it, or answered Load. One that
 * arrived with data (a trusted host's project, a collaboration snapshot, an
 * undo step), or one stored before that choice was recorded, is not restored.
 *
 * A map CRS already in the workspace (seeded from a `?crs=` link) brings the
 * body it maps, which outranks the remembered basemap's: a basemap of another
 * body is not restored, so `?crs=mars-north-polar` keeps measuring on Mars
 * after an Earth basemap was last used (GeoLibre#3515).
 */
export function useLastBasemapPersistence(): void {
  useLayoutEffect(() => {
    const state = useAppStore.getState();
    const lastBasemap = readLastBasemap();
    const regional = lastBasemap !== null && getRegionalBasemapByStyleUrl(lastBasemap);
    const storedBasemap =
      regional &&
      (state.regionalBasemapPolicy === "block" || readChosenRegionalBasemap() !== lastBasemap)
        ? null
        : lastBasemap;

    const storedBody =
      storedBasemap === null
        ? null
        : (getPlanetaryBasemapByStyleUrl(storedBasemap)?.ellipsoidId ?? DEFAULT_ELLIPSOID_ID);
    // A map CRS on screen keeps its body; skipped, the remembered basemap is
    // also left in storage for the next launch. The CRS lives in project
    // preferences, not device storage, so in the untitled startup workspace
    // only a `?crs=` link can have put one there.
    const crsBodyConflict =
      storedBody !== null &&
      normalizeMapCrs(state.preferences.map.mapCrs) !== undefined &&
      storedBody !== state.preferences.map.ellipsoidId;
    // Never replace a project that another startup source already loaded.
    if (
      storedBasemap !== null &&
      storedBody !== null &&
      !crsBodyConflict &&
      state.projectGeneration === 0 &&
      state.projectPath === null &&
      !state.isDirty
    ) {
      useAppStore.setState({
        basemapStyleUrl: storedBasemap,
        preferences: {
          ...state.preferences,
          map: { ...state.preferences.map, ellipsoidId: storedBody },
        },
      });
    }

    // A regional basemap on screen at mount that was not restored from a
    // recorded choice (e.g. a collaboration snapshot before a remount) keeps
    // the previous value.
    const current = useAppStore.getState().basemapStyleUrl;
    if (
      !crsBodyConflict &&
      (!getRegionalBasemapByStyleUrl(current) ||
        (current === storedBasemap && readChosenRegionalBasemap() === current))
    ) {
      writeLastBasemap(current);
    }
    return useAppStore.subscribe((next, previous) => {
      const chosen = next.basemapChoiceGeneration !== previous.basemapChoiceGeneration;
      // A pick of the basemap already on screen still records the choice.
      if (next.basemapStyleUrl === previous.basemapStyleUrl && !chosen) return;
      if (getRegionalBasemapByStyleUrl(next.basemapStyleUrl)) {
        if (!chosen) return;
        writeChosenRegionalBasemap(next.basemapStyleUrl);
      }
      writeLastBasemap(next.basemapStyleUrl);
    });
  }, []);
}
