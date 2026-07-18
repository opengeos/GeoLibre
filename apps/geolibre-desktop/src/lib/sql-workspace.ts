import type { GeoLibreLayer } from "@geolibre/core";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import {
  DuckDBDataProtocol,
  type AsyncDuckDB,
  type AsyncDuckDBConnection,
} from "@duckdb/duckdb-wasm";
import {
  acquireSqlDatabase,
  ensureSpatialExtension,
  getSqlDatabase,
  isGeometryColumnType,
  quoteIdentifier,
  quoteSqlString,
  releaseSqlDatabase,
  resetSqlDatabase,
  rowsFromResult,
} from "./duckdb-vector-loader";
import { GDAL_AUTO_FID_COLUMN, stripAutoFidColumn } from "./duckdb-geometry";

// Hidden column appended to the user's query so geometry can be returned as
// GeoJSON for the "Add as layer" / export paths without disturbing the columns
// the user sees in the results grid. This is a reserved name: a user column of
// the same name is filtered out of both the grid and the GeoJSON properties.
export const GEOMETRY_JSON_COLUMN = "__geolibre_sql_geometry_geojson";

// Reserved alias wrapping the user's statement when geometry is detected; kept
// deliberately obscure so it does not collide with a user's own CTE/subquery.
const SQL_SUBQUERY_ALIAS = "__geolibre_sql_subquery";

// DuckDB reserved keywords cannot be used as unquoted identifiers, so a layer
// named e.g. "Group" would sanitize to `group` and break `SELECT * FROM group`.
// Such names are prefixed with `t_` to stay valid in the SQL the user types.
const RESERVED_TABLE_NAMES = new Set([
  "all",
  "analyse",
  "analyze",
  "and",
  "any",
  "array",
  "as",
  "asc",
  "asymmetric",
  "both",
  "case",
  "cast",
  "check",
  "collate",
  "column",
  "constraint",
  "create",
  "default",
  "deferrable",
  "desc",
  "describe",
  "distinct",
  "do",
  "else",
  "end",
  "except",
  "false",
  "fetch",
  "for",
  "foreign",
  "from",
  "grant",
  "group",
  "having",
  "in",
  "initially",
  "intersect",
  "into",
  "lateral",
  "leading",
  "limit",
  "not",
  "null",
  "offset",
  "on",
  "only",
  "or",
  "order",
  "pivot",
  "placing",
  "primary",
  "qualify",
  "references",
  "returning",
  "select",
  "show",
  "some",
  "symmetric",
  "table",
  "then",
  "to",
  "trailing",
  "true",
  "union",
  "unique",
  "using",
  "variadic",
  "when",
  "where",
  "window",
  "with",
  // DuckDB-specific keywords beyond the ANSI set above.
  "anti",
  "asof",
  "by",
  "glob",
  "ilike",
  "like",
  "macro",
  "map",
  "positional",
  "semi",
  "struct",
  "summarize",
  "try_cast",
  "unpivot",
  "values",
  "virtual",
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

// ---------------------------------------------------------------------------
// Cloud object-store URL translation
// ---------------------------------------------------------------------------
// s3://, gs://, and az:// URLs are transparently rewritten to their public
// HTTPS gateway equivalents so they flow through the existing HTTP range reader
// pipeline without requiring the (unreliable in WASM) httpfs extension or
// CREATE SECRET. Only anonymous / public access is supported.
const CLOUD_URL_PATTERN = /\b(s3|gs|az):\/\/([^\s'"`,;)]+)/gi;

/** Map a single cloud URL to its public HTTPS equivalent. */
function cloudUrlToHttps(scheme: string, path: string): string {
  const lower = scheme.toLowerCase();
  const slashIndex = path.indexOf("/");
  if (lower === "s3") {
    // s3://bucket/key → https://bucket.s3.amazonaws.com/key
    const bucket = slashIndex >= 0 ? path.slice(0, slashIndex) : path;
    const key = slashIndex >= 0 ? path.slice(slashIndex) : "";
    return `https://${bucket}.s3.amazonaws.com${key}`;
  }
  if (lower === "gs") {
    // gs://bucket/key → https://storage.googleapis.com/bucket/key
    return `https://storage.googleapis.com/${path}`;
  }
  // az://account/container/key → https://account.blob.core.windows.net/container/key
  const account = slashIndex >= 0 ? path.slice(0, slashIndex) : path;
  const rest = slashIndex >= 0 ? path.slice(slashIndex) : "";
  return `https://${account}.blob.core.windows.net${rest}`;
}

/**
 * Replace every `s3://`, `gs://`, and `az://` URL in the SQL text with its
 * public HTTPS equivalent. Operates via {@link maskSqlLiterals} so URLs inside
 * comments and quoted identifiers are left untouched, but URLs inside string
 * literals (reader-function arguments) ARE translated since the user intends
 * those to be data sources.
 */
export function rewriteCloudUrls(sql: string): string {
  // Mask only comments and quoted identifiers (keep string literals intact) —
  // cloud URLs inside reader args like read_parquet('s3://…') must be rewritten.
  const masked = maskSqlLiterals(sql, false);
  let result = "";
  let lastIndex = 0;
  // Run the pattern against the original SQL (not the mask) to capture the real
  // URL text; check the mask only to skip URLs inside comments/identifiers.
  for (const match of sql.matchAll(CLOUD_URL_PATTERN)) {
    const index = match.index ?? 0;
    // If the position is blanked in the mask, it is inside a comment or quoted
    // identifier — skip it.
    if (masked[index] === " ") continue;
    result += sql.slice(lastIndex, index);
    result += cloudUrlToHttps(match[1], match[2]);
    lastIndex = index + match[0].length;
  }
  result += sql.slice(lastIndex);
  return result;
}

const BARE_SOURCE_PATTERN =
  /\b(from|join)\s+((?:https?:\/\/|\/|\.\/|\.\.\/|~\/|[A-Za-z]:[\\/])[^\s,;()]+)/gi;

// HTTP(S) URLs that are arguments to a native DuckDB reader are registered as
// DuckDB file handles so the JS runtime streams them via range requests. The
// in-WASM httpfs path used by a bare `read_parquet('https://…')` fails with
// "stoi: no conversion" on many servers. ST_Read (GDAL/vsicurl) URLs are left
// bare so GDAL handles them. Matching only reader-call arguments (rather than
// any URL) means a URL inside an unrelated string literal is never rewritten.
const REMOTE_READER_ARG_PATTERN =
  /\b(read_parquet|parquet_scan|read_csv_auto|read_csv|read_json_auto|read_json|read_ndjson_auto|read_ndjson)\s*\(\s*'(https?:\/\/[^']+)'/gi;

// Public sample dataset used both by the dialog's example queries and as the
// pre-spatial HTTP warm-up read. A pre-spatial remote read_parquet is what
// initialises the HTTP read path (see ensureSpatialExtension); when a query has
// no remote parquet of its own to warm up with (e.g. a local-only first query
// that would otherwise load spatial cold), this parquet is read instead — only
// its footer is fetched. Exported so the dialog shares the same single URL.
export const SAMPLE_DATASET_URL = "https://data.source.coop/giswqs/opengeos/countries.parquet";

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
  const needsPrefix = !!base && (!/^[a-z_]/.test(base) || RESERVED_TABLE_NAMES.has(base));
  const normalized = base ? (needsPrefix ? `t_${base}` : base) : "";
  return normalized || `layer_${layerId.replace(/[^a-z0-9]+/gi, "_")}`;
}

/**
 * Assign a unique table name to each layer that carries an in-memory GeoJSON
 * FeatureCollection. Names are derived from layer names and de-duplicated with a
 * numeric suffix on collision. Shared by registration and the UI preview so the
 * names cannot drift.
 */
export function assignTableNames(
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
export function previewLayerTables(layers: GeoLibreLayer[]): SqlWorkspaceTable[] {
  return assignTableNames(layers).map(({ layer, tableName }) => ({
    tableName,
    layerName: layer.name,
  }));
}

/** A loaded layer's queryable table name and the columns its table exposes. */
export interface SqlWorkspaceTableColumns {
  /** SQL identifier the user references in queries. */
  tableName: string;
  /** Column names available on the table (attributes plus the `geom` geometry). */
  columns: string[];
}

// The geometry column the DuckDB and PGlite engines materialise for a registered
// GeoJSON layer. The Sedona engine names it `geometry` instead, so the caller
// passes the engine-appropriate name (see previewLayerColumns).
const DEFAULT_LAYER_GEOMETRY_COLUMN = "geom";
// Cap how many features are scanned for property keys so a huge layer cannot
// make the (synchronous) autocomplete walk the whole collection.
const COLUMN_SCAN_FEATURE_LIMIT = 50;

/**
 * Compute, without touching DuckDB, the columns each layer table will expose so
 * the editor can autocomplete column names. Attribute columns come from the
 * union of feature property keys (scanning a bounded number of features); the
 * registered geometry column is appended.
 *
 * The result is a heuristic, not an exhaustive schema: only the first
 * {@link COLUMN_SCAN_FEATURE_LIMIT} features are scanned, so a property that
 * appears only in later features of a sparse layer may be omitted from the
 * completions (the query itself still works).
 *
 * @param layers Current app layers; those without `geojson` are skipped.
 * @param geometryColumn The geometry column name the active engine registers
 *   (`geom` for DuckDB/PGlite, `geometry` for Sedona). Defaults to `geom`.
 * @returns Table name and its column names, in the same naming as registration.
 */
export function previewLayerColumns(
  layers: GeoLibreLayer[],
  geometryColumn: string = DEFAULT_LAYER_GEOMETRY_COLUMN,
): SqlWorkspaceTableColumns[] {
  return assignTableNames(layers).map(({ layer, tableName }) => {
    const seen = new Set<string>();
    // Lowercased keys so the geometry column is not offered twice when a
    // property already provides it under different casing (e.g. "GEOM").
    const seenLower = new Set<string>();
    const columns: string[] = [];
    const features = layer.geojson?.features ?? [];
    for (const feature of features.slice(0, COLUMN_SCAN_FEATURE_LIMIT)) {
      const properties = feature.properties;
      if (!properties) continue;
      for (const key of Object.keys(properties)) {
        // Skip GDAL's synthetic FID: it is dropped from registered layers, so
        // offering it as a completion would only mislead.
        if (key === GDAL_AUTO_FID_COLUMN || seen.has(key)) continue;
        seen.add(key);
        seenLower.add(key.toLowerCase());
        columns.push(key);
      }
    }
    if (!seenLower.has(geometryColumn.toLowerCase())) {
      columns.push(geometryColumn);
    }
    return { tableName, columns };
  });
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
    // assignTableNames already filters out layers without geojson; this guard
    // narrows the optional `layer.geojson` to FeatureCollection for the call
    // below (TypeScript does not carry the filter's narrowing across functions).
    if (!layer.geojson) continue;
    const fileName = `${filePrefix}__${tableName}.geojson`;
    await db.registerFileText(fileName, JSON.stringify(stripAutoFidColumn(layer.geojson)));
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
export function normalizeValue(value: unknown): unknown {
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

export function normalizeRow(
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
          `${quoteIdentifier(SQL_SUBQUERY_ALIAS)} LIMIT 0`,
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
      geometryColumn: typeof geometryColumn === "string" ? geometryColumn : null,
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
 *
 * The scanner always parses literals and comments (so a `--` inside a string is
 * not mistaken for a comment), but `blankLiterals` controls whether literal
 * content is blanked. Callers that need to find the end of the real statement
 * (e.g. `cleanStatement`) pass `false` so a trailing string literal is not
 * mistaken for trailing whitespace.
 */
export function maskSqlLiterals(sql: string, blankLiterals = true): string {
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
      if (blankLiterals) blank(i, j + 1);
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
        if (blankLiterals) blank(i, end);
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
export function cleanStatement(sql: string): string {
  const src = sql.trim();
  // Blank comments only (keep string literals): trimming the mask then drops a
  // trailing comment without mistaking a trailing string literal — e.g. the
  // `'a;b'` in `SELECT 'a;b'` — for trailing whitespace.
  const masked = maskSqlLiterals(src, false);
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
export function containsMultipleStatements(sql: string): boolean {
  const masked = maskSqlLiterals(sql);
  const semicolon = masked.indexOf(";");
  // A semicolon is only a statement separator when real content follows it;
  // trailing comments/whitespace have already been blanked by the mask.
  return semicolon !== -1 && masked.slice(semicolon + 1).trim().length > 0;
}

/** Pick the DuckDB table function for a data source extension, if recognised. */
function readerForExtension(extension: string): string | null {
  return DATA_SOURCE_READERS.find((entry) => entry.extensions.includes(extension))?.reader ?? null;
}

/**
 * Rewrite a bare URL or file path after FROM/JOIN into the matching DuckDB
 * reader (`read_parquet`, `read_csv_auto`, `read_json_auto`, or `ST_Read`) by
 * file extension, so `SELECT * FROM https://host/data.parquet` works. Sources
 * with an unrecognised extension, and anything already quoted or wrapped in a
 * function call, are left unchanged.
 */
function rewriteBareSources(sql: string): string {
  // Match against the masked SQL so a `FROM`/`JOIN` that appears inside a string
  // literal or comment is never rewritten; the match indices are valid against
  // the original string, and the matched source text is code (never masked).
  const masked = maskSqlLiterals(sql);
  let result = "";
  let lastIndex = 0;
  for (const match of masked.matchAll(BARE_SOURCE_PATTERN)) {
    const index = match.index ?? 0;
    const whole = sql.slice(index, index + match[0].length);
    const keyword = match[1];
    const source = match[2];
    const path = source.split(/[?#]/)[0];
    const dot = path.lastIndexOf(".");
    const extension = dot >= 0 ? path.slice(dot + 1).toLowerCase() : "";
    const reader = readerForExtension(extension);
    result += sql.slice(lastIndex, index);
    result += reader ? `${keyword} ${reader}(${quoteSqlString(source)})` : whole;
    lastIndex = index + match[0].length;
  }
  result += sql.slice(lastIndex);
  return result;
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
  const matches = matchRemoteReaderCalls(statement);

  // Collect each distinct URL that is a native reader's argument, keeping the
  // first reader function it appears with (used to warm up the HTTP path).
  const readerByUrl = new Map<string, string>();
  for (const match of matches) {
    const url = match[2];
    if (!readerByUrl.has(url)) readerByUrl.set(url, match[1].toLowerCase());
  }
  if (readerByUrl.size === 0) return { statement, readerCalls: [] };

  const handleByUrl = new Map<string, string>();
  const readerCalls: string[] = [];
  let index = 0;
  for (const [url, reader] of readerByUrl) {
    const handle = remoteHandleName(filePrefix, index, url);
    index += 1;
    // directIO = true forces range-based reads so the whole file is never
    // buffered locally.
    await db.registerFileURL(handle, url, DuckDBDataProtocol.HTTP, true);
    registeredFiles.push(handle);
    handleByUrl.set(url, handle);
    readerCalls.push(`${reader}(${quoteSqlString(handle)})`);
  }

  // Rebuild the statement replacing only the matched (code) reader-call
  // arguments via their indices. The pattern matches up to the URL's closing
  // quote but not the call's closing paren, so the replacement must not add one:
  // the original `)` and any trailing arguments stay in place.
  let rewritten = "";
  let lastIndex = 0;
  for (const match of matches) {
    const matchIndex = match.index ?? 0;
    const handle = handleByUrl.get(match[2]);
    rewritten += statement.slice(lastIndex, matchIndex);
    rewritten += handle ? `${match[1]}(${quoteSqlString(handle)}` : match[0];
    lastIndex = matchIndex + match[0].length;
  }
  rewritten += statement.slice(lastIndex);
  return { statement: rewritten, readerCalls };
}

export function rowsToFeatureCollection(
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
      // Drop GDAL's synthetic FID so a SQL-result layer never carries the
      // OGC_FID artefact into its attributes/exports — and so re-reading it
      // can't trigger the duplicate-column Binder Error (issue #499).
      // stripAutoFidColumn remains the belt-and-braces guard at registration
      // time for layers that arrive via other paths (drag-drop, project
      // restore, plugins) and already carry OGC_FID.
      if (key === GDAL_AUTO_FID_COLUMN) continue;
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
export async function runSqlQuery(sql: string, layers: GeoLibreLayer[]): Promise<SqlQueryResult> {
  // Strip a trailing semicolon and any trailing comment (literal-aware) so the
  // statement can be wrapped in the geometry-detection subquery `... FROM
  // (<sql>) AS ...` without the terminator or a line comment breaking it.
  const cleaned = cleanStatement(sql);
  if (containsMultipleStatements(cleaned)) {
    throw new Error(
      "Only a single SQL statement is supported. Remove any intermediate semicolons.",
    );
  }
  // Translate cloud object-store URLs (s3://, gs://, az://) to their public
  // HTTPS equivalents so they flow through the HTTP range reader pipeline.
  const withCloudUrls = rewriteCloudUrls(cleaned);
  // Wrap bare URLs/paths after FROM/JOIN in the matching reader so the
  // convenient `SELECT * FROM https://…/x.parquet` form runs.
  const rewritten = rewriteBareSources(withCloudUrls);

  // Only a query that actually reads a remote source can hit the poisoned-
  // instance path, so gate the recovery on a real remote reader call (not an
  // http URL that merely appears in a string literal or WHERE clause).
  const hasRemoteReader = statementHasRemoteReader(rewritten);

  // Run one attempt, ref-counting the instance so a poison recovery can defer
  // terminating it until no query is still using it.
  const attempt = async (db: AsyncDuckDB): Promise<SqlQueryResult> => {
    acquireSqlDatabase(db);
    try {
      return await runSqlStatementOnce(rewritten, layers, db);
    } finally {
      await releaseSqlDatabase(db);
    }
  };

  const db = await getSqlDatabase();
  try {
    return await attempt(db);
  } catch (error) {
    // Recover from a poisoned WASM instance: duckdb-wasm 1.33.1-dev45 breaks
    // remote read_parquet with "stoi: no conversion" on an instance that ran
    // LOAD spatial before its first successful remote read (e.g. after an
    // earlier query's warm-up failed). That state cannot be undone in place, so
    // rebuild the SQL Workspace's dedicated instance — which re-runs the
    // pre-spatial warm-up — and retry once. `attempt` has already released `db`,
    // so resetSqlDatabase tears it down now unless another query is still on it.
    if (hasRemoteReader && isStoiConversionError(error)) {
      await resetSqlDatabase(db);
      return await attempt(await getSqlDatabase());
    }
    throw error;
  }
}

/** True when an error is the duckdb-wasm poisoned-instance "stoi" symptom. */
function isStoiConversionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /stoi:\s*no conversion/i.test(message);
}

/**
 * The native reader calls with an http(s) URL argument in a statement, ignoring
 * any that appear inside a string literal or comment. Matches against the masked
 * SQL (a match whose start is blanked in the mask is not real code); the match
 * indices are valid against the original string, and the reader keyword and URL
 * the pattern captures are code (never masked).
 */
function matchRemoteReaderCalls(statement: string): RegExpMatchArray[] {
  const masked = maskSqlLiterals(statement);
  return [...statement.matchAll(REMOTE_READER_ARG_PATTERN)].filter(
    (match) => masked[match.index ?? 0] !== " ",
  );
}

/**
 * True when the statement contains a real remote-reader call (a native reader
 * with an http(s) URL argument), ignoring URLs inside string literals.
 */
function statementHasRemoteReader(statement: string): boolean {
  return matchRemoteReaderCalls(statement).length > 0;
}

/**
 * Runs one attempt of a prepared SQL statement against a DuckDB instance. Split
 * out of {@link runSqlQuery} so it can be retried against a freshly rebuilt
 * instance when the current one's remote read path is poisoned.
 */
async function runSqlStatementOnce(
  rewritten: string,
  layers: GeoLibreLayer[],
  db: AsyncDuckDB,
): Promise<SqlQueryResult> {
  const connection = await db.connect();
  // Per-run prefix so concurrent queries on the shared database do not register
  // or drop one another's VFS files. Populated by registerLayerTables and
  // registerRemoteSources as they create handles so cleanup matches exactly
  // what was registered.
  const filePrefix = `__geolibre_sql_${Date.now()}_${Math.random().toString(36).slice(2)}`;
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
    // read_parquet and its alias parquet_scan both initialise the HTTP read
    // path; only fall back to the default warmup when neither is present.
    if (
      !warmups.some((call) => call.startsWith("read_parquet") || call.startsWith("parquet_scan"))
    ) {
      warmups.push(`read_parquet(${quoteSqlString(SAMPLE_DATASET_URL)})`);
    }
    await ensureSpatialExtension(db, connection, async () => {
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
      const columns = allColumns.filter((column) => column !== GEOMETRY_JSON_COLUMN);
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
    const rows = rowsFromResult(result).map((row) => normalizeRow(row, columns));
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
export function resultToCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const escape = (value: unknown): string => {
    if (value === null || value === undefined) return "";
    const text = typeof value === "object" ? JSON.stringify(value) : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const lines = [columns.map(escape).join(",")];
  for (const row of rows) {
    lines.push(columns.map((column) => escape(row[column])).join(","));
  }
  // RFC 4180 specifies CRLF line endings for the broadest spreadsheet support.
  return lines.join("\r\n");
}
