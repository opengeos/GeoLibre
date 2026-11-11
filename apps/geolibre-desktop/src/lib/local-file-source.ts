import type { GeoLibreLayer } from "@geolibre/core";

/**
 * The table of a multi-layer file a layer reads, or "" for the file's first.
 * Set by the QGIS importer for a GeoPackage (`file.gpkg|layername=roads`).
 *
 * @param layer - A store layer.
 * @returns The `metadata.sourceLayer` name, trimmed.
 */
export function localFileSourceLayer(layer: Pick<GeoLibreLayer, "metadata">): string {
  const value = layer.metadata.sourceLayer;
  return typeof value === "string" ? value.trim() : "";
}
