import type { MapProjection, MapRendererKind } from "@geolibre/core";
import { ARCGIS_CAPABILITIES, ARCGIS_DECK_CAPABILITIES } from "./arcgis-engine";
import { CESIUM_CAPABILITIES } from "./cesium-engine";
import { MAPBOX_CAPABILITIES } from "./mapbox-engine";
import { MAPLIBRE_CAPABILITIES, type MapEngineCapabilities } from "./map-engine";

/**
 * The capabilities a primary map drawn by `renderer` has, without a live engine.
 *
 * This is the one place outside the engines that maps a renderer name to what
 * it can do, so code that only knows the store's `primaryRenderer` (a plugin, a
 * menu handler, the window before a canvas publishes its engine) gates on a
 * capability instead of comparing names. A live engine's own
 * `MapEngine.capabilities` is still the better answer when there is one: it can
 * narrow these (a grid pane has no DOM controls; an ArcGIS view without its
 * deck.gl bridge has no overlay).
 *
 * @param renderer - The renderer drawing the primary map.
 * @param projection - The project's map projection. Only ArcGIS reads it: its
 *   globe is a `SceneView` without the deck.gl overlay, while a flat view hosts
 *   one.
 * @returns That renderer's frozen capability object.
 */
export function rendererCapabilities(
  renderer: MapRendererKind,
  projection?: MapProjection,
): MapEngineCapabilities {
  switch (renderer) {
    case "cesium":
      return CESIUM_CAPABILITIES;
    case "mapbox":
      return MAPBOX_CAPABILITIES;
    case "arcgis":
      return projection === "globe" ? ARCGIS_CAPABILITIES : ARCGIS_DECK_CAPABILITIES;
    default:
      return MAPLIBRE_CAPABILITIES;
  }
}
