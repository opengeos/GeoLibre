import type { MapEngine } from "@geolibre/map";
import { VIEWER_BLOCKED_PLUGIN_IDS } from "@geolibre/plugins";
import { useCallback, useEffect, type RefObject } from "react";
import type { LayoutOptions } from "../useLayoutOptions";
import { createAppAPI, getPluginManager } from "../usePlugins";

/**
 * Keeps map-editing plugins deactivated in the read-only viewer preset.
 *
 * @param layoutOptions - The shell's layout options (`viewer` gates the guard).
 * @param mapControllerRef - The primary map engine.
 * @returns A callback that re-asserts the guard, for the plugin restore to call.
 */
export function useViewerPluginGuard(
  layoutOptions: LayoutOptions,
  mapControllerRef: RefObject<MapEngine | null>,
) {
  // The plugins in VIEWER_BLOCKED_PLUGIN_IDS paint drawing and editing controls
  // onto the map, which the read-only viewer preset cannot hide the way it
  // hides React chrome, so they are deactivated outright. This has to run more
  // than once: `restoreProjectState` activates whatever a loaded project lists
  // in `projectPlugins.activePluginIds` with no viewer awareness, so every
  // project load — the initial `?url=` one and any later `loadProject` embed
  // command — can put them back. It is a callback rather than an effect of its
  // own so the restore effect below can re-assert it *after* restoring, which
  // effect ordering alone would not guarantee.
  const enforceViewerPlugins = useCallback(() => {
    if (!layoutOptions.viewer) return;
    const manager = getPluginManager();
    for (const id of VIEWER_BLOCKED_PLUGIN_IDS) {
      if (!manager.isActive(id)) continue;
      // `isActive` is true from the moment activation starts, so a plugin that
      // mounts behind a dynamic import (GeoAgent) is "active" with no control
      // yet: deactivating now would tear down nothing and the mount would land
      // straight after. Wait for it, then re-check — a failed mount rolls the
      // active flag back on its own, so there is nothing left to do.
      const pending = manager.pendingActivation(id);
      if (pending) {
        void pending.then(() => {
          if (manager.isActive(id)) manager.deactivate(id, createAppAPI(mapControllerRef));
        });
        continue;
      }
      manager.deactivate(id, createAppAPI(mapControllerRef));
    }
  }, [layoutOptions.viewer, mapControllerRef]);

  useEffect(() => {
    enforceViewerPlugins();
  }, [enforceViewerPlugins]);
  return enforceViewerPlugins;
}
