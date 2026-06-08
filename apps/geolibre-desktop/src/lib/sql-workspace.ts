import type { GeoLibreLayer } from "@geolibre/core";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import {
  DuckDBDataProtocol,
  type AsyncDuckDB,
  type AsyncDuckDBConnection,
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

// Reserved alias wrapping the user's statement when geometry is detected; kept
// deliberately obscure so it does not collide with a user's own CTE/subquery.
const SQL_SUBQUERY_ALIAS = "__geolibre_sql_subquery";

// DuckDB reserved keywords cannot be used as unquoted identifiers, so a layer
// named e.g. "Group" would sanitize to `group` and break `SELECT * FROM group`.
// Such names are prefixed with `t_` to stay valid in the SQL the user types.
const RESERVED_TABLE_NAMES = new Set([
  "all", "analyse", "analyze", "and", "any", "array", "as", "asc",
  "asymmetric", "both", "case", "cast", "check", "collate", "column",
  "constraint", "create", "default", "deferrable", "desc", "describe",
  "distinct", "do", "else", "end", "except", "false", "fetch", "for",
  "foreign", "from", "grant", "group", "having", "in", "initially",
  "intersect", "into", "lateral", "leading", "limit", "not", "null", "offset",
  "on", "only", "or", "order", "pivot", "placing", "primary", "qualify",
  "references", "returning", "select", "show", "some", "symmetric", "table",
  "then", "to", "trailing", "true", "union", "unique", "using", "variadic",
  "when", "where", "window", "with",
]);

// Bare URLs and file paths after FROM/JOIN are auto-wrapped in a matching
// DuckDB table function so the convenient `SELECT * FROM https://…/x.parquet`
// form works (DuckDB itself rejects unquoted URLs/paths). Quoted sources,
// subqueries, and plain table names are left untouched.
const DATA_SOURCE_READERS: Array<{ extensions: string[]; reader: string }> = [
  { extensions: ["parquet", "geoparquet", "pq"], reader: "read_parquet" },
  { extensions: ["csv", "tsv", "txt"], reader: "read_csv_auto" },
  { extensions: ["json", "ndjson"], reader: "read_json_auto" },
  {
    extensions: ["geojson", "fgb", "shp", "gpkg", "kml", "gml"],
    reader: "ST_Read",
  },
];
const BARE_SOURCE_PATTERN =
  /\b(from|join)\s+((?:https?:\/\/|\/|\.\/|\.\.\/|~\/|[A-Za-z]:[\\/])[^\s,;()]+)/gi;

// HTTP(S) URLs whose extension feeds a native DuckDB reader (read_parquet /
// read_csv_auto / read_json_auto) are registered as DuckDB file handles so the
// JS runtime streams them via range requests. The in-WASM httpfs path used by a
// bare `read_parquet('https://…')` fails with "stoi: no conversion" on many
// servers. ST_Read (GDAL/vsicurl) URLs are left bare so GDAL handles them.
const REMOTE_URL_PATTERN = /https?:\/\/[^\s'");]+/gi;

// A pre-spatial remote read_parquet is what initialises the HTTP read path (see
// ensureSpatialExtension). When a query has no remote parquet of its own to warm
// up with (e.g. a local-only first query that would otherwise load spatial
// cold), this tiny public parquet is read instead. Only its footer is fetched.
const HTTP_WARMUP_PARQUET_URL =
  "https://data.source.coop/giswqs/opengeos/countries.parquet";

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
  // A leading digit or a reserved keyword is prefixed with `t_` so the name is
  // a usable bare identifier in the SQL the user writes.
  const needsPrefix =
    !!base && (!/^[a-z_]/.test(base) || RESERVED_TABLE_NAMES.has(base));
  const normalized = base ? (needsPrefix ? `t_${base}` : base) : "";
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
 * The registered GeoJSON file names are namespaced with `filePrefix` so that
 * concurrent `runSqlQuery` calls against the shared database instance cannot
 * overwrite or drop each other's files while a query is still reading them.
 *
 * @param db Shared DuckDB-WASM database instance.
 * @param connection Open connection used to create the tables.
 * @param layers Current app layers; those without `geojson` are skipped.
 * @param filePrefix Per-run prefix applied to every registered VFS file name.
 * @param registeredFiles Optional accumulator; each created file name is pushed
 *   as it is registered so the caller can clean up even if a later layer throws.
 * @returns The registered tables in registration order.
 */
export async function registerLayerTables(
  db: AsyncDuckDB,
  connection: AsyncDuckDBConnection,
  layers: GeoLibreLayer[],
  filePrefix: string,
  registeredFiles?: string[],
): Promise<SqlWorkspaceTable[]> {
  const registered: SqlWorkspaceTable[] = [];

  for (const { layer, tableName } of assignTableNames(layers)) {
    const fileName = `${filePrefix}__${tableName}.geojson`;
    await db.registerFileText(fileName, JSON.stringify(layer.geojson));
    // Track immediately after registration so a failure in the CREATE TABLE
    // below still leaves this file in the cleanup list.
    registeredFiles?.push(fileName);
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

interface DescribedQuery {
  /** Column names the query returns, in select order. */
  columnNames: string[];
  /** Name of the first GEOMETRY-typed column, or null when there is none. */
  geometryColumn: string | null;
}

/**
 * Describe the user's query to learn its columns and detect a GEOMETRY column.
 *
 * The statement is wrapped in a `SELECT * FROM (...)` subquery so the probe also
 * works for CTE (`WITH`) and set-operation (`UNION`) queries, which a bare
 * `DESCRIBE <statement>` rejects. Because DDL/DML cannot appear inside a FROM
 * subquery, this also avoids ever executing a mutating statement (e.g. a
 * `DELETE ... RETURNING`) during description: such statements simply throw here
 * and fall through to being run once, normally. Returns null when the statement
 * cannot be described as a query result.
 */
async function describeQuery(
  connection: AsyncDuckDBConnection,
  statement: string,
): Promise<DescribedQuery | null> {
  try {
    const described = rowsFromResult(
      await connection.query(
        `DESCRIBE SELECT * FROM (${statement}) AS ` +
          quoteIdentifier(SQL_SUBQUERY_ALIAS),
      ),
    );
    const columnNames = described
      .map((row) => row.column_name)
      .filter((name): name is string => typeof name === "string");
    const geometryColumn = described.find((row) =>
      isGeometryColumnType(row.column_type),
    )?.column_name;
    return {
      columnNames,
      geometryColumn:
        typeof geometryColumn === "string" ? geometryColumn : null,
    };
  } catch {
    return null;
  }
}

/**
 * Return a copy of `sql` in which every character inside a string literal,
 * quoted identifier, line/block comment, or dollar-quoted string (`$$…$$`,
 * `$tag$…$tag$`) is replaced with a space, while newlines and all "code"
 * characters keep their original position.
 *
 * Running regexes against this mask makes them literal-aware without a full
 * parser: a match's indices are valid against the original string, but the
 * regex can never match text that lives inside a literal or comment.
 */
function maskSqlLiterals(sql: string): string {
  const out = sql.split("");
  const blank = (start: number, end: number): void => {
    for (let k = start; k < end && k < out.length; k += 1) {
      if (out[k] !== "\n") out[k] = " ";
    }
  };
  let i = 0;
  while (i < sql.length) {
    const char = sql[i];
    if (char === "'" || char === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === char) {
          // A doubled quote is an escaped quote, not the end of the literal.
          if (sql[j + 1] === char) {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      blank(i, j + 1);
      i = j + 1;
    } else if (char === "-" && sql[i + 1] === "-") {
      let j = i;
      while (j < sql.length && sql[j] !== "\n") j += 1;
      blank(i, j);
      i = j;
    } else if (char === "/" && sql[i + 1] === "*") {
      let j = i + 2;
      while (j < sql.length && !(sql[j] === "*" && sql[j + 1] === "/")) j += 1;
      blank(i, j + 2);
      i = j + 2;
    } else if (char === "$") {
      // Dollar-quote tag: $tag$ where tag is empty or [A-Za-z0-9_]+.
      const tagMatch = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (tagMatch) {
        const tag = tagMatch[0];
        const closeAt = sql.indexOf(tag, i + tag.length);
        const end = closeAt === -1 ? sql.length : closeAt + tag.length;
        blank(i, end);
        i = end;
      } else {
        i += 1;
      }
    } else {
      i += 1;
    }
  }
  return out.join("");
}

/**
 * Trim the statement and strip a single trailing semicolon and any trailing
 * comment, so it can be safely wrapped in `... FROM (<statement>) AS …` for
 * geometry detection. Operates via {@link maskSqlLiterals} so a semicolon or
 * comment inside a literal is never mistaken for the terminator.
 */
function cleanStatement(sql: string): string {
  const src = sql.trim();
  const masked = maskSqlLiterals(src);
  // maskSqlLiterals blanks comments to spaces, so trimming the mask drops any
  // trailing comment; the matching slice of the original is the real content.
  let end = masked.replace(/\s+$/, "").length;
  if (end > 0 && masked[end - 1] === ";") end -= 1;
  return src.slice(0, end).trimEnd();
}

/**
 * Detect whether `sql` contains more than one statement (an interior semicolon
 * outside of string literals, quoted identifiers, comments, and dollar-quotes).
 * DuckDB-WASM silently runs every statement but only returns the last result,
 * so the caller rejects multi-statement input instead of discarding earlier
 * results. Expects a statement already cleaned of its trailing semicolon.
 */
function containsMultipleStatements(sql: string): boolean {
  const masked = maskSqlLiterals(sql);
  const semicolon = masked.indexOf(";");
  // A semicolon is only a statement separator when real content follows it;
  // trailing comments/whitespace have already been blanked by the mask.
  return semicolon !== -1 && masked.slice(semicolon + 1).trim().length > 0;
}

/** Names of layer tables referenced (as bare identifiers) in the statement. */
function referencedTableNames(
  statement: string,
  candidates: Iterable<string>,
): Set<string> {
  const masked = maskSqlLiterals(statement);
  const referenced = new Set<string>();
  for (const name of candidates) {
    // Table names are sanitized lower-case identifiers, so a word-boundary
    // match against the masked (literal-free) statement is reliable.
    const pattern = new RegExp(`(?<![\\w.])${name}\\b`, "i");
    if (pattern.test(masked)) referenced.add(name);
  }
  return referenced;
}

/** Pick the DuckDB table function for a data source extension, if recognised. */
function readerForExtension(extension: string): string | null {
  return (
    DATA_SOURCE_READERS.find((entry) => entry.extensions.includes(extension))
      ?.reader ?? null
  );
}

/**
 * Rewrite a bare URL or file path after FROM/JOIN into the matching DuckDB
 * reader (`read_parquet`, `read_csv_auto`, `read_json_auto`, or `ST_Read`) by
 * file extension, so `SELECT * FROM https://host/data.parquet` works. Sources
 * with an unrecognised extension, and anything already quoted or wrapped in a
 * function call, are left unchanged.
 */
function rewriteBareSources(sql: string): string {
  return sql.replace(
    BARE_SOURCE_PATTERN,
    (whole, keyword: string, source: string) => {
      const path = source.split(/[?#]/)[0];
      const dot = path.lastIndexOf(".");
      const extension = dot >= 0 ? path.slice(dot + 1).toLowerCase() : "";
      const reader = readerForExtension(extension);
      return reader ? `${keyword} ${reader}(${quoteSqlString(source)})` : whole;
    },
  );
}

/** Derive a stable, VFS-safe handle name from a URL, keeping its extension. */
function remoteHandleName(filePrefix: string, index: number, url: string): string {
  const path = url.split(/[?#]/)[0];
  const base = path.slice(path.lastIndexOf("/") + 1).replace(/[^\w.-]/g, "_");
  return `${filePrefix}__remote_${index}_${base || "source"}`;
}

/**
 * Register each HTTP(S) URL that feeds a native DuckDB reader as a file handle
 * and rewrite the statement to reference the handle. DuckDB-WASM then reads the
 * remote file through the JS runtime's HTTP range reader (streaming only the
 * byte ranges the query needs, so large files work) instead of the in-WASM
 * httpfs path, which fails with "stoi: no conversion" against many servers.
 *
 * @returns The statement with registered URLs replaced by their handle names.
 */
async function registerRemoteSources(
  db: AsyncDuckDB,
  filePrefix: string,
  statement: string,
  registeredFiles: string[],
): Promise<{ statement: string; readerCalls: string[] }> {
  // Longest first so a URL that is a prefix of another is replaced correctly.
  const urls = [...new Set(statement.match(REMOTE_URL_PATTERN) ?? [])].sort(
    (a, b) => b.length - a.length,
  );
  let rewritten = statement;
  let index = 0;
  const readerCalls: string[] = [];
  for (const url of urls) {
    const path = url.split(/[?#]/)[0];
    const dot = path.lastIndexOf(".");
    const extension = dot >= 0 ? path.slice(dot + 1).toLowerCase() : "";
    const reader = readerForExtension(extension);
    if (!reader || reader === "ST_Read") continue;
    const handle = remoteHandleName(filePrefix, index, url);
    index += 1;
    // directIO = true forces range-based reads so the whole file is never
    // buffered locally.
    await db.registerFileURL(handle, url, DuckDBDataProtocol.HTTP, true);
    registeredFiles.push(handle);
    readerCalls.push(`${reader}(${quoteSqlString(handle)})`);
    rewritten = rewritten.split(url).join(handle);
  }
  return { statement: rewritten, readerCalls };
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
  const trimmed = sql.trim().replace(/;\s*$/, "");
  if (containsMultipleStatements(trimmed)) {
    throw new Error(
      "Only a single SQL statement is supported. Remove any intermediate semicolons.",
    );
  }
  // Wrap bare URLs/paths after FROM/JOIN in the matching reader so the
  // convenient `SELECT * FROM https://…/x.parquet` form runs.
  const rewritten = rewriteBareSources(trimmed);

  const db = await getDatabase();
  const connection = await db.connect();
  // Per-run prefix so concurrent queries on the shared database do not register
  // or drop one another's VFS files. Populated by registerLayerTables and
  // registerRemoteSources as they create handles so cleanup matches exactly
  // what was registered.
  const filePrefix = `__geolibre_sql_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2)}`;
  const registeredFiles: string[] = [];

  try {
    // Register remote URLs as DuckDB file handles so they stream over HTTP
    // range requests instead of the unreliable in-WASM httpfs path. Done before
    // loading spatial so the handles can warm up the HTTP read path first.
    const { statement, readerCalls } = await registerRemoteSources(
      db,
      filePrefix,
      rewritten,
      registeredFiles,
    );
    // Load spatial, warming up the HTTP read path first: duckdb-wasm breaks
    // remote read_parquet if spatial is loaded before the first remote read. A
    // single pre-spatial read_parquet initialises the path for all later remote
    // reads. Warm up with the query's own remote readers (no extra request),
    // and guarantee at least one read_parquet runs by falling back to a tiny
    // default parquet when the query has none of its own.
    const warmups = [...readerCalls];
    if (!warmups.some((call) => call.startsWith("read_parquet"))) {
      warmups.push(`read_parquet(${quoteSqlString(HTTP_WARMUP_PARQUET_URL)})`);
    }
    await ensureSpatialExtension(connection, async () => {
      for (const readerCall of warmups) {
        await connection.query(`SELECT 1 FROM ${readerCall} LIMIT 0`);
      }
    });
    await registerLayerTables(db, connection, layers, filePrefix, registeredFiles);

    const described = await describeQuery(connection, statement);
    const geometryColumn = described?.geometryColumn ?? null;

    if (geometryColumn) {
      const geomId = quoteIdentifier(geometryColumn);
      const hiddenId = quoteIdentifier(GEOMETRY_JSON_COLUMN);
      // Drop a user column that already uses the reserved hidden name from the
      // wildcard so appending our own alias cannot raise a duplicate-column
      // error. EXCLUDE only when present, since DuckDB rejects EXCLUDE of a
      // missing column.
      const excludeClause = described?.columnNames.includes(GEOMETRY_JSON_COLUMN)
        ? ` EXCLUDE (${hiddenId})`
        : "";
      const result = await connection.query(
        `SELECT *${excludeClause} REPLACE (ST_AsText(${geomId}) AS ${geomId}), ` +
          `ST_AsGeoJSON(${geomId}) AS ${hiddenId} ` +
          `FROM (${statement}) AS ${quoteIdentifier(SQL_SUBQUERY_ALIAS)}`,
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
