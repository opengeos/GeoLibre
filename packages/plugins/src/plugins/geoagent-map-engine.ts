import type { GeoAgentMapEngine } from "maplibre-gl-geoagent";
import type { GeoLibreAppAPI } from "../types";

/**
 * Which map library the GeoAgent tools should speak.
 *
 * Almost every tool already stays on the Style Spec surface both 2D engines
 * share. Four cannot, and each breaks differently on a mapbox-gl map:
 * `add_marker` builds MapLibre's `Marker`/`Popup` (whose position update reads
 * `map._camera.transform` and throws), `set_projection` writes `{ type }`
 * (Mapbox takes a name string), `get_map_state` reads `projection.type` (which
 * is `undefined` there), and `run_maplibre_script` hands user-authored code the
 * wrong namespace. `maplibre-gl-geoagent` 0.6.0 takes the engine as one option
 * and all four follow it — which matters more here than in a control that
 * simply fails to mount: an agent run that breaks does so mid-way, after it has
 * already changed the map.
 *
 * Lives in its own module so it can be unit-tested: the plugin's entry module
 * pulls the Earth Engine browser client in at import time.
 *
 * Two deliberate choices about *when* things are read. The engine is decided
 * from the renderer, which the store flips synchronously, rather than from the
 * namespace, which only appears once `MapboxEngine` has mounted — and GeoAgent
 * is built behind a dynamic import, so that window is wide. And the namespace
 * itself is resolved on access rather than now, so a control constructed while
 * the engine was still mounting still hands its tools the right library.
 *
 * @param app - The plugin host API, read for the renderer and the namespace.
 * @returns The Mapbox engine descriptor on a Mapbox host, else `undefined`,
 *   which leaves the upstream default of this package's own `maplibre-gl`.
 */
export function geoAgentMapEngine(
  app: Pick<GeoLibreAppAPI, "getMapboxGl" | "getMapRenderer"> | null | undefined,
): GeoAgentMapEngine | undefined {
  const mapbox = app?.getMapRenderer?.() === "mapbox" || !!app?.getMapboxGl?.();
  if (!mapbox) return undefined;
  return {
    kind: "mapbox",
    // The whole namespace, not a narrowed subset: `run_maplibre_script` passes
    // it straight to the script it runs, so a script reaching for
    // `LngLatBounds` must find the engine's own. Read on access: the control
    // stores this descriptor and its tools only dereference `namespace` when a
    // tool actually runs, long after the map exists.
    get namespace(): GeoAgentMapEngine["namespace"] {
      const mapboxgl = app?.getMapboxGl?.();
      if (!mapboxgl) {
        // Unreachable once a tool can run (see above); loud rather than
        // silently handing the agent MapLibre's classes, which throw later.
        throw new Error("GeoAgent needs the mapbox-gl namespace to drive a Mapbox map.");
      }
      return mapboxgl as unknown as GeoAgentMapEngine["namespace"];
    },
  };
}
