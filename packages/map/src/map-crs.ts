/**
 * MapLibre side of a project's map CRS (`preferences.map.mapCrs`, issue #1128).
 *
 * MapLibre 6.15 draws a flat map in a CRS registered with
 * `maplibregl.addProjection`, placing tiles on that CRS's square quad grid
 * without reprojecting them. This module resolves the preference to a CRS,
 * registers it, teaches MapLibre's workers to project GeoJSON into it, and
 * builds the style a map in it starts from: the projection is part of the style
 * so every source loads in the CRS grid from the first tile, as MapLibre's
 * custom CRS guide asks.
 *
 * The API is `@experimental` upstream and may change in a minor release; see
 * docs/maintenance.md before bumping `maplibre-gl`.
 */

import {
  deriveTileMatrixSet,
  getMapCrsPreset,
  normalizeMapCrs,
  parseMapCrsEpsgCode,
} from "@geolibre/core";
import * as maplibregl from "maplibre-gl";
import { BLANK_BACKGROUND_LAYER_ID } from "./basemap-style";
import type { ResolvedMapCrs } from "./active-map-crs";
import { resolveEpsgProjection } from "./epsg-proj4";

export type { ResolvedMapCrs } from "./active-map-crs";

/** Source and layer id of a CRS's own basemap in the style. */
export const MAP_CRS_BASEMAP_ID = "map-crs-basemap";

const resolvedCrs = new Map<string, Promise<ResolvedMapCrs | null>>();

/**
 * Resolve a map CRS preference.
 *
 * A preset resolves to its own definition and grid. An `EPSG:<code>` value is
 * looked up in the bundled EPSG tables and gets a grid fitted to the part of
 * the world it maps (`deriveTileMatrixSet`). Results, failures included, are
 * cached per value: the tables are bundled, so a miss is not transient.
 *
 * Args:
 *   value: The raw `preferences.map.mapCrs` value.
 *
 * Returns:
 *   The CRS, or `null` for the default map or a code that cannot be resolved.
 */
export function resolveMapCrs(value: unknown): Promise<ResolvedMapCrs | null> {
  const id = normalizeMapCrs(value);
  if (id === undefined) return Promise.resolve(null);
  let pending = resolvedCrs.get(id);
  if (!pending) {
    pending = resolveNormalizedMapCrs(id);
    // A rejection (a lazy chunk that failed to load) may be transient; only a
    // resolved miss is cached for good.
    pending.catch(() => resolvedCrs.delete(id));
    resolvedCrs.set(id, pending);
  }
  return pending;
}

async function resolveNormalizedMapCrs(id: string): Promise<ResolvedMapCrs | null> {
  const preset = getMapCrsPreset(id);
  if (preset) {
    return {
      id,
      code: preset.code,
      definition: preset.definition,
      tileMatrixSet: preset.tileMatrixSet,
      basemap: preset.basemap,
      bounds: preset.bounds,
      ...(preset.wmsSrs ? { wmsSrs: preset.wmsSrs } : {}),
    };
  }
  const code = parseMapCrsEpsgCode(id);
  if (code === null) return null;
  const projection = await resolveEpsgProjection(code);
  if (!projection) return null;
  const converter = projection.proj4(projection.definition);
  const tileMatrixSet = deriveTileMatrixSet(converter, projection.geographic);
  if (!tileMatrixSet) return null;
  const { origin, extentAtZoom0 } = tileMatrixSet;
  const [lng, lat] = converter.inverse([
    origin[0] + extentAtZoom0 / 2,
    origin[1] - extentAtZoom0 / 2,
  ]);
  return {
    id,
    code: `EPSG:${code}`,
    definition: projection.definition,
    tileMatrixSet,
    ...(Number.isFinite(lng) && Number.isFinite(lat) ? { gridCenter: [lng, lat] } : {}),
  };
}

const registeredCodes = new Set<string>();
let workerScript: Promise<string> | null = null;

/**
 * The script that gives MapLibre's workers a projection handler: proj4's UMD
 * build, which defines a global `proj4` when evaluated outside a module system,
 * followed by the handler. MapLibre fetches the script and evaluates it in each
 * worker (both CSPs allow `blob:` in connect-src and `'unsafe-eval'`), so the
 * workers build the same converter the page does from each CRS's `definition`.
 */
function projectionHandlerScript(): Promise<string> {
  if (!workerScript) {
    const pending = import("proj4/dist/proj4.js?raw").then(
      ({ default: proj4Source }) =>
        `${proj4Source}\n;self.setProjectionHandler(function (definition) { return proj4(definition); });\n`,
    );
    // A failed lazy chunk may be transient: let the next call retry it.
    pending.catch(() => {
      if (workerScript === pending) workerScript = null;
    });
    workerScript = pending;
  }
  return workerScript;
}

/**
 * Register a map CRS with MapLibre and install the workers' projection handler.
 *
 * Registration happens once per code. The handler is sent to the workers on
 * every call rather than once: MapLibre terminates its worker pool when the
 * last map is removed and starts fresh workers for the next one, which would
 * otherwise draw GeoJSON without it.
 *
 * Args:
 *   crs: The resolved CRS.
 */
export async function registerMapCrs(crs: ResolvedMapCrs): Promise<void> {
  const { default: proj4 } = await import("proj4");
  if (!registeredCodes.has(crs.code)) {
    try {
      maplibregl.addProjection({
        name: crs.code,
        definition: crs.definition,
        projection: proj4(crs.definition),
        tileMatrixSet: crs.tileMatrixSet,
      });
    } catch (error) {
      // A hot reload re-runs this module against MapLibre's registry, which
      // still holds the CRS; anything else is a real failure.
      if (!/already registered/i.test(String(error))) throw error;
    }
    registeredCodes.add(crs.code);
  }
  const url = URL.createObjectURL(
    new Blob([await projectionHandlerScript()], { type: "text/javascript" }),
  );
  try {
    await maplibregl.importScriptInWorkers(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * The style a map in `crs` starts from: the projection, a dark background (the
 * edge of a polar grid is space, not missing data) and the preset's own WMS
 * basemap when it has one.
 *
 * Args:
 *   crs: The resolved CRS.
 *
 * Returns:
 *   A fresh style object; MapLibre mutates the style it is handed.
 */
export function createMapCrsStyle(crs: ResolvedMapCrs): maplibregl.StyleSpecification {
  const basemap = crs.basemap;
  return {
    version: 8,
    projection: { type: crs.code },
    sources: basemap
      ? {
          [MAP_CRS_BASEMAP_ID]: {
            type: "raster",
            tiles: [basemap.tiles],
            tileSize: 512,
            maxzoom: basemap.maxZoom,
            attribution: basemap.attribution,
          },
        }
      : {},
    layers: [
      {
        id: BLANK_BACKGROUND_LAYER_ID,
        type: "background",
        paint: { "background-color": "#000000" },
      },
      ...(basemap
        ? [{ id: MAP_CRS_BASEMAP_ID, type: "raster" as const, source: MAP_CRS_BASEMAP_ID }]
        : []),
    ],
  };
}
