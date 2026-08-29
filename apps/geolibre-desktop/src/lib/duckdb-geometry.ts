// Pure SQL/geometry-column helpers shared by the DuckDB vector loader and the
// GeoParquet writer. Kept free of `@duckdb/duckdb-wasm` (and its Vite `?url`
// imports) so the detection logic can be unit-tested under plain Node.
import type { Feature, FeatureCollection, Geometry } from "geojson";
import { decodeWkb } from "./geometry-wkb";

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

// Column names a longitude / latitude pair is recognised under when a Parquet
// file carries no geometry column at all — the shape a great many point
// datasets are published in. The pair is synthesised into points with ST_Point
// and assumed to be OGC:CRS84, which is what such tables invariably hold. The
// CSV importer has always done this from user-picked columns; this is the same
// idea, guessed from the schema. Ported from GeoPQ Workbench's `xy_columns`.
export const LONGITUDE_COLUMN_NAMES = new Set(["lon", "longitude", "long", "lng", "x"]);
export const LATITUDE_COLUMN_NAMES = new Set(["lat", "latitude", "y"]);

// The column name reported for a geometry no column actually holds, so nothing
// downstream strips a real attribute (the lon/lat columns stay readable as
// properties) or tries to reference it in SQL.
export const SYNTHESIZED_GEOMETRY_COLUMN = "__geolibre_synthesized_geometry";

// The DuckDB floating-point column types a coordinate pair is accepted from: an
// integer or string "lat" column is an identifier or a formatted value far more
// often than it is a coordinate.
const FLOAT_COLUMN_TYPE = /^(DOUBLE|FLOAT|REAL)$/i;

// The DuckDB column types a WKB blob arrives as.
const BINARY_COLUMN_TYPE = /^(BLOB|BINARY|VARBINARY)/i;

export function quoteSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

// ISO WKB base type codes of the surface geometries decodeWkb can now turn into
// a MultiPolygon/Polygon: PolyhedralSurface (15), TIN (16), Triangle (17). The
// Z/M variants (1015-1017, 2015-2017, 3015-3017) share these `code % 1000`.
const SURFACE_WKB_TYPE_CODES = new Set([15, 16, 17]);

/**
 * True when a DuckDB query failed specifically because its Spatial WKB reader
 * cannot represent a **surface** geometry (TIN / PolyhedralSurface / Triangle) —
 * the encoding GDAL emits for ESRI MultiPatch shapefiles (3D buildings), e.g.
 * `Could not parse WKB input: WKB type 'TIN Z' is not supported! (type id: 1016,
 * SRID: 0)`. Only these surfaces trigger the (more expensive) raw-WKB fallback,
 * which {@link decodeWkb} can decode.
 *
 * Curved geometries (CircularString, CompoundCurve, CurvePolygon, MultiCurve,
 * MultiSurface — codes 8-12) raise the same "WKB type ... is not supported"
 * template but stay undecodable, so they are deliberately excluded: routing them
 * into the fallback would silently produce an empty (all-null-geometry) layer
 * instead of failing loudly. The match therefore requires a surface type name or
 * a surface type id (15/16/17) in the message, not just the generic error shape.
 *
 * @param error The thrown value from a DuckDB query.
 */
export function isUnsupportedSurfaceWkbError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  // Detailed form: "Could not parse WKB input: WKB type 'TIN Z' is not
  // supported! (type id: 1016, SRID: 0)".
  const isUnsupportedWkb =
    lower.includes("could not parse wkb") ||
    (lower.includes("wkb type") && lower.includes("not supported"));
  if (!isUnsupportedWkb) return false;
  // Prefer the numeric type id when present (unambiguous); otherwise fall back
  // to the type name DuckDB quotes in the message. Curved geometries
  // (CircularString etc.) are excluded so they still fail loudly.
  const idMatch = message.match(/type id:\s*(\d+)/i);
  if (idMatch) {
    return SURFACE_WKB_TYPE_CODES.has(Number(idMatch[1]) % 1000);
  }
  // Match the type name DuckDB quotes (e.g. 'TIN Z', 'PolyhedralSurface Z',
  // 'Triangle'). `tin` needs word boundaries so it does not match substrings
  // like "casting"; `polyhedral`/`triangle` are distinctive enough as-is (and
  // "PolyhedralSurface" has no boundary before "Surface").
  return /\btin\b|polyhedral|triangle/i.test(message);
}

/**
 * True for the generic "Unsupported geometry type in WKB" error some DuckDB
 * Spatial builds (e.g. the WASM 1.33 extension on a full MultiPatch shapefile)
 * emit instead of the detailed {@link isUnsupportedSurfaceWkbError} form.
 *
 * It carries no type name or id, so it cannot be told apart from a curved
 * geometry (CircularString etc.). Callers must therefore only route it into the
 * raw-WKB fallback for a source where a surface is the sole possible cause — an
 * ESRI shapefile, whose only surface geometry is MultiPatch and which cannot
 * hold curves. For every other format this message must still fail loudly.
 */
export function isGenericUnsupportedWkbError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return message.includes("unsupported geometry type in wkb");
}

/**
 * Normalize a DuckDB cell value into a JSON-serializable GeoJSON property:
 * BigInt to a safe number (or string when it would lose precision), Date to an
 * ISO string, and arrays/objects recursively.
 */
export function normalizePropertyValue(value: unknown): unknown {
  if (typeof value === "bigint") {
    const numberValue = Number(value);
    return Number.isSafeInteger(numberValue) ? numberValue : value.toString();
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizePropertyValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, normalizePropertyValue(item)]),
    );
  }
  return value;
}

/**
 * Coerce a DuckDB geometry cell to WKB bytes: a BLOB arrives as a `Uint8Array`,
 * but a base64-encoded WKB string column arrives as a `string`. Returns null for
 * an empty/absent value or an undecodable base64 string, so the caller can treat
 * it as a null geometry rather than mis-reading a string as an empty blob.
 */
function wkbCellToBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value.length > 0 ? value : null;
  if (typeof value === "string" && value.length > 0) {
    try {
      return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Build a FeatureCollection from `keep_wkb=true` rows, decoding each row's raw
 * WKB with {@link decodeWkb} (which maps TIN / PolyhedralSurface surfaces to a
 * MultiPolygon). The geometry cell is accepted as either a BLOB (`Uint8Array`)
 * or a base64 WKB string, so a string-typed WKB column does not silently degrade
 * to null geometries. A value that cannot be decoded yields a null geometry
 * rather than aborting the whole file, and the WKB column is dropped from the
 * feature's properties.
 *
 * @param rows Rows from a `SELECT * FROM ST_Read(..., keep_wkb=true)` query.
 * @param wkbColumn The name of the WKB geometry column.
 */
export function wkbRowsToFeatureCollection(
  rows: Record<string, unknown>[],
  wkbColumn: string,
): FeatureCollection<Geometry | null> {
  const features = rows.map((row) => {
    const bytes = wkbCellToBytes(row[wkbColumn]);
    let geometry: Geometry | null = null;
    if (bytes) {
      try {
        geometry = decodeWkb(bytes);
      } catch (error) {
        // One malformed/unrepresentable geometry must not fail the whole layer.
        console.warn("[GeoLibre] Skipped an undecodable WKB geometry.", error);
      }
    }
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (key === wkbColumn || value instanceof Uint8Array) continue;
      properties[key] = normalizePropertyValue(value);
    }
    return {
      type: "Feature",
      geometry,
      properties,
    } satisfies Feature<Geometry | null>;
  });
  return { type: "FeatureCollection", features };
}

export function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

// DuckDB Spatial reports CRS-annotated geometry types such as
// GEOMETRY('EPSG:4326'), so match on the prefix rather than equality.
export function isGeometryColumnType(columnType: unknown): boolean {
  return typeof columnType === "string" && columnType.toUpperCase().startsWith("GEOMETRY");
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
  /**
   * Set when there is no geometry column and points are synthesized from a
   * longitude/latitude column pair. {@link DetectedGeometry.column} is then
   * {@link SYNTHESIZED_GEOMETRY_COLUMN}, which no source column can be named.
   */
  coordinateColumns?: { x: string; y: string };
}

export interface GeometryDetectionOptions {
  /**
   * The `primary_column` a GeoParquet `geo` block declares, when the file
   * carries one. It is checked first: the file itself is a better authority on
   * which of several candidate columns holds the geometry than a name guess is.
   */
  primaryColumn?: string;
  /**
   * Allow synthesizing points from a longitude/latitude column pair when the
   * file carries no geometry-capable column at all. Off by default so the paths
   * that re-read GeoJSON (reprojection, export) cannot promote an ordinary
   * `x`/`y` attribute pair into a geometry; the Parquet load path opts in.
   */
  allowCoordinateColumns?: boolean;
}

/**
 * Find the geometry column in a DESCRIBE result, best evidence first:
 *
 * 1. the column a GeoParquet `geo` block names as `primary_column`;
 * 2. a native GEOMETRY-typed column (DuckDB surfaces the Parquet 2.0
 *    GEOMETRY/GEOGRAPHY logical types as this type already);
 * 3. a well-known WKB blob column name, then a base64 WKB string one, so plain
 *    Parquet files (and GeoParquet files DuckDB does not decode natively) load;
 * 4. with `allowCoordinateColumns`, and only in a file carrying no GEOMETRY and
 *    no binary column at all, a longitude/latitude pair of float columns,
 *    synthesized into points.
 *
 * @param description Rows from `DESCRIBE <query>` (column_name / column_type).
 * @param options Extra evidence and opt-ins; see {@link GeometryDetectionOptions}.
 * @returns The detected geometry column and how to read it, or null when no
 *   geometry can be identified.
 */
export function detectGeometryColumn(
  description: Record<string, unknown>[],
  options: GeometryDetectionOptions = {},
): DetectedGeometry | null {
  const declared = detectDeclaredColumn(description, options.primaryColumn);
  if (declared) return declared;

  const native = description.find((row) => isGeometryColumnType(row.column_type))?.column_name;
  if (typeof native === "string") {
    return { column: native, isWkb: false };
  }
  const rankedWkbCandidates = description
    .filter(
      (row): row is Record<string, unknown> & { column_name: string } =>
        typeof row.column_name === "string" &&
        WKB_GEOMETRY_COLUMN_NAMES.has(row.column_name.toLowerCase()),
    )
    .sort((a, b) => wkbColumnRank(a.column_name) - wkbColumnRank(b.column_name));

  // Prefer binary/blob WKB candidates because DuckDB reads canonical WKB as
  // binary data. String WKB candidates are intentionally a later fallback and
  // must be value-probed by the loader before being decoded: they may be base64
  // geometry, but WKB-style names are still user-authored attributes in some
  // loose Parquet files.
  const wkb = rankedWkbCandidates.find(
    (row) => typeof row.column_type === "string" && BINARY_COLUMN_TYPE.test(row.column_type),
  )?.column_name;
  if (typeof wkb === "string") {
    return { column: wkb, isWkb: true };
  }

  const base64WkbCandidates = rankedWkbCandidates
    .filter(
      (row) =>
        typeof row.column_type === "string" && /^(VARCHAR|TEXT|STRING)/i.test(row.column_type),
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

  // Only a schema holding nothing that could itself be geometry may fall back to
  // a coordinate pair. A WKB blob under a name this module does not know is
  // still geometry, and promoting an unrelated `x`/`y` pair beside it would draw
  // a layer of bogus points instead of reporting that the column was not read.
  if (options.allowCoordinateColumns && !hasGeometryCandidateColumn(description)) {
    const pair = detectCoordinateColumns(description);
    if (pair) {
      return {
        column: SYNTHESIZED_GEOMETRY_COLUMN,
        isWkb: false,
        coordinateColumns: pair,
      };
    }
  }
  return null;
}

/**
 * Read the column a GeoParquet `geo` block declares as primary, classified by
 * how DuckDB typed it. A declared column DuckDB typed as something no geometry
 * reader accepts (an integer, say) returns null so detection falls through to
 * the name-based candidates rather than failing the whole file on a metadata
 * document that disagrees with the schema.
 */
function detectDeclaredColumn(
  description: Record<string, unknown>[],
  primaryColumn: string | undefined,
): DetectedGeometry | null {
  if (!primaryColumn) return null;
  const row = description.find((entry) => entry.column_name === primaryColumn);
  if (!row) return null;
  const type = row.column_type;
  if (isGeometryColumnType(type)) return { column: primaryColumn, isWkb: false };
  if (typeof type !== "string") return null;
  if (BINARY_COLUMN_TYPE.test(type)) return { column: primaryColumn, isWkb: true };
  if (/^(VARCHAR|TEXT|STRING)/i.test(type)) {
    // Still value-probed: a declared column is strong evidence of intent, not
    // proof that its strings decode as base64 WKB.
    return {
      column: primaryColumn,
      isWkb: true,
      isBase64Wkb: true,
      requiresBase64WkbValidation: true,
      base64WkbCandidates: [primaryColumn],
    };
  }
  return null;
}

/**
 * True when the schema holds a column that could itself be the geometry: a
 * native GEOMETRY type, or a binary column under *any* name. Such a file has a
 * geometry the loader failed to recognise, not a table of plain coordinates, so
 * it must not fall back to {@link detectCoordinateColumns}.
 */
function hasGeometryCandidateColumn(description: Record<string, unknown>[]): boolean {
  return description.some(
    (row) =>
      isGeometryColumnType(row.column_type) ||
      (typeof row.column_type === "string" && BINARY_COLUMN_TYPE.test(row.column_type)),
  );
}

/**
 * A longitude/latitude pair of float columns, matched case-insensitively
 * against {@link LONGITUDE_COLUMN_NAMES} / {@link LATITUDE_COLUMN_NAMES}.
 *
 * The two must be different columns: `x`/`y` and `lon`/`lat` overlap in neither
 * set, but a single column cannot be both halves of a point.
 */
export function detectCoordinateColumns(
  description: Record<string, unknown>[],
): { x: string; y: string } | null {
  const find = (names: Set<string>): string | null => {
    const row = description.find(
      (entry) =>
        typeof entry.column_name === "string" &&
        names.has(entry.column_name.toLowerCase()) &&
        typeof entry.column_type === "string" &&
        FLOAT_COLUMN_TYPE.test(entry.column_type),
    );
    return typeof row?.column_name === "string" ? row.column_name : null;
  };
  const x = find(LONGITUDE_COLUMN_NAMES);
  const y = find(LATITUDE_COLUMN_NAMES);
  if (!x || !y || x === y) return null;
  return { x, y };
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
 * column is referenced directly; a raw WKB blob is decoded with ST_GeomFromWKB;
 * a longitude/latitude pair is built into a point with ST_Point.
 */
export function geometryExpr(detected: DetectedGeometry): string {
  if (detected.requiresBase64WkbValidation) {
    throw new Error("Base64 WKB geometry candidates must be validated before SQL generation.");
  }
  if (detected.coordinateColumns) {
    const { x, y } = detected.coordinateColumns;
    return `ST_Point(${quoteIdentifier(x)}, ${quoteIdentifier(y)})`;
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
export function geometryGeoJsonSql(geometryExpression: string, sourceCrs: string | null): string {
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
export function stripAutoFidColumn(geojson: FeatureCollection): FeatureCollection {
  // Scan first so the common (no-OGC_FID) path returns the original object
  // without allocating a throw-away features array or any feature copies.
  const needsStrip = geojson.features.some(
    (feature) => feature.properties != null && GDAL_AUTO_FID_COLUMN in feature.properties,
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
