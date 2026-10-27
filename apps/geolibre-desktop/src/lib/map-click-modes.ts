import { DIRECTIONS_PLUGIN_ID, REVERSE_GEOCODE_PLUGIN_ID } from "@geolibre/plugins";

/**
 * The click-to-interact map modes (the ones `MapModeBanner` announces): while
 * one is on, a map click belongs to it, placing a waypoint or running a lookup.
 */
const MAP_CLICK_MODE_PLUGIN_IDS: readonly string[] = [
  DIRECTIONS_PLUGIN_ID,
  REVERSE_GEOCODE_PLUGIN_ID,
];

/**
 * Whether a click-to-interact map mode (Directions or Reverse Geocode) is on,
 * so other map-click tools can stand aside instead of acting on the same click
 * (#3256).
 *
 * @param pluginManager - The plugin manager to read active state from.
 * @returns True when Directions or Reverse Geocode is active.
 */
export function isMapClickModeActive(pluginManager: { isActive(id: string): boolean }): boolean {
  return MAP_CLICK_MODE_PLUGIN_IDS.some((id) => pluginManager.isActive(id));
}
