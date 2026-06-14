import type { GeoLibreLayer } from "@geolibre/core";
import { fetchSqlStatus, runSedonaSql } from "@geolibre/processing";
import type { FeatureCollection } from "geojson";
import { tableFromIPC } from "apache-arrow";
import { loadCereusDb, type CereusInstance } from "./cereus-loader";
import {
  assignTableNames,
  cleanStatement,
  containsMultipleStatements,
  GEOMETRY_JSON_COLUMN,
  normalizeRow,
  rowsToFeatureCollection,
  type SqlQueryResult,
  type SqlWorkspaceTable,
} from "./sql-workspace";

// Reserved alias wrapping the user's statement when geometry is detected; kept
// deliberately obscure so it does not collide with a user's own CTE/subquery.
const SQL_SUBQUERY_ALIAS = "__geolibre_sql_subquery";

// Geometry column names recognised by the CereusDB engine when the Arrow schema
// carries no GeoArrow extension metadata (the heuristic fallback). The sidecar
// engine and `registerGeoJSON` both name the column `geometry`; `geom` is the
// alias used throughout the workspace's sample queries.
const GEOMETRY_COLUMN_NAMES = new Set([
  "geometry",
  "geom",
  "the_geom",
  "wkb_geometry",
  "geometry_wkb",
]);

/** Quote a SQL identifier for the DataFusion/Sedona dialect (double quotes). */
function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

// ---------------------------------------------------------------------------
// CereusDB (in-browser WASM) engine
// ---------------------------------------------------------------------------

// Memoized singleton: the large CereusDB WASM bundle loads only on first use.
let dbPromise: Promise<CereusInstance> | null = null;

function getDb(): Promise<CereusInstance> {
  if (!dbPromise) {
    dbPromise = loadCereusDb().catch((err) => {
      // Reset so a failed load (e.g. an aborted WASM fetch) can be retried.
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

// CereusDB executes on a single instance; chain whole register+run operations so
// concurrent dialog runs cannot interleave table resets. Mirrors the PGlite
// engine's exclusivity queue.
let queue: Promise<unknown> = Promise.resolve();

function runExclusive<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task, task);
  queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * Drop every previously registered table, then register each layer that carries
 * an in-memory GeoJSON FeatureCollection as a table, so user SQL can reference
 * the current map data by layer name. Rebuilding on each run keeps the tables in
 * sync with edits and drops tables for layers that were since removed.
 */
function registerLayerTables(
  db: CereusInstance,
  layers: GeoLibreLayer[],
): SqlWorkspaceTable[] {
  for (const name of db.tables()) {
    try {
      db.dropTable(name);
    } catch {
      // Best-effort cleanup; a table that cannot be dropped is harmless here.
    }
  }
  const registered: SqlWorkspaceTable[] = [];
  for (const { layer, tableName } of assignTableNames(layers)) {
    db.registerGeoJSON(tableName, layer.geojson as object);
    registered.push({ tableName, layerName: layer.name });
  }
  return registered;
}

interface DescribedQuery {
  columnNames: string[];
  geometryColumn: string | null;
}

/**
 * Describe the user's statement to learn its result columns and find the
 * geometry column. The statement is wrapped in `SELECT * FROM (...) LIMIT 0` so
 * the probe works for CTE/UNION queries and returns the schema even when the
 * result is empty. The geometry column is detected from the Arrow schema's
 * GeoArrow extension metadata, falling back to a column-name heuristic. Returns
 * null when the statement cannot be described as a query (e.g. DDL).
 */
async function describeQuery(
  db: CereusInstance,
  statement: string,
): Promise<DescribedQuery | null> {
  try {
    const ipc = await db.sql(
      `SELECT * FROM (${statement}) AS ${quoteIdentifier(SQL_SUBQUERY_ALIAS)} LIMIT 0`,
    );
    const fields = tableFromIPC(ipc).schema.fields;
    const columnNames = fields.map((field) => String(field.name));
    const byExtension = fields.find((field) => {
      const ext = field.metadata?.get?.("ARROW:extension:name");
      return typeof ext === "string" && ext.toLowerCase().startsWith("geoarrow");
    })?.name;
    const geometryColumn =
      byExtension ??
      columnNames.find((name) => GEOMETRY_COLUMN_NAMES.has(name.toLowerCase())) ??
      null;
    return {
      columnNames,
      geometryColumn: geometryColumn === undefined ? null : String(geometryColumn),
    };
  } catch {
    return null;
  }
}

/**
 * Run a single statement against the in-browser CereusDB engine with every
 * GeoJSON-backed layer registered as a table.
 *
 * When the result has a geometry column, geometry is rendered as WKT in the grid
 * rows and a GeoJSON FeatureCollection is built (via `ST_AsGeoJSON`) for the
 * add-as-layer and export paths. Coordinates are assumed/declared as WGS84
 * (EPSG:4326). The returned shape matches {@link SqlQueryResult} so the dialog
 * renders this engine identically to DuckDB and PostGIS.
 */
async function runCereusQuery(
  statement: string,
  layers: GeoLibreLayer[],
): Promise<SqlQueryResult> {
  return runExclusive(async () => {
    const db = await getDb();
    registerLayerTables(db, layers);

    const described = await describeQuery(db, statement);
    const geometryColumn = described?.geometryColumn ?? null;

    if (described && geometryColumn) {
      const sub = quoteIdentifier(SQL_SUBQUERY_ALIAS);
      const geomId = quoteIdentifier(geometryColumn);
      const hiddenId = quoteIdentifier(GEOMETRY_JSON_COLUMN);
      // Pass each column through, but render the geometry column as WKT text for
      // the grid and append the hidden GeoJSON column for the layer/export path.
      const projection = described.columnNames
        .filter((name) => name !== GEOMETRY_JSON_COLUMN)
        .map((name) => {
          const id = quoteIdentifier(name);
          return name === geometryColumn
            ? `ST_AsText(${sub}.${geomId}) AS ${geomId}`
            : `${sub}.${id} AS ${id}`;
        });
      projection.push(`ST_AsGeoJSON(${sub}.${geomId}) AS ${hiddenId}`);
      const queryRows = await db.sqlJSON(
        `SELECT ${projection.join(", ")} FROM (${statement}) AS ${sub}`,
      );
      const columns = described.columnNames.filter(
        (name) => name !== GEOMETRY_JSON_COLUMN,
      );
      const geojson = rowsToFeatureCollection(queryRows, geometryColumn);
      const rows = queryRows.map((row) => normalizeRow(row, columns));
      return {
        columns,
        rows,
        rowCount: rows.length,
        geometryColumn,
        geojson,
      } satisfies SqlQueryResult;
    }

    const queryRows = await db.sqlJSON(statement);
    const columns =
      described?.columnNames ??
      (queryRows[0] ? Object.keys(queryRows[0]) : []);
    const rows = queryRows.map((row) => normalizeRow(row, columns));
    return {
      columns,
      rows,
      rowCount: rows.length,
      geometryColumn: null,
      geojson: null,
    } satisfies SqlQueryResult;
  });
}

// ---------------------------------------------------------------------------
// SedonaDB (Python sidecar) engine
// ---------------------------------------------------------------------------

/** Run a statement via the SedonaDB sidecar and map it to {@link SqlQueryResult}. */
async function runSidecarQuery(
  statement: string,
  layers: GeoLibreLayer[],
): Promise<SqlQueryResult> {
  // Send the same sanitised table names the workspace shows the user, so SQL
  // written against the "Queryable layers" names resolves on the sidecar too.
  const payloadLayers = assignTableNames(layers).map(({ layer, tableName }) => ({
    name: tableName,
    geojson: layer.geojson as FeatureCollection,
  }));
  const result = await runSedonaSql({ sql: statement, layers: payloadLayers });
  return {
    columns: result.columns,
    rows: result.rows,
    rowCount: result.rows.length,
    geometryColumn: result.geometry_column ?? null,
    geojson: (result.geojson as FeatureCollection | null) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Engine routing
// ---------------------------------------------------------------------------

/** Probe the SedonaDB sidecar; treat any connection failure as unavailable. */
async function sidecarSqlAvailable(): Promise<boolean> {
  try {
    return (await fetchSqlStatus()).available;
  } catch {
    return false;
  }
}

/**
 * Run a single statement with the Apache Sedona engine.
 *
 * Both backends speak Sedona's spatial-SQL dialect. The SedonaDB sidecar is
 * preferred when it is reachable and the optional `sedona` extra is installed
 * (typically desktop, and better for larger/local data); otherwise the query
 * runs entirely in-browser on CereusDB (the WebAssembly build of SedonaDB) — the
 * default for the web build and when no sidecar is running. This mirrors the
 * Vector Tools dialog's engine fallback.
 *
 * @param sql The SQL statement to execute.
 * @param layers Current app layers exposed as queryable tables.
 * @returns Columns, rows, row count, geometry column name, and GeoJSON result.
 * @throws Whatever the active engine throws for invalid SQL (surfaced to the caller).
 */
export async function runSedonaQuery(
  sql: string,
  layers: GeoLibreLayer[],
): Promise<SqlQueryResult> {
  const cleaned = cleanStatement(sql);
  if (containsMultipleStatements(cleaned)) {
    throw new Error(
      "Only a single SQL statement is supported. Remove any intermediate semicolons.",
    );
  }
  if (await sidecarSqlAvailable()) {
    return runSidecarQuery(cleaned, layers);
  }
  return runCereusQuery(cleaned, layers);
}
