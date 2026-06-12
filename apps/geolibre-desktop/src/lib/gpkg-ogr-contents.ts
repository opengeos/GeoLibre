import type { Database, SqlJsStatic } from "sql.js";

/**
 * Ensures a GeoPackage carries the `gpkg_ogr_contents` feature-count table so
 * DuckDB-WASM's `ST_Read` can open it without crashing.
 *
 * GeoPackages written without `gpkg_ogr_contents` (e.g. by QGIS, or any tool
 * that skips the OGR feature-count cache) force GDAL's GeoPackage driver to
 * compute the feature count the slow way, which sends it down a multithreaded
 * Arrow read path. That path calls `std::thread`/`pthread_create`, and the
 * single-threaded DuckDB-WASM `eh` bundle the app loads in the browser and the
 * Tauri webview has no pthread support, so the read fails with:
 *
 *   "thread constructor failed: Resource temporarily unavailable"
 *
 * Injecting `gpkg_ogr_contents` with a cached count keeps GDAL on the fast,
 * single-threaded path. See GitHub issue #258.
 */

const SQLITE_MAGIC = "SQLite format 3\0";

/** A SQLite/GeoPackage file begins with the 16-byte "SQLite format 3\0" magic. */
export function looksLikeSqlite(bytes: Uint8Array): boolean {
  if (bytes.length < SQLITE_MAGIC.length) return false;
  for (let i = 0; i < SQLITE_MAGIC.length; i += 1) {
    if (bytes[i] !== SQLITE_MAGIC.charCodeAt(i)) return false;
  }
  return true;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function tableExists(db: Database, name: string): boolean {
  const result = db.exec(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=:name",
    { ":name": name },
  );
  return result.length > 0 && result[0].values.length > 0;
}

/**
 * Synchronous core of {@link ensureGpkgFeatureCount}, kept separate so it can be
 * unit-tested with an already-initialised sql.js factory. Returns the original
 * buffer unchanged when the file is not a GeoPackage or already has a count for
 * every feature table; otherwise returns a patched buffer.
 *
 * Loads the whole file into the sql.js WASM heap. When patching is needed the
 * exported buffer is a second full-size allocation, so peak memory is roughly
 * 2x the file size. Fine for typical browser-side GeoPackages.
 */
export function ensureGpkgFeatureCountSync(
  SQL: SqlJsStatic,
  bytes: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> {
  const db = new SQL.Database(bytes);
  try {
    // Only touch real GeoPackages; gpkg_contents is mandatory in the spec.
    if (!tableExists(db, "gpkg_contents")) return bytes;

    const featureTablesResult = db.exec(
      // lower() so out-of-spec producers writing 'Features'/'FEATURES' still match.
      "SELECT table_name FROM gpkg_contents WHERE lower(data_type)='features'",
    );
    if (
      featureTablesResult.length === 0 ||
      featureTablesResult[0].values.length === 0
    ) {
      return bytes;
    }
    const featureTables = featureTablesResult[0].values
      .map((row) => row[0])
      .filter((name): name is string => typeof name === "string");

    const hasOgrContents = tableExists(db, "gpkg_ogr_contents");
    const existingCounts = hasOgrContents
      ? new Set(
          (
            db.exec("SELECT table_name FROM gpkg_ogr_contents")[0]?.values ?? []
          )
            .map((row) => row[0])
            .filter((name): name is string => typeof name === "string"),
        )
      : new Set<string>();

    const missing = featureTables.filter((name) => !existingCounts.has(name));
    if (missing.length === 0) return bytes;

    if (!hasOgrContents) {
      db.run(
        "CREATE TABLE gpkg_ogr_contents (" +
          "table_name TEXT NOT NULL PRIMARY KEY, " +
          "feature_count INTEGER DEFAULT NULL)",
      );
    }

    for (const tableName of missing) {
      const countResult = db.exec(
        `SELECT count(*) FROM ${quoteIdentifier(tableName)}`,
      );
      const count = countResult[0]?.values[0]?.[0] ?? 0;
      db.run(
        "INSERT INTO gpkg_ogr_contents (table_name, feature_count) VALUES (:name, :count)",
        { ":name": tableName, ":count": count },
      );
    }

    // sql.js always exports an ArrayBuffer-backed Uint8Array; re-narrow the type.
    return db.export() as Uint8Array<ArrayBuffer>;
  } finally {
    db.close();
  }
}

let sqlJsPromise: Promise<SqlJsStatic> | null = null;

async function loadSqlJs(): Promise<SqlJsStatic> {
  sqlJsPromise ??= (async () => {
    const [{ default: initSqlJs }, { default: wasmUrl }] = await Promise.all([
      import("sql.js"),
      // Bundled locally by Vite (works offline and in the Tauri webview).
      import("sql.js/dist/sql-wasm.wasm?url"),
    ]);
    return initSqlJs({ locateFile: () => wasmUrl });
  })();
  try {
    return await sqlJsPromise;
  } catch (error) {
    sqlJsPromise = null;
    throw error;
  }
}

/**
 * Returns a GeoPackage buffer guaranteed to carry `gpkg_ogr_contents` for every
 * feature table, patching it in-memory when needed. Non-GeoPackage input and
 * already-complete files are returned untouched. Best-effort: if sql.js fails to
 * load or the file cannot be parsed, the original buffer is returned so the
 * normal `ST_Read` error path still applies.
 */
export async function ensureGpkgFeatureCount(
  bytes: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!looksLikeSqlite(bytes)) return bytes;
  try {
    const SQL = await loadSqlJs();
    return ensureGpkgFeatureCountSync(SQL, bytes);
  } catch (error) {
    console.warn(
      "[GeoLibre] Could not ensure gpkg_ogr_contents; reading file as-is.",
      error,
    );
    return bytes;
  }
}
