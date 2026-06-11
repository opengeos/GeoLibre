import type MapLibreGlDirections from "@maplibre/maplibre-gl-directions";
import type { IControl, Map as MapLibreMap } from "maplibre-gl";
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
 * Privacy note: waypoints are sent to the public OSRM demo server. This is
 * surfaced to the user via the Controls menu item's tooltip and the README; a
 * configurable/self-hosted routing server is a planned follow-up.
 *
 * The heavy routing library is lazy-imported on activate so it stays out of the
 * main bundle.
 */
export const DIRECTIONS_PLUGIN_ID = "maplibre-gl-directions";

let directions: MapLibreGlDirections | null = null;
// The map the current instance is bound to, so restoreDirections can detect a
// map re-initialization (a brand-new Map object) and rebind.
let directionsMap: MapLibreMap | null = null;
let loadingControl: IControl | null = null;
// Bumped on every attach/teardown. A lazy import that resolves with a stale
// token (the user toggled off, or off then on, while it loaded) is discarded so
// it doesn't attach a directions instance to a tool that is no longer active.
let loadToken = 0;

function attach(app: GeoLibreAppAPI): void {
  const map = app.getMap?.();
  if (!map) return;
  const token = ++loadToken;
  void import("@maplibre/maplibre-gl-directions")
    .then(({ default: DirectionsClass, LoadingIndicatorControl }) => {
      // Stale token means a newer attach()/teardown() superseded this import, so
      // discard it. The `|| directions` check is a defensive belt-and-braces:
      // every attach() bumps loadToken first, so a surviving token implies
      // directions is still null — but it guards against ever double-creating.
      if (token !== loadToken || directions) return;
      const currentMap = app.getMap?.();
      if (!currentMap) return;
      directions = new DirectionsClass(currentMap);
      // `interactive` is an instance setter, not a constructor config option in
      // this library version (it's absent from MapLibreGlDirectionsConfiguration).
      directions.interactive = true;
      directionsMap = currentMap;
      loadingControl = new LoadingIndicatorControl(directions);
      app.addMapControl(loadingControl, "top-right");
    })
    .catch((error) => {
      console.error(
        "Directions plugin failed to load; it stays toggled on but inactive.",
        error,
      );
    });
}

function teardown(app: GeoLibreAppAPI): void {
  // Invalidate any in-flight import so it doesn't reattach after teardown.
  ++loadToken;
  if (loadingControl) {
    app.removeMapControl(loadingControl);
    loadingControl = null;
  }
  directions?.destroy();
  directions = null;
  directionsMap = null;
}

/**
 * Keep the directions tool bound to the current map after a map re-init.
 *
 * Mirrors `restoreEffects`: the desktop shell calls this after restoring plugin
 * state. Directions is off by default, so unlike the effects plugin it does not
 * need a first-load kick — this only matters when it is active and the map
 * object is replaced (a MapCanvas remount), where the manager would otherwise
 * leave the instance bound to the destroyed old map. Idempotent.
 */
export function restoreDirections(app: GeoLibreAppAPI, active: boolean): void {
  if (!active) {
    teardown(app);
    return;
  }
  const map = app.getMap?.();
  if (directions && directionsMap === map) return; // already bound to this map
  teardown(app);
  attach(app);
}

export const maplibreDirectionsPlugin: GeoLibrePlugin = {
  id: DIRECTIONS_PLUGIN_ID,
  name: "Directions",
  version: "1.0.0",
  activate: (app: GeoLibreAppAPI) => attach(app),
  deactivate: (app: GeoLibreAppAPI) => teardown(app),
};
