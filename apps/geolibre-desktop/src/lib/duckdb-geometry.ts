// Pure SQL/geometry-column helpers shared by the DuckDB vector loader and the
// GeoParquet writer. Kept free of `@duckdb/duckdb-wasm` (and its Vite `?url`
// imports) so the detection logic can be unit-tested under plain Node.
import type { FeatureCollection } from "geojson";

const TARGET_CRS = "EPSG:4326";

// Well-known WKB geometry column names used when a Parquet input lacks a
// GEOMETRY-typed column (e.g. plain Parquet carrying geometry as a WKB blob,
// or a GeoParquet whose CRS metadata DuckDB cannot read). The geometry is
// rebuilt with ST_GeomFromWKB so ST_AsGeoJSON / ST_Hilbert can use it.
// Mirrors the sidecar's vector conversion fallback. See issue #336.
export const WKB_GEOMETRY_COLUMN_NAMES = new Set([
  "geometry",
  "geom",
  "wkb_geometry",
  "geometry_wkb",
  "geom_wkb",
  "wkb",
]);

export function quoteSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

// DuckDB Spatial reports CRS-annotated geometry types such as
// GEOMETRY('EPSG:4326'), so match on the prefix rather than equality.
export function isGeometryColumnType(columnType: unknown): boolean {
  return (
    typeof columnType === "string" &&
    columnType.toUpperCase().startsWith("GEOMETRY")
  );
}

export interface DetectedGeometry {
  column: string;
  /** True when the column stores WKB that needs ST_GeomFromWKB. */
  isWkb: boolean;
  /** True when a WKB value is stored as a base64 string. */
  isBase64Wkb?: boolean;
  /** True when schema detection found a string WKB candidate that still needs a value probe. */
  requiresBase64WkbValidation?: boolean;
  /** Ranked string WKB candidates to value-probe before SQL generation. */
  base64WkbCandidates?: string[];
}

/**
 * Find the geometry column in a DESCRIBE result. Prefers a native GEOMETRY-typed
 * column; otherwise falls back to a well-known WKB blob column name so plain
 * Parquet files (and GeoParquet files DuckDB does not decode natively) load.
 *
 * @param description Rows from `DESCRIBE <query>` (column_name / column_type).
 * @returns The detected geometry column and whether it is a raw WKB blob, or
 *   null when no geometry column can be identified.
 */
export function detectGeometryColumn(
  description: Record<string, unknown>[],
): DetectedGeometry | null {
  const native = description.find((row) =>
    isGeometryColumnType(row.column_type),
  )?.column_name;
  if (typeof native === "string") {
    return { column: native, isWkb: false };
  }
  const rankedWkbCandidates = description
    .filter(
      (row): row is Record<string, unknown> & { column_name: string } =>
        typeof row.column_name === "string" &&
        WKB_GEOMETRY_COLUMN_NAMES.has(row.column_name.toLowerCase()),
    )
    .sort(
      (a, b) =>
        wkbColumnRank(a.column_name) - wkbColumnRank(b.column_name),
    );

  // Prefer binary/blob WKB candidates because DuckDB reads canonical WKB as
  // binary data. String WKB candidates are intentionally a later fallback and
  // must be value-probed by the loader before being decoded: they may be base64
  // geometry, but WKB-style names are still user-authored attributes in some
  // loose Parquet files.
  const wkb = rankedWkbCandidates.find(
    (row) =>
      typeof row.column_type === "string" &&
      /^(BLOB|BINARY|VARBINARY)/i.test(row.column_type),
  )?.column_name;
  if (typeof wkb === "string") {
    return { column: wkb, isWkb: true };
  }

  const base64WkbCandidates = rankedWkbCandidates
    .filter(
      (row) =>
        typeof row.column_type === "string" &&
        /^(VARCHAR|TEXT|STRING)/i.test(row.column_type),
    )
    .map((row) => row.column_name);
  if (base64WkbCandidates.length > 0) {
    return {
      column: base64WkbCandidates[0],
      isWkb: true,
      isBase64Wkb: true,
      requiresBase64WkbValidation: true,
      base64WkbCandidates,
    };
  }
  return null;
}

function wkbColumnRank(name: string): number {
  let rank = 0;
  for (const candidate of WKB_GEOMETRY_COLUMN_NAMES) {
    if (candidate === name.toLowerCase()) return rank;
    rank += 1;
  }
  return WKB_GEOMETRY_COLUMN_NAMES.size;
}

/**
 * Build a SQL expression that yields the geometry to read. A native GEOMETRY
 * column is referenced directly; a raw WKB blob is decoded with ST_GeomFromWKB.
 */
export function geometryExpr(detected: DetectedGeometry): string {
  if (detected.requiresBase64WkbValidation) {
    throw new Error(
      "Base64 WKB geometry candidates must be validated before SQL generation.",
    );
  }
  const column = quoteIdentifier(detected.column);
  if (!detected.isWkb) return column;
  const wkb = detected.isBase64Wkb ? `from_base64(${column})` : column;
  return `ST_GeomFromWKB(${wkb})`;
}

/**
 * Wrap a geometry SQL expression in ST_AsGeoJSON, transforming to WGS84 when a
 * source CRS is known.
 *
 * @param geometryExpression A fully-formed SQL expression for the geometry
 *   value, e.g. `"geom"` or `ST_GeomFromWKB("geometry_wkb")` (use
 *   {@link geometryExpr}). The caller owns identifier quoting; a bare column
 *   name passed here produces broken SQL.
 * @param sourceCrs The source CRS as `AUTHORITY:CODE`, or null to skip the
 *   reprojection to WGS84.
 */
export function geometryGeoJsonSql(
  geometryExpression: string,
  sourceCrs: string | null,
): string {
  if (!sourceCrs) {
    return `ST_AsGeoJSON(${geometryExpression})`;
  }
  // Transform even for EPSG:4326 sources: always_xy=true normalises axis order
  // to lon/lat, which a no-op EPSG:4326 -> EPSG:4326 transform guarantees for
  // formats that may store data as lat/lon.
  return `ST_AsGeoJSON(ST_Transform(${geometryExpression}, ${quoteSqlString(
    sourceCrs,
  )}, ${quoteSqlString(TARGET_CRS)}, true))`;
}

// GDAL's GeoJSON driver (used by `ST_Read`) synthesises an `OGC_FID` column for
// every feature. When a layer's GeoJSON already carries an `OGC_FID` property —
// which happens whenever the layer was itself derived from a prior `ST_Read`
// result, e.g. a SQL query result added back as a layer or created by the AI
// assistant — re-reading it makes GDAL emit a *second* `OGC_FID`, so `ST_Read`
// fails to bind with `duplicate column name "OGC_FID"` (issue #499).
export const GDAL_AUTO_FID_COLUMN = "OGC_FID";

/**
 * Return a copy of `geojson` with the reserved GDAL FID column
 * (`OGC_FID`) removed from every feature's properties, so re-reading it with
 * `ST_Read` cannot collide with GDAL's auto-generated FID column. The input is
 * left untouched and the same object is returned when no feature carries the
 * property, so unaffected layers pay no allocation cost.
 *
 * @param geojson Feature collection about to be handed to `ST_Read`.
 * @returns The collection without any `OGC_FID` properties.
 */
export function stripAutoFidColumn(
  geojson: FeatureCollection,
): FeatureCollection {
  // Scan first so the common (no-OGC_FID) path returns the original object
  // without allocating a throw-away features array or any feature copies.
  const needsStrip = geojson.features.some(
    (feature) =>
      feature.properties != null && GDAL_AUTO_FID_COLUMN in feature.properties,
  );
  if (!needsStrip) return geojson;
  const features = geojson.features.map((feature) => {
    const props = feature.properties;
    if (props && GDAL_AUTO_FID_COLUMN in props) {
      const { [GDAL_AUTO_FID_COLUMN]: _omit, ...rest } = props;
      return { ...feature, properties: rest };
    }
    return feature;
  });
  return { ...geojson, features };
}
