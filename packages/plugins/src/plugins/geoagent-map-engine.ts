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
 * @param app - The plugin host API, read for the mapbox-gl namespace.
 * @returns The Mapbox engine descriptor on a Mapbox host, else `undefined`,
 *   which leaves the upstream default of this package's own `maplibre-gl`.
 */
export function geoAgentMapEngine(
  app: Pick<GeoLibreAppAPI, "getMapboxGl"> | null | undefined,
): GeoAgentMapEngine | undefined {
  const mapboxgl = app?.getMapboxGl?.();
  if (!mapboxgl) return undefined;
  // The whole namespace, not a narrowed subset: `run_maplibre_script` passes it
  // straight to the script it runs, so a script reaching for `LngLatBounds`
  // must find the engine's own.
  return { kind: "mapbox", namespace: mapboxgl as unknown as GeoAgentMapEngine["namespace"] };
}
