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
  /** Whether the layer is currently shown on the map. */
  visible: boolean;
  /** Current layer opacity, 0-1. */
  opacity: number;
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
    visible: layer.visible,
    opacity: layer.opacity,
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
        // Current display state, so a follow-up turn can reason about a change
        // it did not make itself. The fast path executes without going through
        // the agent, so its actions never enter the model's conversation
        // history; re-sending state the model can see keeps "undo that" and
        // "why is it hidden?" answerable. Only stated when it is not the
        // default, to keep the context short for the common case. Only an
        // explicit `false` counts as hidden: a layer that never set the field
        // is shown, and must not be reported to the model as hidden.
        summary.visible === false ? ", hidden" : "",
        typeof summary.opacity === "number" && summary.opacity < 1
          ? `, opacity ${summary.opacity}`
          : "",
        `)`,
        fields ? ` fields: ${fields}` : "",
      ].join("");
    })
    .join("\n");
}
