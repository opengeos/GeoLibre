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

function getDatabase(): Promise<duckdb.AsyncDuckDB> {
  dbPromise ??= createDatabase();
  return dbPromise;
}

let spatialExtensionLoaded = false;

/**
 * Install and load the DuckDB spatial extension once per database instance.
 * `getDatabase` returns a memoized singleton, so the extension persists across
 * connections and the redundant INSTALL/LOAD queries are skipped on reuse.
 */
async function ensureSpatialExtension(
  connection: duckdb.AsyncDuckDBConnection,
): Promise<void> {
  if (spatialExtensionLoaded) return;
  await connection.query("INSTALL spatial");
  await connection.query("LOAD spatial");
  spatialExtensionLoaded = true;
}

async function createDatabase(): Promise<duckdb.AsyncDuckDB> {
  const bundle = await duckdb.selectBundle(MANUAL_BUNDLES);
  const worker = new Worker(bundle.mainWorker!, { type: "module" });
  const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
  const db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  return db;
}

function quoteSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function exportBaseName(): string {
  const suffix = Math.random().toString(36).slice(2);
  return `__geolibre_export_${Date.now()}_${suffix}`;
}

function rowsFromResult(result: { toArray: () => DuckDbRow[] }) {
  return result.toArray().map((row) =>
    typeof row.toJSON === "function" ? row.toJSON() : { ...row },
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
    const geometryColumn = description.find(
      (row) =>
        typeof row.column_type === "string" &&
        row.column_type.toUpperCase() === "GEOMETRY",
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
