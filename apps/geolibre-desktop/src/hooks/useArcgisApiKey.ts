import { getArcgisApiKey } from "@geolibre/core";
import { useEffect, useState } from "react";

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
 * @returns The trimmed key, or `undefined` when none is configured.
 */
export function useArcgisApiKey(): string | undefined {
  const [key, setKey] = useState<string | undefined>(() => getArcgisApiKey());
  useEffect(() => {
    const refresh = () => setKey(getArcgisApiKey());
    refresh();
    window.addEventListener("geolibre:runtime-env-change", refresh);
    return () => window.removeEventListener("geolibre:runtime-env-change", refresh);
  }, []);
  return key;
}
