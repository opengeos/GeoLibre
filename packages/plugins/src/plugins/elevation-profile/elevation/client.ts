/**
 * Client for the Open-Meteo elevation API (https://open-meteo.com/en/docs/elevation-api).
 *
 * The implementation moved to `@geolibre/core` (`core/src/elevation.ts`) so the
 * status-bar pointer readout in `@geolibre/map` can share it — plugins depends
 * on map, so map cannot import from here without a dependency cycle.
 *
 * This module stays as the plugin-local name for those exports, both because
 * the Elevation Profile plugin's internal imports read better relative and
 * because it keeps the move from rippling through every call site.
 */

export {
  ELEVATION_REQUEST_TIMEOUT_MS,
  ElevationFetchError,
  fetchElevations,
  MAX_POINTS_PER_REQUEST,
  type FetchLike,
} from "@geolibre/core";
