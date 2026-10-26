/**
 * The CRS each map is drawn in, and the tile templates layer sync requests on
 * it. Kept apart from map-crs.ts, which registers projections and loads proj4
 * for MapLibre's workers through a Vite `?raw` import, so the layer sync (and
 * the published headless `@geolibre/map` bundle built from it) never reaches
 * that code.
 */

import {
  adaptBboxTemplateToCrs,
  MAP_CRS_CHANGE_EVENT,
  type MapCrsBasemap,
  type MapCrsTileMatrixSet,
} from "@geolibre/core";
import type * as maplibregl from "maplibre-gl";

/** A map CRS ready to register with MapLibre. */
export interface ResolvedMapCrs {
  /** The `preferences.map.mapCrs` value it was resolved from. */
  id: string;
  /** Name it is registered under, and the `SRS` WMS layers ask for by default. */
  code: string;
  /**
   * The label WMS and ArcGIS export layers ask for instead of `code`, for a
   * CRS whose authority code servers do not read (the planetary IAU codes).
   */
  wmsSrs?: string;
  /** PROJ string, rebuilt into a converter by proj4 on the page and in the workers. */
  definition: string;
  tileMatrixSet: MapCrsTileMatrixSet;
  /** The preset's native basemap; an EPSG CRS has none. */
  basemap?: MapCrsBasemap;
  /** Box the map frames when it enters the CRS, `[west, south, east, north]`. */
  bounds?: [number, number, number, number];
  /**
   * The lng/lat at the center of the tile grid. An EPSG CRS has no box, so the
   * map frames its whole grid around this point on the way in.
   */
  gridCenter?: [number, number];
}

const activeCrsByMap = new WeakMap<maplibregl.Map, ResolvedMapCrs>();

/** Tell `MAP_CRS_CHANGE_EVENT` listeners a map's CRS changed. A no-op off the browser (node, workers). */
export function notifyMapCrsChange(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(MAP_CRS_CHANGE_EVENT));
}

/**
 * Record the CRS a map is drawn in, for layer sync to read.
 *
 * Args:
 *   map: The map.
 *   crs: Its CRS, or `null` for the default Web Mercator map or globe.
 */
export function setActiveMapCrs(map: maplibregl.Map, crs: ResolvedMapCrs | null): void {
  const previous = activeCrsByMap.get(map) ?? null;
  if (crs) activeCrsByMap.set(map, crs);
  else activeCrsByMap.delete(map);
  if (previous !== crs) notifyMapCrsChange();
}

/**
 * The CRS a map is drawn in.
 *
 * Args:
 *   map: The map.
 *
 * Returns:
 *   The CRS, or `undefined` on the default Web Mercator map or globe.
 */
export function getActiveMapCrs(map: maplibregl.Map): ResolvedMapCrs | undefined {
  return activeCrsByMap.get(map);
}

/**
 * The raster tile templates a layer requests on `map`.
 *
 * On the default map they are returned as they are. On a map in another CRS,
 * WMS and ArcGIS export templates ask for each tile's box in that CRS, and
 * templates with no bounding box (XYZ, TMS) are dropped, since their Web
 * Mercator tiles would land in the wrong place.
 *
 * Args:
 *   map: The map the layer is drawn on.
 *   tiles: The layer's tile templates.
 *
 * Returns:
 *   The templates to request; empty when none can be drawn.
 */
export function tileTemplatesForMapCrs(map: maplibregl.Map, tiles: string[]): string[] {
  const crs = getActiveMapCrs(map);
  if (!crs) return tiles;
  return tiles
    .map((tile) => adaptBboxTemplateToCrs(tile, crs.wmsSrs ?? crs.code))
    .filter((tile): tile is string => tile !== null);
}
