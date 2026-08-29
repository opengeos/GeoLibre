/**
 * Reading a GeoParquet file's declared CRS out of its `geo` file metadata.
 *
 * Every other vector format GeoLibre loads goes through GDAL's `ST_Read`, whose
 * `ST_Read_Meta` reports the layer CRS, so the loader can reproject it to WGS84.
 * GeoParquet is read with `read_parquet` instead, and DuckDB does not surface
 * that file's CRS anywhere in the scan — so a file stored in a projected CRS used
 * to load with raw metre coordinates and draw nothing (issue #2086, reported for
 * EPSG:2100 / the Greek Grid).
 *
 * The CRS is not lost, though: the GeoParquet specification puts it in the
 * Parquet file-level key/value metadata under the key `geo`, which DuckDB does
 * expose via `parquet_kv_metadata`; a Parquet 2.0 file may instead carry it on
 * the geometry column's GEOMETRY/GEOGRAPHY logical type, which `parquet_schema`
 * exposes. This module builds those two queries and adapts
 * `geoparquet-metadata.ts` — which owns every parsing rule and holds no DuckDB
 * import — to what the loader needs.
 */

import { isGeographicCrs } from "./crs-utils";
import { quoteSqlString } from "./duckdb-geometry";
import {
  geoParquetColumn,
  geoParquetCrsIdentifier,
  parseGeoParquetMetadata,
  parseLogicalTypeCrs,
  parseNativeGeometryLogicalType,
  type GeoParquetColumnMetadata,
  type GeoParquetCrs,
  type GeoParquetMetadata,
  type NativeGeometryLogicalType,
} from "./geoparquet-metadata";

/** The Parquet file-metadata key the GeoParquet specification writes to. */
export const GEOPARQUET_METADATA_KEY = "geo";

/** The column the {@link geoParquetMetadataSql} query returns the document in. */
export const GEOPARQUET_METADATA_COLUMN = "geo_metadata";

/** The `parquet_schema()` column holding a schema element's name. */
export const PARQUET_SCHEMA_NAME_COLUMN = "name";

/** The `parquet_schema()` column holding a schema element's logical type. */
export const PARQUET_SCHEMA_LOGICAL_TYPE_COLUMN = "logical_type";

/**
 * SQL that yields the `geo` metadata document of a registered Parquet file as
 * text, or no rows when the file carries none (a plain, non-spatial Parquet).
 *
 * The key is matched as a BLOB via `encode` rather than by decoding every key,
 * so a file carrying a non-UTF-8 metadata key cannot fail the whole read; only
 * the matched row's value is decoded.
 *
 * @param fileName The registered DuckDB file name to read metadata from.
 * @returns A SELECT returning at most one row, holding the JSON text.
 */
export function geoParquetMetadataSql(fileName: string): string {
  return (
    `SELECT decode(value) AS ${GEOPARQUET_METADATA_COLUMN} ` +
    `FROM parquet_kv_metadata(${quoteSqlString(fileName)}) ` +
    `WHERE key = encode(${quoteSqlString(GEOPARQUET_METADATA_KEY)})`
  );
}

/**
 * SQL that yields each Parquet schema element's name and logical type, which is
 * where a Parquet 2.0 file records that a column is GEOMETRY or GEOGRAPHY and
 * what CRS its values are in. A 1.x file returns no rows at all.
 *
 * Elements with no logical type are filtered out in SQL rather than in JS so a
 * wide file's whole schema does not cross the WASM boundary for nothing.
 *
 * @param fileName The registered DuckDB file name to read the schema of.
 */
export function parquetLogicalTypesSql(fileName: string): string {
  return (
    `SELECT ${PARQUET_SCHEMA_NAME_COLUMN}, ${PARQUET_SCHEMA_LOGICAL_TYPE_COLUMN} ` +
    `FROM parquet_schema(${quoteSqlString(fileName)}) ` +
    `WHERE ${PARQUET_SCHEMA_LOGICAL_TYPE_COLUMN} IS NOT NULL`
  );
}

/** A column carrying the Parquet 2.0 native geospatial logical type. */
export interface NativeGeometryColumn extends NativeGeometryLogicalType {
  /** The Parquet schema element's name. */
  column: string;
  /** The logical type's free-form CRS string, parsed. */
  parsedCrs: GeoParquetCrs;
}

/**
 * The GEOMETRY/GEOGRAPHY column in a {@link parquetLogicalTypesSql} result: the
 * one the caller names when it is present, else the first one found.
 *
 * `parquet_schema` reports each schema element's own name rather than its dotted
 * path, so this resolves top-level geometry columns — the only place the Parquet
 * geospatial logical types are used in practice.
 *
 * @param rows Rows from {@link parquetLogicalTypesSql}.
 * @param geometryColumn The column the loader detected, when known.
 */
export function nativeGeometryColumn(
  rows: Record<string, unknown>[],
  geometryColumn?: string,
): NativeGeometryColumn | null {
  const found = rows.flatMap((row) => {
    const name = row[PARQUET_SCHEMA_NAME_COLUMN];
    const type = parseNativeGeometryLogicalType(row[PARQUET_SCHEMA_LOGICAL_TYPE_COLUMN]);
    if (typeof name !== "string" || !type) return [];
    return [{ ...type, column: name, parsedCrs: parseLogicalTypeCrs(type.crs) }];
  });
  if (found.length === 0) return null;
  return found.find((entry) => entry.column === geometryColumn) ?? found[0];
}

/** What the loader and the layer info surface need from a file's `geo` block. */
export interface GeoParquetGeoMetadata {
  /** The whole parsed document, or null when the file carries no `geo` key. */
  metadata: GeoParquetMetadata | null;
  /** The entry for the column being read, or null. */
  column: GeoParquetColumnMetadata | null;
  /** That column's CRS, including the `default` / `undefined` distinction. */
  crs: GeoParquetCrs;
  /** The CRS to hand `ST_Transform`, or null to skip reprojection. */
  sourceCrs: string | null;
}

/**
 * Read a `geo` metadata document into everything the loader needs from it: the
 * parsed block, the entry for the column being read, that column's CRS in full,
 * and the reprojection source that CRS reduces to.
 *
 * The CRS is kept alongside `sourceCrs` because the two answer different
 * questions. `sourceCrs` is null for every file that needs no transform, which
 * the specification spells three ways — an absent `crs` member (GeoParquet
 * defaults to OGC:CRS84), an explicit WGS84/CRS84 identifier, and `"crs": null`,
 * which declares that the coordinates are in no known CRS at all. Reprojecting
 * the last of those would invent an answer, so it is passed through as-is; but
 * it is the only one the UI must label as an undefined CRS, and only `crs` can
 * tell it apart.
 *
 * @param metadataJson The `geo` document as text, or null/blank when absent.
 * @param geometryColumn The column actually being read, when known. A
 *   GeoParquet may carry several geometry columns in different CRSs, and the
 *   loader reads whichever one it detected rather than necessarily the primary
 *   one, so that column's CRS is the one to transform from.
 */
export function readGeoParquetGeoMetadata(
  metadataJson: string | null | undefined,
  geometryColumn?: string,
): GeoParquetGeoMetadata {
  const metadata = parseGeoParquetMetadata(metadataJson);
  const column = geoParquetColumn(metadata, geometryColumn);
  const crs: GeoParquetCrs = column?.crs ?? { kind: "default" };
  return { metadata, column, crs, sourceCrs: geoParquetTransformCrs(crs) };
}

/**
 * The CRS to reproject from for a parsed {@link GeoParquetCrs}, or null when the
 * data is already in GeoJSON's coordinate convention.
 *
 * A CRS that is present and not already lon/lat is returned in the most specific
 * form the document supports, in this order:
 *
 * 1. `AUTHORITY:CODE` from the PROJJSON `id` member (`EPSG:2100`), which is what
 *    every writer that round-trips an EPSG code emits and what `ST_Transform`
 *    resolves most reliably.
 * 2. The PROJJSON document itself, for a CRS with no authority code (a custom
 *    projection); PROJ parses PROJJSON wherever it parses WKT.
 * 3. The raw string, for the pre-1.0 GeoParquet drafts that wrote the CRS as a
 *    WKT2 string rather than as PROJJSON.
 */
export function geoParquetTransformCrs(crs: GeoParquetCrs): string | null {
  const identifier = geoParquetCrsIdentifier(crs);
  // An identifier that is already lon/lat needs no transform, and neither do
  // the `default` and `undefined` states, for which `geoParquetCrsIdentifier`
  // yields null in the first place.
  if (!identifier || isGeographicCrs(identifier)) return null;
  return identifier;
}
