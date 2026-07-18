import type { GeoLibreLayer } from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import { loadPgliteModules } from "./pglite-loader";
import {
  buildCreateTableStatement,
  buildInsertChunk,
  inferPropertyColumns,
  pickGeometryColumnName,
  quoteIdentifier,
} from "./pglite-sql";
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

// Schema that holds every layer table. It is dropped and recreated on each run
// so the exposed tables always match the current layers (and tables for removed
// layers never linger), mirroring how the DuckDB engine rebuilds TEMP tables.
const WORKSPACE_SCHEMA = "geolibre";

// Rows are inserted in batches so a layer with many features does not build one
// enormous parameterized statement. Postgres caps bind parameters at 65535, so a
// wide table also needs a smaller batch: the effective size is the lesser of this
// row cap and the per-statement parameter budget.
const INSERT_CHUNK_ROWS = 500;
const MAX_BIND_PARAMS = 65535;

/** Rows per INSERT batch, shrinking for wide tables to stay under the param cap. */
function insertChunkRows(columnCount: number): number {
  // Each row binds one parameter per property column plus one for the geometry.
  const paramsPerRow = columnCount + 1;
  return Math.max(1, Math.min(INSERT_CHUNK_ROWS, Math.floor(MAX_BIND_PARAMS / paramsPerRow)));
}

// Minimal structural view of the PGlite instance this module relies on, so the
// dynamic import does not force the whole app to depend on PGlite's types.
interface PgliteLike {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{
    rows: Record<string, unknown>[];
    fields: { name: string; dataTypeID: number }[];
  }>;
  exec: (sql: string) => Promise<unknown>;
}

interface PgliteState {
  pg: PgliteLike;
  /** OID of the PostGIS `geometry` type, used to detect geometry columns. */
  geometryOid: number | null;
}

// Memoized singleton: the ~18.8 MB PostGIS WASM bundle loads only on first use.
let statePromise: Promise<PgliteState> | null = null;

// PGlite executes statements on a single instance; chain whole register+run
// operations so concurrent dialog runs cannot interleave schema resets.
let queue: Promise<unknown> = Promise.resolve();

function runExclusive<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task, task);
  queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function getState(): Promise<PgliteState> {
  if (!statePromise) {
    statePromise = (async () => {
      const { PGlite, postgis } = await loadPgliteModules();
      const pg = new PGlite({
        extensions: { postgis },
      }) as unknown as PgliteLike;
      await pg.exec("CREATE EXTENSION IF NOT EXISTS postgis;");
      const oidResult = await pg.query("SELECT oid FROM pg_type WHERE typname = 'geometry'");
      const oid = oidResult.rows[0]?.oid;
      return {
        pg,
        geometryOid: typeof oid === "number" ? oid : Number(oid) || null,
      };
    })().catch((err) => {
      // Reset so a failed load (e.g. an aborted bundle fetch) can be retried.
      statePromise = null;
      throw err;
    });
  }
  return statePromise;
}

/**
 * Drop and recreate the workspace schema, then register every layer that carries
 * an in-memory GeoJSON FeatureCollection as a table inside it, and point the
 * search path at the schema so the user can reference tables by bare name.
 *
 * @param pg The PGlite instance.
 * @param layers Current app layers; those without `geojson` are skipped.
 * @returns The registered tables, in the same naming as the DuckDB engine.
 */
async function registerLayerTables(
  pg: PgliteLike,
  layers: GeoLibreLayer[],
): Promise<SqlWorkspaceTable[]> {
  await pg.exec(
    `DROP SCHEMA IF EXISTS ${quoteIdentifier(WORKSPACE_SCHEMA)} CASCADE; ` +
      `CREATE SCHEMA ${quoteIdentifier(WORKSPACE_SCHEMA)}; ` +
      `SET search_path TO ${quoteIdentifier(WORKSPACE_SCHEMA)}, public;`,
  );

  const registered: SqlWorkspaceTable[] = [];
  for (const { layer, tableName } of assignTableNames(layers)) {
    const collection = layer.geojson as FeatureCollection | undefined;
    const features = collection?.features ?? [];
    const qualifiedTable = `${quoteIdentifier(WORKSPACE_SCHEMA)}.${quoteIdentifier(tableName)}`;
    const columns = inferPropertyColumns(features);
    const geometryColumn = pickGeometryColumnName(columns.map((c) => c.name));
    await pg.query(buildCreateTableStatement(qualifiedTable, columns, geometryColumn));
    const chunkRows = insertChunkRows(columns.length);
    for (let i = 0; i < features.length; i += chunkRows) {
      const chunk = buildInsertChunk(
        qualifiedTable,
        columns,
        geometryColumn,
        features.slice(i, i + chunkRows),
      );
      await pg.query(chunk.text, chunk.params);
    }
    registered.push({ tableName, layerName: layer.name });
  }
  return registered;
}

interface DescribedQuery {
  columnNames: string[];
  geometryColumn: string | null;
}

/**
 * Describe the user's statement to learn its result columns and find the geometry
 * column (the first whose type OID matches PostGIS `geometry`). Returns null when
 * the statement is not a query that can be wrapped in a FROM subquery (e.g. DDL),
 * which the caller then runs directly without geometry handling.
 */
async function describeQuery(
  pg: PgliteLike,
  geometryOid: number | null,
  statement: string,
): Promise<DescribedQuery | null> {
  try {
    const described = await pg.query(
      `SELECT * FROM (${statement}) AS ${quoteIdentifier("__geolibre_sql_subquery")} LIMIT 0`,
    );
    const columnNames = described.fields.map((field) => field.name);
    const geometryColumn =
      geometryOid === null
        ? null
        : (described.fields.find((field) => field.dataTypeID === geometryOid)?.name ?? null);
    return { columnNames, geometryColumn };
  } catch {
    return null;
  }
}

/**
 * Run a single SQL statement against the embedded PGlite + PostGIS engine with
 * every GeoJSON-backed layer registered as a table.
 *
 * When the result has a PostGIS geometry column, geometry is rendered as WKT in
 * the grid rows and a GeoJSON FeatureCollection is built (via `ST_AsGeoJSON`) for
 * the add-as-layer and export paths. Coordinates are assumed/declared as WGS84
 * (EPSG:4326). The returned shape matches the DuckDB engine's {@link SqlQueryResult}
 * so the dialog renders both engines identically.
 *
 * @param sql The SQL statement to execute.
 * @param layers Current app layers exposed as queryable tables.
 * @returns Columns, rows, row count, geometry column name, and GeoJSON result.
 * @throws Whatever PostGIS throws for invalid SQL (surfaced to the caller).
 */
export async function runPostgisQuery(
  sql: string,
  layers: GeoLibreLayer[],
): Promise<SqlQueryResult> {
  const cleaned = cleanStatement(sql);
  if (containsMultipleStatements(cleaned)) {
    throw new Error(
      "Only a single SQL statement is supported. Remove any intermediate semicolons.",
    );
  }

  return runExclusive(async () => {
    const { pg, geometryOid } = await getState();
    await registerLayerTables(pg, layers);

    const described = await describeQuery(pg, geometryOid, cleaned);
    const geometryColumn = described?.geometryColumn ?? null;

    if (described && geometryColumn) {
      const geomId = quoteIdentifier(geometryColumn);
      const sub = quoteIdentifier("__geolibre_sql_subquery");
      const hiddenId = quoteIdentifier(GEOMETRY_JSON_COLUMN);
      // Build an explicit projection (Postgres has no DuckDB `SELECT * REPLACE`):
      // pass each column through, but render the geometry column as WKT text for
      // the grid, and append the hidden GeoJSON column for the layer/export path.
      const projection = described.columnNames
        .filter((name) => name !== GEOMETRY_JSON_COLUMN)
        .map((name) => {
          const id = quoteIdentifier(name);
          return name === geometryColumn
            ? `ST_AsText(${sub}.${geomId}) AS ${geomId}`
            : `${sub}.${id} AS ${id}`;
        });
      projection.push(`ST_AsGeoJSON(${sub}.${geomId}) AS ${hiddenId}`);
      const result = await pg.query(`SELECT ${projection.join(", ")} FROM (${cleaned}) AS ${sub}`);
      const columns = result.fields
        .map((field) => field.name)
        .filter((name) => name !== GEOMETRY_JSON_COLUMN);
      const geojson = rowsToFeatureCollection(result.rows, geometryColumn);
      const rows = result.rows.map((row) => normalizeRow(row, columns));
      return {
        columns,
        rows,
        rowCount: rows.length,
        geometryColumn,
        geojson,
      } satisfies SqlQueryResult;
    }

    const result = await pg.query(cleaned);
    const columns = result.fields.map((field) => field.name);
    const rows = result.rows.map((row) => normalizeRow(row, columns));
    return {
      columns,
      rows,
      rowCount: rows.length,
      geometryColumn: null,
      geojson: null,
    } satisfies SqlQueryResult;
  });
}
