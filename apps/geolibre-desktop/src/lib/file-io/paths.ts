/**
 * File name and path predicates shared by the local file I/O modules: which
 * extensions are vectors, rasters, sidecars or GeoLibre projects, plus the
 * small name helpers they are built on. Pure string logic with no Tauri or
 * DOM dependency, so it is safe to import anywhere (and from Node tests).
 */

import { isAbsoluteFilesystemPath, localFileName } from "@geolibre/core";

export function browserSafeFileName(path: string): string {
  return localFileName(path) || "project.geolibre";
}

/** Project extension handled as a workspace switch by drag-and-drop. */
export function isGeoLibreProjectFileName(path: string): boolean {
  const name = browserSafeFileName(path).toLowerCase();
  return name.endsWith(".geolibre") || name.endsWith(".geolibre.json");
}

export const SHAPEFILE_SIDECAR_EXTENSIONS = ["dbf", "shx", "prj", "cpg"];
// SYNC: RESTORABLE_VECTOR_EXTENSIONS in src-tauri/src/lib.rs must list the same
// extensions, or a format added here would be rejected by the Rust restore
// guard on every project reopen (the bug this PR fixes). Grep "SYNC:" to find
// the partner list.
export const VECTOR_FILE_DIALOG_EXTENSIONS = [
  "geojson",
  "json",
  "gpkg",
  "geoparquet",
  "parquet",
  "fgb",
  "flatgeobuf",
  "csv",
  "tsv",
  "kml",
  "kmz",
  "gml",
  "gpx",
  "dxf",
  "tab",
  "shp",
  "zip",
];

const RESTORABLE_VECTOR_PATH = new RegExp(`\\.(${VECTOR_FILE_DIALOG_EXTENSIONS.join("|")})$`, "i");

/**
 * Whether a path ends in a recognized vector extension. Used as a whitelist
 * guard before re-reading a project's `sourcePath` off disk, so a crafted path
 * pointing at a non-vector file is rejected.
 *
 * @param path - The path to check.
 * @returns True when the extension is a loadable vector format.
 */
export function isRestorableVectorPath(path: string): boolean {
  return RESTORABLE_VECTOR_PATH.test(path);
}

/**
 * Whether a file name is a geospatial format the Browser panel's Files tree can
 * add with one click — vectors and GeoTIFF/COG rasters. Deliberately stricter
 * than the lenient drop-path filter (which accepts anything explicitly dropped).
 * MBTiles are excluded for now: vector MBTiles need source-layer selection, so
 * they go through the Add Data dialog rather than a one-click tree add.
 *
 * @param name - The file name (or path) to test.
 * @returns True when the extension is a one-click-loadable geospatial format.
 */
export function isLoadableFilePath(name: string): boolean {
  return isRestorableVectorPath(name) || isRasterFileName(name);
}

// Auxiliary files that accompany Shapefiles (spatial indexes, metadata, etc.)
// but are never standalone vector layers. Skipping them keeps a single such
// file from aborting an otherwise valid drag-and-drop import.
const NON_VECTOR_SIDECAR_EXTENSIONS = [
  ...SHAPEFILE_SIDECAR_EXTENSIONS,
  "sbn",
  "sbx",
  "qix",
  "qpj",
  "cst",
  "aih",
  "ain",
  "atx",
  "fbn",
  "fbx",
  "ixs",
  "mxs",
];

/** GeoTIFF/COG extensions handled by the map drag and drop raster path. */
export const RASTER_DROP_EXTENSIONS = ["tif", "tiff"];

/** Whether a filename looks like a raster the map can load (GeoTIFF/COG). */
export function isRasterFileName(name: string): boolean {
  return RASTER_DROP_EXTENSIONS.includes(fileExtension(name));
}

export function isHttpUrl(path: string): boolean {
  try {
    const url = new URL(path);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function fileExtension(path: string): string {
  const name = browserSafeFileName(path).toLowerCase();
  if (name.endsWith(".geoparquet")) return "geoparquet";
  return name.split(".").pop() ?? "";
}

export function pathWithoutExtension(path: string): string {
  return path.replace(/\.[^.\\/]+$/, "");
}

export function isVectorFileName(path: string): boolean {
  if (isGeoLibreProjectFileName(path)) return false;
  if (browserSafeFileName(path).toLowerCase().endsWith(".shp.xml")) return false;
  // Rasters are handled by the raster drop path, not the DuckDB vector loader.
  if (isRasterFileName(path)) return false;
  return !NON_VECTOR_SIDECAR_EXTENSIONS.includes(fileExtension(path));
}

export function isAbsoluteLocalPath(path: string): boolean {
  // Delegates to core so record normalization (which cannot import this module)
  // validates a persisted path by exactly the same rule; see
  // `isAbsoluteFilesystemPath` for why UNC paths are rejected.
  return isAbsoluteFilesystemPath(path);
}

export function fileBaseName(path: string): string {
  return localFileName(path) || path;
}

/**
 * Whether a local path is Windows-style: a drive-letter prefix (`C:\`, `C:/`)
 * or a UNC prefix (`\\server`). Only these use `\` as a separator; on
 * Linux/macOS `\` is a legal filename character.
 *
 * @param path - The local path to classify.
 * @returns True for a drive-letter or UNC path.
 */
export function isWindowsStylePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

/**
 * Join a directory path and an entry name with the directory's own separator
 * style, so a Windows path stays all-backslash while a POSIX directory whose
 * name contains a literal `\` is still joined with `/`.
 *
 * @param dir - The directory path.
 * @param name - The entry name to append.
 * @returns The joined path.
 */
export function joinLocalPath(dir: string, name: string): string {
  if (isWindowsStylePath(dir)) {
    if (/[/\\]$/.test(dir)) return `${dir}${name}`;
    return `${dir}${dir.includes("\\") ? "\\" : "/"}${name}`;
  }
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}
