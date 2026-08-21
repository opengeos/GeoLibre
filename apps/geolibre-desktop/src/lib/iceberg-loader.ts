/**
 * Apache Iceberg vector support (engine half).
 *
 * Runs the DuckDB side of the Iceberg source: loads the `spatial` + `iceberg`
 * extensions, lists a REST catalog's tables, inspects the chosen table, and
 * materializes a bounded GeoJSON snapshot of it. The pure config/SQL half lives
 * in `iceberg.ts`; keep anything that does not need DuckDB there so it stays
 * unit-testable.
 *
 * Everything runs on the SQL Workspace's dedicated DuckDB instance
 * ({@link getSqlDatabase}) rather than the shared one. That instance exists for
 * remote reads: it carries the pre-spatial HTTP warm-up and the poisoned-
 * instance recovery that duckdb-wasm's remote `read_parquet` path needs — which
 * is exactly the path every Iceberg scan goes through to reach the table's data
 * files.
 */

import type * as duckdb from "@duckdb/duckdb-wasm";
import type { FeatureCollection } from "geojson";
import {
  geometryGeoJsonSql,
  isGeometryColumnType,
  quoteIdentifier,
  quoteSqlString,
} from "./duckdb-geometry";
import {
  acquireSqlDatabase,
  ensureIcebergExtension,
  ensureSpatialExtension,
  getSqlDatabase,
  releaseSqlDatabase,
  resetSqlDatabase,
  rowsFromResult,
} from "./duckdb-vector-loader";
import {
  buildIcebergAttachSql,
  buildIcebergDetachSql,
  buildIcebergSelectSql,
  buildIcebergSourceSql,
  clampIcebergRowLimit,
  ICEBERG_CATALOG_ALIAS,
  icebergCrsFromColumnType,
  icebergNameFromLocation,
  icebergTransformCrs,
  type IcebergColumn,
  type IcebergLayerConfig,
  type IcebergTableInfo,
  type IcebergTableRef,
} from "./iceberg";
import {
  cleanStatement,
  containsMultipleStatements,
  GEOMETRY_JSON_COLUMN,
  rowsToFeatureCollection,
  SAMPLE_DATASET_URL,
} from "./sql-workspace";

/** The outcome of materializing a table, including what the row cap left out. */
export interface IcebergLoadResult {
  geojson: FeatureCollection;
  /** Features actually materialized (at most the config's row limit). */
  featureCount: number;
  /** Rows the table holds in total, so the caller can report a truncation. */
  totalRows: number;
  /** True when `totalRows` exceeded the row limit and the read was capped. */
  truncated: boolean;
  /** The geometry column the scan read. */
  geometryColumn: string;
  /** The CRS that column declared, or null when it carried none (CRS84). */
  crs: string | null;
}

// `ATTACH` is database-wide, not connection-scoped, so two catalog operations
// running at once on the same instance would collide on the fixed alias: the
// second ATTACH fails outright, or a DETACH pulls the catalog out from under an
// in-flight scan. That is reachable in practice — a layer's manual Refresh can
// overlap with a connect in the Add Data dialog. Iceberg reads are heavy and
// there is nothing to gain from overlapping them, so every operation is queued
// behind the previous one.
let icebergQueue: Promise<unknown> = Promise.resolve();

function enqueueIcebergWork<T>(run: () => Promise<T>): Promise<T> {
  // Chained off both settle paths so a rejected predecessor still releases the
  // queue instead of wedging every later operation.
  const next = icebergQueue.then(run, run);
  icebergQueue = next.catch(() => {});
  return next;
}

/**
 * Run `work` on a connection with `spatial` and `iceberg` loaded, and — in
 * catalog mode — the catalog ATTACHed under the fixed alias. Operations are
 * serialized (see {@link enqueueIcebergWork}).
 *
 * Retries once against a freshly rebuilt instance on the duckdb-wasm
 * poisoned-remote-read symptom, mirroring `runSqlQuery`: an Iceberg scan is a
 * remote Parquet read and hits the same failure mode.
 */
async function withIcebergConnection<T>(
  config: IcebergLayerConfig,
  work: (connection: duckdb.AsyncDuckDBConnection) => Promise<T>,
): Promise<T> {
  const attempt = async (db: duckdb.AsyncDuckDB): Promise<T> => {
    acquireSqlDatabase(db);
    // `connect()` runs *inside* the try so a rejection still reaches the
    // `finally` and releases the instance. Leaking the in-flight count would be
    // permanent: resetSqlDatabase only terminates an instance once that count is
    // zero, so a never-released count strands the poisoned instance and its
    // worker — and a failing connect is reachable on exactly the poisoned
    // instance the retry below exists for.
    let connection: duckdb.AsyncDuckDBConnection | null = null;
    let attached = false;
    try {
      // A const alias, because TypeScript cannot narrow the mutable `connection`
      // inside the callback below.
      const active = await db.connect();
      connection = active;
      // Warm the HTTP read path with a pre-spatial remote read_parquet before
      // any LOAD: duckdb-wasm otherwise breaks remote reads on a connection
      // that loaded spatial first, which every Iceberg data-file read needs.
      await ensureSpatialExtension(db, active, async () => {
        await active.query(
          `SELECT 1 FROM read_parquet(${quoteSqlString(SAMPLE_DATASET_URL)}) LIMIT 0`,
        );
      });
      await ensureIcebergExtension(db, active);
      if (config.mode === "catalog") {
        await active.query(buildIcebergAttachSql(config));
        attached = true;
      }
      return await work(active);
    } finally {
      // The release is the `finally` of its own nested try, for the same reason
      // `connect()` sits inside the outer one: a rejecting `close()` would
      // otherwise skip it and leak the in-flight count permanently.
      try {
        if (connection) {
          if (attached) {
            try {
              await connection.query(buildIcebergDetachSql());
            } catch {
              // Best-effort: the connection is closing anyway, and leaving the
              // catalog attached would make the next ATTACH fail on the alias.
            }
          }
          await connection.close();
        }
      } finally {
        await releaseSqlDatabase(db);
      }
    }
  };

  return enqueueIcebergWork(async () => {
    const db = await getSqlDatabase();
    try {
      return await attempt(db);
    } catch (error) {
      if (!isStoiConversionError(error)) throw error;
      await resetSqlDatabase(db);
      return await attempt(await getSqlDatabase());
    }
  });
}

/** True when an error is the duckdb-wasm poisoned-instance "stoi" symptom. */
function isStoiConversionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /stoi:\s*no conversion/i.test(message);
}

/**
 * The tables the configured source exposes.
 *
 * A catalog is enumerated with `SHOW ALL TABLES`, filtered to the catalog we
 * attached so DuckDB's own `memory`/`system` databases are not offered. A direct
 * table location is a single table by construction, but the scan is still probed
 * (`LIMIT 0`) so an unreachable location fails here — while the user is still in
 * the Connect step — rather than after they have picked a row limit.
 *
 * @param config The connection to enumerate (its `table` is ignored).
 * @returns The available tables, in catalog order.
 */
export async function listIcebergTables(config: IcebergLayerConfig): Promise<IcebergTableRef[]> {
  return withIcebergConnection(config, async (connection) => {
    if (config.mode === "table") {
      // Through the guarded helper and wrapped as a sub-select, exactly like the
      // inspect/load paths: a custom statement may end in its own `LIMIT` or a
      // `--` comment, either of which would break (or silently defeat) a
      // concatenated ` LIMIT 0`.
      await connection.query(
        `SELECT * FROM (${icebergSourceSql(config)}) AS iceberg_source LIMIT 0`,
      );
      return [{ name: icebergNameFromLocation(config.location) }];
    }
    const rows = rowsFromResult(await connection.query("SHOW ALL TABLES"));
    const tables: IcebergTableRef[] = [];
    for (const row of rows) {
      // SHOW ALL TABLES reports every attached database; keep only ours.
      if (String(row.database ?? "") !== ICEBERG_CATALOG_ALIAS) continue;
      const name = row.name;
      if (typeof name !== "string" || name === "") continue;
      const schema = row.schema;
      tables.push({
        name,
        ...(typeof schema === "string" && schema !== "" ? { schema } : {}),
      });
    }
    return tables;
  });
}

/**
 * Describe the configured source without materializing it: its GEOMETRY
 * columns, the total row count, and which column (with which CRS) will be read.
 *
 * The row count is what makes an Iceberg load an informed choice. It is a
 * `count(*)` over the configured source: for an unfiltered table DuckDB answers
 * it from the manifest metadata rather than a scan, so it is cheap even for a
 * table far too large to render. A custom statement is not free in the same way
 * — its filters, joins, or projections have to be evaluated over the data files
 * — but it runs once, on an explicit user action, and the count is the whole
 * point of the step.
 *
 * @param config The connection, selected table, and any custom SQL.
 * @returns The geometry columns, row count, chosen column, and its CRS.
 */
export async function inspectIcebergTable(config: IcebergLayerConfig): Promise<IcebergTableInfo> {
  return withIcebergConnection(config, async (connection) => {
    const source = icebergSourceSql(config);
    const { geometryColumns } = await describeSource(connection, source);
    const chosen = resolveGeometryColumn(geometryColumns, config);
    const countRows = rowsFromResult(
      await connection.query(`SELECT count(*) AS row_count FROM (${source}) AS iceberg_source`),
    );
    return {
      geometryColumns,
      rowCount: toCount(countRows[0]?.row_count),
      geometryColumn: chosen?.name ?? null,
      crs: chosen ? icebergCrsFromColumnType(chosen.type) : null,
    };
  });
}

/**
 * Read the configured table into a bounded GeoJSON FeatureCollection.
 *
 * The read is capped at `config.rowLimit`; `totalRows` in the result reports
 * what the table actually holds so the caller can tell the user the layer is a
 * subset. Nothing here re-runs on its own — an Iceberg layer is reloaded only by
 * an explicit user action.
 *
 * @param config The connection, selected table, row limit, and CRS override.
 * @returns The features plus the counts describing what was left out.
 * @throws When no geometry column can be identified, or DuckDB rejects the scan
 *   (its message is surfaced as-is).
 */
export async function loadIcebergTable(config: IcebergLayerConfig): Promise<IcebergLoadResult> {
  return withIcebergConnection(config, async (connection) => {
    const source = icebergSourceSql(config);
    const { columnNames, geometryColumns } = await describeSource(connection, source);
    const chosen = resolveGeometryColumn(geometryColumns, config);
    if (!chosen) {
      throw new Error(
        config.geometryColumn
          ? `"${config.geometryColumn}" is not a GEOMETRY column in this Iceberg source.`
          : "This Iceberg source has no GEOMETRY column to render.",
      );
    }
    const rowLimit = clampIcebergRowLimit(config.rowLimit);
    const countRows = rowsFromResult(
      await connection.query(`SELECT count(*) AS row_count FROM (${source}) AS iceberg_source`),
    );
    const totalRows = toCount(countRows[0]?.row_count);
    // The CRS comes from the column's own type rather than from the user: a
    // CRS-annotated GEOMETRY reprojects to WGS84, and Iceberg's default
    // (OGC:CRS84) is already GeoJSON's convention, so it passes through.
    const sourceCrs = icebergTransformCrs(chosen.type);
    const sql = buildIcebergSelectSql(
      source,
      geometryGeoJsonSql(quoteIdentifier(chosen.name), sourceCrs),
      GEOMETRY_JSON_COLUMN,
      rowLimit,
      // Every geometry column, not just the unselected ones: the rendered one
      // reaches the features through the GeoJSON alias, so keeping its raw value
      // in the wildcard would only ship redundant binary across Arrow. These
      // names came from a DESCRIBE of this very source, so they are certain to
      // exist — which matters, as DuckDB rejects EXCLUDE of a missing column.
      //
      // A source column that already carries the reserved GeoJSON alias joins
      // them, and only then: left in the wildcard it would collide with the
      // alias appended beside it (a duplicate-column error, or a silent read of
      // that attribute as the geometry, since rowsToFeatureCollection consumes
      // the name unconditionally). De-duplicated because that reserved name
      // could itself be a geometry column, and EXCLUDE rejects a repeat too.
      [
        ...new Set([
          ...geometryColumns.map((column) => column.name),
          ...(columnNames.includes(GEOMETRY_JSON_COLUMN) ? [GEOMETRY_JSON_COLUMN] : []),
        ]),
      ],
    );
    const rows = rowsFromResult(await connection.query(sql));
    const geojson = rowsToFeatureCollection(rows, chosen.name);
    return {
      geojson,
      featureCount: geojson.features.length,
      totalRows,
      truncated: totalRows > rowLimit,
      geometryColumn: chosen.name,
      crs: icebergCrsFromColumnType(chosen.type),
    };
  });
}

/**
 * The source statement to read, guarded.
 *
 * A custom statement is wrapped as a sub-select later, so it has to be a single
 * statement: `cleanStatement` strips a trailing terminator or comment and
 * `containsMultipleStatements` is literal-aware, so a semicolon inside a string
 * is not mistaken for a second statement. Rejecting here means a pasted script
 * fails with a clear message instead of a DuckDB parse error pointing at the
 * generated wrapper.
 */
function icebergSourceSql(config: IcebergLayerConfig): string {
  const source = buildIcebergSourceSql(config);
  if (!config.sql) return source;
  const cleaned = cleanStatement(source);
  if (containsMultipleStatements(cleaned)) {
    throw new Error(
      "Only a single SQL statement is supported. Remove any intermediate semicolons.",
    );
  }
  return cleaned;
}

/** A source's column names, plus the subset of them that are GEOMETRY typed. */
interface IcebergSourceSchema {
  columnNames: string[];
  geometryColumns: IcebergColumn[];
}

/**
 * Describe a source: every column name it exposes, and the GEOMETRY-typed ones
 * in schema order.
 *
 * Deliberately only native `GEOMETRY`: Iceberg v3 carries a real geometry type
 * (and DuckDB's iceberg extension maps it to `LogicalType::GEOMETRY`), so a BLOB
 * or VARCHAR here is an ordinary attribute. Offering those as candidates — the
 * way the vector-file loader does for plain Parquet, where WKB-in-a-blob is the
 * norm — would only produce loads that fail inside `ST_AsGeoJSON`.
 */
async function describeSource(
  connection: duckdb.AsyncDuckDBConnection,
  source: string,
): Promise<IcebergSourceSchema> {
  const description = rowsFromResult(await connection.query(`DESCRIBE ${source}`));
  const columnNames = description.map((row) => String(row.column_name ?? ""));
  const geometryColumns = description
    .filter((row) => isGeometryColumnType(row.column_type))
    .map((row) => ({
      name: String(row.column_name ?? ""),
      type: String(row.column_type ?? ""),
    }));
  return { columnNames, geometryColumns };
}

/**
 * The geometry column to read: the one the user picked when it is still a
 * GEOMETRY column of this source, otherwise the first one.
 *
 * Returns null rather than throwing so the inspect path can report "no geometry
 * here" as a status while the load path turns it into an error.
 */
function resolveGeometryColumn(
  geometryColumns: IcebergColumn[],
  config: IcebergLayerConfig,
): IcebergColumn | null {
  const wanted = config.geometryColumn?.trim();
  if (wanted) {
    return geometryColumns.find((column) => column.name === wanted) ?? null;
  }
  return geometryColumns[0] ?? null;
}

/** DuckDB returns counts as BigInt; normalize to a JS number. */
function toCount(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") return Number(value) || 0;
  return 0;
}
