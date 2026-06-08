import * as duckdb from "@duckdb/duckdb-wasm";
import duckdbWasmEh from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import ehWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import duckdbWasmMvp from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import mvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import type { Feature, FeatureCollection, Geometry } from "geojson";

const GEOMETRY_JSON_COLUMN = "__geolibre_geometry_geojson";
const EXPORT_GEOJSON_EXTENSION = "geojson";
const EXPORT_GEOPARQUET_EXTENSION = "parquet";
const TARGET_CRS = "EPSG:4326";

const MANUAL_BUNDLES: duckdb.DuckDBBundles = {
  mvp: {
    mainModule: duckdbWasmMvp,
    mainWorker: mvpWorker,
  },
  eh: {
    mainModule: duckdbWasmEh,
    mainWorker: ehWorker,
  },
};

let dbPromise: Promise<duckdb.AsyncDuckDB> | null = null;

interface DuckDbRow {
  toJSON?: () => Record<string, unknown>;
  [key: string]: unknown;
}

export interface DuckDbVectorFile {
  name: string;
  extension: string;
  data: Uint8Array<ArrayBuffer>;
  siblingFiles?: DuckDbVectorFile[];
}

export function getDatabase(): Promise<duckdb.AsyncDuckDB> {
  dbPromise ??= createDatabase();
  return dbPromise;
}

let spatialExtensionPromise: Promise<void> | null = null;

/**
 * Install and load the DuckDB spatial extension once per database instance.
 * `getDatabase` returns a memoized singleton, so the extension persists across
 * connections and the redundant INSTALL/LOAD queries are skipped on reuse.
 *
 * The load is memoized as a promise rather than a boolean so concurrent callers
 * (the function is exported and reused) share a single INSTALL/LOAD instead of
 * each racing to run it. On failure the memo is cleared so a later call retries.
 */
export async function ensureSpatialExtension(
  connection: duckdb.AsyncDuckDBConnection,
  beforeLoad?: () => Promise<void>,
): Promise<void> {
  spatialExtensionPromise ??= (async () => {
    // duckdb-wasm 1.33.1-dev45 breaks remote read_parquet if the spatial
    // extension is loaded before the first remote HTTP read on the database.
    // `beforeLoad` lets the caller warm up that path (a pre-spatial remote read)
    // before INSTALL/LOAD, which is the only thing that initialises it.
    if (beforeLoad) {
      try {
        await beforeLoad();
      } catch {
        // Warm-up is best-effort; a failure here must not block spatial loading.
      }
    }
    await connection.query("INSTALL spatial");
    await connection.query("LOAD spatial");
  })();
  try {
    await spatialExtensionPromise;
  } catch (error) {
    spatialExtensionPromise = null;
    throw error;
  }
}

async function createDatabase(): Promise<duckdb.AsyncDuckDB> {
  const bundle = await duckdb.selectBundle(MANUAL_BUNDLES);
  const worker = new Worker(bundle.mainWorker!, { type: "module" });
  const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
  const db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  // Open the database so its runtime/filesystem config is initialised. Without
  // this, locally registered buffers still read, but remote HTTP reads fail
  // (e.g. read_parquet over https throws "stoi: no conversion"). This mirrors
  // how maplibre-gl-duckdb initialises the engine that reads remote files.
  await db.open({});
  return db;
}

export function quoteSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function exportBaseName(): string {
  const suffix = Math.random().toString(36).slice(2);
  return `__geolibre_export_${Date.now()}_${suffix}`;
}

export function rowsFromResult(result: { toArray: () => DuckDbRow[] }) {
  return result.toArray().map((row) =>
    typeof row.toJSON === "function" ? row.toJSON() : { ...row },
  );
}

// DuckDB Spatial reports CRS-annotated geometry types such as
// GEOMETRY('EPSG:4326'), so match on the prefix rather than equality.
export function isGeometryColumnType(columnType: unknown): boolean {
  return (
    typeof columnType === "string" &&
    columnType.toUpperCase().startsWith("GEOMETRY")
  );
}

function isParquetExtension(extension: string): boolean {
  return extension === "parquet" || extension === "geoparquet";
}

function sourceSql(fileName: string, extension: string): string {
  const quotedName = quoteSqlString(fileName);
  if (isParquetExtension(extension)) {
    return `SELECT * FROM read_parquet(${quotedName})`;
  }
  return `SELECT * FROM ST_Read(${quotedName})`;
}

function crsSql(fileName: string): string {
  return `
    SELECT
      -- Always reads the first layer's first geometry field. This matches
      -- ST_Read's default (no layer= argument) but would be wrong for
      -- multi-layer or multi-geometry-column files if layer selection is added.
      layers[1].geometry_fields[1].crs.auth_name AS auth_name,
      layers[1].geometry_fields[1].crs.auth_code AS auth_code
    FROM ST_Read_Meta(${quoteSqlString(fileName)})
  `;
}

async function readSourceCrs(
  connection: duckdb.AsyncDuckDBConnection,
  file: DuckDbVectorFile,
): Promise<string | null> {
  // GeoParquet CRS is not read via ST_Read_Meta, so reprojection is skipped.
  // A spec-valid GeoParquet file not stored in WGS84 will render with wrong
  // coordinates; revisit if/when DuckDB exposes its CRS metadata here.
  if (isParquetExtension(file.extension)) {
    return null;
  }

  try {
    const row = rowsFromResult(await connection.query(crsSql(file.name)))[0];
    if (!row) return null;
    const authName =
      typeof row.auth_name === "string" ? row.auth_name.trim() : "";
    const authCode = row.auth_code != null ? String(row.auth_code).trim() : "";
    if (!authName || !authCode) return null;
    return `${authName.toUpperCase()}:${authCode}`;
  } catch (err) {
    console.warn(
      "[GeoLibre] Could not read CRS metadata; reprojection skipped.",
      err,
    );
    return null;
  }
}

function geometryGeoJsonSql(
  geometryColumn: string,
  sourceCrs: string | null,
): string {
  const geometrySql = quoteIdentifier(geometryColumn);
  if (!sourceCrs) {
    return `ST_AsGeoJSON(${geometrySql})`;
  }
  // Transform even for EPSG:4326 sources: always_xy=true normalises axis order
  // to lon/lat, which a no-op EPSG:4326 -> EPSG:4326 transform guarantees for
  // formats that may store data as lat/lon.
  return `ST_AsGeoJSON(ST_Transform(${geometrySql}, ${quoteSqlString(
    sourceCrs,
  )}, ${quoteSqlString(TARGET_CRS)}, true))`;
}

function toFeatureCollection(
  rows: Record<string, unknown>[],
): FeatureCollection<Geometry | null> {
  const features = rows.map((row) => {
    const rawGeometry = row[GEOMETRY_JSON_COLUMN];
    // ST_AsGeoJSON returns SQL NULL for rows with missing/NULL geometries.
    // GeoJSON Features may legally have a null geometry, so keep the row.
    const geometry =
      typeof rawGeometry === "string"
        ? (JSON.parse(rawGeometry) as Geometry)
        : null;
    const properties: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(row)) {
      if (key === GEOMETRY_JSON_COLUMN || value instanceof Uint8Array) continue;
      properties[key] = normalizePropertyValue(value);
    }

    return {
      type: "Feature",
      geometry,
      properties,
    } satisfies Feature<Geometry | null>;
  });

  return {
    type: "FeatureCollection",
    features,
  };
}

function normalizePropertyValue(value: unknown): unknown {
  if (typeof value === "bigint") {
    const numberValue = Number(value);
    return Number.isSafeInteger(numberValue) ? numberValue : value.toString();
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizePropertyValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        normalizePropertyValue(item),
      ]),
    );
  }
  return value;
}

export async function loadDuckDbVectorFile(
  file: DuckDbVectorFile,
): Promise<FeatureCollection> {
  const db = await getDatabase();
  const connection = await db.connect();

  try {
    await db.registerFileBuffer(file.name, file.data);
    for (const sibling of file.siblingFiles ?? []) {
      await db.registerFileBuffer(sibling.name, sibling.data);
    }
    await ensureSpatialExtension(connection);

    const sql = sourceSql(file.name, file.extension);
    const description = rowsFromResult(
      await connection.query(`DESCRIBE ${sql}`),
    );
    const geometryColumn = description.find((row) =>
      isGeometryColumnType(row.column_type),
    )?.column_name;

    if (typeof geometryColumn !== "string") {
      throw new Error("DuckDB did not find a GEOMETRY column in this file.");
    }

    const sourceCrs = await readSourceCrs(connection, file);
    const geometryJsonSql = geometryGeoJsonSql(geometryColumn, sourceCrs);
    const result = await connection.query(
      `SELECT *, ${geometryJsonSql} AS ${quoteIdentifier(
        GEOMETRY_JSON_COLUMN,
      )} FROM (${sql}) AS data`,
    );
    // Features may carry a null geometry; the app's layer model treats them as
    // a regular FeatureCollection and the map ignores null geometries.
    return toFeatureCollection(rowsFromResult(result)) as FeatureCollection;
  } finally {
    await connection.close();
  }
}

async function dropFilesIfPresent(
  db: duckdb.AsyncDuckDB,
  fileNames: string[],
): Promise<void> {
  try {
    await db.dropFiles(fileNames);
  } catch {
    // Some files are optional or may not have been created yet.
  }
}

async function registerGeoJsonExportSource(
  db: duckdb.AsyncDuckDB,
  geojson: FeatureCollection,
  sourceFile: string,
): Promise<void> {
  await db.registerFileText(sourceFile, JSON.stringify(geojson));
}

export interface GeoParquetConversionOptions {
  compression?: string;
  rowGroupSize?: number;
  /**
   * When set, the input is read as a CSV and a point geometry is built from
   * the named longitude/latitude columns (assumed WGS84).
   */
  csv?: { lonColumn: string; latColumn: string };
}

export interface GeoParquetConversionResult {
  data: Uint8Array;
  /**
   * Number of rows written, or `undefined` — DuckDB-WASM does not surface the
   * COPY row count, so the count is only populated when a caller opts into the
   * extra scan. It is left out here to avoid a second full pass over the data.
   */
  featureCount?: number;
  geometryColumn: string;
}

const GEOPARQUET_COMPRESSIONS = new Set([
  "zstd",
  "snappy",
  "gzip",
  "lz4",
  "uncompressed",
]);
const DEFAULT_GEOPARQUET_COMPRESSION = "zstd";
const DEFAULT_GEOPARQUET_ROW_GROUP_SIZE = 30000;

// Well-known WKB geometry column names used when a plain Parquet input lacks
// a GEOMETRY-typed column. Mirrors the sidecar's vector conversion fallback.
const WKB_GEOMETRY_COLUMN_NAMES = new Set(["geometry", "geom", "wkb_geometry"]);

/**
 * Convert an in-memory vector file to a Hilbert-sorted, compressed GeoParquet
 * entirely inside DuckDB-WASM. Rows are ordered by ST_Hilbert over the
 * dataset extent so row groups stay spatially clustered for range requests.
 */
export async function convertDuckDbVectorToGeoParquet(
  file: DuckDbVectorFile,
  options: GeoParquetConversionOptions = {},
): Promise<GeoParquetConversionResult> {
  const compression = (
    options.compression ?? DEFAULT_GEOPARQUET_COMPRESSION
  ).toLowerCase();
  if (!GEOPARQUET_COMPRESSIONS.has(compression)) {
    throw new Error(`Unsupported Parquet compression: ${compression}`);
  }
  const rowGroupSize = Math.trunc(
    options.rowGroupSize ?? DEFAULT_GEOPARQUET_ROW_GROUP_SIZE,
  );
  if (!Number.isFinite(rowGroupSize) || rowGroupSize <= 0) {
    throw new Error("Row group size must be a positive integer.");
  }

  const db = await getDatabase();
  const connection = await db.connect();
  const outputFile = `${exportBaseName()}.${EXPORT_GEOPARQUET_EXTENSION}`;
  const registeredFiles = [
    file.name,
    ...(file.siblingFiles ?? []).map((sibling) => sibling.name),
  ];

  try {
    await db.registerFileBuffer(file.name, file.data);
    for (const sibling of file.siblingFiles ?? []) {
      await db.registerFileBuffer(sibling.name, sibling.data);
    }
    await ensureSpatialExtension(connection);

    let geometryColumn: string;
    let source: string;
    if (options.csv) {
      // Build a point geometry from CSV lon/lat columns (assumed WGS84).
      geometryColumn = "geometry";
      const geometrySql = quoteIdentifier(geometryColumn);
      const lonSql = quoteIdentifier(options.csv.lonColumn);
      const latSql = quoteIdentifier(options.csv.latColumn);
      source =
        `SELECT *, ST_Point(CAST(${lonSql} AS DOUBLE), CAST(${latSql} AS DOUBLE)) ` +
        `AS ${geometrySql} FROM read_csv_auto(${quoteSqlString(file.name)}, header=true)`;
    } else {
      const sql = sourceSql(file.name, file.extension);
      const description = rowsFromResult(
        await connection.query(`DESCRIBE ${sql}`),
      );
      let detected = description.find((row) =>
        isGeometryColumnType(row.column_type),
      )?.column_name;
      let geometryIsNative = true;
      if (typeof detected !== "string") {
        // Plain Parquet files may carry geometry as a WKB blob; rebuild it as a
        // GEOMETRY column so ST_Hilbert and the GeoParquet writer can use it.
        detected = description.find(
          (row) =>
            typeof row.column_name === "string" &&
            WKB_GEOMETRY_COLUMN_NAMES.has(row.column_name.toLowerCase()),
        )?.column_name as string | undefined;
        geometryIsNative = false;
      }
      if (typeof detected !== "string") {
        throw new Error("DuckDB did not find a geometry column in this file.");
      }
      geometryColumn = detected;
      const geometrySql = quoteIdentifier(geometryColumn);
      source = geometryIsNative
        ? sql
        : `SELECT * REPLACE (ST_GeomFromWKB(${geometrySql}) AS ${geometrySql}) FROM (${sql}) AS data`;
    }

    const geometrySql = quoteIdentifier(geometryColumn);

    // DuckDB-WASM's connection.query does not surface the COPY row count, and a
    // separate COUNT(*) would scan the whole dataset a second time, so the
    // feature count is left undefined to keep the in-browser path single-pass.
    await connection.query(
      `COPY (
        WITH src AS (${source}),
        b AS (SELECT ST_Extent(ST_Extent_Agg(${geometrySql})) AS box FROM src)
        SELECT * FROM src
        ORDER BY ST_Hilbert(${geometrySql}, (SELECT box FROM b))
      ) TO ${quoteSqlString(outputFile)} (FORMAT PARQUET, COMPRESSION ${quoteSqlString(
        compression,
      )}, ROW_GROUP_SIZE ${rowGroupSize})`,
    );
    await db.flushFiles();
    const data = await db.copyFileToBuffer(outputFile);
    return { data, geometryColumn };
  } finally {
    await connection.close();
    await dropFilesIfPresent(db, [...registeredFiles, outputFile]);
  }
}

export async function exportDuckDbGeoParquet(
  geojson: FeatureCollection,
): Promise<Uint8Array> {
  const db = await getDatabase();
  const connection = await db.connect();
  const baseName = exportBaseName();
  const sourceFile = `${baseName}.${EXPORT_GEOJSON_EXTENSION}`;
  const outputFile = `${baseName}.${EXPORT_GEOPARQUET_EXTENSION}`;

  try {
    await registerGeoJsonExportSource(db, geojson, sourceFile);
    await ensureSpatialExtension(connection);
    await connection.query(
      `COPY (SELECT * FROM ST_Read(${quoteSqlString(
        sourceFile,
      )})) TO ${quoteSqlString(outputFile)} (FORMAT PARQUET)`,
    );
    await db.flushFiles();
    return await db.copyFileToBuffer(outputFile);
  } finally {
    await connection.close();
    await dropFilesIfPresent(db, [sourceFile, outputFile]);
  }
}
