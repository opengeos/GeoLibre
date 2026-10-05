import {
  CZML_SOURCE_KIND,
  isDuckDBQueryLayer,
  resolveLayerCapabilities,
  type GeoLibreLayer,
} from "@geolibre/core";
import { geojsonVectorSourceId } from "./vector-export";

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

/**
 * Whether the attribute table keeps this layer read-only. Add Vector Layer
 * layers render from a source the control owns, and their `layer.geojson` is
 * dropped when a project is saved, so edits would neither redraw on the map nor
 * survive a save.
 *
 * @param layer The candidate layer, or undefined.
 * @returns True when the table must not edit the layer's values.
 */
export function isReadOnlyAttributeLayer(layer: GeoLibreLayer | undefined): boolean {
  return geojsonVectorSourceId(layer) !== null || isVectorControlAttributeSource(layer);
}

/**
 * The attribute table's Edit-button gate, shared with Identify's Edit
 * attributes action so the two cannot drift apart (#2932).
 *
 * @param layer The layer shown in the table, or undefined.
 * @param geometryEditLayerId The layer in a geometry-edit session, or null.
 *   Attribute edits would race the editor's write-back, so that layer is out.
 * @returns True when the table may enter edit mode on this layer.
 */
export function canEditAttributeValues(
  layer: GeoLibreLayer | undefined,
  geometryEditLayerId: string | null,
): boolean {
  if (!layer) return false;
  const caps = resolveLayerCapabilities(layer);
  const hasAttributeSource = Boolean((layer.geojson || isDuckDBQueryLayer(layer)) && caps.query);
  return (
    hasAttributeSource &&
    caps.update &&
    !isReadOnlyAttributeLayer(layer) &&
    geometryEditLayerId !== layer.id
  );
}
