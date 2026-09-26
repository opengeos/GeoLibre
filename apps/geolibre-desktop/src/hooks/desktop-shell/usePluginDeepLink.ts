import type { MapEngine } from "@geolibre/map";
import { useEffect, useMemo, useRef, type RefObject } from "react";
import { pluginDeepLinkFromSearch, pluginDeepLinkNames } from "../../lib/plugin-deep-link";
import { activateDeepLinkedPlugin, DEEP_LINKABLE_PLUGIN_IDS } from "../usePlugins";

interface PluginDeepLinkOptions {
  mapControllerRef: RefObject<MapEngine | null>;
  enforceViewerPlugins: () => void;
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
 * plugins are never activated (see `DEEP_LINKABLE_PLUGIN_IDS`), and the
 * read-only viewer guard is re-asserted afterwards, so a link cannot bring up an
 * editing plugin in `layout=viewer`.
 *
 * @param options - The map engine, the viewer guard, and the readiness signals.
 */
export function usePluginDeepLink({
  mapControllerRef,
  enforceViewerPlugins,
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
    externalPluginsReady,
    mapReadyGeneration,
    projectUrlSettled,
    mapControllerRef,
  ]);
}
