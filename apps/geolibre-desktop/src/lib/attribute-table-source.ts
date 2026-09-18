import { isDuckDBQueryLayer, resolveLayerCapabilities, type GeoLibreLayer } from "@geolibre/core";

/** Control-backed tables can return complete features independently of visible tiles. */
export function isVectorControlAttributeSource(layer: GeoLibreLayer | undefined): boolean {
  if (
    !layer ||
    layer.metadata.sourceKind !== "maplibre-gl-vector" ||
    layer.metadata.externalNativeLayer !== true
  )
    return false;
  const state = layer.metadata.vectorState as { ingestMode?: string } | undefined;
  // Streamed GeoParquet has no local table to materialize.
  return state?.ingestMode !== "stream";
}

export function canOpenLayerAttributeTable(layer: GeoLibreLayer | undefined): boolean {
  return Boolean(
    layer &&
    resolveLayerCapabilities(layer).query &&
    (layer.type === "geojson" ||
      isDuckDBQueryLayer(layer) ||
      isVectorControlAttributeSource(layer)),
  );
}
