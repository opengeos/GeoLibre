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
 * expose via `parquet_kv_metadata`. This module is the parsing half of that read
 * — kept free of DuckDB imports so it can be tested on its own.
 */

import { isGeographicCrs } from "./crs-utils";
import { quoteSqlString } from "./duckdb-geometry";

/** The Parquet file-metadata key the GeoParquet specification writes to. */
export const GEOPARQUET_METADATA_KEY = "geo";

/** The column the {@link geoParquetMetadataSql} query returns the document in. */
export const GEOPARQUET_METADATA_COLUMN = "geo_metadata";

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
 * The CRS to reproject a GeoParquet file from, parsed from its `geo` metadata
 * document, or null when it needs no reprojection.
 *
 * Null is returned for every "already in GeoJSON's coordinate convention" case,
 * which the specification spells three ways: an absent `crs` member (GeoParquet
 * defaults to OGC:CRS84), an explicit WGS84/CRS84 identifier, and `"crs": null`,
 * which declares that the coordinates are in no known CRS at all — reprojecting
 * those would invent an answer, so they are passed through as-is.
 *
 * A CRS that is present and not WGS84 is returned in the most specific form the
 * document supports, in this order:
 *
 * 1. `AUTHORITY:CODE` from the PROJJSON `id` member (`EPSG:2100`), which is what
 *    every writer that round-trips an EPSG code emits and what `ST_Transform`
 *    resolves most reliably.
 * 2. The PROJJSON document itself, for a CRS with no authority code (a custom
 *    projection); PROJ parses PROJJSON wherever it parses WKT.
 * 3. The raw string, for the pre-1.0 GeoParquet drafts that wrote the CRS as a
 *    WKT2 string rather than as PROJJSON.
 *
 * @param metadataJson The `geo` metadata document as text, or null/blank when
 *   the file has none.
 * @param geometryColumn The column actually being read, when known. A
 *   GeoParquet may carry several geometry columns in different CRSs, and the
 *   loader reads whichever one it detected rather than necessarily the primary
 *   one, so that column's CRS is the one to transform from.
 * @returns A CRS string `ST_Transform` accepts, or null to skip reprojection.
 */
export function geoParquetSourceCrs(
  metadataJson: string | null | undefined,
  geometryColumn?: string,
): string | null {
  if (!metadataJson) return null;

  let metadata: unknown;
  try {
    metadata = JSON.parse(metadataJson);
  } catch {
    // A `geo` key that is not JSON is not a GeoParquet document; treat the file
    // as carrying no CRS rather than failing the load.
    return null;
  }

  const column = geometryColumnMetadata(metadata, geometryColumn);
  if (!column || !("crs" in column)) return null;

  const crs = (column as { crs?: unknown }).crs;
  // An explicit null declares "no CRS", distinct from an absent member (CRS84).
  if (crs === null || crs === undefined) return null;

  const resolved = crsString(crs);
  if (!resolved || isGeographicCrs(resolved)) return null;
  return resolved;
}

/**
 * The metadata entry for the geometry column being read: the named column when
 * the document describes it, else the one `primary_column` names, else the first
 * column listed (so a hand-written document with a single geometry column still
 * resolves).
 *
 * The named column comes first because a GeoParquet may hold several geometry
 * columns in different CRSs; transforming the column the loader read with the
 * primary column's CRS would place the layer somewhere else entirely.
 */
function geometryColumnMetadata(metadata: unknown, geometryColumn?: string): object | null {
  const columns = (metadata as { columns?: unknown })?.columns;
  if (!columns || typeof columns !== "object") return null;
  const entries = Object.entries(columns as Record<string, unknown>).filter(
    (entry): entry is [string, object] => typeof entry[1] === "object" && entry[1] !== null,
  );
  if (entries.length === 0) return null;

  const primary = (metadata as { primary_column?: unknown }).primary_column;
  for (const wanted of [geometryColumn, primary]) {
    if (typeof wanted !== "string") continue;
    const named = entries.find(([name]) => name === wanted);
    if (named) return named[1];
  }
  return entries[0][1];
}

/** One column's `crs` value rendered as a string `ST_Transform` accepts. */
function crsString(crs: unknown): string | null {
  if (typeof crs === "string") return crs.trim() || null;
  if (typeof crs !== "object") return null;

  const id = (crs as { id?: unknown }).id;
  const authority = (id as { authority?: unknown })?.authority;
  const code = (id as { code?: unknown })?.code;
  if (typeof authority === "string" && (typeof code === "string" || typeof code === "number")) {
    return `${authority.trim().toUpperCase()}:${String(code).trim()}`;
  }

  // No authority code: hand PROJ the whole PROJJSON definition instead, so a
  // custom projection still reprojects rather than silently rendering in raw
  // projected coordinates.
  return JSON.stringify(crs);
}
