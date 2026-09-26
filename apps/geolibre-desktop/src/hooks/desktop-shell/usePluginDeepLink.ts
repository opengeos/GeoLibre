import type { MapEngine } from "@geolibre/map";
import { VIEWER_BLOCKED_PLUGIN_IDS } from "@geolibre/plugins";
import { useEffect, useMemo, useRef, type RefObject } from "react";
import { pluginDeepLinkFromSearch, pluginDeepLinkNames } from "../../lib/plugin-deep-link";
import { activateDeepLinkedPlugin, DEEP_LINKABLE_PLUGIN_IDS } from "../usePlugins";

interface PluginDeepLinkOptions {
  mapControllerRef: RefObject<MapEngine | null>;
  enforceViewerPlugins: () => void;
  /** Whether the app runs in the read-only `layout=viewer` preset. */
  viewer: boolean;
  externalPluginsReady: boolean;
  mapReadyGeneration: number;
  /**
   * Whether a `?url=` project the page opened with has finished loading (or
   * failed). `true` when there is none. Only its first `true` matters: the
   * loader's "loaded" state later decays back to idle.
   */
  projectUrlSettled: boolean;
}

/**
 * Activates the built-in plugins a `?plugin=<id>` deep link names, once per
 * page load, e.g. `…/?plugin=swipe` or `…/?plugin=maplibre-gl-time-slider`.
 *
 * It waits for the map and for any `?url=` project: restoring a loaded
 * project's plugin state deactivates every plugin the project does not list,
 * so activating earlier would be undone. Call it after `usePluginStateRestore`
 * so, in the commit a project loads in, the restore runs first. Consent-gated
 * plugins are never activated (see `DEEP_LINKABLE_PLUGIN_IDS`), nor are the
 * editing plugins `layout=viewer` blocks; the viewer guard is still re-asserted
 * afterwards.
 *
 * @param options - The map engine, the viewer guard, and the readiness signals.
 */
export function usePluginDeepLink({
  mapControllerRef,
  enforceViewerPlugins,
  viewer,
  externalPluginsReady,
  mapReadyGeneration,
  projectUrlSettled,
}: PluginDeepLinkOptions): void {
  const targets = useMemo(
    () =>
      typeof window === "undefined"
        ? null
        : pluginDeepLinkFromSearch(window.location.search, DEEP_LINKABLE_PLUGIN_IDS),
    [],
  );
  const handled = useRef(false);
  const projectSettled = useRef(false);

  useEffect(() => {
    if (projectUrlSettled) projectSettled.current = true;
    if (!targets || handled.current) return;
    if (!externalPluginsReady || !mapReadyGeneration || !projectSettled.current) return;
    if (!mapControllerRef.current) return;
    handled.current = true;

    if (targets.unknown.length > 0) {
      // The valid names go last, after a fixed label: the docs check in
      // e2e/plugin-deep-link.spec.ts reads them from this message.
      console.warn(
        `[GeoLibre] Ignoring unknown plugin(s) in the ?plugin= link: ${targets.unknown.join(", ")}. ` +
          `Valid names: ${pluginDeepLinkNames(DEEP_LINKABLE_PLUGIN_IDS).join(", ")}`,
      );
    }
    void (async () => {
      // One at a time so plugins sharing an exclusive group resolve in link
      // order (the last one wins), as they would clicked from the menu.
      for (const id of targets.pluginIds) {
        // Skipped rather than left to the guard: activating would mount the
        // editing control for a moment and record it in the project's plugin
        // state, so every later restore would bring it back.
        if (viewer && VIEWER_BLOCKED_PLUGIN_IDS.includes(id)) continue;
        try {
          if (!(await activateDeepLinkedPlugin(id, mapControllerRef))) {
            console.warn(`[GeoLibre] The plugin "${id}" from the ?plugin= link did not activate.`);
          }
        } catch (error) {
          console.error(`[GeoLibre] Could not activate the plugin "${id}"`, error);
        }
      }
    })().finally(enforceViewerPlugins);
  }, [
    targets,
    enforceViewerPlugins,
    viewer,
    externalPluginsReady,
    mapReadyGeneration,
    projectUrlSettled,
    mapControllerRef,
  ]);
}
