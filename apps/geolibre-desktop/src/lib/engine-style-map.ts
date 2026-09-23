import * as maplibregl from "maplibre-gl";
import type { MapEngine } from "@geolibre/map";

/**
 * The primary 2D map, whichever Style Spec engine draws it: the MapLibre map,
 * else the Mapbox map presented through MapLibre's types (the same cast
 * `getStyleMap` applies for plugins). Honest only for the members both
 * libraries share (`on`/`off`, `project`, `getCanvas`, `getCanvasContainer`,
 * sources and layers); MapLibre's `Marker` and `Popup` classes are not among
 * them, so use {@link createEnginePopup} and `createAnnotationMarker`.
 *
 * @param engine - The live map engine.
 * @returns The 2D map, or null on a globe engine or before the map exists.
 */
export function engineStyleMap(engine: MapEngine | null | undefined): maplibregl.Map | null {
  const map = engine?.getMap();
  if (map) return map;
  return engine?.kind === "mapbox" &&
    "getMapboxMap" in engine &&
    typeof engine.getMapboxMap === "function"
    ? (engine.getMapboxMap() as unknown as maplibregl.Map)
    : null;
}

/**
 * A popup from the library that draws the map. MapLibre's `Popup` throws on a
 * mapbox-gl map (it reads MapLibre's camera internals), so the Mapbox engine
 * hands out mapbox-gl's own class, whose surface (`setLngLat`,
 * `setDOMContent`, `addTo`, `remove`, `on`/`once`/`off`) matches.
 *
 * @param engine - The live map engine.
 * @param options - Popup options both libraries accept.
 * @returns A popup to place with `setLngLat` and add to {@link engineStyleMap}.
 */
export function createEnginePopup(
  engine: MapEngine | null | undefined,
  options: maplibregl.PopupOptions,
): maplibregl.Popup {
  if (engine?.kind === "mapbox" && "getMapboxGl" in engine) {
    const gl = (
      engine as unknown as { getMapboxGl(): { Popup: new (options: unknown) => unknown } }
    ).getMapboxGl();
    return new gl.Popup(options) as unknown as maplibregl.Popup;
  }
  return new maplibregl.Popup(options);
}
