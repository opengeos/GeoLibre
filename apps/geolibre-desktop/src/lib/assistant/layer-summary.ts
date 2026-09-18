import type { GeoLibreLayer } from "@geolibre/core";
import { inferPropertyColumns } from "../pglite-sql";
import { assignTableNames } from "../sql-table-names";

/** A short, model-facing description of one layer (no feature data leaked). */
export interface LayerSummary {
  id: string;
  name: string;
  type: string;
  geometryType: string | null;
  featureCount: number;
  fields: { name: string; type: string }[];
  /**
   * The table name `run_sql` exposes this layer as, or null when the layer has
   * no in-memory GeoJSON (tile, raster and service layers are not queryable).
   */
  sqlTable: string | null;
}

/** Detect a layer's geometry family from its first feature. */
function geometryTypeOf(layer: GeoLibreLayer): string | null {
  return layer.geojson?.features?.[0]?.geometry?.type ?? null;
}

/** Summarize a layer's identity and schema without exposing row data. */
function summarizeLayer(layer: GeoLibreLayer, sqlTable: string | null): LayerSummary {
  const features = layer.geojson?.features ?? [];
  return {
    id: layer.id,
    name: layer.name,
    type: layer.type,
    geometryType: geometryTypeOf(layer),
    featureCount: features.length,
    fields: features.length
      ? inferPropertyColumns(features).map((column) => ({
          name: column.name,
          type: column.type,
        }))
      : [],
    sqlTable,
  };
}

/**
 * Summarize every layer, pairing each with the SQL table name the workspace
 * registers it under. Table names are looked up by layer id rather than array
 * position: `assignTableNames` skips layers without GeoJSON (vector-tile,
 * raster, XYZ), so positional alignment would report a later GeoJSON layer
 * against the wrong table (or none at all).
 *
 * @param layers Current app layers, in store order.
 * @returns One summary per layer, in the same order.
 */
export function summarizeLayers(layers: GeoLibreLayer[]): LayerSummary[] {
  const tableByLayerId = new Map(
    assignTableNames(layers).map(({ layer, tableName }) => [layer.id, tableName]),
  );
  return layers.map((layer) => summarizeLayer(layer, tableByLayerId.get(layer.id) ?? null));
}

/**
 * Build a compact, model-facing description of the current layers and the SQL
 * table names they map to. Used to seed the agent's conversation context with
 * names and schemas only, never full datasets.
 */
export function describeLayers(layers: GeoLibreLayer[]): string {
  if (layers.length === 0) return "No layers are currently loaded.";
  return summarizeLayers(layers)
    .map((summary) => {
      const fields = summary.fields.map((field) => `${field.name}:${field.type}`).join(", ");
      return [
        `- "${summary.name}" (${summary.type}`,
        summary.geometryType ? `, ${summary.geometryType}` : "",
        `, ${summary.featureCount} features`,
        summary.sqlTable ? `, SQL table ${summary.sqlTable}` : "",
        `)`,
        fields ? ` fields: ${fields}` : "",
      ].join("");
    })
    .join("\n");
}
