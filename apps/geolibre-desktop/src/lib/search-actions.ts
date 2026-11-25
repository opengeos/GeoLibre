/**
 * What picking a search result does to the map, shared by the Layers panel's
 * search box and the command palette so the two cannot drift: a feature is
 * selected and framed the way the attribute table does it, a place is framed by
 * its extent, and a layer is selected and framed like its Zoom to layer button.
 */

import { type GeocodeMatch, useAppStore } from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import { geocodeResultCamera, POINT_RESULT_ZOOM } from "./geocode-camera";

/** A feature found by `searchLayerFeatures`, as much of it as a pick needs. */
export interface FeaturePick {
  layerId: string;
  featureId: string;
}

/**
 * Make a matched feature the live selection on its layer and frame it with the
 * shared highlight overlay. The explicit fit is what a search row promises,
 * regardless of the "zoom to selected feature" preference the map effect
 * honors.
 *
 * @param engine - The map engine, or null while the map is unavailable.
 * @param pick - The layer and selection id of the matched feature.
 * @returns False when the layer has been removed since the search ran, in
 *   which case nothing is selected: `selectedLayerId` must never name a layer
 *   that no longer resolves.
 */
export function selectFeatureMatch(engine: MapEngine | null, pick: FeaturePick): boolean {
  const store = useAppStore.getState();
  const layer = store.layers.find((item) => item.id === pick.layerId);
  if (!layer) return false;
  store.selectLayer(pick.layerId);
  store.selectFeature(pick.featureId);
  engine?.highlightFeature(layer, pick.featureId, { fit: true });
  return true;
}

/**
 * Move the camera to a geocoder match: frame its extent when it reports one,
 * so a state is seen whole and an address lands at street level, and fly to
 * its point otherwise.
 *
 * Every engine frames an extent, the globe included: the store's view holds
 * only a center and a zoom, so it cannot frame a box. A point-only result on
 * the globe keeps Cesium's instant placement through the store's view instead
 * of a flight, because the Cesium camera's flight path differs in flat scene
 * modes and with no box there is nothing a flight would frame.
 *
 * @param engine - The map engine.
 * @param match - The picked geocoder match.
 */
export function flyToGeocodeMatch(engine: MapEngine, match: GeocodeMatch): void {
  const camera = geocodeResultCamera(match, engine.readView().zoom);
  if (camera.kind === "bounds") {
    engine.fitBounds(camera.bounds);
    return;
  }
  // eslint-disable-next-line local/no-renderer-kind-checks -- the Cesium camera's flight path, not a capability, is why the globe jumps instead
  if (engine.kind === "cesium") {
    const store = useAppStore.getState();
    store.setMapView({
      center: camera.center,
      zoom: Math.max(store.mapView.zoom, POINT_RESULT_ZOOM),
    });
  } else {
    engine.flyTo({ center: camera.center, zoom: camera.zoom });
  }
}

/** Why {@link selectAndFitLayer} could not frame a layer. */
export type LayerFitFailure = "missing" | "outsideMapCrs" | "unknownExtent";

/**
 * Select a layer and frame it, like its Zoom to layer button.
 *
 * @param engine - The map engine, or null while the map is unavailable.
 * @param layerId - The layer to select and frame.
 * @returns Null when the layer was framed (or there is no map to frame it on),
 *   otherwise why it could not be: removed since the search ran, wholly outside
 *   the area a custom map CRS shows, or with no known extent (a bare
 *   `{z}/{x}/{y}` vector tile URL). The layer is still selected in the last two
 *   cases, so the caller only has to say why the map did not move.
 */
export function selectAndFitLayer(
  engine: MapEngine | null,
  layerId: string,
): LayerFitFailure | null {
  const store = useAppStore.getState();
  const layer = store.layers.find((item) => item.id === layerId);
  if (!layer) return "missing";
  store.selectLayer(layerId);
  if (!engine || engine.fitLayer(layer)) return null;
  return engine.isLayerOutsideMapCrs?.(layer) ? "outsideMapCrs" : "unknownExtent";
}
