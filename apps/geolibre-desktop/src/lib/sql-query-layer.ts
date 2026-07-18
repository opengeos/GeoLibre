import type { FeatureCollection } from "geojson";
import { SQL_QUERY_SOURCE_KIND, type GeoLibreLayer } from "@geolibre/core";

/**
 * Live SQL query layers (issue #1295): GeoJSON-backed layers whose features are
 * the result of a DuckDB SQL statement from the SQL Workspace. The statement is
 * stored on the layer's metadata so the layer can be re-executed (refreshed)
 * against the current layers at any time, while the last result is embedded as
 * a regular GeoJSON snapshot so the layer renders instantly on project load.
 *
 * Module-level imports are deliberately light (types only): the DuckDB-WASM
 * engine behind `runSqlQuery` cannot load under the node test runner, so
 * {@link refreshSqlQueryLayer} pulls it in with a dynamic import instead.
 */

// Re-exported so app-local callers and tests can keep importing the source
// kind from this module alongside the query-layer helpers.
export { SQL_QUERY_SOURCE_KIND };

/** The persisted query definition carried on a query layer's metadata. */
export interface SqlQueryLayerConfig {
  /** SQL engine the statement targets; only DuckDB is supported today. */
  engine: "duckdb";
  /** The SQL statement re-executed on refresh. */
  sql: string;
}

/**
 * Build the metadata for a new SQL query layer.
 *
 * @param sql The DuckDB SQL statement that produced the layer's features.
 * @returns Metadata carrying the source kind tag and the query definition.
 */
export function sqlQueryLayerMetadata(sql: string): Record<string, unknown> {
  return {
    sourceKind: SQL_QUERY_SOURCE_KIND,
    sqlQuery: { engine: "duckdb", sql },
  };
}

/**
 * Read and validate the query definition from a layer's metadata.
 *
 * Tolerates hand-edited project files: a missing/blank statement or an unknown
 * engine yields null (the layer then behaves as a plain GeoJSON layer) rather
 * than a refresh that would fail confusingly later.
 *
 * @param layer The candidate layer (only `metadata` is inspected).
 * @returns The validated config, or null when the layer is not a query layer.
 */
export function getSqlQueryLayerConfig(
  layer: Pick<GeoLibreLayer, "metadata">,
): SqlQueryLayerConfig | null {
  if (layer.metadata.sourceKind !== SQL_QUERY_SOURCE_KIND) return null;
  const candidate = layer.metadata.sqlQuery;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }
  const { engine, sql } = candidate as { engine?: unknown; sql?: unknown };
  if (engine !== "duckdb") return null;
  if (typeof sql !== "string" || sql.trim() === "") return null;
  return { engine, sql };
}

/**
 * True when the layer is a refreshable SQL query layer: a GeoJSON-backed layer
 * carrying a valid query definition.
 *
 * @param layer The candidate layer.
 * @returns Whether the layer refreshes by re-executing its SQL.
 */
export function isSqlQueryLayer(layer: Pick<GeoLibreLayer, "metadata" | "type">): boolean {
  return layer.type === "geojson" && getSqlQueryLayerConfig(layer) !== null;
}

/**
 * The layers a query layer's SQL runs against: every layer except the query
 * layer itself. Excluding it keeps its own table registration from stealing a
 * source layer's table name (names are deduplicated with numeric suffixes in
 * layer order, so a query layer whose name collides with a source's could
 * otherwise shift the very table its SQL references).
 *
 * @param layer The query layer being refreshed.
 * @param layers The current app layers.
 * @returns The layers to expose as queryable tables.
 */
export function sourceLayersForQueryRefresh(
  layer: Pick<GeoLibreLayer, "id">,
  layers: GeoLibreLayer[],
): GeoLibreLayer[] {
  return layers.filter((candidate) => candidate.id !== layer.id);
}

/**
 * Re-execute a query layer's SQL against the current layers and return the new
 * feature snapshot.
 *
 * Tables are bound by *name* at refresh time, mirroring the SQL Workspace's
 * model: the statement references table names derived from the current layer
 * names (deduplicated in layer order). Renaming, removing, or reordering
 * same-named source layers between runs can therefore rebind a referenced
 * table — usually surfacing as a catalog error on the layer, but with
 * colliding names potentially to a different layer. Storing stable layer-id
 * references instead is a possible future hardening.
 *
 * @param layer The query layer to refresh.
 * @param layers The current app layers (the query layer itself is excluded).
 * @returns The refreshed features and their count.
 * @throws When the layer carries no valid query definition, the SQL fails
 *   (DuckDB's message is surfaced as-is), or the result no longer has a
 *   geometry column (e.g. after a source schema change).
 */
export async function refreshSqlQueryLayer(
  layer: GeoLibreLayer,
  layers: GeoLibreLayer[],
): Promise<{ geojson: FeatureCollection; featureCount: number }> {
  const config = getSqlQueryLayerConfig(layer);
  if (!config) {
    throw new Error("This layer does not carry a SQL query definition.");
  }
  // Deferred so this module stays importable without the DuckDB-WASM bundle.
  const { runSqlQuery } = await import("./sql-workspace");
  const result = await runSqlQuery(config.sql, sourceLayersForQueryRefresh(layer, layers));
  if (!result.geojson) {
    throw new Error(
      "The query result no longer has a geometry column. Edit the query in the SQL Workspace.",
    );
  }
  return {
    geojson: result.geojson,
    featureCount: result.geojson.features.length,
  };
}
