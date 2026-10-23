import type { MapEngine } from "@geolibre/map";
import {
  VIEWER_BLOCKED_PLUGIN_IDS,
  isViewerBlockedPlugin,
  setGeoEditorFileTools,
} from "@geolibre/plugins";
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
  // The plugins in VIEWER_BLOCKED_PLUGIN_IDS (minus the geometry editor when the
  // launch opted into `?draw`) paint drawing and editing controls onto the map,
  // which the read-only viewer preset cannot hide the way it hides React
  // chrome, so they are deactivated outright. This has to run more
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
      if (!isViewerBlockedPlugin(id, { viewer: true, drawing: layoutOptions.viewerDrawing })) {
        continue;
      }
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
  }, [layoutOptions.viewer, layoutOptions.viewerDrawing, mapControllerRef]);

  // The editor's Open/Save file buttons import and export GeoJSON, which would
  // bypass the `data:add` and `export:data` gates, so the viewer drops them.
  // The editor reads this flag once, when it is constructed, and the plugin
  // restore and the `?plugin=` deep link construct it from effects. A
  // child's effect runs before this component's own, so an effect here could
  // lose that race; setting the flag while rendering cannot, because every
  // effect in the tree runs after the render. The write is idempotent, and
  // `layoutOptions.viewer` comes from the launch URL, so it never changes for
  // the page's lifetime: an editor built earlier can never hold a stale value,
  // and there is nothing to reset on unmount.
  setGeoEditorFileTools(!layoutOptions.viewer);

  useEffect(() => {
    enforceViewerPlugins();
  }, [enforceViewerPlugins]);
  return enforceViewerPlugins;
}
