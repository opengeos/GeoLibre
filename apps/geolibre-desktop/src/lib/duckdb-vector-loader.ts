import * as duckdb from "@duckdb/duckdb-wasm";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import {
  detectGeometryColumn,
  geometryExpr,
  geometryGeoJsonSql,
  isGenericUnsupportedWkbError,
  isGeometryColumnType,
  isUnsupportedSurfaceWkbError,
  normalizePropertyValue,
  quoteIdentifier,
  quoteSqlString,
  stripAutoFidColumn,
  wkbRowsToFeatureCollection,
} from "./duckdb-geometry";
import { confirmLargeDataset, type DuckDbVectorLoadOptions } from "./duckdb-vector-guard";
import { ensureGpkgFeatureCount } from "./gpkg-ogr-contents";
import { isLikelyGeoPackage, loadGeoPackageVectorFile } from "./gpkg-reader";
import { prjSidecarCrs } from "./prj-sidecar";
import { selectDuckDbBundle } from "./duckdb-wasm-bundles";
import { getSpatialExtensionPath } from "./spatial-extension-config";

// Re-exported for existing importers (sql-workspace, duckdb-processing, etc.)
// that reach for these helpers via this module.
export { isGeometryColumnType, quoteIdentifier, quoteSqlString } from "./duckdb-geometry";

// Re-exported so callers can keep importing the guard surface from the loader.
export {
  confirmLargeDataset,
  DUCKDB_VECTOR_FEATURE_WARN_COUNT,
  VectorLoadCancelledError,
  type DuckDbVectorLoadOptions,
  type LargeVectorDataset,
} from "./duckdb-vector-guard";

const GEOMETRY_JSON_COLUMN = "__geolibre_geometry_geojson";
const EXPORT_GEOJSON_EXTENSION = "geojson";
const EXPORT_GEOPARQUET_EXTENSION = "parquet";

const FEATURE_COUNT_COLUMN = "__geolibre_feature_count";

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
  if (!dbPromise) {
    // Clear the memo if the build rejects (identity-guarded so a concurrent
    // rebuild is not clobbered): a transient WASM-bundle fetch failure must not
    // leave a rejected promise cached forever, breaking every later call.
    const building: Promise<duckdb.AsyncDuckDB> = createDatabase().catch((error) => {
      if (dbPromise === building) dbPromise = null;
      throw error;
    });
    dbPromise = building;
  }
  return dbPromise;
}

// The SQL Workspace runs on its own DuckDB instance, separate from the shared
// one every other consumer uses. It is the only feature that reads remote
// Parquet over HTTP, which is the operation duckdb-wasm 1.33.1-dev45 can poison
// (see resetSqlDatabase). Isolating it means the poison-recovery rebuild can
// safely terminate and replace the instance without disturbing in-flight vector
// loads, exports, reprojection, or processing on the shared instance.
let sqlDbPromise: Promise<duckdb.AsyncDuckDB> | null = null;

/** The DuckDB instance dedicated to the SQL Workspace. */
export function getSqlDatabase(): Promise<duckdb.AsyncDuckDB> {
  if (!sqlDbPromise) {
    // Same self-heal as getDatabase: clear the memo (identity-guarded against a
    // concurrent resetSqlDatabase) if the build rejects, so a failed build is
    // retried rather than cached as a permanently-rejected promise.
    const building: Promise<duckdb.AsyncDuckDB> = createDatabase().catch((error) => {
      if (sqlDbPromise === building) sqlDbPromise = null;
      throw error;
    });
    sqlDbPromise = building;
  }
  return sqlDbPromise;
}

// Count of SQL queries currently using each SQL instance, so a poisoned one is
// terminated only once no query is still on it (see resetSqlDatabase). Instances
// flagged here are pending teardown once their in-flight count drains to zero.
const sqlDbInFlight = new WeakMap<duckdb.AsyncDuckDB, number>();
const sqlDbTerminateWhenIdle = new WeakSet<duckdb.AsyncDuckDB>();

async function terminateSqlDatabase(db: duckdb.AsyncDuckDB): Promise<void> {
  sqlDbTerminateWhenIdle.delete(db);
  try {
    await db.terminate();
  } catch {
    // Best-effort teardown: the instance is already being discarded.
  }
}

/**
 * Marks a query as in flight on a SQL instance. Pair every call with a
 * {@link releaseSqlDatabase} in a `finally` so the count cannot leak.
 */
export function acquireSqlDatabase(db: duckdb.AsyncDuckDB): void {
  sqlDbInFlight.set(db, (sqlDbInFlight.get(db) ?? 0) + 1);
}

/**
 * Marks a query as finished on a SQL instance. If the instance was flagged for
 * teardown by {@link resetSqlDatabase} and this was the last in-flight query, it
 * is terminated now.
 */
export async function releaseSqlDatabase(db: duckdb.AsyncDuckDB): Promise<void> {
  const next = (sqlDbInFlight.get(db) ?? 1) - 1;
  if (next > 0) {
    sqlDbInFlight.set(db, next);
    return;
  }
  sqlDbInFlight.delete(db);
  if (sqlDbTerminateWhenIdle.has(db)) await terminateSqlDatabase(db);
}

/**
 * Rebuilds the SQL Workspace's DuckDB instance to recover from a poisoned remote
 * read path — duckdb-wasm 1.33.1-dev45 permanently breaks `read_parquet` over
 * HTTP (failing with "stoi: no conversion") on an instance that ran
 * `LOAD spatial` before its first successful remote Parquet read, and that state
 * cannot be undone in place. Stops handing the instance out so the next
 * {@link getSqlDatabase} builds a fresh one that re-runs the pre-spatial warm-up.
 *
 * `poisoned` scopes the swap: it is a no-op unless that instance is still the
 * current one, so a fresh instance a concurrent caller has already rebuilt is
 * never discarded. The identity is re-checked after the await to close the
 * window where another reset ran while this one was suspended.
 *
 * The old worker is terminated to free its WASM heap, but only once no query is
 * still using it: if another SQL query is in flight on the same instance, the
 * teardown is deferred to {@link releaseSqlDatabase} so that query is not
 * stranded. Nothing outside the SQL Workspace uses this instance, so the shared
 * DB's consumers are unaffected either way.
 *
 * @param poisoned - The instance to replace; only reset if it is still current.
 */
export async function resetSqlDatabase(poisoned: duckdb.AsyncDuckDB): Promise<void> {
  const previous = sqlDbPromise;
  if (!previous) return;
  let current: duckdb.AsyncDuckDB | null = null;
  try {
    current = await previous;
  } catch {
    current = null;
  }
  // Another query may have rebuilt the instance while we awaited; only discard
  // the still-current poisoned one.
  if (current !== poisoned || sqlDbPromise !== previous) return;
  sqlDbPromise = null;
  spatialExtensionByDb.delete(poisoned);
  // Terminate now if idle; otherwise let the last in-flight query's release do it.
  if ((sqlDbInFlight.get(poisoned) ?? 0) > 0) {
    sqlDbTerminateWhenIdle.add(poisoned);
  } else {
    await terminateSqlDatabase(poisoned);
  }
}

// Spatial extension load state, keyed per instance so the shared DB and the SQL
// Workspace DB each track their own load (and a rebuilt SQL instance starts
// fresh). Memoized as a promise so concurrent callers share one INSTALL/LOAD.
const spatialExtensionByDb = new WeakMap<duckdb.AsyncDuckDB, Promise<void>>();

/**
 * Install and load the DuckDB spatial extension once per database instance.
 * Redundant INSTALL/LOAD queries are skipped on reuse; on failure the memo is
 * cleared so a later call retries.
 *
 * When `VITE_DUCKDB_SPATIAL_EXTENSION_PATH` is set, INSTALL is skipped and
 * the extension is loaded from the provided local path (useful for offline or
 * sandboxed environments where the remote extension repository is unreachable).
 *
 * @param db - The instance the extension is loaded on (keys the memo).
 * @param connection - A connection to that instance to run the load on.
 * @param beforeLoad - Optional pre-load warm-up (a remote read before LOAD).
 */
export async function ensureSpatialExtension(
  db: duckdb.AsyncDuckDB,
  connection: duckdb.AsyncDuckDBConnection,
  beforeLoad?: () => Promise<void>,
): Promise<void> {
  let promise = spatialExtensionByDb.get(db);
  if (!promise) {
    promise = (async () => {
      // duckdb-wasm 1.33.1-dev45 breaks read_parquet on any connection that runs
      // LOAD spatial itself before it has read a Parquet file. `beforeLoad` lets
      // the caller warm up that path (a pre-spatial read) before any LOAD,
      // including the custom-path branch below, which is the only thing that
      // initialises it. Runs before the branch split so a custom extension path
      // (VITE_DUCKDB_SPATIAL_EXTENSION_PATH) gets the same warm-up.
      if (beforeLoad) {
        try {
          await beforeLoad();
        } catch (error) {
          // Warm-up is best-effort; a failure here must not block spatial
          // loading. Warn (not debug, which DevTools hides by default) so a
          // genuinely corrupt/mislabelled file surfaces its real cause here
          // instead of only as a later "stoi: no conversion" on DESCRIBE.
          console.warn("[GeoLibre] spatial warm-up failed (ignored)", error);
        }
      }

      const customPath = getSpatialExtensionPath();
      if (customPath) {
        const normalizedPath = customPath.replace(/\\/g, "/");
        await connection.query(`LOAD ${quoteSqlString(normalizedPath)}`);
        return;
      }

      await connection.query("INSTALL spatial");
      await connection.query("LOAD spatial");
    })();
    spatialExtensionByDb.set(db, promise);
  }
  try {
    await promise;
  } catch (error) {
    // Only clear the memo if it still points at this failed load: a concurrent
    // caller may have already installed a retry, which must not be wiped out.
    if (spatialExtensionByDb.get(db) === promise) spatialExtensionByDb.delete(db);
    throw error;
  }
}

let h3ExtensionPromise: Promise<void> | null = null;

/**
 * Install and load the DuckDB `h3` community extension once per database
 * instance. Mirrors {@link ensureSpatialExtension}: memoized as a promise so
 * concurrent callers share one INSTALL/LOAD, and cleared on failure so a later
 * call can retry. `h3` is published for the bundled DuckDB version (v1.5.1) on
 * all WASM platforms.
 */
export async function ensureH3Extension(connection: duckdb.AsyncDuckDBConnection): Promise<void> {
  h3ExtensionPromise ??= (async () => {
    // Unlike `ensureSpatialExtension`, no `beforeLoad` warm-up is needed here:
    // the duckdb-wasm v1.33.1-dev45 remote-read bug only affects `spatial`. If a
    // similar issue ever surfaces for `h3`, add a `beforeLoad` hook to match.
    await connection.query("INSTALL h3 FROM community");
    await connection.query("LOAD h3");
  })();
  try {
    await h3ExtensionPromise;
  } catch (error) {
    h3ExtensionPromise = null;
    throw error;
  }
}

async function createDatabase(): Promise<duckdb.AsyncDuckDB> {
  const bundle = await selectDuckDbBundle();
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

function exportBaseName(): string {
  const suffix = Math.random().toString(36).slice(2);
  return `__geolibre_export_${Date.now()}_${suffix}`;
}

export function rowsFromResult(result: { toArray: () => DuckDbRow[] }) {
  return result
    .toArray()
    .map((row) => (typeof row.toJSON === "function" ? row.toJSON() : { ...row }));
}

function isParquetExtension(extension: string): boolean {
  return extension === "parquet" || extension === "geoparquet";
}

/**
 * Register a vector file (and any siblings) as DuckDB file buffers, repairing
 * GeoPackages that lack `gpkg_ogr_contents` first so `ST_Read` does not crash on
 * the single-threaded WASM build. See `gpkg-ogr-contents.ts` and issue #258.
 */
async function registerVectorFileBuffers(
  db: duckdb.AsyncDuckDB,
  file: DuckDbVectorFile,
): Promise<void> {
  const data = file.extension === "gpkg" ? await ensureGpkgFeatureCount(file.data) : file.data;
  await db.registerFileBuffer(file.name, data);
  for (const sibling of file.siblingFiles ?? []) {
    await db.registerFileBuffer(sibling.name, sibling.data);
  }
}

/**
 * The `, layer=...` argument for `ST_Read`, or "" when no (non-blank) layer is
 * named. Shared by {@link sourceSql} and the keep_wkb fallback so both quote and
 * trim the layer identically.
 */
function layerArgSql(layer?: string): string {
  const trimmed = layer?.trim();
  // A named layer targets one OGR layer in a multi-layer source (CAD DWG); the
  // default (no layer=) reads the first layer.
  return trimmed ? `, layer=${quoteSqlString(trimmed)}` : "";
}

function sourceSql(fileName: string, extension: string, layer?: string): string {
  const quotedName = quoteSqlString(fileName);
  if (isParquetExtension(extension)) {
    return `SELECT * FROM read_parquet(${quotedName})`;
  }
  return `SELECT * FROM ST_Read(${quotedName}${layerArgSql(layer)})`;
}

/**
 * Build a {@link ensureSpatialExtension} `beforeLoad` warm-up that reads the
 * Parquet file once before the spatial extension is loaded, or `undefined` for
 * non-Parquet inputs.
 *
 * duckdb-wasm 1.33.1-dev45 breaks `read_parquet` on any connection that runs
 * `LOAD spatial` itself unless that connection has already read the file at
 * least once: the read then throws `Invalid Error: stoi: no conversion`. A
 * Parquet dropped as the first vector file is exactly that case, because its
 * connection is the one that triggers the singleton `LOAD spatial`. Reading the
 * file before the load primes the connection so the later `DESCRIBE`/`SELECT`
 * succeed. Later Parquet loads reuse the already-loaded extension, so their
 * connections never run `LOAD` and need no warm-up. This mirrors the remote
 * warm-up in `sql-workspace.ts`.
 */
function parquetWarmUp(
  connection: duckdb.AsyncDuckDBConnection,
  extension: string,
  fileName: string,
): (() => Promise<void>) | undefined {
  if (!isParquetExtension(extension)) return undefined;
  return async () => {
    await connection.query(`SELECT 1 FROM read_parquet(${quoteSqlString(fileName)}) LIMIT 0`);
  };
}

function crsSql(fileName: string, includeWkt: boolean): string {
  // WKT is the reprojection fallback for a CRS that GDAL could not resolve to an
  // EPSG code (e.g. an ESRI .prj carrying a custom State Plane definition):
  // ST_Transform accepts a WKT string source just as it does AUTHORITY:CODE, so
  // the layer still reprojects to WGS84 instead of rendering in raw projected
  // coordinates (issue #1121). It is selected only when `includeWkt` so
  // readSourceCrs can retry without it if the field is ever absent.
  const wktSelect = includeWkt ? ",\n      layers[1].geometry_fields[1].crs.wkt AS wkt" : "";
  return `
    SELECT
      -- Always reads the FIRST layer's first geometry field, regardless of the
      -- loader's \`layer\` option: that option selects which geometry ST_Read
      -- materializes, not which layer CRS is discovered here. The two formats
      -- that use a non-first layer (CAD DXF/DWG) carry no embedded CRS, so this
      -- returns null for them anyway and the user-supplied \`overrideSourceCrs\`
      -- drives reprojection instead. A future multi-layer format that DOES embed
      -- per-layer CRS would need this query to look the chosen layer up by name.
      layers[1].geometry_fields[1].crs.auth_name AS auth_name,
      layers[1].geometry_fields[1].crs.auth_code AS auth_code${wktSelect}
    FROM ST_Read_Meta(${quoteSqlString(fileName)})
  `;
}

/**
 * Resolve the source CRS of a vector file as a string ST_Transform accepts —
 * `AUTHORITY:CODE` when GDAL identified one, otherwise the raw WKT definition,
 * else a shapefile's `.prj` sidecar text, or null when the file carries no
 * usable CRS (so reprojection is skipped).
 *
 * `prjCrs` is the `.prj` sidecar WKT captured by {@link prjSidecarCrs} before
 * the file buffers were registered (which detaches them), passed in because it
 * can no longer be read from `file.siblingFiles` here.
 */
async function readSourceCrs(
  connection: duckdb.AsyncDuckDBConnection,
  file: DuckDbVectorFile,
  prjCrs: string | null,
): Promise<string | null> {
  // GeoParquet CRS is not read via ST_Read_Meta, so reprojection is skipped.
  // A spec-valid GeoParquet file not stored in WGS84 will render with wrong
  // coordinates; revisit if/when DuckDB exposes its CRS metadata here.
  if (isParquetExtension(file.extension)) {
    return null;
  }

  let row: Record<string, unknown> | undefined;
  try {
    row = rowsFromResult(await connection.query(crsSql(file.name, true)))[0];
  } catch (err) {
    // Selecting `crs.wkt` failed (an older ST_Read_Meta schema without that
    // field would fail the whole query as a binder error). Retry without it so a
    // resolvable EPSG code still drives reprojection instead of silently
    // disabling it for every file — only the EPSG-less WKT fallback is lost.
    try {
      row = rowsFromResult(await connection.query(crsSql(file.name, false)))[0];
    } catch (retryErr) {
      // ST_Read_Meta cannot materialize this file's CRS metadata at all. Some
      // GDAL/PROJ builds (notably duckdb-wasm) throw "cannot be formatted as
      // WKT1 TOWGS84 parameters" for a datum whose transform to WGS84 is
      // grid-based rather than a 7-parameter shift (e.g. OSGB36 / EPSG:27700),
      // which fails even the auth-code-only query. A shapefile still carries its
      // CRS in the `.prj` sidecar, so reproject from that before giving up
      // (issue #1148).
      if (prjCrs) return prjCrs;
      console.warn("[GeoLibre] Could not read CRS metadata; reprojection skipped.", retryErr);
      return null;
    }
  }
  if (!row) return prjCrs;
  const authName = typeof row.auth_name === "string" ? row.auth_name.trim() : "";
  const authCode = row.auth_code != null ? String(row.auth_code).trim() : "";
  if (authName && authCode) return `${authName.toUpperCase()}:${authCode}`;
  // No EPSG identity: fall back to the raw WKT so a projected file without a
  // recognised authority code still reprojects (issue #1121), and to the `.prj`
  // sidecar when even the WKT field is empty (issue #1148).
  const wkt = typeof row.wkt === "string" ? row.wkt.trim() : "";
  return wkt || prjCrs;
}

function toFeatureCollection(
  rows: Record<string, unknown>[],
  geometryColumn?: string,
): FeatureCollection<Geometry | null> {
  const features = rows.map((row) => {
    const rawGeometry = row[GEOMETRY_JSON_COLUMN];
    // ST_AsGeoJSON returns SQL NULL for rows with missing/NULL geometries.
    // GeoJSON Features may legally have a null geometry, so keep the row.
    const geometry = typeof rawGeometry === "string" ? (JSON.parse(rawGeometry) as Geometry) : null;
    const properties: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(row)) {
      if (key === GEOMETRY_JSON_COLUMN || key === geometryColumn || value instanceof Uint8Array) {
        continue;
      }
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

async function validateDetectedGeometry(
  connection: duckdb.AsyncDuckDBConnection,
  source: string,
  detected: ReturnType<typeof detectGeometryColumn>,
): Promise<NonNullable<ReturnType<typeof detectGeometryColumn>> | null> {
  if (!detected) return null;
  if (!detected.requiresBase64WkbValidation) return detected;
  const candidates = detected.base64WkbCandidates ?? [];
  for (const column of candidates) {
    if (await hasValidBase64WkbValues(connection, source, column)) {
      const {
        requiresBase64WkbValidation: _validated,
        base64WkbCandidates: _candidates,
        ...validated
      } = detected;
      return { ...validated, column };
    }
  }
  return null;
}

async function hasValidBase64WkbValues(
  connection: duckdb.AsyncDuckDBConnection,
  source: string,
  column: string,
): Promise<boolean> {
  const columnSql = quoteIdentifier(column);
  const sampleColumn = quoteIdentifier("__geolibre_base64_wkb_sample");
  const rows = rowsFromResult(
    await connection.query(
      `SELECT count(*) AS sample_count, count(TRY(ST_GeomFromWKB(from_base64(${sampleColumn})))) AS valid_count ` +
        `FROM (SELECT ${columnSql} AS ${sampleColumn} FROM (${source}) AS data ` +
        `WHERE ${columnSql} IS NOT NULL LIMIT 20) AS sample`,
    ),
  );
  const row = rows[0] ?? {};
  const sampleCount = numberFromCount(row.sample_count);
  const validCount = numberFromCount(row.valid_count);
  // Require every sampled non-null value to decode as WKB so a user attribute
  // named "geometry" or "wkb" is not promoted based on a partial match.
  return sampleCount > 0 && sampleCount === validCount;
}

function numberFromCount(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") return Number(value);
  return 0;
}

/**
 * Count the rows a source SQL statement would return. DuckDB answers this from
 * Parquet metadata without a scan and, for `ST_Read` formats, far more cheaply
 * than the full `SELECT *, ST_AsGeoJSON(...)` materialization, so it is a sound
 * up-front guard against runaway feature counts.
 */
async function countFeatures(
  connection: duckdb.AsyncDuckDBConnection,
  sql: string,
): Promise<number> {
  const row = rowsFromResult(
    await connection.query(
      `SELECT count(*) AS ${quoteIdentifier(FEATURE_COUNT_COLUMN)} FROM (${sql}) AS data`,
    ),
  )[0];
  const raw = row?.[FEATURE_COUNT_COLUMN];
  return typeof raw === "bigint" ? Number(raw) : Number(raw ?? 0);
}

/**
 * Read a GeoPackage with sql.js + {@link decodeWkb} instead of DuckDB's
 * `ST_Read`, which crashes on the single-threaded WASM build for all but the
 * smallest layers (GDAL fills Arrow batches on a background thread). The
 * geometries are reprojected to WGS84 via the shared DuckDB-based path when the
 * layer is not already in EPSG:4326. See `gpkg-reader.ts` and issue #393.
 */
async function loadGeoPackageVector(
  file: DuckDbVectorFile,
  options: DuckDbVectorLoadOptions,
): Promise<FeatureCollection> {
  // Guard large datasets on the single GeoPackage open: the count is taken
  // before the rows are read, so the file is not parsed twice.
  const onBeforeRead = options.onLargeDataset
    ? ({ featureCount }: { featureCount: number }) =>
        confirmLargeDataset({ name: file.name, featureCount }, options.onLargeDataset)
    : undefined;

  const { featureCollection, epsgCode } = await loadGeoPackageVectorFile(file.data, onBeforeRead);
  if (epsgCode == null) {
    return featureCollection as FeatureCollection;
  }

  // Tag the collection with its source CRS and reproject to WGS84 through the
  // shared DuckDB ST_Transform path (the GeoJSON reader it uses is not affected
  // by the GeoPackage threading bug).
  const tagged = {
    ...featureCollection,
    crs: { type: "name", properties: { name: `EPSG:${epsgCode}` } },
  } as FeatureCollection;
  return reprojectFeatureCollectionToWgs84(tagged);
}

export async function loadDuckDbVectorFile(
  file: DuckDbVectorFile,
  options: DuckDbVectorLoadOptions = {},
): Promise<FeatureCollection> {
  // GeoPackages are read without GDAL to avoid the single-threaded-WASM thread
  // crash in DuckDB's ST_Read (issue #393). A file mislabelled `.gpkg` that is
  // not actually SQLite falls through to the generic ST_Read path below.
  if (file.extension === "gpkg" && isLikelyGeoPackage(file.data)) {
    return loadGeoPackageVector(file, options);
  }

  const db = await getDatabase();
  const connection = await db.connect();

  try {
    // Capture the `.prj` sidecar CRS before registering the file buffers, which
    // detaches each sibling's ArrayBuffer (transferred to the worker) and would
    // leave the `.prj` unreadable by the reprojection fallback (issue #1148).
    // Inside the try so the finally still closes the connection if it throws.
    // `prjSidecarCrs` is `.shp`-scoped, so a non-shapefile's siblings are safe.
    const prjCrs = prjSidecarCrs(file);

    await registerVectorFileBuffers(db, file);
    await ensureSpatialExtension(
      db,
      connection,
      parquetWarmUp(connection, file.extension, file.name),
    );

    const sql = sourceSql(file.name, file.extension, options.layer);
    const description = rowsFromResult(await connection.query(`DESCRIBE ${sql}`));
    const detected = await validateDetectedGeometry(
      connection,
      sql,
      detectGeometryColumn(description),
    );

    if (!detected) {
      throw new Error("DuckDB did not find a geometry column in this file.");
    }

    // A caller-supplied CRS (CAD DXF/DWG, which carry none of their own) wins
    // over the file's metadata; a blank override falls back to the file's CRS.
    // Resolved up front (ST_Read_Meta does not materialize geometry) so the
    // surface-WKB fallback below can reuse it.
    const sourceCrs =
      options.overrideSourceCrs?.trim() || (await readSourceCrs(connection, file, prjCrs));

    // Tracks whether the large-dataset guard already confirmed, so the
    // surface-WKB fallback does not prompt a second time (or skip it entirely
    // when the error fired on the count guard before it ran).
    let guardConfirmed = false;
    try {
      // Guard against very large files before the expensive GeoJSON
      // materialization. Only counted when a callback is attached, so the
      // common (non-interactive) path stays single-pass.
      if (options.onLargeDataset) {
        const featureCount = await countFeatures(connection, sql);
        await confirmLargeDataset({ name: file.name, featureCount }, options.onLargeDataset);
        guardConfirmed = true;
      }

      const geometryJsonSql = geometryGeoJsonSql(geometryExpr(detected), sourceCrs);
      const result = await connection.query(
        `SELECT *, ${geometryJsonSql} AS ${quoteIdentifier(
          GEOMETRY_JSON_COLUMN,
        )} FROM (${sql}) AS data`,
      );
      // Features may carry a null geometry; the app's layer model treats them
      // as a regular FeatureCollection and the map ignores null geometries.
      return toFeatureCollection(rowsFromResult(result), detected.column) as FeatureCollection;
    } catch (error) {
      // DuckDB Spatial's WKB reader rejects surface geometries (TIN /
      // PolyhedralSurface), which its bundled GDAL emits for ESRI MultiPatch
      // shapefiles (3D buildings) — either as a detailed "WKB type 'TIN Z'..."
      // or a generic "Unsupported geometry type in WKB". Depending on the build
      // that fires on the count(*) guard or the GeoJSON read, so the whole read
      // is wrapped. Re-read the raw WKB and decode it in JS, where TIN triangles
      // become a MultiPolygon (issue #1121). The fallback re-reads via
      // `ST_Read`, so a Parquet file (read via `read_parquet`, not GDAL)
      // propagates the error instead of being mis-read through GDAL's driver.
      //
      // The detailed message names the surface type, so it is trusted for any
      // format. The generic message names nothing, so it is only trusted for a
      // shapefile, whose sole surface geometry is MultiPatch (and which cannot
      // hold the curved geometries that share that message).
      const isSurfaceError =
        isUnsupportedSurfaceWkbError(error) ||
        (file.extension === "shp" && isGenericUnsupportedWkbError(error));
      if (isParquetExtension(file.extension) || !isSurfaceError) {
        throw error;
      }
      return loadViaKeepWkbFallback(db, file, options, sourceCrs, error, guardConfirmed);
    }
  } finally {
    await connection.close();
  }
}

/**
 * Load a vector file by re-reading its geometry as raw WKB (`keep_wkb=true`) and
 * decoding it in JS, the fallback for surface geometries DuckDB Spatial cannot
 * materialize as a GEOMETRY value (TIN / PolyhedralSurface from an ESRI
 * MultiPatch shapefile). `keep_wkb` hands back GDAL's WKB export untouched, so
 * the read succeeds where the normal path threw; {@link decodeWkb} then turns a
 * TIN into a MultiPolygon. Reprojection to WGS84 runs afterwards on the decoded
 * (now DuckDB-representable) MultiPolygon via the shared ST_Transform path.
 *
 * @param sourceCrs The source CRS resolved for the normal path (reused so the
 *   fallback reprojects identically), as `AUTHORITY:CODE`, a WKT string, or null.
 * @param originalError The error that triggered the fallback, re-thrown when
 *   nothing decodes so an unsupported geometry still fails loudly.
 * @param guardConfirmed Whether the normal path already confirmed the
 *   large-dataset guard; when false (the error fired on the count guard) it is
 *   re-run here so a huge file is not loaded without confirmation.
 */
async function loadViaKeepWkbFallback(
  db: duckdb.AsyncDuckDB,
  file: DuckDbVectorFile,
  options: DuckDbVectorLoadOptions,
  sourceCrs: string | null,
  originalError: unknown,
  guardConfirmed: boolean,
): Promise<FeatureCollection> {
  // Read on a fresh connection: re-running ST_Read on the connection that
  // already scanned the file trips a "Missing DB manager" GDAL assertion in the
  // single-threaded WASM build. The file itself is already registered on the db.
  const connection = await db.connect();
  try {
    await ensureSpatialExtension(db, connection);
    const wkbSql = `SELECT * FROM ST_Read(${quoteSqlString(file.name)}, keep_wkb=true${layerArgSql(options.layer)})`;
    // `keep_wkb` materializes the geometry as a WKB blob column named
    // `wkb_geometry` (its DuckDB type varies by build: `BLOB` or `WKB_BLOB`), so
    // find it by that name, falling back to any WKB/BLOB-typed column.
    const columns = rowsFromResult(await connection.query(`DESCRIBE ${wkbSql}`));
    const wkbColumn =
      columns.find(
        (column) =>
          typeof column.column_name === "string" &&
          column.column_name.toLowerCase() === "wkb_geometry",
      )?.column_name ??
      columns.find(
        (column) =>
          typeof column.column_type === "string" && /WKB|BLOB|BINARY/i.test(column.column_type),
      )?.column_name;
    if (typeof wkbColumn !== "string") {
      throw new Error("DuckDB did not find a geometry column in this file.");
    }
    // Re-run the large-dataset guard when the count(*) failure above pre-empted
    // it, so a huge MultiPatch file still prompts before every row is decoded.
    if (options.onLargeDataset && !guardConfirmed) {
      const featureCount = await countFeatures(connection, wkbSql);
      await confirmLargeDataset({ name: file.name, featureCount }, options.onLargeDataset);
    }
    const rows = rowsFromResult(await connection.query(wkbSql));
    // Null geometries are legal in a FeatureCollection; the map ignores them.
    const collection = wkbRowsToFeatureCollection(rows, wkbColumn) as FeatureCollection;
    // If nothing decoded, the geometry was not a surface this fallback handles
    // (e.g. the original error was the generic "Unsupported geometry type in
    // WKB", which also fires for curved geometries). Surface the original error
    // rather than adding an invisible, all-null-geometry layer.
    if (
      collection.features.length > 0 &&
      collection.features.every((feature) => feature.geometry === null)
    ) {
      throw originalError;
    }
    // The decoded geometry is in the file's own CRS; reproject to WGS84 with the
    // same source CRS the normal path resolved. Reuses the shared ST_Transform
    // path, which handles the MultiPolygon the TIN decoded to.
    return reprojectFeatureCollectionToWgs84(collection, sourceCrs);
  } finally {
    await connection.close();
  }
}

/** One OGR layer in a multi-layer source, as reported by `ST_Read_Meta`. */
export interface CadLayerInfo {
  /** The OGR layer name, passed to `ST_Read(..., layer=...)` to read it. */
  name: string;
  /** Feature count GDAL reports for the layer. */
  featureCount: number;
  /** The layer's first geometry field type (e.g. `Line String`), or "". */
  geometryType: string;
}

/**
 * List the OGR layers in a CAD (DXF/DWG) file via `ST_Read_Meta`, so the Add CAD
 * Layer dialog can let the user choose which one to load. DXF exposes a single
 * `entities` layer; DWG drawings are usually multi-layer. The reported layers
 * include ones whose geometry `ST_Read` cannot decode (e.g. Geometry
 * Collection); the load surfaces that per-layer rather than hiding the layer
 * here, since the count and type are still useful context.
 *
 * @param file The CAD file (bytes + name + extension) to inspect.
 * @returns One {@link CadLayerInfo} per layer, in the file's layer order.
 */
export async function readCadLayers(file: DuckDbVectorFile): Promise<CadLayerInfo[]> {
  const db = await getDatabase();
  const connection = await db.connect();
  try {
    await registerVectorFileBuffers(db, file);
    await ensureSpatialExtension(db, connection);
    const rows = rowsFromResult(
      await connection.query(
        `SELECT
           l.name AS name,
           l.feature_count AS feature_count,
           l.geometry_fields[1].type AS geom_type
         FROM (
           SELECT UNNEST(layers) AS l
           FROM ST_Read_Meta(${quoteSqlString(file.name)})
         )`,
      ),
    );
    return rows.map((row) => ({
      name: String(row.name ?? ""),
      featureCount:
        typeof row.feature_count === "bigint"
          ? Number(row.feature_count)
          : Number(row.feature_count ?? 0),
      geometryType: typeof row.geom_type === "string" ? row.geom_type : "",
    }));
  } finally {
    // Release the probe's file buffer so the worker does not hold a second copy
    // while the subsequent loadDuckDbVectorFile re-registers the same name.
    await dropFilesIfPresent(db, [
      file.name,
      ...(file.siblingFiles?.map((sibling) => sibling.name) ?? []),
    ]);
    await connection.close();
  }
}

// Monotonic suffix so concurrent reprojections register distinct DuckDB files.
let reprojectionSeq = 0;

/**
 * Resolve the EPSG source CRS declared by a legacy GeoJSON ``crs`` member.
 *
 * Handles the common forms (``urn:ogc:def:crs:EPSG::3857``, ``EPSG:3857``) and
 * treats WGS84 variants (``EPSG:4326``, OGC ``CRS84``) as "no reprojection
 * needed" by returning null.
 *
 * @param fc The FeatureCollection that may carry a ``crs`` member.
 * @returns An ``EPSG:<code>`` string to reproject from, or null when the member
 *   is absent, unparseable, or already WGS84.
 */
function sourceCrsFromGeoJson(fc: FeatureCollection): string | null {
  const name = (fc as { crs?: { properties?: { name?: unknown } } }).crs?.properties?.name;
  if (typeof name !== "string") return null;
  const upper = name.toUpperCase();
  // CRS84 and EPSG:4326 are both WGS84 lon/lat; no reprojection is required.
  if (upper.includes("CRS84") || /EPSG:+4326\b/.test(upper)) return null;
  const match = upper.match(/EPSG:+(\d+)/);
  return match ? `EPSG:${match[1]}` : null;
}

/**
 * Reproject a FeatureCollection to WGS84 (EPSG:4326) when it declares a
 * non-WGS84 CRS via a legacy GeoJSON ``crs`` member.
 *
 * The AI segmentation backend (samgeo-api) returns polygons in the source
 * raster's CRS (e.g. EPSG:3857 in metres) tagged with a ``crs`` member, but
 * MapLibre and the store expect WGS84 lon/lat, so the raw coordinates trip
 * MapLibre's "Invalid LngLat latitude" guard. Reprojection reuses the bundled
 * DuckDB-WASM Spatial engine (PROJ) so any EPSG code is handled. A collection
 * with no CRS member (or one already in WGS84) is returned unchanged, with the
 * deprecated ``crs`` member stripped either way.
 *
 * @param fc The FeatureCollection to reproject.
 * @param explicitSourceCrs When provided (the TIN/MultiPatch fallback, whose
 *   decoded geometry carries no ``crs`` member), the source CRS as
 *   `AUTHORITY:CODE` or a WKT string — both accepted by ST_Transform. `null`
 *   skips reprojection; omit it to parse the CRS from the collection's own
 *   member instead.
 * @returns A WGS84 FeatureCollection without a ``crs`` member.
 */
export async function reprojectFeatureCollectionToWgs84(
  fc: FeatureCollection,
  explicitSourceCrs?: string | null,
): Promise<FeatureCollection> {
  const sourceCrs = explicitSourceCrs !== undefined ? explicitSourceCrs : sourceCrsFromGeoJson(fc);
  const { crs: _deprecatedCrs, ...stripped } = fc as FeatureCollection & {
    crs?: unknown;
  };
  if (!sourceCrs) return stripped as FeatureCollection;

  const db = await getDatabase();
  const connection = await db.connect();
  const sourceFile = `geolibre-reproject-${(reprojectionSeq += 1)}.geojson`;
  try {
    // Strip GDAL's synthetic OGC_FID before ST_Read re-reads the file: a
    // collection decoded from a prior ST_Read carries OGC_FID as a property, and
    // GDAL's GeoJSON driver would add a second one, aborting with
    // `duplicate column name "OGC_FID"` (issue #499).
    await db.registerFileText(sourceFile, JSON.stringify(stripAutoFidColumn(fc)));
    await ensureSpatialExtension(db, connection);

    const sql = `SELECT * FROM ST_Read(${quoteSqlString(sourceFile)})`;
    const description = rowsFromResult(await connection.query(`DESCRIBE ${sql}`));
    const detected = await validateDetectedGeometry(
      connection,
      sql,
      detectGeometryColumn(description),
    );
    if (!detected) {
      // No geometry to reproject; hand back the stripped collection untouched.
      return stripped as FeatureCollection;
    }

    // Pass the CRS parsed from the `crs` member explicitly rather than relying
    // on ST_Read_Meta, which does not surface a legacy GeoJSON CRS member.
    const geometryJsonSql = geometryGeoJsonSql(geometryExpr(detected), sourceCrs);
    const result = await connection.query(
      `SELECT *, ${geometryJsonSql} AS ${quoteIdentifier(
        GEOMETRY_JSON_COLUMN,
      )} FROM (${sql}) AS data`,
    );
    return toFeatureCollection(rowsFromResult(result), detected.column) as FeatureCollection;
  } finally {
    await connection.close();
    await dropFilesIfPresent(db, [sourceFile]);
  }
}

async function dropFilesIfPresent(db: duckdb.AsyncDuckDB, fileNames: string[]): Promise<void> {
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
  // Drop any reserved OGC_FID property before ST_Read re-reads the file. A
  // collection previously read with ST_Read (e.g. a Shapefile/GeoPackage layer,
  // or this tool's own input load) carries OGC_FID as a property, and GDAL's
  // GeoJSON driver adds its own OGC_FID id column, so the read would otherwise
  // abort with `duplicate column name "OGC_FID"` (issue #499).
  await db.registerFileText(sourceFile, JSON.stringify(stripAutoFidColumn(geojson)));
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

const GEOPARQUET_COMPRESSIONS = new Set(["zstd", "snappy", "gzip", "lz4", "uncompressed"]);
const DEFAULT_GEOPARQUET_COMPRESSION = "zstd";
const DEFAULT_GEOPARQUET_ROW_GROUP_SIZE = 30000;

/**
 * Convert an in-memory vector file to a Hilbert-sorted, compressed GeoParquet
 * entirely inside DuckDB-WASM. Rows are ordered by ST_Hilbert over the
 * dataset extent so row groups stay spatially clustered for range requests.
 */
export async function convertDuckDbVectorToGeoParquet(
  file: DuckDbVectorFile,
  options: GeoParquetConversionOptions = {},
): Promise<GeoParquetConversionResult> {
  const compression = (options.compression ?? DEFAULT_GEOPARQUET_COMPRESSION).toLowerCase();
  if (!GEOPARQUET_COMPRESSIONS.has(compression)) {
    throw new Error(`Unsupported Parquet compression: ${compression}`);
  }
  const rowGroupSize = Math.trunc(options.rowGroupSize ?? DEFAULT_GEOPARQUET_ROW_GROUP_SIZE);
  if (!Number.isFinite(rowGroupSize) || rowGroupSize <= 0) {
    throw new Error("Row group size must be a positive integer.");
  }

  const db = await getDatabase();
  const connection = await db.connect();
  const outputFile = `${exportBaseName()}.${EXPORT_GEOPARQUET_EXTENSION}`;
  const registeredFiles = [file.name, ...(file.siblingFiles ?? []).map((sibling) => sibling.name)];

  try {
    await registerVectorFileBuffers(db, file);
    // Warm up the Parquet read path before LOAD spatial (see `parquetWarmUp`).
    // CSV input uses `read_csv_auto` and non-Parquet vector files use `ST_Read`,
    // neither affected by the bug; `parquetWarmUp` returns undefined for both,
    // and the `options.csv` guard short-circuits the CSV branch before calling it.
    await ensureSpatialExtension(
      db,
      connection,
      options.csv ? undefined : parquetWarmUp(connection, file.extension, file.name),
    );

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
      const description = rowsFromResult(await connection.query(`DESCRIBE ${sql}`));
      const detected = await validateDetectedGeometry(
        connection,
        sql,
        detectGeometryColumn(description),
      );
      if (!detected) {
        throw new Error("DuckDB did not find a geometry column in this file.");
      }
      geometryColumn = detected.column;
      const geometrySql = quoteIdentifier(geometryColumn);
      // Plain Parquet files may carry geometry as WKB bytes or base64 WKB;
      // rebuild it as a GEOMETRY column so ST_Hilbert and the GeoParquet writer
      // can use it.
      source = detected.isWkb
        ? `SELECT * REPLACE (${geometryExpr(detected)} AS ${geometrySql}) FROM (${sql}) AS data`
        : sql;
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

export async function exportDuckDbGeoParquet(geojson: FeatureCollection): Promise<Uint8Array> {
  const db = await getDatabase();
  const connection = await db.connect();
  const baseName = exportBaseName();
  const sourceFile = `${baseName}.${EXPORT_GEOJSON_EXTENSION}`;
  const outputFile = `${baseName}.${EXPORT_GEOPARQUET_EXTENSION}`;

  try {
    await registerGeoJsonExportSource(db, geojson, sourceFile);
    await ensureSpatialExtension(db, connection);
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
