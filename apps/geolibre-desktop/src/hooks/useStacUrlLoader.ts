import { cancelStacCatalogRequest, requestStacCatalogUrl, STAC_PLUGIN_ID } from "@geolibre/plugins";
import { useEffect, useMemo, useRef } from "react";
import { stacUrlParameter } from "../lib/data-url";
import type { createAppAPI } from "./usePlugins";

/**
 * Opens the STAC Catalogs browser on the catalog a `?stac=<url>` deep link names and connects to
 * it. A URL naming one collection of a STAC API connects to that API and searches the collection,
 * so its item footprints land on the map as a layer.
 *
 * The query string is read once on mount, and the request is made once the map's app API exists,
 * since the browser draws its footprints on the map. A read-only `layout=viewer` embed skips it:
 * the browser adds layers to the project, which that layout does not allow.
 *
 * Args:
 *   mapAppAPI: The app API handed out once the map is ready, or null before that.
 *   viewer: Whether the app runs in the read-only viewer layout.
 */
export function useStacUrlLoader(
  mapAppAPI: ReturnType<typeof createAppAPI> | null,
  viewer: boolean,
): void {
  const url = useMemo(
    () => (typeof window === "undefined" ? null : stacUrlParameter(window.location.search)),
    [],
  );
  const requested = useRef(false);

  useEffect(() => {
    if (!url || viewer || !mapAppAPI || requested.current) return;
    requested.current = true;
    requestStacCatalogUrl(url);
    void Promise.resolve(mapAppAPI.activatePlugin?.(STAC_PLUGIN_ID))
      .catch((error: unknown) => {
        console.error("[GeoLibre] Could not open the STAC Catalogs browser", error);
      })
      // An activation that bailed out or threw leaves the request queued, and the next manual
      // open of the browser must not reconnect to this one-time link's catalog.
      .finally(cancelStacCatalogRequest);
  }, [mapAppAPI, url, viewer]);
}
