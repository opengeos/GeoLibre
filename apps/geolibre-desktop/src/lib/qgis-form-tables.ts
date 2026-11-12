/**
 * Host side of the QGIS importer's relation-backed dropdowns (issue #3398):
 * reads one table of a local GeoPackage as plain rows. Kept apart from
 * `qgis-project-import.ts` so the parser stays free of filesystem and sql.js
 * imports and runs under `node --test`.
 */
import { hasPathTraversal } from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import { loadGeoPackageTableRows } from "./gpkg-reader";
import { localFileSizeBytes, readLocalFileBytes } from "./file-io/local-fs";
import { isAbsoluteLocalPath, isTauri } from "./tauri-io";

/** Lookup tables live in small files; do not pull a huge one into memory. */
const MAX_LOOKUP_FILE_BYTES = 256 * 1024 * 1024;

/**
 * Read a referenced table for a QGIS form dropdown.
 *
 * @param sourcePath - Absolute path of the data file, from the QGIS project.
 * @param table - Table name inside it.
 * @returns The table's rows.
 * @throws When the host cannot read local files, the path is not a plain
 *   absolute GeoPackage path, the file is too large, or the table is missing.
 */
export async function readQgisFormTable(
  sourcePath: string,
  table: string,
  limit?: number,
): Promise<Record<string, unknown>[]> {
  if (!isTauri()) throw new Error("Local files are only readable in GeoLibre Desktop.");
  if (
    // Network shares are refused here as they are for layers: opening one
    // makes the machine authenticate to whatever host the project names.
    /^(?:\/\/|\\\\)/.test(sourcePath) ||
    !isAbsoluteLocalPath(sourcePath) ||
    hasPathTraversal(sourcePath) ||
    !/\.gpkg$/i.test(sourcePath)
  ) {
    throw new Error("Only tables in a local GeoPackage can be read.");
  }
  const size = await localFileSizeBytes(sourcePath);
  if (size !== undefined && size > MAX_LOOKUP_FILE_BYTES) {
    throw new Error("The GeoPackage is too large to read a table from.");
  }
  return loadGeoPackageTableRows(await readLocalFileBytes(sourcePath), table, limit);
}

/** Most rows read into a table layer; a table is a list, not a dataset. */
export const TABLE_LAYER_ROW_LIMIT = 100_000;

/**
 * Read a geometry-less GeoPackage table as the features of a table layer:
 * one feature per row, with the row as its properties and no geometry.
 *
 * @param sourcePath - Absolute path of the GeoPackage.
 * @param table - Table name inside it.
 * @returns The geometry-less features, and whether the table had more rows
 *   than {@link TABLE_LAYER_ROW_LIMIT}.
 */
export async function readTableLayerFeatures(
  sourcePath: string,
  table: string,
): Promise<{ geojson: FeatureCollection; truncated: boolean }> {
  // One row past the limit tells a full table from one that was cut short.
  const rows = await readQgisFormTable(sourcePath, table, TABLE_LAYER_ROW_LIMIT + 1);
  const truncated = rows.length > TABLE_LAYER_ROW_LIMIT;
  return {
    truncated,
    geojson: {
      type: "FeatureCollection",
      // GeoJSON allows a null geometry; the typings want a Geometry.
      features: rows
        .slice(0, TABLE_LAYER_ROW_LIMIT)
        .map((properties) => ({ type: "Feature", geometry: null, properties })),
    } as unknown as FeatureCollection,
  };
}
