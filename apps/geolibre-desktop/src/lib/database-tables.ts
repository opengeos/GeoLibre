import type { GeoLibreLayer } from "@geolibre/core";
import type { FeatureCollection } from "geojson";

export interface DatabaseTableIdentity {
  schema: string;
  table: string;
}

/** Collision-safe identity; dots inside schema or table names remain distinct. */
export function databaseTableKey(table: DatabaseTableIdentity): string {
  return JSON.stringify([table.schema, table.table]);
}

/** Human-readable qualified name for display, not an identity key. */
export function databaseTableLabel(table: DatabaseTableIdentity): string {
  return `${table.schema}.${table.table}`;
}

/** First occurrence of each schema/table pair, in input order (keyed by databaseTableKey, so dotted identifiers stay distinct). */
export function uniqueDatabaseTables<T extends DatabaseTableIdentity>(tables: readonly T[]): T[] {
  const seen = new Set<string>();
  return tables.filter((table) => {
    const key = databaseTableKey(table);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The primary-key values carried by a freshly read FeatureCollection. */
export function databaseFeatureKeys(geojson: FeatureCollection): Array<string | number> {
  return geojson.features
    .map((feature) => feature.id)
    .filter((id): id is string | number => typeof id === "string" || typeof id === "number");
}

/** Read a PostGIS or SQL Server baseline-key array from layer metadata. */
export function databaseBaselineKeys(
  layer: GeoLibreLayer,
  metadataKey: "postgisBaselineKeys" | "mssqlBaselineKeys",
): Array<string | number> | undefined {
  const keys = layer.metadata?.[metadataKey];
  if (!Array.isArray(keys)) return undefined;
  return keys.filter(
    (key): key is string | number => typeof key === "string" || typeof key === "number",
  );
}
