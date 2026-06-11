import type MapLibreGlDirections from "@maplibre/maplibre-gl-directions";
import type { IControl } from "maplibre-gl";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";

/**
 * Interactive routing via `@maplibre/maplibre-gl-directions`.
 *
 * Toggled from the Controls menu (off by default). When active, the user can
 * click the map to add waypoints, drag them to reposition, and click a waypoint
 * to remove it; routes come from the library's default OSRM demo server
 * (`https://router.project-osrm.org`, driving only). The route is transient — it
 * is not persisted in the project and is cleared when the tool is toggled off.
 *
 * The heavy routing library is lazy-imported on activate so it stays out of the
 * main bundle.
 */
export const DIRECTIONS_PLUGIN_ID = "maplibre-gl-directions";

let directions: MapLibreGlDirections | null = null;
let loadingControl: IControl | null = null;
// Bumped on every activate/deactivate. A lazy import that resolves with a stale
// token (the user toggled off, or off then on, while it loaded) is discarded so
// it doesn't attach a directions instance to a tool that is no longer active.
let loadToken = 0;

export const maplibreDirectionsPlugin: GeoLibrePlugin = {
  id: DIRECTIONS_PLUGIN_ID,
  name: "Directions",
  version: "1.0.0",
  activate: (app: GeoLibreAppAPI) => {
    const map = app.getMap?.();
    if (!map) return false;
    const token = ++loadToken;
    void import("@maplibre/maplibre-gl-directions")
      .then(({ default: DirectionsClass, LoadingIndicatorControl }) => {
        // Stale (toggled off/on during import) or already attached — discard.
        if (token !== loadToken || directions) return;
        const currentMap = app.getMap?.();
        if (!currentMap) return;
        directions = new DirectionsClass(currentMap);
        directions.interactive = true;
        loadingControl = new LoadingIndicatorControl(directions);
        app.addMapControl(loadingControl, "top-right");
      })
      .catch((error) => {
        console.warn("Could not load the Directions plugin.", error);
      });
  },
  deactivate: (app: GeoLibreAppAPI) => {
    // Invalidate any in-flight import so it doesn't reattach after teardown.
    loadToken += 1;
    if (loadingControl) {
      app.removeMapControl(loadingControl);
      loadingControl = null;
    }
    directions?.destroy();
    directions = null;
  },
};
