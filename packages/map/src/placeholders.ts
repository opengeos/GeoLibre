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
  if (
    Array.isArray(layer.metadata.nativeLayerIds) &&
    layer.metadata.nativeLayerIds.length > 0
  ) {
    return false;
  }

  if (layer.metadata.externalDeckLayer === true) return false;

  return (
    PLACEHOLDER_LAYER_TYPES.has(layer.type) ||
    layer.metadata.placeholder === true
  );
}

export function placeholderMessage(layer: GeoLibreLayer): string {
  switch (layer.type) {
    case "pmtiles":
      // TODO(v0.3): PMTiles — see docs/roadmap.md
      return "PMTiles support planned for v0.3";
    case "cog":
      // TODO(v0.3): Cloud Optimized GeoTIFF
      return "COG support planned for v0.3";
    case "flatgeobuf":
      // TODO(v0.3): FlatGeobuf streaming
      return "FlatGeobuf support planned for v0.3";
    case "geoparquet":
      // TODO(v0.3): GeoParquet via DuckDB or parquet-wasm
      return "GeoParquet support planned for v0.3";
    case "duckdb-query":
      // TODO(v0.4): DuckDB Spatial query results as layers
      return "DuckDB query layers planned for v0.4";
    default:
      return "Layer type not yet implemented";
  }
}
