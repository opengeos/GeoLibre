import maplibregl from "maplibre-gl";
import type {
  LngLat,
  MapMarkerEventMap,
  MapMarkerHandle,
  MapMarkerOptions,
  Unsubscribe,
} from "./types";

function normalizeLngLat(value: { readonly lng: number; readonly lat: number }): LngLat {
  return [value.lng, value.lat];
}

/** Create a MapLibre marker behind the engine-neutral lifecycle handle. */
export function createMapLibreMarker(
  map: maplibregl.Map,
  options: MapMarkerOptions,
): MapMarkerHandle {
  const marker = new maplibregl.Marker({
    element: options.element,
    color: options.color,
    draggable: options.draggable,
    anchor: options.anchor,
    offset: options.offset ? [options.offset.x, options.offset.y] : undefined,
    rotationAlignment: options.rotationAlignment,
    pitchAlignment: options.pitchAlignment,
  })
    .setLngLat(options.lngLat)
    .addTo(map);

  return {
    setLngLat: (lngLat): void => {
      marker.setLngLat(lngLat);
    },
    getLngLat: (): LngLat => normalizeLngLat(marker.getLngLat()),
    setDraggable: (draggable): void => {
      marker.setDraggable(draggable);
    },
    setRotation: (rotation): void => {
      marker.setRotation(rotation);
    },
    on: <K extends keyof MapMarkerEventMap>(
      event: K,
      handler: (payload: MapMarkerEventMap[K]) => void,
    ): Unsubscribe => {
      const listener = (): void => handler({ lngLat: normalizeLngLat(marker.getLngLat()) });
      marker.on(event, listener);
      return () => marker.off(event, listener);
    },
    remove: (): void => {
      marker.remove();
    },
  };
}
