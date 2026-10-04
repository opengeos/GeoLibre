/**
 * Decides when a map-engine error (a failed tile, a style source that would not
 * load) is worth a toast rather than only a Diagnostics entry (issue #2858).
 *
 * Only failures of a user's own layer qualify, and a missing *tile* (HTTP 404)
 * never does: sparse tile sets answer 404 for every empty tile by design, so a
 * toast there would fire on ordinary panning. A 404 for a whole-file source
 * (GeoJSON, PMTiles, a style) still does.
 */
import type { GeoLibreLayer } from "@geolibre/core";
import { mapboxSourceId, sourceId } from "@geolibre/map/style-layer-ids";
import type { MapDiagnosticEvent } from "@geolibre/map";

/** HTTP statuses that mean "no data here" for a tile rather than a failure. */
const EMPTY_TILE_STATUSES = new Set([204, 404]);

/**
 * Finds the store layer a map source belongs to.
 *
 * @param source - The engine's source id from the error event.
 * @param layers - The store's layers.
 * @returns The owning layer, or `null` for basemap/plugin/unknown sources.
 */
export function layerForMapSource(
  source: string | undefined,
  layers: readonly GeoLibreLayer[],
): GeoLibreLayer | null {
  if (!source) return null;
  return (
    layers.find((layer) => sourceId(layer.id) === source || mapboxSourceId(layer.id) === source) ??
    null
  );
}

/**
 * Whether a map error event describes a failed tile rather than a whole source.
 * The engine records the tile coordinates in the event detail when it has them.
 */
function isTileFailure(event: MapDiagnosticEvent): boolean {
  if (typeof event.detail !== "string") return false;
  try {
    const parsed: unknown = JSON.parse(event.detail);
    return typeof parsed === "object" && parsed !== null && "tile" in parsed;
  } catch {
    return false;
  }
}

/**
 * Picks the layer a map error should be surfaced for, if any.
 *
 * @param event - The engine's error event.
 * @param layers - The store's layers.
 * @returns The layer to notify about, or `null` when the error stays in
 *   Diagnostics only (not a user layer, or an empty tile).
 */
export function layerToNotifyForMapError(
  event: MapDiagnosticEvent,
  layers: readonly GeoLibreLayer[],
): GeoLibreLayer | null {
  if (event.status !== undefined && EMPTY_TILE_STATUSES.has(event.status) && isTileFailure(event)) {
    return null;
  }
  return layerForMapSource(event.source, layers);
}
