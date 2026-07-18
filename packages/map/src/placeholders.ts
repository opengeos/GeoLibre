import type { GeoLibreLayer } from "@geolibre/core";

/** Placeholder layer types — no MapLibre source is added until implemented. */
export const PLACEHOLDER_LAYER_TYPES = new Set([
  "pmtiles",
  "cog",
  "flatgeobuf",
  "geoparquet",
  "duckdb-query",
]);

export function isPlaceholderLayer(layer: GeoLibreLayer): boolean {
  if (Array.isArray(layer.metadata.nativeLayerIds) && layer.metadata.nativeLayerIds.length > 0) {
    return false;
  }

  if (layer.metadata.externalDeckLayer === true) return false;

  return PLACEHOLDER_LAYER_TYPES.has(layer.type) || layer.metadata.placeholder === true;
}

export function placeholderMessage(layer: GeoLibreLayer): string {
  switch (layer.type) {
    // PMTiles, COG, FlatGeobuf, and GeoParquet now render natively (each creates
    // its own `nativeLayerIds`, which short-circuits isPlaceholderLayer above).
    // Reaching this branch therefore means native layer creation did not happen
    // for this layer, not that the format is unimplemented.
    case "pmtiles":
      return "This PMTiles layer could not be displayed.";
    case "cog":
      return "This COG layer could not be displayed.";
    case "flatgeobuf":
      return "This FlatGeobuf layer could not be displayed.";
    case "geoparquet":
      return "This GeoParquet layer could not be displayed.";
    case "duckdb-query":
      // TODO(v0.4): DuckDB Spatial query results as layers
      return "DuckDB query layers planned for v0.4";
    default:
      return "Layer type not yet implemented";
  }
}
