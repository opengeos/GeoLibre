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
 * single-threaded path. The same crash happens when the row exists but its
 * `feature_count` is NULL/stale (GDAL recomputes it), so we repair those too.
 * See GitHub issues #258 and #376.
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

/** Quote a SQLite identifier (table/column name) by doubling embedded quotes. */
export function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/** Whether a table of the given name exists in the SQLite database. */
export function tableExists(db: Database, name: string): boolean {
  const result = db.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name=:name", {
    ":name": name,
  });
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

    // The set of feature (vector) tables is the union of two authoritative
    // sources: gpkg_contents rows typed 'features', and every table listed in
    // gpkg_geometry_columns. Out-of-spec producers sometimes mistype or omit
    // the gpkg_contents row while still registering the geometry column, so
    // relying on gpkg_contents alone misses those tables. lower() so producers
    // writing 'Features'/'FEATURES' still match.
    // SQLite identifiers are case-insensitive, but the metadata tables can
    // disagree on casing (e.g. gpkg_contents says 'Places' while
    // gpkg_ogr_contents says 'places'). Key everything by the lowercased name so
    // those resolve to one table — comparing case-sensitively would otherwise
    // report a false "missing" table and INSERT a duplicate ogr_contents row.
    const featureTables = new Map<string, string>(); // lowercase key → canonical name
    for (const sql of [
      "SELECT table_name FROM gpkg_contents WHERE lower(data_type)='features'",
      ...(tableExists(db, "gpkg_geometry_columns")
        ? ["SELECT table_name FROM gpkg_geometry_columns"]
        : []),
    ]) {
      for (const row of db.exec(sql)[0]?.values ?? []) {
        // First-seen wins: gpkg_contents is queried first, so its (spec-primary)
        // spelling is kept as the canonical name even when gpkg_geometry_columns
        // lists the same table with different casing.
        const name = row[0];
        if (typeof name === "string" && !featureTables.has(name.toLowerCase())) {
          featureTables.set(name.toLowerCase(), name);
        }
      }
    }
    if (featureTables.size === 0) return bytes;

    const hasOgrContents = tableExists(db, "gpkg_ogr_contents");
    // A table is only "safe" when its cached count is a real integer. A row
    // whose feature_count is NULL (or any non-integer) is NOT safe: GDAL treats
    // it as unknown and recomputes the count on read, which is the multithreaded
    // path that aborts with "thread constructor failed: Resource temporarily
    // unavailable" on the single-threaded WASM build. Many writers create the
    // gpkg_ogr_contents row but leave feature_count NULL, so checking only for
    // the row's presence (the previous behaviour) let those files through. See
    // issues #258 and #376.
    const tablesWithValidCount = new Set<string>(); // lowercase keys
    const tablesWithRow = new Map<string, string>(); // lowercase key → name as stored
    if (hasOgrContents) {
      for (const row of db.exec(
        "SELECT table_name, typeof(feature_count), feature_count FROM gpkg_ogr_contents",
      )[0]?.values ?? []) {
        const name = row[0];
        if (typeof name !== "string") continue;
        const key = name.toLowerCase();
        tablesWithRow.set(key, name);
        // A valid cached count is a non-negative integer. GDAL uses -1 as a
        // "dirty/invalid" sentinel and recomputes the count for it (the
        // multithreaded path that crashes WASM), so a negative value is not safe.
        if (row[1] === "integer" && (row[2] as number) >= 0) {
          tablesWithValidCount.add(key);
        }
      }
    }

    const needsCount = [...featureTables.keys()].filter((key) => !tablesWithValidCount.has(key));
    if (needsCount.length === 0) return bytes;

    if (!hasOgrContents) {
      db.run(
        "CREATE TABLE gpkg_ogr_contents (" +
          "table_name TEXT NOT NULL PRIMARY KEY, " +
          "feature_count INTEGER DEFAULT NULL)",
      );
    }

    for (const key of needsCount) {
      const tableName = featureTables.get(key)!;
      // Best-effort per table: a malformed GeoPackage can register a view, a
      // deleted table, or a virtual table that count(*) cannot read. Skipping it
      // keeps the other feature tables repairable instead of aborting the whole
      // file (which would leave every table unpatched).
      try {
        const countResult = db.exec(`SELECT count(*) FROM ${quoteIdentifier(tableName)}`);
        const count = countResult[0]?.values[0]?.[0] ?? 0;
        const storedName = tablesWithRow.get(key);
        if (storedName !== undefined) {
          // Repair a stale/NULL count rather than INSERT (which would collide
          // with the existing primary-key row). Match on the exact stored name
          // (SQLite's lower() is ASCII-only, so a `lower(table_name) = :key`
          // predicate would miss non-ASCII names) and normalise table_name to
          // the canonical (gpkg_contents) casing: GDAL looks the row up with a
          // case-sensitive `table_name = <name from gpkg_contents>`, so a
          // wrong-cased row would not be found and would still crash.
          db.run(
            "UPDATE gpkg_ogr_contents SET feature_count = :count, table_name = :canonical WHERE table_name = :stored",
            { ":canonical": tableName, ":stored": storedName, ":count": count },
          );
        } else {
          db.run(
            "INSERT INTO gpkg_ogr_contents (table_name, feature_count) VALUES (:name, :count)",
            { ":name": tableName, ":count": count },
          );
        }
      } catch (error) {
        // Leave this table to GDAL's normal error path; other tables still get
        // fixed. Warn so a malformed GeoPackage is diagnosable rather than silent.
        console.warn(
          `[GeoLibre] Could not repair gpkg_ogr_contents for table "${tableName}":`,
          error,
        );
      }
    }

    // sql.js always exports an ArrayBuffer-backed Uint8Array; re-narrow the type.
    return db.export() as Uint8Array<ArrayBuffer>;
  } finally {
    db.close();
  }
}

let sqlJsPromise: Promise<SqlJsStatic> | null = null;

/**
 * Load the sql.js (SQLite/WASM) factory once and memoize it. Shared by the
 * GeoPackage reader-repair path here and the GeoPackage writer; the promise is
 * cleared on failure so a later call retries.
 */
export async function loadSqlJs(): Promise<SqlJsStatic> {
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
    console.warn("[GeoLibre] Could not ensure gpkg_ogr_contents; reading file as-is.", error);
    return bytes;
  }
}
