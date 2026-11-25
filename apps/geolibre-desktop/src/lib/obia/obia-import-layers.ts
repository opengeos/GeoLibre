import { createLayerSliceSelector, type GeoLibreLayer } from "@geolibre/core";
import { polygonsOf } from "./obia-import";

/** The fields of a vector layer the import pickers list and read. */
export type ImportVectorLayer = Pick<GeoLibreLayer, "id" | "name" | "geojson">;

/**
 * Vector layers with features in memory, other than OBIA objects layers, as
 * the `{ id, name, geojson }` the pickers read, so restyling a layer does not
 * re-render the panel.
 */
export const selectImportVectorLayers = () =>
  createLayerSliceSelector((layer): ImportVectorLayer | null =>
    layer.geojson && layer.metadata.obiaRole !== "objects"
      ? { id: layer.id, name: layer.name, geojson: layer.geojson }
      : null,
  );

/** Whether a layer has a polygon feature (stops at the first). */
export function hasPolygons(layer: ImportVectorLayer): boolean {
  return (layer.geojson?.features ?? []).some((f) => polygonsOf(f.geometry).length > 0);
}

/** Property names of a layer's first features. */
export function fieldsOf(layer: ImportVectorLayer | undefined): string[] {
  const names = new Set<string>();
  for (const feature of layer?.geojson?.features.slice(0, 50) ?? []) {
    for (const key of Object.keys(feature.properties ?? {})) names.add(key);
  }
  return [...names];
}
