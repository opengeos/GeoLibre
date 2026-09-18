import { getCesiumIonToken } from "@geolibre/core";
import { useEffect, useState } from "react";

/**
 * The current Cesium Ion token, re-resolved whenever the runtime environment
 * changes. It can come from the build (the `CESIUM_TOKEN` env var) or from
 * Settings → Environment variables (`VITE_CESIUM_TOKEN`), so it can be supplied
 * at runtime in the web build with no rebuild.
 *
 * The globe is offered either way: it renders the project basemap as its base
 * imagery, which needs no token. A token adds Cesium World Terrain (relief on
 * tilted views) and Ion World Imagery as the fallback for a basemap with no
 * raster form, so without one the globe shows a hint rather than disappearing.
 *
 * Shared by the multi-map grid's globe panes ({@link MapGrid}) and the primary
 * globe renderer ({@link DesktopShell}), so both resolve the token the same way
 * and both remount when it changes.
 *
 * @returns The trimmed Ion token, or `undefined` when none is configured.
 */
export function useCesiumIonToken(): string | undefined {
  const [token, setToken] = useState<string | undefined>(() => getCesiumIonToken());
  useEffect(() => {
    const refresh = () => setToken(getCesiumIonToken());
    refresh();
    window.addEventListener("geolibre:runtime-env-change", refresh);
    return () => window.removeEventListener("geolibre:runtime-env-change", refresh);
  }, []);
  return token;
}
