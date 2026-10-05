import type { MapEngine } from "@geolibre/map";
import { S3_BROWSER_PLUGIN_ID } from "@geolibre/plugins";
import { useEffect, useRef, type RefObject } from "react";
import { useDesktopSettingsStore } from "../useDesktopSettings";
import { createAppAPI, getPluginManager } from "../usePlugins";

interface StartupPanelsOptions {
  mapControllerRef: RefObject<MapEngine | null>;
  /** Whether the app runs in the read-only `layout=viewer` preset. */
  viewer: boolean;
  externalPluginsReady: boolean;
  mapReadyGeneration: number;
}

/**
 * Opens the panels Settings → Startup asks for (the S3 Browser), once per page
 * load, after the map and plugins are ready.
 *
 * The S3 Browser is session-scoped, so the startup project's plugin restore
 * leaves it open whichever runs first. The read-only viewer never opens it.
 *
 * @param options - The map engine, the viewer flag, and the readiness signals.
 */
export function useStartupPanels({
  mapControllerRef,
  viewer,
  externalPluginsReady,
  mapReadyGeneration,
}: StartupPanelsOptions): void {
  const handled = useRef(false);
  const openS3Browser = useDesktopSettingsStore(
    (state) => state.desktopSettings.startup.openS3Browser,
  );
  useEffect(() => {
    if (handled.current || viewer || !externalPluginsReady || !mapReadyGeneration) return;
    if (!mapControllerRef.current) return;
    handled.current = true;
    const manager = getPluginManager();
    if (!openS3Browser || manager.isActive(S3_BROWSER_PLUGIN_ID)) return;
    void Promise.resolve(
      manager.activate(S3_BROWSER_PLUGIN_ID, createAppAPI(mapControllerRef)),
    ).catch((error) => console.warn("[GeoLibre] Could not open the S3 Browser at startup", error));
  }, [externalPluginsReady, mapControllerRef, mapReadyGeneration, openS3Browser, viewer]);
}
