import type { MapEngine } from "@geolibre/map";
import { S3_BROWSER_PLUGIN_ID } from "@geolibre/plugins";
import { useEffect, useRef, type RefObject } from "react";
import { getDeploymentPolicy } from "../../lib/deployment-env";
import {
  isStartupPanelGateOpen,
  isStartupProjectFresh,
  openStartupPanel,
} from "../../lib/startup-panel";
import { useDesktopSettingsStore } from "../useDesktopSettings";
import { createAppAPI, getPluginManager } from "../usePlugins";

interface StartupPanelsOptions {
  mapControllerRef: RefObject<MapEngine | null>;
  /** Whether the app runs in the read-only `layout=viewer` preset. */
  viewer: boolean;
  /** Whether the embed hides every side panel (`?maponly`, `?panels=hidden`, `?hidePanels=true`). */
  panelsHidden?: boolean;
  externalPluginsReady: boolean;
  mapReadyGeneration: number;
  /** Whether an initial `?url=` project load has settled (defaults to true). */
  projectUrlSettled?: boolean;
  /** Whether an initial native startup project restore has settled (defaults to true). */
  startupProjectSettled?: boolean;
}

/**
 * Opens the panels Settings → Startup asks for (the S3 Browser) and any
 * deployment policy `plugins.openPanel`, once per page load, after the map
 * and plugins are ready.
 *
 * The S3 Browser is session-scoped, so the startup project's plugin restore
 * leaves it open whichever runs first. The deployment openPanel opens only in
 * fresh projects and is ignored in the read-only viewer preset or when panels
 * are hidden.
 *
 * @param options - The map engine, the viewer flag, and the readiness signals.
 */
export function useStartupPanels({
  mapControllerRef,
  viewer,
  panelsHidden = false,
  externalPluginsReady,
  mapReadyGeneration,
  projectUrlSettled = true,
  startupProjectSettled = true,
}: StartupPanelsOptions): void {
  const s3Handled = useRef(false);
  const openS3Browser = useDesktopSettingsStore(
    (state) => state.desktopSettings.startup.openS3Browser,
  );

  useEffect(() => {
    if (s3Handled.current || viewer || !externalPluginsReady || !mapReadyGeneration) return;
    if (!mapControllerRef.current) return;
    s3Handled.current = true;
    const manager = getPluginManager();
    if (!openS3Browser || manager.isActive(S3_BROWSER_PLUGIN_ID)) return;
    void Promise.resolve(manager.activate(S3_BROWSER_PLUGIN_ID, createAppAPI(mapControllerRef)))
      .then((activated) => {
        if (!activated) console.warn("[GeoLibre] Could not open the S3 Browser at startup");
      })
      .catch((error) => console.warn("[GeoLibre] Could not open the S3 Browser at startup", error));
  }, [externalPluginsReady, mapControllerRef, mapReadyGeneration, openS3Browser, viewer]);

  const panelOpened = useRef(false);
  // Set when another right panel opened while waiting, so a later re-run of
  // the effect does not start waiting again.
  const panelAbandoned = useRef(false);
  useEffect(() => {
    if (
      panelOpened.current ||
      panelAbandoned.current ||
      !isStartupPanelGateOpen({
        viewer,
        panelsHidden,
        externalPluginsReady,
        mapReadyGeneration,
        projectUrlSettled,
        startupProjectSettled,
      })
    ) {
      return;
    }
    if (!mapControllerRef.current) return;
    const openPanelId = getDeploymentPolicy()?.plugins?.openPanel;
    if (!openPanelId) return;
    if (!isStartupProjectFresh()) return;

    const stillWaiting = () =>
      !panelOpened.current && !panelAbandoned.current && isStartupProjectFresh();

    const warnTimer = setTimeout(() => {
      if (stillWaiting()) {
        console.warn(
          `[GeoLibre] Deployment openPanel "${openPanelId}" is not registered after 10 seconds; it opens if it registers later`,
        );
      }
    }, 10000);

    const dispose = openStartupPanel(
      openPanelId,
      stillWaiting,
      () => {
        panelOpened.current = true;
        clearTimeout(warnTimer);
      },
      () => {
        panelAbandoned.current = true;
        clearTimeout(warnTimer);
      },
    );

    return () => {
      clearTimeout(warnTimer);
      dispose();
    };
  }, [
    externalPluginsReady,
    mapControllerRef,
    mapReadyGeneration,
    panelsHidden,
    projectUrlSettled,
    startupProjectSettled,
    viewer,
  ]);
}
