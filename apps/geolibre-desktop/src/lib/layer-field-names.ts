import type { GeoLibreLayer } from "@geolibre/core";

/** Features sampled per layer: GeoJSON is schemaless, and a full scan of a large layer would run on the React commit path. */
export const FIELD_SCAN_SAMPLE = 1000;

/**
 * Attribute-column names per in-memory GeoJSON layer, for field pickers.
 *
 * Only `geojson` layers carry their features in the store; any other layer is
 * absent from the map, so a picker reading it offers nothing rather than a
 * wrong list.
 *
 * @param layers The project layers.
 * @param sample How many features to scan per layer.
 * @returns Column names keyed by layer id, in first-seen order.
 */
export function fieldNamesByLayer(
  layers: readonly GeoLibreLayer[],
  sample: number = FIELD_SCAN_SAMPLE,
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const layer of layers) {
    if (layer.type !== "geojson" || !layer.geojson) continue;
    const keys = new Set<string>();
    for (const feature of layer.geojson.features.slice(0, sample)) {
      for (const key of Object.keys(feature.properties ?? {})) keys.add(key);
    }
    map.set(layer.id, [...keys]);
  }
  return map;
}
