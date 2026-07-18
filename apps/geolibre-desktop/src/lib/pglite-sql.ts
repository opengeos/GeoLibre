import type { Feature } from "geojson";

// Pure SQL-building helpers for the PGlite + PostGIS workspace. This module has
// no heavy/Vite-only imports (no DuckDB `?url` assets), so it can be unit-tested
// under `node --test` directly. The runtime engine lives in pglite-workspace.ts.

// Geometry column name created on every registered table. PostGIS geometry is
// kept separate from feature properties, so a `geom` collision is rare; when a
// property is already named `geom`, a non-colliding fallback is chosen.
const DEFAULT_GEOMETRY_COLUMN = "geom";

/** Quote a Postgres identifier (double quotes, doubling embedded quotes). */
export function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/** Postgres column type chosen for a flattened GeoJSON property. */
export type PgColumnType = "double precision" | "boolean" | "jsonb" | "text";

/** A property flattened to a Postgres table column. */
export interface PgColumn {
  /** Property key, used verbatim as the column name. */
  name: string;
  /** Inferred Postgres column type. */
  type: PgColumnType;
}

/**
 * Choose a Postgres column type for a single property given every value it takes
 * across a layer's features. The rule favours the most specific type that fits
 * all non-null values: numeric -> double precision, boolean -> boolean, anything
 * containing an object/array -> jsonb, otherwise text. An all-null property
 * defaults to text.
 *
 * @param values Non-null/undefined values are considered; null/undefined skipped.
 * @returns The inferred Postgres column type.
 */
export function classifyColumnType(values: unknown[]): PgColumnType {
  const present = values.filter((value) => value !== null && value !== undefined);
  if (present.length === 0) return "text";
  if (present.some((value) => typeof value === "object")) return "jsonb";
  if (present.every((value) => typeof value === "number" && Number.isFinite(value))) {
    return "double precision";
  }
  if (present.every((value) => typeof value === "boolean")) return "boolean";
  return "text";
}

/**
 * Infer the flattened property columns for a layer's features. Keys are taken in
 * first-seen order across all features so the column order is stable, and each
 * key's type is inferred from every value it takes via {@link classifyColumnType}.
 *
 * @param features GeoJSON features whose `properties` are flattened to columns.
 * @returns The columns in stable order; never includes a geometry column.
 */
export function inferPropertyColumns(features: Feature[]): PgColumn[] {
  const order: string[] = [];
  const valuesByKey = new Map<string, unknown[]>();
  for (const feature of features) {
    const properties = feature.properties;
    if (!properties) continue;
    for (const [key, value] of Object.entries(properties)) {
      let bucket = valuesByKey.get(key);
      if (!bucket) {
        bucket = [];
        valuesByKey.set(key, bucket);
        order.push(key);
      }
      bucket.push(value);
    }
  }
  return order.map((name) => ({
    name,
    type: classifyColumnType(valuesByKey.get(name) ?? []),
  }));
}

/**
 * Pick a geometry column name that does not collide with any property column.
 * Prefers `geom`, then `geometry`, then `geom_2`, `geom_3`, ... so the generated
 * tables use a predictable, query-friendly name in the common (no-collision) case.
 *
 * @param propertyNames Names already used by flattened property columns.
 * @returns A geometry column name guaranteed not to be in `propertyNames`.
 */
export function pickGeometryColumnName(propertyNames: Iterable<string>): string {
  const used = new Set(propertyNames);
  if (!used.has(DEFAULT_GEOMETRY_COLUMN)) return DEFAULT_GEOMETRY_COLUMN;
  if (!used.has("geometry")) return "geometry";
  let suffix = 2;
  while (used.has(`${DEFAULT_GEOMETRY_COLUMN}_${suffix}`)) suffix += 1;
  return `${DEFAULT_GEOMETRY_COLUMN}_${suffix}`;
}

/**
 * Build the `CREATE TABLE` statement for a registered layer: one column per
 * inferred property plus a `geometry(Geometry, 4326)` geometry column.
 *
 * @param qualifiedTable Schema-qualified, already-quoted table name.
 * @param columns Inferred property columns.
 * @param geometryColumn Name of the geometry column to append.
 * @returns A single `CREATE TABLE` SQL statement.
 */
export function buildCreateTableStatement(
  qualifiedTable: string,
  columns: PgColumn[],
  geometryColumn: string,
): string {
  const columnDefs = columns.map((column) => `${quoteIdentifier(column.name)} ${column.type}`);
  columnDefs.push(`${quoteIdentifier(geometryColumn)} geometry(Geometry, 4326)`);
  return `CREATE TABLE ${qualifiedTable} (${columnDefs.join(", ")})`;
}

/** Coerce a property value into a bind parameter matching its column type. */
function toBindValue(value: unknown, type: PgColumnType): unknown {
  if (value === null || value === undefined) return null;
  if (type === "jsonb") return JSON.stringify(value);
  if (type === "text") {
    if (typeof value === "string") return value;
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  }
  // double precision / boolean values are already primitives PGlite serializes.
  return value;
}

/**
 * Build one batched, parameterized `INSERT` for a slice of features. Property
 * values bind as plain parameters; the geometry binds through
 * `ST_SetSRID(ST_GeomFromGeoJSON($n), 4326)` so each feature's GeoJSON geometry
 * becomes a 4326 PostGIS geometry (a null geometry yields a null cell).
 *
 * @param qualifiedTable Schema-qualified, already-quoted table name.
 * @param columns Inferred property columns, in insert order.
 * @param geometryColumn Name of the geometry column.
 * @param features Features to insert (one row each).
 * @returns The statement text and its ordered bind parameters.
 */
export function buildInsertChunk(
  qualifiedTable: string,
  columns: PgColumn[],
  geometryColumn: string,
  features: Feature[],
): { text: string; params: unknown[] } {
  const columnList = [
    ...columns.map((column) => quoteIdentifier(column.name)),
    quoteIdentifier(geometryColumn),
  ].join(", ");
  const params: unknown[] = [];
  const rows: string[] = [];
  for (const feature of features) {
    const placeholders: string[] = [];
    const properties = feature.properties ?? {};
    for (const column of columns) {
      params.push(toBindValue(properties[column.name], column.type));
      placeholders.push(`$${params.length}`);
    }
    params.push(feature.geometry ? JSON.stringify(feature.geometry) : null);
    placeholders.push(`ST_SetSRID(ST_GeomFromGeoJSON($${params.length}), 4326)`);
    rows.push(`(${placeholders.join(", ")})`);
  }
  return {
    text: `INSERT INTO ${qualifiedTable} (${columnList}) VALUES ${rows.join(", ")}`,
    params,
  };
}
