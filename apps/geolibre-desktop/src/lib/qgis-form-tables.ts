/**
 * Host side of the QGIS importer's relation-backed dropdowns (issue #3398):
 * reads one table of a local GeoPackage as plain rows. Kept apart from
 * `qgis-project-import.ts` so the parser stays free of filesystem and sql.js
 * imports and runs under `node --test`.
 */
import { hasPathTraversal } from "@geolibre/core";
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
): Promise<Record<string, unknown>[]> {
  if (!isTauri()) throw new Error("Local files are only readable in GeoLibre Desktop.");
  if (
    !isAbsoluteLocalPath(sourcePath) ||
    hasPathTraversal(sourcePath) ||
    !/\.gpkg$/i.test(sourcePath)
  ) {
    throw new Error("Only tables in a local GeoPackage can fill a dropdown list.");
  }
  const size = await localFileSizeBytes(sourcePath);
  if (size !== undefined && size > MAX_LOOKUP_FILE_BYTES) {
    throw new Error("The GeoPackage is too large to read a dropdown list from.");
  }
  return loadGeoPackageTableRows(await readLocalFileBytes(sourcePath), table);
}
