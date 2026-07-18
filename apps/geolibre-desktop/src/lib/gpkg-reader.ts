import type { Feature, FeatureCollection, Geometry } from "geojson";
import type { Database, SqlJsStatic } from "sql.js";
import { decodeWkb } from "./geometry-wkb";
import { loadSqlJs, looksLikeSqlite, quoteIdentifier, tableExists } from "./gpkg-ogr-contents";

/**
 * Read GeoPackages with sql.js (SQLite/WASM) instead of DuckDB's `ST_Read`.
 *
 * GDAL's GeoPackage driver fills Arrow result batches on a background thread
 * once a layer is more than a few features long. The single-threaded DuckDB-WASM
 * `eh` bundle the app loads has no pthread support, so that read aborts with
 * "thread constructor failed: Resource temporarily unavailable" — many valid
 * GeoPackages never render, while tiny ones happen to slip under the threshold.
 * Repairing `gpkg_ogr_contents` (see `gpkg-ogr-contents.ts`) fixes the related
 * feature-count crash but not this one, and no DuckDB-reachable GDAL config
 * disables the threading. Reading the SQLite tables directly sidesteps GDAL
 * entirely: sql.js is already bundled for the count repair, GeoPackage geometry
 * blobs are a thin "GP" header over standard WKB, and {@link decodeWkb} turns
 * that WKB into GeoJSON. See GitHub issue #393.
 */

/** A selected feature layer plus the metadata needed to read its rows. */
interface GeoPackageLayer {
  table: string;
  geometryColumn: string;
  srsId: number | null;
  /** The INTEGER PRIMARY KEY column, excluded from feature properties. */
  idColumn: string | null;
}

export interface GeoPackageReadResult {
  featureCollection: FeatureCollection<Geometry | null>;
  /**
   * The EPSG code the geometries are stored in, or null when they are already
   * WGS84 lon/lat (or the CRS is undefined). The caller reprojects when set.
   */
  epsgCode: number | null;
}

// Envelope byte sizes by GeoPackage envelope indicator: 0=none, 1=XY, 2=XYZ,
// 3=XYM, 4=XYZM. Indicators 5-7 are reserved/invalid (OGC 12-128r18, Table 1).
const ENVELOPE_BYTES = [0, 32, 48, 48, 64];

/**
 * Strip the GeoPackage geometry-blob header, returning the standard WKB inside.
 *
 * The header is the "GP" magic, a version byte, a flags byte, a 4-byte srs_id,
 * and an optional envelope whose size is encoded in flag bits 1-3. A blob that
 * is already bare WKB (first byte a 0x00/0x01 byte-order marker) is returned
 * unchanged so non-conformant producers still read. A blob that claims the "GP"
 * magic but is truncated or carries a reserved envelope indicator throws, so a
 * malformed geometry surfaces as an explicit error instead of decoding from the
 * wrong offset into a silently wrong (or null) geometry.
 */
export function stripGeoPackageHeader(blob: Uint8Array): Uint8Array {
  // 'G','P' magic identifies a GeoPackage geometry blob; otherwise assume the
  // value is already standalone WKB (byte-order byte 0x00 or 0x01).
  if (blob.length < 2 || blob[0] !== 0x47 || blob[1] !== 0x50) return blob;
  if (blob.length < 8) {
    throw new Error("Invalid GeoPackage geometry blob: truncated header.");
  }
  const flags = blob[3];
  const envelopeIndicator = (flags >> 1) & 0x07;
  if (envelopeIndicator >= ENVELOPE_BYTES.length) {
    throw new Error(
      `Invalid GeoPackage geometry blob: reserved envelope indicator ${envelopeIndicator}.`,
    );
  }
  const headerLength = 8 + ENVELOPE_BYTES[envelopeIndicator];
  if (blob.length < headerLength) {
    throw new Error("Invalid GeoPackage geometry blob: truncated envelope.");
  }
  return blob.subarray(headerLength);
}

/**
 * Pick the layer to read: the first `features` row in `gpkg_contents` that has a
 * registered geometry column. Mirrors GDAL's "first layer" default (no `layer=`
 * argument), which is what the previous `ST_Read` path used.
 */
function selectLayer(db: Database): GeoPackageLayer | null {
  // Both tables are referenced by the JOIN below. gpkg_contents is mandatory in
  // the spec, but guard it too so a malformed file returns null (no layer) here
  // rather than throwing an opaque sql.js error from the JOIN.
  if (!tableExists(db, "gpkg_geometry_columns")) return null;
  if (!tableExists(db, "gpkg_contents")) return null;
  const result = db.exec(
    // COLLATE NOCASE: SQLite's default BINARY collation makes the join
    // case-sensitive, but a producer can spell the same table differently in
    // gpkg_contents and gpkg_geometry_columns (SQLite table names are
    // case-insensitive). gpkg-ogr-contents.ts handles the same mismatch.
    `SELECT g.table_name, g.column_name, g.srs_id
     FROM gpkg_geometry_columns g
     JOIN gpkg_contents c ON c.table_name = g.table_name COLLATE NOCASE
     WHERE lower(c.data_type) = 'features'
     ORDER BY c.rowid
     LIMIT 1`,
  );
  const row = result[0]?.values[0];
  if (!row) return null;
  const table = String(row[0]);
  const geometryColumn = String(row[1]);
  const srsId = row[2] == null ? null : Number(row[2]);

  let idColumn: string | null = null;
  for (const info of db.exec(`PRAGMA table_info(${quoteIdentifier(table)})`)[0]?.values ?? []) {
    // table_info columns: cid, name, type, notnull, dflt_value, pk.
    if (info[5] === 1) idColumn = String(info[1]);
  }
  return { table, geometryColumn, srsId, idColumn };
}

/**
 * Resolve the layer's SRS to an EPSG code, or null when it is WGS84 lon/lat or
 * undefined (srs_id 0 = undefined geographic, -1 = undefined cartesian). Only
 * EPSG-organization rows are reprojectable here.
 */
// EPSG codes whose horizontal axes are already WGS84 lon/lat, so reprojecting
// to 4326 is a no-op: 4326 (2D) and 4979 (3D geographic, same lat/lon).
const WGS84_EPSG_CODES = new Set([4326, 4979]);

function resolveEpsgCode(db: Database, srsId: number | null): number | null {
  // srs_id 0 = undefined geographic, -1 = undefined cartesian (GeoPackage spec).
  if (srsId == null || srsId === 0 || srsId === -1 || WGS84_EPSG_CODES.has(srsId)) {
    return null;
  }
  if (!tableExists(db, "gpkg_spatial_ref_sys")) return null;
  const row = db.exec(
    `SELECT organization, organization_coordsys_id
     FROM gpkg_spatial_ref_sys WHERE srs_id = :id`,
    { ":id": srsId },
  )[0]?.values[0];
  if (!row) return null;
  const organization = String(row[0] ?? "").toUpperCase();
  const code = row[1] == null ? null : Number(row[1]);
  // A non-numeric organization_coordsys_id yields NaN, which is not null; guard
  // it so a malformed row is treated as "no reprojection" instead of tagging the
  // collection "EPSG:NaN" (which silently fails to reproject and misrenders).
  if (organization !== "EPSG" || code == null || !Number.isFinite(code)) {
    return null;
  }
  return WGS84_EPSG_CODES.has(code) ? null : code;
}

/** Count a layer's rows without materializing them (for the large-dataset guard). */
function countLayerRows(db: Database, table: string): number {
  const row = db.exec(`SELECT count(*) FROM ${quoteIdentifier(table)}`)[0]?.values[0];
  return Number(row?.[0] ?? 0);
}

/** Read every feature of `layer` from an open database into a FeatureCollection. */
function readLayerFeatures(
  db: Database,
  layer: GeoPackageLayer,
): FeatureCollection<Geometry | null> {
  const result = db.exec(`SELECT * FROM ${quoteIdentifier(layer.table)}`);
  const features: Feature<Geometry | null>[] = [];
  if (result.length > 0) {
    const columns = result[0].columns;
    const geometryIndex = columns.indexOf(layer.geometryColumn);
    // The geometry column is declared in gpkg_geometry_columns; if SELECT * does
    // not return it, the file is inconsistent. Fail loudly rather than emit every
    // feature with a silent null geometry.
    if (geometryIndex < 0) {
      throw new Error(
        `GeoPackage layer "${layer.table}" is missing its declared geometry ` +
          `column "${layer.geometryColumn}".`,
      );
    }
    const idIndex = layer.idColumn ? columns.indexOf(layer.idColumn) : -1;

    for (const row of result[0].values) {
      const properties: Record<string, unknown> = {};
      for (let i = 0; i < columns.length; i += 1) {
        if (i === geometryIndex || i === idIndex) continue;
        const value = row[i];
        // sql.js returns BLOB columns as Uint8Array; binary attributes are not
        // JSON-serialisable, so drop them (matching the ST_Read path).
        if (value instanceof Uint8Array) continue;
        properties[columns[i]] = value;
      }

      const rawGeometry = row[geometryIndex];
      let geometry: Geometry | null = null;
      if (rawGeometry instanceof Uint8Array && rawGeometry.length > 0) {
        try {
          const wkb = stripGeoPackageHeader(rawGeometry);
          // A GeoPackage "empty geometry" header carries no WKB body.
          geometry = wkb.length > 0 ? decodeWkb(wkb) : null;
        } catch (error) {
          // One unreadable geometry (malformed header, truncated WKB, or an
          // unsupported curved type) must not abort the whole layer. Keep the
          // feature with a null geometry and warn so the loss is diagnosable
          // rather than silent.
          console.warn(
            `[GeoLibre] Skipped an unreadable geometry in GeoPackage layer "${layer.table}":`,
            error,
          );
        }
      }
      features.push({ type: "Feature", geometry, properties });
    }
  }
  return { type: "FeatureCollection", features };
}

/** Read the first feature layer of an open GeoPackage database. */
function readGeoPackage(db: Database): GeoPackageReadResult {
  const layer = selectLayer(db);
  if (!layer) {
    throw new Error("No vector feature layer found in this GeoPackage.");
  }
  return {
    featureCollection: readLayerFeatures(db, layer),
    epsgCode: resolveEpsgCode(db, layer.srsId),
  };
}

/**
 * Synchronous core of {@link loadGeoPackageVectorFile}: read every feature of
 * the first layer into a GeoJSON FeatureCollection. Separated so it can be
 * unit-tested with an already-initialised sql.js factory.
 */
export function readGeoPackageSync(SQL: SqlJsStatic, bytes: Uint8Array): GeoPackageReadResult {
  const db = new SQL.Database(bytes);
  try {
    return readGeoPackage(db);
  } finally {
    db.close();
  }
}

/**
 * Cheap pre-check: whether these bytes are a SQLite file (a GeoPackage is one).
 *
 * Only the SQLite magic is inspected, so a non-GeoPackage SQLite database with a
 * `.gpkg` name also passes; such a file then fails in {@link readGeoPackageSync}
 * with "No vector feature layer found" rather than falling through to `ST_Read`.
 * That is acceptable: `ST_Read` cannot read a SQLite file with no feature layer
 * either, and full GeoPackage validation only happens once the tables are read.
 */
export function isLikelyGeoPackage(bytes: Uint8Array): boolean {
  return looksLikeSqlite(bytes);
}

/** First-layer feature count, passed to {@link LargeGeoPackageGuard}. */
export interface GeoPackageLayerCount {
  name: string;
  featureCount: number;
}

/**
 * Invoked with the first layer's feature count before its rows are read, so a
 * caller can prompt about a large dataset. Throw (or reject) to abort the load.
 */
export type LargeGeoPackageGuard = (count: GeoPackageLayerCount) => void | Promise<void>;

/**
 * Read a GeoPackage buffer into a GeoJSON FeatureCollection via sql.js,
 * bypassing GDAL. Returns the collection plus the source EPSG code (null when
 * already WGS84) so the caller can reproject. Loads sql.js on demand.
 *
 * The database is opened once: when `onBeforeRead` is supplied, the layer's
 * feature count is taken on that same open and passed to the guard before the
 * rows are materialized, so a counted load does not parse the file twice.
 */
export async function loadGeoPackageVectorFile(
  bytes: Uint8Array,
  onBeforeRead?: LargeGeoPackageGuard,
): Promise<GeoPackageReadResult> {
  const SQL = await loadSqlJs();
  const db = new SQL.Database(bytes);
  try {
    const layer = selectLayer(db);
    if (!layer) {
      throw new Error("No vector feature layer found in this GeoPackage.");
    }
    if (onBeforeRead) {
      await onBeforeRead({
        name: layer.table,
        featureCount: countLayerRows(db, layer.table),
      });
    }
    return {
      featureCollection: readLayerFeatures(db, layer),
      epsgCode: resolveEpsgCode(db, layer.srsId),
    };
  } finally {
    db.close();
  }
}
