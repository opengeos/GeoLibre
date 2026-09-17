import { SEARCH_HIGHLIGHT_COLOR } from "./map-engine";
import type { Point, Polygon } from "geojson";
import type { Map as MaplibreMap } from "maplibre-gl";
import type { Map as MapboxMap } from "mapbox-gl";

type SearchMap = Pick<
  MaplibreMap | MapboxMap,
  "isStyleLoaded" | "addSource" | "addLayer" | "getLayer" | "removeLayer" | "removeSource"
> & {
  // Each SDK has a different generic Source constraint; cleanup only tests
  // presence, so it does not need either SDK's source implementation type.
  getSource(id: string): unknown;
};

/** Draw a GL search highlight and register its teardown with the owning engine. */
export function showGlSearchResult(
  map: SearchMap,
  geometry: Point | Polygon,
  createMarker: (center: [number, number], color: string) => { remove(): unknown },
  disposers: Set<() => void>,
): () => void {
  const color = SEARCH_HIGHLIGHT_COLOR;
  let remove: () => void;
  if (geometry.type === "Point") {
    const marker = createMarker([geometry.coordinates[0], geometry.coordinates[1]], color);
    remove = () => {
      marker.remove();
    };
  } else {
    if (!map.isStyleLoaded()) return () => {};
    const id = `geolibre-search-${crypto.randomUUID()}`;
    map.addSource(id, { type: "geojson", data: { type: "Feature", properties: {}, geometry } });
    map.addLayer({
      id: id + "-fill",
      type: "fill",
      source: id,
      paint: { "fill-color": color, "fill-opacity": 0.15 },
    });
    map.addLayer({
      id: id + "-line",
      type: "line",
      source: id,
      paint: { "line-color": color, "line-width": 2 },
    });
    remove = () => {
      for (const suffix of ["-line", "-fill"])
        if (map.getLayer(id + suffix)) map.removeLayer(id + suffix);
      if (map.getSource(id)) map.removeSource(id);
    };
  }
  const dispose = () => {
    if (!disposers.delete(dispose)) return;
    remove();
  };
  disposers.add(dispose);
  return dispose;
}
