/** Zipped shapefile reading: shpjs for ordinary files, DuckDB for the rest. */

import type { FeatureCollection } from "geojson";
import { combine, parseDbf, parseShp } from "shpjs";
import { shouldRouteToDuckDb, type DuckDbVectorLoadOptions } from "../duckdb-vector-guard";
import type { DuckDbVectorFile } from "../duckdb-vector-loader";
import { browserSafeFileName } from "./paths";
import { toArrayBuffer } from "./shared";
import {
  assertFeatureCollection,
  loadDuckDbVector,
  mergeFeatureCollections,
  toDuckDbVectorData,
  unzipArchive,
} from "./vector-shared";

function normalizeShapefileResult(value: unknown): FeatureCollection {
  if (Array.isArray(value)) {
    return mergeFeatureCollections(value.map(assertFeatureCollection));
  }
  return assertFeatureCollection(value);
}

/** ESRI shape type for MultiPatch (3D surfaces), read from a `.shp` header. */
const SHAPEFILE_MULTIPATCH_TYPE = 31;

/**
 * True for the metadata entries macOS Finder adds to a zip: the `__MACOSX/`
 * resource-fork tree and AppleDouble `._<name>` files that shadow every real
 * entry (an AppleDouble `._x.shp` otherwise looks like the shapefile).
 */
function isMacOsMetadataEntry(entryName: string): boolean {
  const baseName = entryName.slice(entryName.lastIndexOf("/") + 1);
  return entryName.startsWith("__MACOSX/") || baseName.startsWith("._");
}

/** The ESRI shape type from a `.shp` header (byte 32, little-endian), or -1. */
export function shapefileShapeType(shp: Uint8Array): number {
  if (shp.byteLength < 36) return -1;
  return new DataView(shp.buffer, shp.byteOffset, shp.byteLength).getInt32(32, true);
}

/** A zipped shapefile unzipped once: the DuckDB file, its raw sidecar bytes
 *  (keyed by lowercase extension), and whether it is a 3D MultiPatch. */
export interface UnzippedShapefile {
  file: DuckDbVectorFile;
  /** Sidecar bytes keyed by lowercase extension (`dbf`, `prj`, `cpg`, ...). */
  sidecar: Record<string, Uint8Array>;
  isMultiPatch: boolean;
}

/**
 * Unzip a shapefile archive **once** into a {@link DuckDbVectorFile} (the `.shp`
 * plus its sidecars, registered under one flat base name) and the raw sidecar
 * bytes, skipping macOS `__MACOSX` / AppleDouble entries. Returns null when the
 * archive has no `.shp` (a corrupt archive rejects, so the caller does not
 * silently fall through to a mis-parse).
 *
 * The `isMultiPatch` flag marks 3D MultiPatch (shape type 31) shapefiles: shpjs
 * mis-reads those as points, so they must be loaded through DuckDB, which
 * decodes the TIN surfaces (issue #1121).
 */
export async function readShapefileZipForDuckDb(
  data: ArrayBuffer | Uint8Array,
): Promise<UnzippedShapefile | null> {
  const entries = await unzipArchive(data);
  const shpEntry = Object.keys(entries).find(
    (name) => /\.shp$/i.test(name) && !isMacOsMetadataEntry(name),
  );
  if (!shpEntry) return null;
  const baseName = browserSafeFileName(shpEntry) || "layer.shp";
  const stem = baseName.replace(/\.shp$/i, "");
  const entryBase = shpEntry.replace(/\.[^./]+$/, "");
  const shpBytes = entries[shpEntry];
  const siblingFiles: DuckDbVectorFile[] = [];
  const sidecar: Record<string, Uint8Array> = {};
  for (const [entry, bytes] of Object.entries(entries)) {
    if (entry === shpEntry || isMacOsMetadataEntry(entry)) continue;
    // Same base path (any extension): the shapefile's sidecars (.dbf, .shx, ...).
    if (entry.replace(/\.[^./]+$/, "") !== entryBase) continue;
    const extension = entry.slice(entry.lastIndexOf(".") + 1).toLowerCase();
    siblingFiles.push({
      name: `${stem}.${extension}`,
      extension,
      data: toDuckDbVectorData(bytes),
    });
    sidecar[extension] = bytes;
  }
  return {
    file: {
      name: baseName,
      extension: "shp",
      data: toDuckDbVectorData(shpBytes),
      siblingFiles,
    },
    sidecar,
    isMultiPatch: shapefileShapeType(shpBytes) === SHAPEFILE_MULTIPATCH_TYPE,
  };
}

/**
 * Parse an already-unzipped shapefile with shpjs's low-level parsers, so the
 * archive is not unzipped a second time (shpjs's `shp(zip)` re-inflates every
 * entry). The `.prj` drives reprojection to WGS84 and the `.cpg` the DBF
 * encoding, mirroring `shp(zip)`. Requires the `.dbf`; without it the caller
 * falls back to DuckDB.
 */
function parseShapefileComponents({ file, sidecar }: UnzippedShapefile): FeatureCollection {
  if (!sidecar.dbf) {
    throw new Error("Shapefile archive is missing its .dbf sidecar.");
  }
  const decoder = new TextDecoder();
  const prj = sidecar.prj ? decoder.decode(sidecar.prj) : undefined;
  const cpg = sidecar.cpg ? decoder.decode(sidecar.cpg).trim() : undefined;
  const geometries = parseShp(toArrayBuffer(file.data), prj);
  const attributes = parseDbf(toArrayBuffer(sidecar.dbf), cpg);
  return normalizeShapefileResult(combine([geometries, attributes]));
}

/**
 * Load a zipped shapefile. Unzips once, then reads a 3D MultiPatch shapefile
 * through DuckDB (shpjs mis-parses its surfaces as points; DuckDB decodes the
 * TIN as a MultiPolygon, issue #1121) or parses an ordinary shapefile from the
 * already-extracted buffers, retrying through DuckDB if shpjs cannot read it. A
 * corrupt archive or one without a `.shp` throws, since GeoLibre reads only
 * shapefile `.zip`s.
 *
 * A `.shp` that {@link shouldRouteToDuckDb} routes (at or above
 * `DUCKDB_VECTOR_ROUTE_BYTES`, from `@geolibre/core`) skips shpjs and streams
 * through DuckDB: shpjs would otherwise freeze the main thread reprojecting
 * every coordinate synchronously, with no progress, no cancel, and no
 * feature-count guard. The threshold is measured on the *uncompressed* `.shp`,
 * which is the number that governs the parse cost — shapefiles compress heavily,
 * so the zip's own size says little about it.
 */
export async function loadShapefileZip(
  data: ArrayBuffer | Uint8Array,
  options?: DuckDbVectorLoadOptions,
): Promise<FeatureCollection> {
  const unzipped = await readShapefileZipForDuckDb(data);
  if (!unzipped) {
    throw new Error("The zip archive does not contain a .shp file.");
  }
  if (unzipped.isMultiPatch) {
    return loadDuckDbVector(unzipped.file, options);
  }
  if (shouldRouteToDuckDb(unzipped.file.data.byteLength)) {
    console.info(
      `[GeoLibre] "${unzipped.file.name}" is ${Math.round(
        unzipped.file.data.byteLength / (1024 * 1024),
      )} MB uncompressed; reading it with DuckDB instead of shpjs to keep the parse off the main thread.`,
    );
    return loadDuckDbVector(unzipped.file, options);
  }
  try {
    return parseShapefileComponents(unzipped);
  } catch {
    // shpjs could not read it; retry through DuckDB with the registered
    // components (a raw `.zip` is not a GDAL dataset, so the `.shp` and its
    // sidecars must be registered individually).
    return loadDuckDbVector(unzipped.file, options);
  }
}
