import { getArcgisApiKey, getRuntimeEnvironment } from "@geolibre/core";
import { useEffect, useState } from "react";
import { useDesktopSettingsStore } from "./useDesktopSettings";

/**
 * The current ArcGIS API key, re-resolved whenever the runtime environment
 * changes. It can come from the build (the `ARCGIS_API_KEY` env var) or from
 * Settings → Environment variables (`VITE_ARCGIS_API_KEY`, projected from the
 * device-local field), so it can be supplied at runtime with no rebuild.
 *
 * The ArcGIS renderer is offered either way: it draws the translated project
 * basemap and every non-Esri layer without a key. A key unlocks Esri's basemap
 * styles (Streets, Imagery, ...) and is required by Esri for those, so without
 * one the pane shows a hint rather than disappearing. ArcGIS maps are recreated
 * when the key changes, since the SDK reads it at construction.
 *
 * The device-local setting is also read directly as a fallback: an ArcGIS pane
 * that mounts with the app (a project saved on this renderer) runs its effect
 * before `useRuntimeEnvironmentVariables` projects the saved key into the
 * runtime environment, and that first projection deliberately fires no change
 * event. The resolver still wins once it answers, so a build-time or project
 * value keeps its precedence over the device setting.
 *
 * @returns The trimmed key, or `undefined` when none is configured.
 */
/**
 * The device key fills in only while the runtime environment says nothing at
 * all: an explicit (even empty) project or build value is an answer.
 */
function resolveArcgisApiKey(deviceKey: string): string | undefined {
  const env = getRuntimeEnvironment();
  if (env.VITE_ARCGIS_API_KEY !== undefined || env.ARCGIS_API_KEY !== undefined)
    return getArcgisApiKey();
  return deviceKey.trim() || undefined;
}

export function useArcgisApiKey(): string | undefined {
  const deviceKey = useDesktopSettingsStore((s) => s.desktopSettings.arcgisApiKey);
  const [key, setKey] = useState<string | undefined>(() => resolveArcgisApiKey(deviceKey));
  useEffect(() => {
    const refresh = () => setKey(resolveArcgisApiKey(deviceKey));
    refresh();
    window.addEventListener("geolibre:runtime-env-change", refresh);
    return () => window.removeEventListener("geolibre:runtime-env-change", refresh);
  }, [deviceKey]);
  return key;
}
