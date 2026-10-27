/**
 * The map CRS half of the plugin app API: `getMapCrs` and `onMapCrsChange`
 * (GeoLibre#3213).
 *
 * The host adapts the layers it manages to a map drawn in another CRS (WMS and
 * ArcGIS export boxes in that CRS, XYZ and vector tiles left out), but before
 * these two methods a plugin could not tell which CRS that was, nor that it had
 * changed. They read the primary engine's CRS and listen for the map's
 * `MAP_CRS_CHANGE_EVENT`. Only the MapLibre engine draws another CRS, and it
 * fires the event when torn down in one, so a switch to another renderer is
 * reported too.
 *
 * Kept in its own module, parameterized over the engine ref and the event
 * target, so it is unit-testable under node.
 */
import { MAP_CRS_CHANGE_EVENT } from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import type { GeoLibreMapCrs } from "@geolibre/plugins";

/** What the map CRS API reads from the host. */
export interface PluginMapCrsHost {
  /** The primary engine, read per call since a renderer swap replaces it. */
  getEngine: () => Pick<MapEngine, "getMapCrs"> | null | undefined;
  /** Where the map dispatches `MAP_CRS_CHANGE_EVENT`; omitted off the browser. */
  eventTarget?: Pick<EventTarget, "addEventListener" | "removeEventListener">;
}

/**
 * Read the plugin-facing CRS of the primary map.
 *
 * Args:
 *   host: The host to read the engine from.
 *
 * Returns:
 *   The CRS, or `null` on the default map, while a CRS is still resolving, or
 *   on an engine that does not draw other CRSs.
 */
function readMapCrs(host: PluginMapCrsHost): GeoLibreMapCrs | null {
  const crs = host.getEngine()?.getMapCrs?.();
  if (!crs) return null;
  return {
    id: crs.id,
    code: crs.code,
    ...(crs.wmsSrs && crs.wmsSrs !== crs.code ? { wmsSrs: crs.wmsSrs } : {}),
  };
}

function sameMapCrs(a: GeoLibreMapCrs | null, b: GeoLibreMapCrs | null): boolean {
  if (a === null || b === null) return a === b;
  return a.id === b.id && a.code === b.code && a.wmsSrs === b.wmsSrs;
}

/**
 * Build `getMapCrs` and `onMapCrsChange` for the plugin app API.
 *
 * Args:
 *   host: The engine ref and event target to read from.
 *
 * Returns:
 *   The two methods, ready to spread into the app API.
 */
export function createPluginMapCrsApi(host: PluginMapCrsHost): {
  getMapCrs: () => GeoLibreMapCrs | null;
  onMapCrsChange: (listener: (crs: GeoLibreMapCrs | null) => void) => () => void;
} {
  return {
    getMapCrs: () => readMapCrs(host),
    onMapCrsChange: (listener) => {
      let previous = readMapCrs(host);
      const emitIfChanged = () => {
        const crs = readMapCrs(host);
        if (sameMapCrs(crs, previous)) return;
        previous = crs;
        listener(crs);
      };
      host.eventTarget?.addEventListener(MAP_CRS_CHANGE_EVENT, emitIfChanged);
      return () => {
        host.eventTarget?.removeEventListener(MAP_CRS_CHANGE_EVENT, emitIfChanged);
      };
    },
  };
}
