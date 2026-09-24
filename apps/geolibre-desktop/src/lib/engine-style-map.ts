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

/** Engine-backed marker hosts, one per engine so their identity is stable. */
const markerMaps = new WeakMap<MapEngine, maplibregl.Map>();

/**
 * A map to pin DOM markers to (`createAnnotationMarker`) on any renderer: the
 * 2D style map where there is one, else a stand-in over the engine's render
 * surface that places the element through `project()` and follows the camera
 * through `onCameraMove` / `onCameraIdle` (the ArcGIS map, #2477). Only the
 * members the projected marker uses exist on the stand-in.
 *
 * @param engine - The live map engine.
 * @returns A marker host, or null before the map exists.
 */
export function engineMarkerMap(engine: MapEngine | null | undefined): maplibregl.Map | null {
  const styleMap = engineStyleMap(engine);
  if (styleMap || !engine) return styleMap;
  const cached = markerMaps.get(engine);
  if (cached) return cached;
  const surface = engine.getRenderSurface();
  if (!surface) return null;
  const subscriptions = new Map<unknown, Map<string, () => void>>();
  const host = {
    getCanvasContainer: () => surface.getContainer(),
    project: (lngLat: [number, number]) => {
      try {
        return surface.project(lngLat);
      } catch {
        // A globe cannot project its far side: park the marker off screen.
        return { x: -1e6, y: -1e6 };
      }
    },
    on(type: string, listener: () => void) {
      let stop: () => void;
      if (type === "resize") {
        const observer = new ResizeObserver(() => listener());
        observer.observe(surface.getContainer());
        stop = () => observer.disconnect();
      } else if (type === "moveend") stop = engine.onCameraIdle(() => listener());
      else stop = engine.onCameraMove(() => listener());
      const byType = subscriptions.get(listener) ?? new Map<string, () => void>();
      byType.get(type)?.();
      byType.set(type, stop);
      subscriptions.set(listener, byType);
      return host;
    },
    off(type: string, listener: () => void) {
      const byType = subscriptions.get(listener);
      byType?.get(type)?.();
      byType?.delete(type);
      if (byType?.size === 0) subscriptions.delete(listener);
      return host;
    },
  };
  const map = host as unknown as maplibregl.Map;
  markerMaps.set(engine, map);
  return map;
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
