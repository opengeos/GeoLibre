import {
  CZML_SOURCE_KIND,
  isDuckDBQueryLayer,
  resolveLayerCapabilities,
  type GeoLibreLayer,
} from "@geolibre/core";

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
      // A CZML layer carries a complete, materialized GeoJSON row model solely
      // for the table: its entities move, so they have no stored geometry, but
      // their attributes are still queryable. Named rather than inferred from a
      // truthy `geojson`, so a future layer that stashes one for its own
      // reasons does not quietly acquire an Attribute Table.
      (layer.metadata.sourceKind === CZML_SOURCE_KIND && Boolean(layer.geojson)) ||
      isDuckDBQueryLayer(layer) ||
      isVectorControlAttributeSource(layer)),
  );
}
