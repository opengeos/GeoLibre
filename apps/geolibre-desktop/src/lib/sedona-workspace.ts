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

// Cap the per-layer feature count registered into the in-browser engine so a
// very large layer cannot exhaust browser memory. Mirrors the sidecar's
// MAX_FEATURES (sedona_ops.py), which returns HTTP 413 for oversized layers.
const MAX_CEREUS_FEATURES = 50_000;

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

// CereusDB's registerGeoJSON loads a FeatureCollection as a two-column table —
// `geometry` as WKT *text* and `properties` as a JSON *string* — not as parsed
// spatial/struct types. Each layer is therefore registered under a hidden source
// name and exposed through a view that parses the geometry with ST_GeomFromText
// so ST_* functions work; `properties` is carried through as JSON and flattened
// in JS (this CereusDB build implements no struct/JSON field access in SQL).
const VIEW_SOURCE_SUFFIX = "__geolibre_src";

// Column names CereusDB's registerGeoJSON produces.
const RAW_GEOMETRY_COLUMN = "geometry";
const PROPERTIES_COLUMN = "properties";

// Views created on the previous run, dropped before the next one so removed
// layers do not linger (a view is not removed by dropTable).
let registeredViews: string[] = [];

/**
 * Drop the previous run's views and source tables, then register each layer that
 * carries an in-memory GeoJSON FeatureCollection and expose it as a view with a
 * parsed geometry column, so user SQL can reference the current map data by layer
 * name. Rebuilding on each run keeps the tables in sync with edits.
 */
async function registerLayerTables(
  db: CereusInstance,
  layers: GeoLibreLayer[],
): Promise<SqlWorkspaceTable[]> {
  for (const view of registeredViews) {
    try {
      await db.sqlJSON(`DROP VIEW IF EXISTS ${quoteIdentifier(view)}`);
    } catch {
      // Best-effort cleanup; CREATE OR REPLACE below tolerates a leftover view.
    }
  }
  registeredViews = [];
  for (const name of db.tables()) {
    try {
      db.dropTable(name);
    } catch {
      // Best-effort cleanup; a table that cannot be dropped is harmless here.
    }
  }

  const registered: SqlWorkspaceTable[] = [];
  for (const { layer, tableName } of assignTableNames(layers)) {
    const featureCount = (layer.geojson as FeatureCollection).features?.length ?? 0;
    if (featureCount > MAX_CEREUS_FEATURES) {
      throw new Error(
        `Layer "${layer.name}" has ${featureCount} features, exceeding the ` +
          `${MAX_CEREUS_FEATURES}-feature limit for the in-browser Apache Sedona ` +
          `engine. Run the SedonaDB sidecar for larger layers.`,
      );
    }
    const sourceName = `${tableName}${VIEW_SOURCE_SUFFIX}`;
    db.registerGeoJSON(sourceName, layer.geojson as object);
    const geom = quoteIdentifier(RAW_GEOMETRY_COLUMN);
    const props = quoteIdentifier(PROPERTIES_COLUMN);
    await db.sqlJSON(
      `CREATE OR REPLACE VIEW ${quoteIdentifier(tableName)} AS ` +
        `SELECT ST_GeomFromText(${geom}) AS ${geom}, ${props} ` +
        `FROM ${quoteIdentifier(sourceName)}`,
    );
    registeredViews.push(tableName);
    registered.push({ tableName, layerName: layer.name });
  }
  return registered;
}

/**
 * Expand a `properties` column holding GeoJSON-style attribute JSON (CereusDB
 * returns it as a JSON string) into top-level columns, so the results grid and
 * "Add as layer" match the DuckDB/PostGIS engines. No-op when the result has no
 * `properties` column. The hidden GeoJSON geometry column is preserved on each
 * row for {@link rowsToFeatureCollection}.
 */
function flattenProperties(
  rows: Record<string, unknown>[],
  columns: string[],
): { rows: Record<string, unknown>[]; columns: string[] } {
  if (!columns.includes(PROPERTIES_COLUMN)) return { rows, columns };
  const keyOrder: string[] = [];
  const seen = new Set<string>();
  const parsed = rows.map((row) => {
    const raw = row[PROPERTIES_COLUMN];
    let obj: Record<string, unknown> = {};
    if (typeof raw === "string") {
      try {
        const value = JSON.parse(raw);
        if (value && typeof value === "object" && !Array.isArray(value)) {
          obj = value as Record<string, unknown>;
        }
      } catch {
        // Leave non-JSON text out of the flattened columns.
      }
    } else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      obj = raw as Record<string, unknown>;
    }
    for (const key of Object.keys(obj)) {
      if (!seen.has(key)) {
        seen.add(key);
        keyOrder.push(key);
      }
    }
    return { row, obj };
  });
  const nextColumns: string[] = [];
  for (const column of columns) {
    if (column === PROPERTIES_COLUMN) {
      for (const key of keyOrder) {
        if (!nextColumns.includes(key)) nextColumns.push(key);
      }
    } else if (!nextColumns.includes(column)) {
      nextColumns.push(column);
    }
  }
  const nextRows = parsed.map(({ row, obj }) => {
    const { [PROPERTIES_COLUMN]: _dropped, ...rest } = row;
    for (const key of keyOrder) {
      if (!(key in rest)) rest[key] = obj[key] ?? null;
    }
    return rest;
  });
  return { rows: nextRows, columns: nextColumns };
}

interface DescribedQuery {
  columnNames: string[];
  geometryColumn: string | null;
}

/**
 * Describe the user's statement to learn its result columns and find the
 * geometry column. The schema is read from the Arrow IPC of the statement
 * itself: CereusDB short-circuits a `LIMIT 0` probe to an empty stream with no
 * field schema, so it is run in full and the Arrow result discarded (the rows
 * are re-fetched as JSON afterwards). The geometry column is detected from the
 * Arrow schema's GeoArrow extension metadata, falling back to a column-name
 * heuristic. Returns null when the statement cannot be described as a query
 * (e.g. DDL).
 */
async function describeQuery(
  db: CereusInstance,
  statement: string,
): Promise<DescribedQuery | null> {
  try {
    // Read the result schema from the Arrow IPC of the statement itself rather
    // than a `LIMIT 0` probe: CereusDB short-circuits `LIMIT 0` to an empty
    // stream with no field schema, which would lose every column name.
    const ipc = await db.sql(statement);
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
    // Keep null as null: stringifying it would yield the literal "null", which
    // would wrongly trigger the geometry projection and reference `sub."null"`.
    return {
      columnNames,
      geometryColumn: geometryColumn == null ? null : String(geometryColumn),
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
async function runCereusQuery(statement: string, layers: GeoLibreLayer[]): Promise<SqlQueryResult> {
  return runExclusive(async () => {
    const db = await getDb();
    await registerLayerTables(db, layers);

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
      const baseColumns = described.columnNames.filter((name) => name !== GEOMETRY_JSON_COLUMN);
      const { rows: flatRows, columns } = flattenProperties(queryRows, baseColumns);
      const geojson = rowsToFeatureCollection(flatRows, geometryColumn);
      const rows = flatRows.map((row) => normalizeRow(row, columns));
      return {
        columns,
        rows,
        rowCount: rows.length,
        geometryColumn,
        geojson,
      } satisfies SqlQueryResult;
    }

    const queryRows = await db.sqlJSON(statement);
    const baseColumns = described?.columnNames?.length
      ? described.columnNames
      : queryRows[0]
        ? Object.keys(queryRows[0])
        : [];
    const { rows: flatRows, columns } = flattenProperties(queryRows, baseColumns);
    const rows = flatRows.map((row) => normalizeRow(row, columns));
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
    geojson: result.geojson ?? null,
  };
}

// ---------------------------------------------------------------------------
// Engine routing
// ---------------------------------------------------------------------------

// Cache the sidecar `/sql/status` probe so it is not re-fetched on every query.
// A short TTL keeps a per-query round-trip off the hot path while still picking
// up the sidecar coming up (or going down) within a few seconds.
const SIDECAR_PROBE_TTL_MS = 5_000;
let sidecarProbe: { at: number; available: boolean } | null = null;

/**
 * Probe the SedonaDB sidecar (cached for {@link SIDECAR_PROBE_TTL_MS}); treat any
 * connection failure as unavailable.
 */
async function sidecarSqlAvailable(): Promise<boolean> {
  const now = Date.now();
  if (sidecarProbe && now - sidecarProbe.at < SIDECAR_PROBE_TTL_MS) {
    return sidecarProbe.available;
  }
  let available = false;
  try {
    available = (await fetchSqlStatus()).available;
  } catch {
    available = false;
  }
  sidecarProbe = { at: now, available };
  return available;
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
