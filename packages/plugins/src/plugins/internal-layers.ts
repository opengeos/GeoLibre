/**
 * Glob patterns for plugin "chrome" / internal helper layer ids: drawing and
 * measure aids, selection / inspect highlight outlines, the USGS lidar coverage
 * index, and Vantor's internal footprint layers. None of these are user data,
 * so every control that surfaces a layer list (the Components control grid,
 * Layer Swipe, ...) hides them to keep the list uncluttered.
 *
 * Centralized here so the excluded set stays consistent across controls instead
 * of drifting per-list. Patterns match the layer ids each plugin uses for its
 * internal helpers; they are safe to over-include because they only ever match
 * helper ids, never a user's data layer.
 */
export const INTERNAL_HELPER_LAYER_PATTERNS = [
  "usgs-lidar-*",
  "lidar-*",
  "mapbox-gl-draw-*",
  "gl-draw-*",
  "gm_*",
  "inspect-highlight-*",
  "geolibre-highlight-*",
  "measure-*",
  "vantor-*",
] as const;
