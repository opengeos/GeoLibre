import type { GeoLibreLayer } from "@geolibre/core";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import type {
  AsyncDuckDB,
  AsyncDuckDBConnection,
} from "@duckdb/duckdb-wasm";
import {
  ensureSpatialExtension,
  getDatabase,
  isGeometryColumnType,
  quoteIdentifier,
  quoteSqlString,
  rowsFromResult,
} from "./duckdb-vector-loader";

// Hidden column appended to the user's query so geometry can be returned as
// GeoJSON for the "Add as layer" / export paths without disturbing the columns
// the user sees in the results grid. This is a reserved name: a user column of
// the same name is filtered out of both the grid and the GeoJSON properties.
const GEOMETRY_JSON_COLUMN = "__geolibre_sql_geometry_geojson";

/** A loaded layer exposed to the workspace as a DuckDB table. */
export interface SqlWorkspaceTable {
  /** SQL identifier the user references in queries. */
  tableName: string;
  /** Human-readable layer name the table was derived from. */
  layerName: string;
}

/** Result of running a single SQL statement in the workspace. */
export interface SqlQueryResult {
  /** Column names in select order (the hidden geometry column is excluded). */
  columns: string[];
  /** Result rows keyed by column name; geometry is rendered as WKT text. */
  rows: Record<string, unknown>[];
  /** Total rows returned (equals `rows.length`). */
  rowCount: number;
  /** Name of the detected GEOMETRY column, or null when the result has none. */
  geometryColumn: string | null;
  /** Result as GeoJSON when a geometry column is present, otherwise null. */
  geojson: FeatureCollection | null;
}

/**
 * Turn a layer name into a valid, lower-case SQL identifier. Non-alphanumeric
 * runs collapse to underscores and a leading digit is prefixed so the result is
 * always a usable bare identifier; an empty result falls back to `layer_<id>`.
 */
function sanitizeTableName(layerName: string, layerId: string): string {
  const base = layerName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  // Keep `normalized` empty when `base` is empty so the layer_<id> fallback is
  // reached; prefixing an empty base would yield "t_" and bypass the fallback.
  const normalized = base ? (/^[a-z_]/.test(base) ? base : `t_${base}`) : "";
  return normalized || `layer_${layerId.replace(/[^a-z0-9]+/gi, "_")}`;
}

/**
 * Assign a unique table name to each layer that carries an in-memory GeoJSON
 * FeatureCollection. Names are derived from layer names and de-duplicated with a
 * numeric suffix on collision. Shared by registration and the UI preview so the
 * names cannot drift.
 */
function assignTableNames(
  layers: GeoLibreLayer[],
): Array<{ layer: GeoLibreLayer; tableName: string }> {
  const assigned: Array<{ layer: GeoLibreLayer; tableName: string }> = [];
  const usedNames = new Set<string>();
  for (const layer of layers) {
    if (!layer.geojson) continue;
    const baseName = sanitizeTableName(layer.name, layer.id);
    let tableName = baseName;
    let suffix = 2;
    while (usedNames.has(tableName)) {
      tableName = `${baseName}_${suffix}`;
      suffix += 1;
    }
    usedNames.add(tableName);
    assigned.push({ layer, tableName });
  }
  return assigned;
}

/**
 * Compute the table names the workspace will expose for the given layers,
 * without touching DuckDB, so the UI can show queryable table names before a
 * query runs.
 *
 * @param layers Current app layers; those without `geojson` are skipped.
 * @returns The tables, in the same order and naming as registration.
 */
export function previewLayerTables(
  layers: GeoLibreLayer[],
): SqlWorkspaceTable[] {
  return assignTableNames(layers).map(({ layer, tableName }) => ({
    tableName,
    layerName: layer.name,
  }));
}

/**
 * Register every loaded layer that carries an in-memory GeoJSON FeatureCollection
 * as a DuckDB table, so user SQL can query the current map data by layer name.
 *
 * Tables are created TEMPORARY so they are scoped to the caller's connection and
 * dropped when it closes. Each query therefore starts from a clean set built
 * from the current layers, which keeps the tables in sync with edits and avoids
 * leaking tables for layers that were since removed.
 *
 * @param db Shared DuckDB-WASM database instance.
 * @param connection Open connection used to create the tables.
 * @param layers Current app layers; those without `geojson` are skipped.
 * @returns The registered tables in registration order.
 */
export async function registerLayerTables(
  db: AsyncDuckDB,
  connection: AsyncDuckDBConnection,
  layers: GeoLibreLayer[],
): Promise<SqlWorkspaceTable[]> {
  const registered: SqlWorkspaceTable[] = [];

  for (const { layer, tableName } of assignTableNames(layers)) {
    const fileName = `${tableName}.geojson`;
    await db.registerFileText(fileName, JSON.stringify(layer.geojson));
    await connection.query(
      `CREATE OR REPLACE TEMP TABLE ${quoteIdentifier(tableName)} AS ` +
        `SELECT * FROM ST_Read(${quoteSqlString(fileName)})`,
    );
    registered.push({ tableName, layerName: layer.name });
  }

  return registered;
}

/** Read the column names from a DuckDB-WASM Arrow result, even when empty. */
function columnNamesFromResult(result: {
  schema?: { fields?: ReadonlyArray<{ name: string }> };
}): string[] {
  return result.schema?.fields?.map((field) => field.name) ?? [];
}

/**
 * Normalise a DuckDB cell value into something JSON/CSV friendly. Recurses into
 * arrays (LIST) and objects (STRUCT) so nested bigint/Date values are coerced,
 * matching the loader's `normalizePropertyValue`; otherwise a nested bigint
 * would make `JSON.stringify` throw during CSV/GeoJSON export.
 */
function normalizeValue(value: unknown): unknown {
  if (typeof value === "bigint") {
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return `[binary ${value.length} bytes]`;
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, normalizeValue(item)]),
    );
  }
  return value;
}

function normalizeRow(
  row: Record<string, unknown>,
  columns: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const column of columns) {
    out[column] = normalizeValue(row[column]);
  }
  return out;
}

/** Find the first GEOMETRY-typed column in the user's query, if any. */
async function detectGeometryColumn(
  connection: AsyncDuckDBConnection,
  sql: string,
): Promise<string | null> {
  try {
    const described = rowsFromResult(await connection.query(`DESCRIBE ${sql}`));
    const match = described.find((row) =>
      isGeometryColumnType(row.column_type),
    )?.column_name;
    return typeof match === "string" ? match : null;
  } catch {
    // DESCRIBE fails for DDL or multi-statement input; those have no geometry.
    return null;
  }
}

function rowsToFeatureCollection(
  rows: Record<string, unknown>[],
  geometryColumn: string,
): FeatureCollection {
  const features = rows.map((row) => {
    const rawGeometry = row[GEOMETRY_JSON_COLUMN];
    // Parse defensively: a single malformed geometry string should drop that
    // one feature's geometry, not abort the whole result set.
    let geometry: Geometry | null = null;
    if (typeof rawGeometry === "string") {
      try {
        geometry = JSON.parse(rawGeometry) as Geometry;
      } catch {
        geometry = null;
      }
    }
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (key === GEOMETRY_JSON_COLUMN || key === geometryColumn) continue;
      if (value instanceof Uint8Array) continue;
      properties[key] = normalizeValue(value);
    }
    return {
      type: "Feature",
      geometry,
      properties,
    } satisfies Feature<Geometry | null>;
  });

  // GeoJSON Features may legally have a null geometry; the app's layer model
  // treats them as a regular FeatureCollection and the map ignores nulls.
  return { type: "FeatureCollection", features } as FeatureCollection;
}

/**
 * Run a single SQL statement against the shared DuckDB instance with the spatial
 * extension loaded and all GeoJSON-backed layers registered as tables.
 *
 * When the result has a GEOMETRY column, geometry is rendered as WKT in the grid
 * rows and a GeoJSON FeatureCollection is built for the add-as-layer and export
 * paths. Coordinates are assumed to be WGS84 (EPSG:4326); reprojection is not
 * applied here.
 *
 * @param sql The SQL statement to execute.
 * @param layers Current app layers exposed as queryable tables.
 * @returns Columns, rows, row count, geometry column name, and GeoJSON result.
 * @throws Whatever DuckDB throws for invalid SQL (surfaced to the caller).
 */
export async function runSqlQuery(
  sql: string,
  layers: GeoLibreLayer[],
): Promise<SqlQueryResult> {
  // A trailing semicolon is valid as a standalone statement but breaks the
  // geometry-detection wrapper `... FROM (<sql>) AS ...`, so strip it once.
  const statement = sql.trim().replace(/;\s*$/, "");

  const db = await getDatabase();
  const connection = await db.connect();
  let registeredFiles: string[] = [];

  try {
    await ensureSpatialExtension(connection);
    // Pre-compute the file names from the same naming logic so the finally
    // block can clean up even if registration throws part-way through the loop.
    registeredFiles = previewLayerTables(layers).map(
      (table) => `${table.tableName}.geojson`,
    );
    await registerLayerTables(db, connection, layers);

    const geometryColumn = await detectGeometryColumn(connection, statement);

    if (geometryColumn) {
      const geomId = quoteIdentifier(geometryColumn);
      const hiddenId = quoteIdentifier(GEOMETRY_JSON_COLUMN);
      const result = await connection.query(
        `SELECT * REPLACE (ST_AsText(${geomId}) AS ${geomId}), ` +
          `ST_AsGeoJSON(${geomId}) AS ${hiddenId} ` +
          `FROM (${statement}) AS __geolibre_sql_query`,
      );
      const allColumns = columnNamesFromResult(result);
      const columns = allColumns.filter(
        (column) => column !== GEOMETRY_JSON_COLUMN,
      );
      const rawRows = rowsFromResult(result);
      const geojson = rowsToFeatureCollection(rawRows, geometryColumn);
      const rows = rawRows.map((row) => normalizeRow(row, columns));
      return {
        columns,
        rows,
        rowCount: rows.length,
        geometryColumn,
        geojson,
      };
    }

    const result = await connection.query(statement);
    const columns = columnNamesFromResult(result);
    const rows = rowsFromResult(result).map((row) =>
      normalizeRow(row, columns),
    );
    return {
      columns,
      rows,
      rowCount: rows.length,
      geometryColumn: null,
      geojson: null,
    };
  } finally {
    await connection.close();
    // The table data is materialised by CREATE TABLE, so the registered GeoJSON
    // files are no longer needed; drop them to free DuckDB's in-memory VFS.
    if (registeredFiles.length > 0) {
      try {
        await db.dropFiles(registeredFiles);
      } catch {
        // Files may already be gone; cleanup is best-effort.
      }
    }
  }
}

/** Serialise result rows to CSV text, quoting per RFC 4180. */
export function resultToCsv(
  columns: string[],
  rows: Record<string, unknown>[],
): string {
  const escape = (value: unknown): string => {
    if (value === null || value === undefined) return "";
    const text =
      typeof value === "object" ? JSON.stringify(value) : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const lines = [columns.map(escape).join(",")];
  for (const row of rows) {
    lines.push(columns.map((column) => escape(row[column])).join(","));
  }
  // RFC 4180 specifies CRLF line endings for the broadest spreadsheet support.
  return lines.join("\r\n");
}
