import type { GeoLibreLayer } from "@geolibre/core";
import type { MapLayerPort } from "@geolibre/map";
import type { FeatureCollection } from "geojson";

/**
 * Read a layer's feature collection without weakening store authority. Inline
 * store data always wins; the engine is consulted only when the store carries
 * no collection, and the returned snapshot is never written back here.
 */
export async function readLayerFeatureCollection(
  layer: GeoLibreLayer,
  layers: MapLayerPort | undefined,
): Promise<FeatureCollection | null> {
  if (layer.geojson) return layer.geojson;
  return (await layers?.readGeoJson(layer.id)) ?? null;
}
