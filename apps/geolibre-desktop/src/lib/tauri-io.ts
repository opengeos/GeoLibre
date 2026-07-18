import { hasPathTraversal, parseProject, type GeoLibreProject } from "@geolibre/core";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  readDir,
  readFile,
  readTextFile,
  readTextFileLines,
  writeFile,
  writeTextFile,
} from "@tauri-apps/plugin-fs";
import { unzip } from "fflate";
import type { FeatureCollection } from "geojson";
import i18next from "i18next";
import { combine, parseDbf, parseShp } from "shpjs";
import {
  DELIMITER_CANDIDATES,
  NO_VALID_COORDINATES_MESSAGE,
  detectCoordinateFields,
  detectDelimitedTextDelimiter,
  parseDelimitedTextFields,
  parseDelimitedTextLayer,
} from "./delimited-text";
import type { DuckDbVectorFile } from "./duckdb-vector-loader";
import {
  confirmLargeDataset,
  type DuckDbVectorLoadOptions,
  type LargeVectorDataset,
} from "./duckdb-vector-guard";
import type { GeotaggedPhotoResult } from "./geotagged-photos";
import { PHOTO_IMAGE_EXTENSIONS, isPhotoDropFileName, isPhotoFileName } from "./geotagged-photos";
import { parseGpxLayer } from "./gpx";
import { isTauri } from "./is-tauri";
import {
  parseKmlGroundOverlays,
  parseKmlModels,
  parseKmlText,
  type KmlGroundOverlay,
  type KmlModel,
} from "./kml";
import {
  findArchiveEntry,
  findArchiveEntryKey,
  imageMimeFromName,
  normalizeArchivePath,
} from "./kml-overlays";

// Re-exported so existing `import { isTauri } from "./tauri-io"` consumers keep
// working; the implementation lives in the lightweight ./is-tauri module.
export { isTauri };

function browserSafeFileName(path: string): string {
  return path.split(/[/\\]/).pop() || "project.geolibre.json";
}

export interface FileDialogFilter {
  name: string;
  extensions: string[];
}

interface PickLocalPathOptions {
  accept?: string;
  directory?: boolean;
  filters?: FileDialogFilter[];
}

interface PickSavePathOptions {
  browserTypes?: BrowserFilePickerType[];
  defaultName: string;
  filters?: FileDialogFilter[];
}

interface LocalDataFileOptions {
  filters: FileDialogFilter[];
  accept: string;
  readBinary?: boolean;
  readText?: boolean;
}

interface BrowserFilePickerType {
  description: string;
  accept: Record<string, string[]>;
}

interface BrowserOpenFileHandle {
  name: string;
  getFile: () => Promise<File>;
}

interface BrowserWritableFileStream {
  write: (data: string | Blob) => Promise<void>;
  close: () => Promise<void>;
}

interface BrowserSaveFileHandle {
  name: string;
  createWritable: () => Promise<BrowserWritableFileStream>;
}

interface BrowserFilePickerWindow extends Window {
  showOpenFilePicker?: (options: {
    multiple?: boolean;
    types?: BrowserFilePickerType[];
    excludeAcceptAllOption?: boolean;
  }) => Promise<BrowserOpenFileHandle[]>;
  showSaveFilePicker?: (options: {
    suggestedName?: string;
    types?: BrowserFilePickerType[];
    excludeAcceptAllOption?: boolean;
  }) => Promise<BrowserSaveFileHandle>;
}

const GEOLIBRE_PROJECT_FILE_TYPES: BrowserFilePickerType[] = [
  {
    description: "GeoLibre Project",
    accept: {
      "application/json": [".geolibre", ".json"],
    },
  },
];

interface SaveTextFileOptions {
  defaultName: string;
  filters: FileDialogFilter[];
  browserTypes: BrowserFilePickerType[];
  mimeType: string;
}

interface SaveBinaryFileOptions extends SaveTextFileOptions {}

const SHAPEFILE_SIDECAR_EXTENSIONS = ["dbf", "shx", "prj", "cpg"];
// SYNC: RESTORABLE_VECTOR_EXTENSIONS in src-tauri/src/lib.rs must list the same
// extensions, or a format added here would be rejected by the Rust restore
// guard on every project reopen (the bug this PR fixes). Grep "SYNC:" to find
// the partner list.
const VECTOR_FILE_DIALOG_EXTENSIONS = [
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

/** One entry of a local directory listing (from {@link listDirectory}). */
export interface LocalDirectoryEntry {
  name: string;
  /** Absolute path of the entry. */
  path: string;
  isDirectory: boolean;
}

/**
 * List a local directory's immediate entries via the `fs` plugin's `readDir`
 * (desktop only; resolves to `[]` off-desktop). This works only within the fs
 * scope the OS folder dialog grants for a picked directory (and its subtree),
 * so the Browser panel only lists folders the user added via the picker — no
 * new unbounded filesystem-read primitive. `readDir` returns names + type flags
 * only, so the absolute path of each entry is joined here. Filtering to loadable
 * file types is the caller's job.
 *
 * @param path - Absolute directory path to list (a picker-granted folder or a
 *   descendant of one).
 * @returns The directory's entries (folders and files).
 */
export async function listDirectory(path: string): Promise<LocalDirectoryEntry[]> {
  if (!isTauri()) return [];
  const entries = await readDir(path);
  // Join with the parent's own separator style so a Windows path stays
  // all-backslash (readDir returns names only, no path).
  const sep = path.includes("\\") ? "\\" : "/";
  const base = /[/\\]$/.test(path) ? path : `${path}${sep}`;
  return entries.map((entry) => ({
    name: entry.name,
    path: `${base}${entry.name}`,
    isDirectory: entry.isDirectory,
  }));
}

// Built at call time so the filter-group label shown in the native file dialog
// is translated (a module-level constant would freeze the English string).
function vectorFileDialogFilters(): FileDialogFilter[] {
  return [
    {
      name: i18next.t("toolbar.item.vectorDataFilter"),
      extensions: VECTOR_FILE_DIALOG_EXTENSIONS,
    },
  ];
}

export interface LoadedVectorLayer {
  data: FeatureCollection;
  name?: string;
  path: string;
}

/**
 * A georeferenced image overlay produced by a KML/KMZ `<GroundOverlay>`. Unlike
 * {@link LoadedVectorLayer} it carries no `FeatureCollection`; the caller turns
 * it into an `image`-type store layer via `addImageOverlayLayer`. The `kind`
 * tag distinguishes it from a vector layer in a mixed load result.
 */
export interface LoadedImageOverlay {
  kind: "image-overlay";
  name: string;
  path: string;
  /** Image data URL (from a KMZ archive) or an absolute URL (from a KML). */
  url: string;
  /** Four `[lng, lat]` corners: top-left, top-right, bottom-right, bottom-left. */
  coordinates: [number, number][];
  /** Overlay extent as `[west, south, east, north]` in WGS84 degrees. */
  bounds: [number, number, number, number];
  /** Overlay opacity in [0, 1]. */
  opacity: number;
  /**
   * Epoch-ms time bounds when the overlay is a `<TimeSpan>`/`<TimeStamp>` frame
   * in a time-animated sequence. Set (with `groupId`/`visible`) by
   * {@link sequenceTimeOverlays}; the Time Slider animates these frames.
   */
  timeSpan?: { begin: number | null; end: number | null };
  /** Shared group id linking the frames of one animation. */
  groupId?: string;
  /** Initial visibility: only the first frame of a sequence starts visible. */
  visible?: boolean;
}

/**
 * A 3D model produced by a KML/KMZ `<Model>` (a COLLADA `.dae` converted to a
 * self-contained GLB). The caller turns it into a deck.gl scenegraph layer. The
 * `kind` tag distinguishes it from a vector layer in a mixed load result.
 */
export interface LoadedModel {
  kind: "model";
  name: string;
  path: string;
  /** GLB model as a `data:` URL (textures embedded), renderable as glTF. */
  url: string;
  /** Model location in WGS84 degrees and meters. */
  longitude: number;
  latitude: number;
  altitude: number;
  /** `<Orientation>` heading/tilt/roll in degrees. */
  heading: number;
  tilt: number;
  roll: number;
  /** `<Scale>` factors along the model's x/y/z axes. */
  scale: { x: number; y: number; z: number };
  /**
   * The model's extent in meters (max distance from its anchored origin to any
   * bounding-box corner), used to frame it on load. `0` when unknown.
   */
  radiusMeters: number;
  /** Model-space vertical bounds after COLLADA unit/up-axis handling. */
  verticalMinMeters: number;
  verticalMaxMeters: number;
}

/**
 * A single result from a vector-file load: a vector layer, an image overlay, or
 * a 3D model. A KMZ/KML file can yield a mix (placemarks plus ground overlays
 * plus models), mirroring how a GPX file yields several vector layers.
 */
export type LoadedLayer = LoadedVectorLayer | LoadedImageOverlay | LoadedModel;

/** Narrow a {@link LoadedLayer} to its image-overlay variant. */
export function isLoadedImageOverlay(layer: LoadedLayer): layer is LoadedImageOverlay {
  return "kind" in layer && layer.kind === "image-overlay";
}

/** Narrow a {@link LoadedLayer} to its 3D-model variant. */
export function isLoadedModel(layer: LoadedLayer): layer is LoadedModel {
  return "kind" in layer && layer.kind === "model";
}

/** Narrow a {@link LoadedLayer} to its vector variant. */
export function isLoadedVectorLayer(layer: LoadedLayer): layer is LoadedVectorLayer {
  return !("kind" in layer);
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
const RASTER_DROP_EXTENSIONS = ["tif", "tiff"];

/** Whether a filename looks like a raster the map can load (GeoTIFF/COG). */
export function isRasterFileName(name: string): boolean {
  return RASTER_DROP_EXTENSIONS.includes(fileExtension(name));
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function isHttpUrl(path: string): boolean {
  try {
    const url = new URL(path);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function fileExtension(path: string): string {
  const name = browserSafeFileName(path).toLowerCase();
  if (name.endsWith(".geoparquet")) return "geoparquet";
  return name.split(".").pop() ?? "";
}

function pathWithoutExtension(path: string): string {
  return path.replace(/\.[^.\\/]+$/, "");
}

function isGeoLibreProjectFile(path: string): boolean {
  const name = browserSafeFileName(path).toLowerCase();
  return name.endsWith(".geolibre") || name.endsWith(".geolibre.json");
}

function isVectorFileName(path: string): boolean {
  if (isGeoLibreProjectFile(path)) return false;
  if (browserSafeFileName(path).toLowerCase().endsWith(".shp.xml")) return false;
  // Rasters are handled by the raster drop path, not the DuckDB vector loader.
  if (isRasterFileName(path)) return false;
  return !NON_VECTOR_SIDECAR_EXTENSIONS.includes(fileExtension(path));
}

function assertFeatureCollection(value: unknown): FeatureCollection {
  if (
    value &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === "FeatureCollection" &&
    Array.isArray((value as { features?: unknown }).features)
  ) {
    return value as FeatureCollection;
  }
  throw new Error("The selected file did not produce a GeoJSON FeatureCollection.");
}

// DuckDB-wasm (pthreads build) can hand back a Uint8Array backed by a
// SharedArrayBuffer, which `Blob`'s BlobPart type rejects. Copy into a plain
// ArrayBuffer so the binary save path type-checks and stays portable.
function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(data.byteLength);
  new Uint8Array(buffer).set(data);
  return buffer;
}

function mergeFeatureCollections(collections: FeatureCollection[]): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: collections.flatMap((collection) => collection.features),
  };
}

function normalizeShapefileResult(value: unknown): FeatureCollection {
  if (Array.isArray(value)) {
    return mergeFeatureCollections(value.map(assertFeatureCollection));
  }
  return assertFeatureCollection(value);
}

async function parseGeoJsonText(text: string): Promise<FeatureCollection> {
  return assertFeatureCollection(JSON.parse(text));
}

/**
 * Read a local file's bytes, falling back to the `read_local_file` Tauri command
 * when the JS `fs` plugin denies the path.
 *
 * When a project is reopened, its file-referenced layer paths come from the
 * saved `.geolibre.json` rather than from a picker or drag-drop, so they sit
 * outside the `fs` plugin's runtime scope and `readFile` rejects them. The
 * command reads the file directly, so a referenced layer reloads after a fresh
 * launch instead of failing with a misleading "Could not convert this vector
 * file with DuckDB-WASM" error.
 *
 * The fall-through is deliberately broad: it covers every `readFile` rejection,
 * not just scope denials. The fs plugin does not expose a stable discriminant
 * for an out-of-scope path (only a message we would have to substring-match, and
 * a wrong guess would silently re-break the reload this fixes), so narrowing is
 * not worth the fragility. The cost is one extra IPC round-trip on a genuine
 * read failure (e.g. a moved file), where `read_local_file` fails too and its
 * error surfaces instead of the plugin's. The command validates the path on the
 * Rust side, so routing the read through it cannot widen what is readable.
 *
 * @param path - Absolute local path to read.
 * @returns The file's raw bytes.
 */
export async function readLocalFileBytes(path: string): Promise<Uint8Array<ArrayBuffer>> {
  try {
    return await readFile(path);
  } catch (error) {
    if (!isTauri()) throw error;
    // Log the original fs-plugin error before retrying so a genuine read
    // failure (a moved/deleted file, not a scope denial) is still diagnosable
    // even though the command's "Could not read local file" error is what
    // ultimately surfaces.
    console.debug(`[GeoLibre] fs read of "${path}" failed; retrying via read_local_file.`, error);
    const buffer = await invoke<ArrayBuffer>("read_local_file", { path });
    return new Uint8Array(buffer);
  }
}

/**
 * Text counterpart to {@link readLocalFileBytes}: read a local file as UTF-8,
 * falling back to the `read_local_file` Tauri command when the `fs` plugin
 * denies the path (e.g. a project-referenced layer after a fresh launch). See
 * {@link readLocalFileBytes} for why the fall-through catches every rejection.
 *
 * @param path - Absolute local path to read.
 * @returns The file's decoded UTF-8 text.
 */
async function readLocalFileText(path: string): Promise<string> {
  try {
    return await readTextFile(path);
  } catch (error) {
    if (!isTauri()) throw error;
    console.debug(`[GeoLibre] fs read of "${path}" failed; retrying via read_local_file.`, error);
    const buffer = await invoke<ArrayBuffer>("read_local_file", { path });
    // `fatal: true` matches `readTextFile`, which rejects on malformed UTF-8
    // rather than silently substituting U+FFFD: a corrupt KML/GPX/GeoJSON
    // should surface a clear read error, not parse as garbled-but-valid text.
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  }
}

function parseGpxText(text: string): FeatureCollection {
  const result = parseGpxLayer(text);
  return mergeFeatureCollections([result.waypoints, result.tracks, result.routes]);
}

function parseGpxTextLayers(text: string, path: string): LoadedVectorLayer[] {
  const result = parseGpxLayer(text);
  const baseName = pathWithoutExtension(browserSafeFileName(path)) || "GPX";
  return [
    { data: result.waypoints, label: "Waypoints" },
    { data: result.tracks, label: "Tracks" },
    { data: result.routes, label: "Routes" },
  ]
    .filter((layer) => layer.data.features.length > 0)
    .map((layer) => ({
      data: layer.data,
      name: `${baseName} ${layer.label}`,
      path,
    }));
}

/** Delimited text formats the drag-and-drop / open path loads as points. */
const DELIMITED_TEXT_DROP_EXTENSIONS = ["csv", "tsv"];

/** Whether a filename looks like a delimited text table (CSV/TSV). */
function isDelimitedTextFileName(path: string): boolean {
  return DELIMITED_TEXT_DROP_EXTENSIONS.includes(fileExtension(path));
}

/**
 * Parses dropped/opened delimited text into a point FeatureCollection by
 * auto-detecting the delimiter and the longitude/latitude columns.
 *
 * Returns `null` when no longitude/latitude columns can be identified, so the
 * caller can fall back to the DuckDB path and still load spatial CSV variants
 * (e.g. a CSV with a WKT geometry column). Throws a helpful error (pointing at
 * the Add Data dialog) when the file is empty or the auto-detected columns hold
 * no usable WGS84 coordinates (e.g. a CSV whose `x`/`y` columns are projected).
 */
function parseDelimitedTextFile(text: string, path: string): FeatureCollection | null {
  const name = browserSafeFileName(path);
  const pickColumns = `Use Add Data → Delimited Text to choose the coordinate columns for ${name}.`;
  const delimiter = detectDelimitedTextDelimiter(text);
  // Detect the coordinate columns from the header slice only;
  // parseDelimitedTextLayer re-reads the header internally, so parsing the
  // whole file here just to recover the column names would double the work.
  const headerLine = text.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0] ?? "";
  if (!headerLine.trim()) {
    throw new Error(`${name} appears to be empty. ${pickColumns}`);
  }
  const fields = parseDelimitedTextFields(headerLine, delimiter);
  const coordinateFields = detectCoordinateFields(fields);
  if (!coordinateFields) return null;
  try {
    return parseDelimitedTextLayer(text, {
      delimiter,
      longitudeField: coordinateFields.longitudeField,
      latitudeField: coordinateFields.latitudeField,
    }).data;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // Only the "no valid coordinates" failure points to the wrong columns
    // (e.g. the auto-detected columns are actually projected x/y); append the
    // column-picker hint just for that case. Other errors (e.g. a header with
    // no data rows) are already self-explanatory, so surface them unchanged.
    const isCoordinateError = detail === NO_VALID_COORDINATES_MESSAGE;
    throw new Error(isCoordinateError ? `${detail} ${pickColumns}` : detail);
  }
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
 */
async function loadShapefileZip(
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
  try {
    return parseShapefileComponents(unzipped);
  } catch {
    // shpjs could not read it; retry through DuckDB with the registered
    // components (a raw `.zip` is not a GDAL dataset, so the `.shp` and its
    // sidecars must be registered individually).
    return loadDuckDbVector(unzipped.file, options);
  }
}

function unzipArchive(data: ArrayBuffer | Uint8Array): Promise<Record<string, Uint8Array>> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    unzip(bytes, (error, entries) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(entries);
    });
  });
}

function toDuckDbVectorData(data: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(data);
}

function readKmlEntries(entries: Record<string, Uint8Array>): DuckDbVectorFile[] {
  const kmlEntries = Object.entries(entries)
    .filter(([entryName]) => entryName.toLowerCase().endsWith(".kml"))
    .sort(([leftName], [rightName]) => {
      if (browserSafeFileName(leftName).toLowerCase() === "doc.kml") return -1;
      if (browserSafeFileName(rightName).toLowerCase() === "doc.kml") return 1;
      return leftName.localeCompare(rightName);
    });

  if (!kmlEntries.length) {
    throw new Error("The KMZ archive did not contain a KML file.");
  }

  return kmlEntries.map(([entryName, data], index) => {
    const entryBaseName = browserSafeFileName(entryName) || `document-${index + 1}.kml`;
    return {
      name: kmlEntries.length === 1 ? entryBaseName : `${index + 1}-${entryBaseName}`,
      extension: "kml",
      data: toDuckDbVectorData(data),
    };
  });
}

async function readKmzKmlFiles(data: ArrayBuffer | Uint8Array): Promise<DuckDbVectorFile[]> {
  return readKmlEntries(await unzipArchive(data));
}

/**
 * Encode raw image bytes as a `data:` URL. Uses a `Blob` + `FileReader` (rather
 * than `btoa`) so a large overlay image cannot overflow the argument stack.
 */
function bytesToDataUrl(bytes: Uint8Array, mime: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("Could not read overlay image."));
    reader.readAsDataURL(new Blob([bytes as BlobPart], { type: mime }));
  });
}

function imageOverlayLayer(
  overlay: KmlGroundOverlay,
  url: string,
  path: string,
): LoadedImageOverlay {
  return {
    kind: "image-overlay",
    // Strip the file extension for the fallback name (e.g. "tour.kmz" ->
    // "tour overlay"), matching how the vector layers are named.
    name: overlay.name?.trim() || `${pathWithoutExtension(fileBaseName(path))} overlay`,
    path,
    url,
    coordinates: overlay.coordinates,
    bounds: overlay.bounds,
    opacity: overlay.opacity,
    ...(overlay.time ? { timeSpan: overlay.time } : {}),
  };
}

/**
 * Turn the time-tagged overlays in a set into an animation: sort them by start
 * time, fill an open `<TimeStamp>`/`<TimeSpan>` end with the next frame's start
 * (a step function), give them a shared group id, and leave only the first
 * frame visible so the others do not all stack at once before the Time Slider
 * is opened.
 *
 * Only overlays with a numeric start (`timeSpan.begin`) are treated as frames,
 * matching what the Time Slider can animate; an overlay with an open-start span
 * (or a lone time-tagged overlay that is not part of a sequence) has its
 * transient `timeSpan` dropped so it stays a normal static overlay the slider
 * never hides.
 *
 * @param overlays - The resolved overlays for one file, mutated in place.
 * @returns The same array, for chaining.
 */
function sequenceTimeOverlays(overlays: LoadedImageOverlay[]): LoadedImageOverlay[] {
  const frames = overlays
    .filter(
      (
        overlay,
      ): overlay is LoadedImageOverlay & {
        timeSpan: { begin: number; end: number | null };
      } => typeof overlay.timeSpan?.begin === "number",
    )
    .sort((a, b) => a.timeSpan.begin - b.timeSpan.begin);

  // An animation needs at least two frames with distinct start times. A lone
  // time-tagged overlay, or several sharing one time (e.g. a single inherited
  // Folder `<TimeSpan>`), is not a sequence; strip every transient timeSpan so
  // the Time Slider treats these overlays as ordinary static layers.
  const distinctBegins = new Set(frames.map((frame) => frame.timeSpan.begin));
  if (distinctBegins.size < 2) {
    for (const overlay of overlays) delete overlay.timeSpan;
    return overlays;
  }

  const inSequence = new Set<LoadedImageOverlay>(frames);
  const groupId = crypto.randomUUID();
  frames.forEach((frame, index) => {
    frame.groupId = groupId;
    frame.visible = index === 0;
    // A frame with an open end runs until the next frame begins (or stays open
    // for the last frame), so an instant-tagged sequence steps cleanly.
    if (frame.timeSpan.end === null) {
      const next = frames[index + 1]?.timeSpan.begin;
      if (typeof next === "number") frame.timeSpan.end = next;
    }
  });
  // Any time-tagged overlay left out of the sequence (e.g. an open-start span)
  // should not be animated, so drop its timeSpan too.
  for (const overlay of overlays) {
    if (!inSequence.has(overlay)) delete overlay.timeSpan;
  }
  return overlays;
}

// A ground-overlay image is inlined as a base64 `data:` URL on the layer and
// persisted in the project file (and every collaboration snapshot) at ~4/3 its
// byte size, so cap it like the Raster Georeferencer does to avoid bloating
// projects and memory.
const MAX_OVERLAY_IMAGE_BYTES = 8 * 1024 * 1024;

// A `<GroundOverlay>` together with the archive directory of the KML that
// declared it, so a relative `href` can be resolved against that directory
// first.
interface KmzOverlay {
  overlay: KmlGroundOverlay;
  baseDir: string;
}

// The directory prefix (with trailing slash) of an archive entry name, or "".
function archiveDirname(entryName: string): string {
  const slash = entryName.lastIndexOf("/");
  return slash >= 0 ? entryName.slice(0, slash + 1) : "";
}

// Resolve every GroundOverlay in the archive's KML documents to an image layer,
// pulling each overlay's image bytes out of the archive (or using an absolute
// URL directly). Overlays whose image is missing, oversized, or in a format
// browsers cannot render are skipped with a warning.
async function groundOverlaysFromKmz(
  entries: Record<string, Uint8Array>,
  kmlDocs: { name: string; text: string }[],
  path: string,
): Promise<LoadedImageOverlay[]> {
  // Prefilter (case-insensitively, matching kml.ts's tolerant element matching)
  // so a KML with no overlay is not DOM-parsed a second time.
  const parsed: KmzOverlay[] = kmlDocs
    .filter((doc) => /groundoverlay/i.test(doc.text))
    .flatMap((doc) =>
      parseKmlGroundOverlays(doc.text).map((overlay) => ({
        overlay,
        baseDir: archiveDirname(doc.name),
      })),
    )
    .sort((a, b) => a.overlay.drawOrder - b.overlay.drawOrder);

  const overlays: LoadedImageOverlay[] = [];
  for (const { overlay, baseDir } of parsed) {
    // Applies to every href type (archive-embedded or absolute URL): browsers
    // cannot decode TIFF for a MapLibre image source.
    if (isUnrenderableOverlayImage(overlay.href)) {
      warnUnrenderableOverlay(overlay.href);
      continue;
    }
    if (isHttpUrl(overlay.href)) {
      overlays.push(imageOverlayLayer(overlay, overlay.href.trim(), path));
      continue;
    }
    // Try the href relative to its KML's directory first (a KMZ nesting
    // `folder/doc.kml` referencing `images/x.png` means `folder/images/x.png`),
    // then fall back to the global archive lookup.
    const data =
      findArchiveEntry(entries, baseDir + overlay.href) ?? findArchiveEntry(entries, overlay.href);
    if (!data) {
      console.warn(
        `Skipping a KML ground overlay: its image "${overlay.href}" was not found in the KMZ archive.`,
      );
      continue;
    }
    if (data.length > MAX_OVERLAY_IMAGE_BYTES) {
      console.warn(
        `Skipping a KML ground overlay: its image "${overlay.href}" is ${Math.round(data.length / (1024 * 1024))} MB, over the ${Math.round(MAX_OVERLAY_IMAGE_BYTES / (1024 * 1024))} MB inline limit.`,
      );
      continue;
    }
    const url = await bytesToDataUrl(data, imageMimeFromName(overlay.href));
    overlays.push(imageOverlayLayer(overlay, url, path));
  }
  return sequenceTimeOverlays(overlays);
}

// Browsers cannot decode TIFF into an <img>/canvas/createImageBitmap, which is
// what a MapLibre image source paints from, so a TIFF overlay would fail to
// render with no feedback. Detected from the href extension.
function isUnrenderableOverlayImage(href: string): boolean {
  return imageMimeFromName(href) === "image/tiff";
}

function warnUnrenderableOverlay(href: string): void {
  console.warn(`Skipping a KML ground overlay: browsers cannot render the TIFF image "${href}".`);
}

// Order overlays by KML `<drawOrder>` ascending. Layers added later render on
// top (higher store index sits above), so emitting the lowest drawOrder first
// makes the highest drawOrder end up on top, matching Google Earth's stacking.
function sortByDrawOrder(overlays: KmlGroundOverlay[]): KmlGroundOverlay[] {
  return [...overlays].sort((a, b) => a.drawOrder - b.drawOrder);
}

// GroundOverlays in a standalone (non-archived) KML can only be resolved when
// their href is an absolute URL; a relative path needs the sibling image files
// a browser load does not have.
function groundOverlaysFromKml(text: string, path: string): LoadedImageOverlay[] {
  // Cheap prefilter so a KML with no overlays is not DOM-parsed a second time
  // (its placemarks are already parsed by the vector loader). Matched
  // case-insensitively, like kml.ts's element matching, so non-conformant
  // casing is not dropped.
  if (!/groundoverlay/i.test(text)) return [];
  const overlays: LoadedImageOverlay[] = [];
  for (const overlay of sortByDrawOrder(parseKmlGroundOverlays(text))) {
    if (!isHttpUrl(overlay.href)) {
      console.warn(
        `Skipping a KML ground overlay: its image "${overlay.href}" is a relative path, which a standalone KML (unlike a KMZ) cannot resolve. Only absolute URLs are supported.`,
      );
      continue;
    }
    if (isUnrenderableOverlayImage(overlay.href)) {
      warnUnrenderableOverlay(overlay.href);
      continue;
    }
    overlays.push(imageOverlayLayer(overlay, overlay.href.trim(), path));
  }
  return sequenceTimeOverlays(overlays);
}

// A KML `<Model>` GLB is inlined as a base64 `data:` URL on the layer (textures
// embedded) and persisted in the project file at ~4/3 its byte size, so cap it
// to avoid bloating projects and memory.
const MAX_MODEL_GLB_BYTES = 24 * 1024 * 1024;

// Cap the raw `.dae` source too, so an enormous mesh is rejected up front rather
// than after the expensive parse/normal-compute/export. COLLADA is verbose XML,
// so the source limit is more generous than the GLB output limit.
const MAX_DAE_SOURCE_BYTES = 64 * 1024 * 1024;

// The display name for a model layer. An unnamed `<Model>` falls back to a
// path-derived name; when a file has several such models the 1-based `index`
// disambiguates them so they are not all named identically. This resolves the
// name once here at load time; `kmlModelDisplayName` (kml-model.ts) is the
// downstream reader whose own fallback is only a defensive/test-time path.
function kmlModelName(model: KmlModel, path: string, index: number, total: number): string {
  const named = model.name?.trim();
  if (named) return named;
  const base = `${pathWithoutExtension(fileBaseName(path))} model`;
  return total > 1 ? `${base} ${index + 1}` : base;
}

function kmlModelLayer(
  model: KmlModel,
  converted: {
    url: string;
    radiusMeters: number;
    verticalMinMeters: number;
    verticalMaxMeters: number;
  },
  path: string,
  index: number,
  total: number,
): LoadedModel {
  return {
    kind: "model",
    name: kmlModelName(model, path, index, total),
    path,
    url: converted.url,
    longitude: model.longitude,
    latitude: model.latitude,
    altitude: model.altitude,
    heading: model.heading,
    tilt: model.tilt,
    roll: model.roll,
    scale: model.scale,
    radiusMeters: converted.radiusMeters,
    verticalMinMeters: converted.verticalMinMeters,
    verticalMaxMeters: converted.verticalMaxMeters,
  };
}

// Convert a COLLADA `.dae` (as text) to a self-contained GLB data URL, resolving
// any textures the DAE references. `resolveTexture` maps a raw texture path to a
// blob URL of an archive entry (for a KMZ); the created blob URLs are revoked
// once the GLTF exporter has embedded the pixels. Returns null on failure so one
// bad model does not abort the rest of the load.
async function daeToGlbDataUrl(
  daeText: string,
  href: string,
  resolveTexture?: (path: string) => Uint8Array | undefined,
  basePath = "",
): Promise<{
  url: string;
  radiusMeters: number;
  verticalMinMeters: number;
  verticalMaxMeters: number;
} | null> {
  const blobUrls: string[] = [];
  const modifier = resolveTexture
    ? (url: string): string | undefined => {
        const bytes = resolveTexture(url);
        if (!bytes) return undefined;
        const blob = URL.createObjectURL(
          new Blob([bytes as BlobPart], { type: imageMimeFromName(url) }),
        );
        blobUrls.push(blob);
        return blob;
      }
    : undefined;
  try {
    const { convertDaeToGlb } = await import("./collada-to-glb");
    const { glb, radiusMeters, verticalMinMeters, verticalMaxMeters } = await convertDaeToGlb(
      daeText,
      modifier,
      basePath,
    );
    if (glb.length > MAX_MODEL_GLB_BYTES) {
      console.warn(
        `Skipping a KML model: "${href}" converts to ${Math.round(glb.length / (1024 * 1024))} MB, over the ${Math.round(MAX_MODEL_GLB_BYTES / (1024 * 1024))} MB inline limit.`,
      );
      return null;
    }
    const url = await bytesToDataUrl(glb, "model/gltf-binary");
    return { url, radiusMeters, verticalMinMeters, verticalMaxMeters };
  } catch (error) {
    console.warn(`Could not convert the KML model "${href}" to glTF.`, error);
    return null;
  } finally {
    for (const url of blobUrls) URL.revokeObjectURL(url);
  }
}

// Resolve the `<Model>` 3D models in an archive's KML documents. Each model's
// `.dae` is read from the archive (relative to its KML's directory) or fetched
// from an absolute URL, converted to a self-contained GLB, and returned as an
// image-free model descriptor. Models that cannot be resolved are skipped.
async function modelsFromKmz(
  entries: Record<string, Uint8Array>,
  kmlDocs: { name: string; text: string }[],
  path: string,
): Promise<LoadedModel[]> {
  const parsed = kmlDocs
    // `(?:\w+:)?` so a namespace-prefixed `<kml:Model>` (valid but rare) isn't
    // filtered out before `parseKmlModels` (which matches by localName) runs.
    .filter((doc) => /<(?:\w+:)?model[\s/>]/i.test(doc.text))
    .flatMap((doc) =>
      parseKmlModels(doc.text).map((model) => ({
        model,
        baseDir: archiveDirname(doc.name),
      })),
    );

  const models: LoadedModel[] = [];
  const total = parsed.length;
  for (const [index, { model, baseDir }] of parsed.entries()) {
    if (isHttpUrl(model.href)) {
      const converted = await fetchDaeAsGlbDataUrl(model.href);
      if (converted) models.push(kmlModelLayer(model, converted, path, index, total));
      continue;
    }
    const daeKey =
      findArchiveEntryKey(entries, baseDir + model.href) ??
      findArchiveEntryKey(entries, model.href);
    if (daeKey === undefined) {
      console.warn(
        `Skipping a KML model: its mesh "${model.href}" was not found in the KMZ archive.`,
      );
      continue;
    }
    const data = entries[daeKey];
    if (data.length > MAX_DAE_SOURCE_BYTES) {
      console.warn(
        `Skipping a KML model: its mesh "${model.href}" is ${Math.round(data.length / (1024 * 1024))} MB, over the ${Math.round(MAX_DAE_SOURCE_BYTES / (1024 * 1024))} MB limit.`,
      );
      continue;
    }
    // Resolve textures relative to where the `.dae` was actually found (its
    // matched key), not the guessed `baseDir + href` — the basename fallback in
    // findArchiveEntryKey can match a differently-nested entry. Fall back to a
    // bare basename for textures stored elsewhere in the archive.
    const daeDir = archiveDirname(normalizeArchivePath(daeKey));
    const resolveTexture = (texturePath: string): Uint8Array | undefined => {
      const bytes =
        findArchiveEntry(entries, daeDir + texturePath) ?? findArchiveEntry(entries, texturePath);
      // Cap a single packaged texture (same limit as ground-overlay images) so
      // an oversized bundled image can't blow up the decode/GPU upload before
      // the GLB-size cap ever measures the result; skip it (untextured) instead.
      if (bytes && bytes.length > MAX_OVERLAY_IMAGE_BYTES) {
        console.warn(
          `Skipping a KML model texture "${texturePath}": ${Math.round(bytes.length / (1024 * 1024))} MB, over the ${Math.round(MAX_OVERLAY_IMAGE_BYTES / (1024 * 1024))} MB limit.`,
        );
        return undefined;
      }
      return bytes;
    };
    const converted = await daeToGlbDataUrl(
      new TextDecoder("utf-8").decode(data),
      model.href,
      resolveTexture,
    );
    if (converted) models.push(kmlModelLayer(model, converted, path, index, total));
  }
  return models;
}

// Fetch an absolute-URL `.dae`, convert it to a GLB data URL. Textures resolve
// against the mesh's URL directory (best effort; a CORS-blocked fetch is
// skipped). Returns null on any failure.
async function fetchDaeAsGlbDataUrl(href: string): Promise<{
  url: string;
  radiusMeters: number;
  verticalMinMeters: number;
  verticalMaxMeters: number;
} | null> {
  try {
    // Bound the fetch so an unresponsive host can't hang the whole KML/KMZ load
    // (models are resolved sequentially), mirroring the texture-load timeout.
    const response = await fetch(href, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) {
      console.warn(`Skipping a KML model: fetching "${href}" returned ${response.status}.`);
      return null;
    }
    // Best-effort size guard before buffering the whole body (mirrors the
    // Content-Length pre-check in `openRecentProjectFile`). A chunked response
    // with no Content-Length still falls through to the post-read check below.
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null && Number(contentLength) > MAX_DAE_SOURCE_BYTES) {
      console.warn(
        `Skipping a KML model: "${href}" is ${Math.round(Number(contentLength) / (1024 * 1024))} MB, over the ${Math.round(MAX_DAE_SOURCE_BYTES / (1024 * 1024))} MB limit.`,
      );
      return null;
    }
    const daeText = await response.text();
    // Measure real byte size (not UTF-16 code units) so the cap matches the
    // archive path's `Uint8Array.length` check.
    const daeBytes = new Blob([daeText]).size;
    if (daeBytes > MAX_DAE_SOURCE_BYTES) {
      console.warn(
        `Skipping a KML model: "${href}" is ${Math.round(daeBytes / (1024 * 1024))} MB, over the ${Math.round(MAX_DAE_SOURCE_BYTES / (1024 * 1024))} MB limit.`,
      );
      return null;
    }
    const basePath = href.slice(0, href.lastIndexOf("/") + 1);
    return await daeToGlbDataUrl(daeText, href, undefined, basePath);
  } catch (error) {
    console.warn(`Skipping a KML model: could not fetch "${href}".`, error);
    return null;
  }
}

// Models in a standalone (non-archived) KML can only be resolved when the mesh
// href is an absolute URL; a relative path needs the archive's packaged files.
async function modelsFromKml(text: string, path: string): Promise<LoadedModel[]> {
  // `(?:\w+:)?` so a namespace-prefixed `<kml:Model>` isn't skipped before
  // `parseKmlModels` (which matches by localName) runs.
  if (!/<(?:\w+:)?model[\s/>]/i.test(text)) return [];
  const parsed = parseKmlModels(text);
  const models: LoadedModel[] = [];
  for (const [index, model] of parsed.entries()) {
    if (!isHttpUrl(model.href)) {
      console.warn(
        `Skipping a KML model: its mesh "${model.href}" is a relative path, which a standalone KML (unlike a KMZ) cannot resolve. Only absolute URLs are supported.`,
      );
      continue;
    }
    const converted = await fetchDaeAsGlbDataUrl(model.href);
    if (converted) models.push(kmlModelLayer(model, converted, path, index, parsed.length));
  }
  return models;
}

// Merge the vector placemarks from every KML in an archive, tolerating entries
// with no readable vector content (returning an empty collection) so an
// overlay-only archive still loads its overlays. Declining an oversized entry
// drops just that entry, matching `parseKmz`; the cancellation only propagates
// (skipping the whole archive) when every entry was declined and nothing else
// loaded.
async function kmzVectorFeatures(
  kmlFiles: DuckDbVectorFile[],
  options?: DuckDbVectorLoadOptions,
): Promise<FeatureCollection> {
  let cancellation: unknown;
  const settled = await Promise.all(
    kmlFiles.map((file) =>
      loadKmlFile(file, options).then(
        (collection): FeatureCollection | null => collection,
        (error): null => {
          if (isVectorLoadCancelled(error)) {
            cancellation = error;
            return null;
          }
          console.warn(
            "Could not read vector features from a KML entry in the KMZ archive.",
            error,
          );
          return null;
        },
      ),
    ),
  );
  const collections = settled.filter(
    (collection): collection is FeatureCollection => collection !== null,
  );
  if (collections.length === 0 && cancellation) throw cancellation;
  return mergeFeatureCollections(collections);
}

/**
 * Load a KMZ archive into its layers: the merged vector placemarks (when any)
 * plus every resolvable `<GroundOverlay>` as an image overlay. Throws only when
 * the archive yields neither, so a placemark-only, overlay-only, or mixed KMZ
 * all load correctly.
 */
async function loadKmzLayers(
  data: ArrayBuffer | Uint8Array,
  path: string,
  options?: DuckDbVectorLoadOptions,
): Promise<LoadedLayer[]> {
  const entries = await unzipArchive(data);
  const kmlFiles = readKmlEntries(entries);

  // Decode the KML text up front, keeping each entry's full archive name so an
  // overlay href can resolve relative to its KML's directory. Reading from
  // `entries` (not the copies in `kmlFiles`) also avoids the DuckDB-WASM
  // fallback transferring/detaching a KML buffer before overlays are parsed.
  const kmlDocs = Object.entries(entries)
    .filter(([name]) => name.toLowerCase().endsWith(".kml"))
    .map(([name, bytes]) => ({
      name,
      text: new TextDecoder("utf-8").decode(bytes),
    }));

  // Ground overlays are drawn under vector placemarks (as in Google Earth), so
  // they are added first: a later store index renders on top. 3D models render
  // in the deck.gl overlay (always above MapLibre layers), so their array order
  // does not affect stacking.
  const layers: LoadedLayer[] = [
    ...(await groundOverlaysFromKmz(entries, kmlDocs, path)),
    // Skip the expensive COLLADA→GLB conversion when the caller only wants
    // vector features (e.g. re-reading a referenced local layer on reopen).
    ...(options?.skipModels ? [] : await modelsFromKmz(entries, kmlDocs, path)),
  ];

  // Declining the oversized-vector prompt must not throw away the archive's
  // ground overlays, so catch the cancellation and keep them; it is only
  // re-thrown at the end when nothing else loaded (so the caller still skips a
  // purely-declined file rather than surfacing a generic error).
  let cancellation: unknown;
  try {
    const features = await kmzVectorFeatures(kmlFiles, options);
    if (features.features.length > 0) layers.push({ data: features, path });
  } catch (error) {
    if (!isVectorLoadCancelled(error)) throw error;
    cancellation = error;
  }

  if (layers.length === 0) {
    if (cancellation) throw cancellation;
    throw new Error(
      "The KMZ archive did not contain readable placemarks, ground overlays, or 3D models.",
    );
  }
  return layers;
}

async function parseKmz(
  data: ArrayBuffer | Uint8Array,
  options?: DuckDbVectorLoadOptions,
): Promise<FeatureCollection> {
  const kmlFiles = await readKmzKmlFiles(data);
  // Load each KML independently so declining one large KML inside a multi-KML
  // archive drops just that layer instead of failing the whole KMZ (Promise.all
  // is fail-fast). Real load errors still reject and abort the archive.
  let cancellation: unknown;
  const settled = await Promise.all(
    kmlFiles.map((file) =>
      loadKmlFile(file, options).then(
        (collection): FeatureCollection | null => collection,
        (error): null => {
          if (!isVectorLoadCancelled(error)) throw error;
          cancellation = error;
          return null;
        },
      ),
    ),
  );
  const collections = settled.filter(
    (collection): collection is FeatureCollection => collection !== null,
  );
  // Every KML was declined: propagate the cancellation so the caller skips the
  // whole archive rather than adding an empty layer.
  if (collections.length === 0 && cancellation) throw cancellation;
  return mergeFeatureCollections(collections);
}

async function loadDuckDbVector(file: DuckDbVectorFile, options?: DuckDbVectorLoadOptions) {
  const { loadDuckDbVectorFile } = await import("./duckdb-vector-loader");
  return loadDuckDbVectorFile(file, options);
}

interface NativeDuckDbVectorInvokeOptions {
  layer?: string;
  overrideSourceCrs?: string;
}

interface NativeDuckDbVectorAttempt {
  data: FeatureCollection | null;
  featureCountChecked: boolean;
}

function nativeDuckDbInvokeOptions(
  options?: DuckDbVectorLoadOptions,
): NativeDuckDbVectorInvokeOptions {
  return {
    ...(options?.layer?.trim() ? { layer: options.layer.trim() } : {}),
    ...(options?.overrideSourceCrs?.trim()
      ? { overrideSourceCrs: options.overrideSourceCrs.trim() }
      : {}),
  };
}

async function tryLoadNativeDuckDbVectorPath(
  path: string,
  options?: DuckDbVectorLoadOptions,
): Promise<NativeDuckDbVectorAttempt> {
  if (!isTauri()) return { data: null, featureCountChecked: false };

  const invokeOptions = nativeDuckDbInvokeOptions(options);
  let featureCountChecked = false;
  try {
    if (options?.onLargeDataset) {
      const featureCount = await invoke<number>("count_native_vector_file_features", {
        path,
        ...invokeOptions,
      });
      await confirmLargeDataset(
        { name: browserSafeFileName(path), featureCount },
        options.onLargeDataset,
      );
      featureCountChecked = true;
    }

    const value = await invoke<unknown>("load_native_vector_file", {
      path,
      ...invokeOptions,
    });
    return {
      data: assertFeatureCollection(value),
      featureCountChecked,
    };
  } catch (error) {
    if (isVectorLoadCancelled(error)) throw error;
    console.warn(
      "[GeoLibre] Native DuckDB vector load failed; falling back to DuckDB-WASM.",
      error,
    );
    return { data: null, featureCountChecked };
  }
}

function confirmPickedNativeVectorDataset({ name, featureCount }: LargeVectorDataset): boolean {
  return window.confirm(
    i18next.t("toolbar.item.largeVectorDesc", {
      name,
      count: featureCount.toLocaleString(),
    }),
  );
}

/**
 * Load one KML entry, preferring the styled in-house reader so embedded
 * symbology survives, and falling back to DuckDB/GDAL for KML the reader does
 * not cover (so geometry still loads, without the styling). Cancellation from
 * the DuckDB fallback is allowed to propagate.
 */
async function loadKmlFile(
  file: DuckDbVectorFile,
  options?: DuckDbVectorLoadOptions,
): Promise<FeatureCollection> {
  try {
    return parseKmlText(new TextDecoder("utf-8").decode(file.data));
  } catch {
    return loadDuckDbVector(file, options);
  }
}

/**
 * Whether an error is the {@link VectorLoadCancelledError} thrown when the user
 * declines a large-file load. Matched by `name` rather than `instanceof` so the
 * heavy `duckdb-vector-loader` module (and its DuckDB-WASM imports) stays a
 * lazy dynamic import instead of being pulled into this module's chunk.
 */
function isVectorLoadCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === "VectorLoadCancelledError";
}

async function fileToDuckDbVectorFile(file: File): Promise<DuckDbVectorFile> {
  return {
    name: file.name,
    extension: fileExtension(file.name),
    data: new Uint8Array(await file.arrayBuffer()),
  };
}

async function loadBrowserVectorFile(
  file: File,
  siblingFiles: DuckDbVectorFile[] = [],
  options?: DuckDbVectorLoadOptions,
): Promise<LoadedVectorLayer> {
  const extension = fileExtension(file.name);
  if (extension === "geojson" || extension === "json") {
    try {
      return {
        data: await parseGeoJsonText(await file.text()),
        path: file.name,
      };
    } catch {
      // Some GDAL-backed vector formats use .json but are not GeoJSON
      // FeatureCollections. Let DuckDB Spatial try them before failing.
    }
  }

  if (extension === "zip") {
    return {
      data: await loadShapefileZip(await file.arrayBuffer(), options),
      path: file.name,
    };
  }

  if (extension === "kmz") {
    return {
      data: await parseKmz(await file.arrayBuffer(), options),
      path: file.name,
    };
  }

  if (extension === "kml") {
    try {
      return {
        data: parseKmlText(await file.text()),
        path: file.name,
      };
    } catch {
      // The styled reader does not cover this KML; let DuckDB Spatial try it.
    }
  }

  if (extension === "gpx") {
    return {
      data: parseGpxText(await file.text()),
      path: file.name,
    };
  }

  if (isDelimitedTextFileName(file.name)) {
    const points = parseDelimitedTextFile(await file.text(), file.name);
    // No lon/lat columns: fall through to DuckDB so spatial CSV variants
    // (e.g. a WKT geometry column) still load.
    if (points) {
      return { data: points, path: file.name };
    }
  }

  return {
    data: await loadDuckDbVector(
      {
        name: file.name,
        extension,
        data: new Uint8Array(await file.arrayBuffer()),
        siblingFiles,
      },
      options,
    ),
    path: file.name,
  };
}

async function openVectorFileBrowser(options?: DuckDbVectorLoadOptions): Promise<{
  data: FeatureCollection;
  path: string;
} | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.onchange = async () => {
      try {
        const file = input.files?.[0];
        if (!file) {
          resolve(null);
          return;
        }

        resolve(await loadBrowserVectorFile(file, [], options));
      } catch (error) {
        reject(error);
      }
    };
    input.click();
  });
}

async function openVectorFileTauri(options?: DuckDbVectorLoadOptions): Promise<{
  data: FeatureCollection;
  path: string;
} | null> {
  const selected = await open({
    multiple: false,
  });
  if (!selected || typeof selected !== "string") return null;
  return loadTauriVectorFile(selected, options);
}

/** A vector file picked from the desktop dialog, with any shapefile sidecars. */
export interface PickedVectorFile {
  /** The main vector file (the `.shp` for a shapefile). */
  file: File;
  /**
   * Sidecar files for a shapefile (`.shx`, `.dbf`, `.prj`, `.cpg`) read from the
   * same directory; empty for any other format.
   */
  companionFiles: File[];
  /** Absolute filesystem path the main file was read from. */
  sourcePath: string;
  /**
   * GeoJSON materialized by native duckdb-rs for formats that would otherwise
   * make the Add Vector Layer panel load DuckDB-WASM.
   */
  nativeData?: FeatureCollection;
}

/**
 * Opens the native file dialog to pick one or more vector files and reads each
 * into a browser `File`. For a `.shp`, its sidecar files in the same directory
 * are read too, so a host with filesystem access can load a loose `.shp` without
 * the user selecting every component. Sidecar files are skipped as standalone
 * picks (they ride along with their `.shp` via `companionFiles`).
 *
 * Used by the Add Data > Vector panel on desktop, which feeds each result to the
 * control's `addData(file, { companionFiles })`. Resolves to an empty array when
 * the dialog is cancelled.
 *
 * @returns The picked vector files, each with its shapefile sidecars.
 */
export async function pickVectorFilesWithSidecars(): Promise<PickedVectorFile[]> {
  const selected = await open({
    filters: vectorFileDialogFilters(),
    multiple: true,
  });
  if (!selected) return [];
  // `isVectorFileName` drops rasters, project files, and shapefile sidecars, so
  // a sidecar picked on its own never becomes its own (unreadable) layer.
  const paths = (Array.isArray(selected) ? selected : [selected]).filter(isVectorFileName);
  const picked: PickedVectorFile[] = [];
  for (const path of paths) {
    // Read each pick independently so one unreadable file (e.g. moved between
    // pick and read, or an unreadable sidecar) does not abandon the rest.
    try {
      const file = new File([toArrayBuffer(await readFile(path))], browserSafeFileName(path));
      const companionFiles =
        fileExtension(path) === "shp"
          ? (await readShapefileSiblings(path)).map(
              (sibling) => new File([toArrayBuffer(sibling.data)], sibling.name),
            )
          : [];
      picked.push({
        file,
        companionFiles,
        sourcePath: path,
        nativeData: await tryLoadPickedNativeVectorPath(path, {
          onLargeDataset: confirmPickedNativeVectorDataset,
        }),
      });
    } catch (error) {
      console.warn(`Could not read the selected file "${path}".`, error);
    }
  }
  return picked;
}

/**
 * Reads a single local vector file (and, for a `.shp`, its shapefile sidecars)
 * back into browser `File`s from an absolute path, so the Add Vector Layer
 * restore can reload a desktop local-file layer when a saved project reopens.
 * Mirrors {@link pickVectorFilesWithSidecars} for one already-known path.
 *
 * @param path - The absolute filesystem path persisted on the layer.
 * @returns The file with its sidecars, or null off the desktop host or when it
 *   can no longer be read (moved or deleted).
 */
export async function readVectorFileWithSidecars(path: string): Promise<{
  file: File;
  companionFiles: File[];
  nativeData?: FeatureCollection;
} | null> {
  // Reject `..` segments as well as relative paths: the path comes from a
  // (possibly hand-edited) project file, so a traversal must not reach outside
  // wherever Tauri's filesystem scope allows. The scope is the real boundary;
  // this is cheap defense-in-depth.
  if (!isTauri() || !isAbsoluteLocalPath(path) || hasPathTraversal(path)) {
    return null;
  }
  try {
    // Use the scope-tolerant reader: a project-reopened path was never picked
    // or dropped this session, so the `fs` plugin scope rejects it and a raw
    // `readFile` would throw — silently dropping the vector-control layer.
    const file = new File(
      [toArrayBuffer(await readLocalFileBytes(path))],
      browserSafeFileName(path),
    );
    const companionFiles =
      fileExtension(path) === "shp"
        ? (await readShapefileSiblings(path)).map(
            (sibling) => new File([toArrayBuffer(sibling.data)], sibling.name),
          )
        : [];
    return {
      file,
      companionFiles,
      nativeData: await tryLoadPickedNativeVectorPath(path, {
        onLargeDataset: ({ name, featureCount }) => {
          console.warn(
            `[GeoLibre] Skipping native vector restore for "${name}" because it contains ${featureCount.toLocaleString()} features; re-add the file to confirm loading it as GeoJSON.`,
          );
          return false;
        },
      }),
    };
  } catch (error) {
    console.warn(`Could not read local vector file "${path}".`, error);
    return null;
  }
}

async function tryLoadPickedNativeVectorPath(
  path: string,
  options: DuckDbVectorLoadOptions,
): Promise<FeatureCollection | undefined> {
  const extension = fileExtension(path);
  if (
    extension === "geojson" ||
    extension === "json" ||
    extension === "kml" ||
    extension === "kmz" ||
    extension === "gpx" ||
    extension === "zip"
  ) {
    return undefined;
  }
  try {
    const result = await tryLoadNativeDuckDbVectorPath(path, options);
    return result.data ?? undefined;
  } catch (error) {
    if (isVectorLoadCancelled(error)) return undefined;
    throw error;
  }
}

export function isAbsoluteLocalPath(path: string): boolean {
  // Match the raw path (not a trimmed copy): a whitespace-padded value would
  // pass a trimmed check but reach `readFile` unchanged and fail there, so
  // reject it up front instead. Accept POSIX paths and Windows drive-letter
  // paths only. UNC paths (\\server\share) are deliberately rejected: reading
  // one can make Windows auto-authenticate against a remote host (NTLM hash
  // capture), and a remote share is not a supported local data source.
  return path.startsWith("/") || /^[a-z]:[\\/]/i.test(path);
}

async function loadTauriVectorFile(
  path: string,
  options?: DuckDbVectorLoadOptions,
): Promise<{
  data: FeatureCollection;
  path: string;
}> {
  const extension = fileExtension(path);
  if (extension === "geojson" || extension === "json") {
    try {
      return {
        data: await parseGeoJsonText(await readLocalFileText(path)),
        path,
      };
    } catch {
      // Some GDAL-backed vector formats use .json but are not GeoJSON
      // FeatureCollections. Let DuckDB Spatial try them before failing.
    }
  }

  if (extension === "zip") {
    return {
      data: await loadShapefileZip(await readLocalFileBytes(path), options),
      path,
    };
  }

  if (extension === "kmz") {
    try {
      return {
        data: await parseKmz(await readLocalFileBytes(path), options),
        path,
      };
    } catch (error) {
      if (isVectorLoadCancelled(error)) throw error;
      const detail = error instanceof Error ? error.message : "Unknown error";
      throw new Error(`Could not read this KMZ file. ${detail}`);
    }
  }

  if (extension === "kml") {
    try {
      return {
        data: parseKmlText(await readLocalFileText(path)),
        path,
      };
    } catch {
      // The styled reader does not cover this KML; let DuckDB Spatial try it.
    }
  }

  if (extension === "gpx") {
    try {
      return {
        data: parseGpxText(await readLocalFileText(path)),
        path,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown error";
      throw new Error(`Could not read this GPX file. ${detail}`);
    }
  }

  if (isDelimitedTextFileName(path)) {
    const points = parseDelimitedTextFile(await readLocalFileText(path), path);
    // No lon/lat columns: fall through to DuckDB so spatial CSV variants
    // (e.g. a WKT geometry column) still load.
    if (points) {
      return { data: points, path };
    }
  }

  const nativeAttempt = await tryLoadNativeDuckDbVectorPath(path, options);
  if (nativeAttempt.data) {
    return {
      data: nativeAttempt.data,
      path,
    };
  }
  const wasmOptions =
    nativeAttempt.featureCountChecked && options
      ? { ...options, onLargeDataset: undefined }
      : options;

  try {
    const siblingFiles = extension === "shp" ? await readShapefileSiblings(path) : [];
    return {
      data: await loadDuckDbVector(
        {
          name: browserSafeFileName(path),
          extension,
          data: await readLocalFileBytes(path),
          siblingFiles,
        },
        wasmOptions,
      ),
      path,
    };
  } catch (error) {
    if (isVectorLoadCancelled(error)) throw error;
    const detail = error instanceof Error ? error.message : "Unknown error";
    throw new Error(`Could not convert this vector file with DuckDB-WASM. ${detail}`);
  }
}

async function readShapefileSiblings(path: string): Promise<DuckDbVectorFile[]> {
  // Read the sidecars through a Tauri command rather than the JS `fs` plugin:
  // `fs` can only read paths the user explicitly picked or dropped, so a sidecar
  // that was not selected (the whole point of auto-discovery) is forbidden. The
  // command reads them directly and case-insensitively, returning each under the
  // `.shp`'s base name with a lowercased extension. Returns [] off the desktop.
  if (!isTauri()) return [];
  const siblings = await invoke<Array<{ name: string; data: number[] }>>(
    "read_shapefile_siblings",
    { path },
  );
  return siblings.map((sibling) => ({
    name: sibling.name,
    extension: fileExtension(sibling.name),
    data: new Uint8Array(sibling.data),
  }));
}

async function openProjectFileBrowser(): Promise<{
  project: GeoLibreProject;
  path: string;
} | null> {
  const pickerWindow = window as BrowserFilePickerWindow;
  if (pickerWindow.showOpenFilePicker) {
    try {
      const [handle] = await pickerWindow.showOpenFilePicker({
        multiple: false,
        types: GEOLIBRE_PROJECT_FILE_TYPES,
        excludeAcceptAllOption: false,
      });
      if (!handle) return null;
      const file = await handle.getFile();
      return {
        project: parseProject(await file.text()),
        path: handle.name || file.name,
      };
    } catch (error) {
      if (isAbortError(error)) return null;
      console.warn("Browser project file picker failed", error);
    }
  }

  const result = await openLocalDataFileWithFallback({
    filters: [{ name: "GeoLibre Project", extensions: ["geolibre", "json"] }],
    accept: ".geolibre,.json,.geolibre.json",
    readText: true,
  });
  if (!result?.text) return null;
  return {
    project: parseProject(result.text),
    path: result.path,
  };
}

/**
 * Whether saving a project in the current environment would silently fall back
 * to an anchor download under a fixed name — i.e. a browser (not Tauri) that
 * lacks the File System Access save picker (`window.showSaveFilePicker`).
 * Chromium browsers expose the picker and let the user name the file; Firefox
 * and Safari do not, so callers prompt for a file name themselves before saving.
 *
 * @returns True only in a browser without the save picker; false under Tauri
 *   (which uses the native save dialog) or when the picker is available.
 */
export function browserSaveFallsBackToDownload(): boolean {
  if (isTauri()) return false;
  if (typeof window === "undefined") return false;
  return typeof (window as BrowserFilePickerWindow).showSaveFilePicker !== "function";
}

async function saveProjectFileBrowser(
  content: string,
  defaultName?: string,
): Promise<string | null> {
  const fileName = browserSafeFileName(defaultName ?? "project.geolibre.json");
  const pickerWindow = window as BrowserFilePickerWindow;

  if (pickerWindow.showSaveFilePicker) {
    try {
      const handle = await pickerWindow.showSaveFilePicker({
        suggestedName: fileName,
        types: GEOLIBRE_PROJECT_FILE_TYPES,
        excludeAcceptAllOption: false,
      });
      const writable = await handle.createWritable();
      await writable.write(content);
      await writable.close();
      return handle.name || fileName;
    } catch (error) {
      if (isAbortError(error)) return null;
      console.warn("Browser project save picker failed", error);
    }
  }

  const blob = new Blob([content], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  return fileName;
}

async function saveTextFileBrowser(
  content: string,
  options: SaveTextFileOptions,
): Promise<string | null> {
  const fileName = browserSafeFileName(options.defaultName);
  const pickerWindow = window as BrowserFilePickerWindow;

  if (pickerWindow.showSaveFilePicker) {
    try {
      const handle = await pickerWindow.showSaveFilePicker({
        suggestedName: fileName,
        types: options.browserTypes,
        excludeAcceptAllOption: false,
      });
      const writable = await handle.createWritable();
      await writable.write(content);
      await writable.close();
      return handle.name || fileName;
    } catch (error) {
      if (isAbortError(error)) return null;
      console.warn("Browser file save picker failed", error);
    }
  }

  const blob = new Blob([content], { type: options.mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  return fileName;
}

async function saveBinaryFileBrowser(
  content: Uint8Array | Blob,
  options: SaveBinaryFileOptions,
): Promise<string | null> {
  const fileName = browserSafeFileName(options.defaultName);
  const pickerWindow = window as BrowserFilePickerWindow;
  // A Blob (e.g. a recorded video) is written straight through; only raw bytes
  // need wrapping, so large callers can avoid an extra full-size copy.
  // Note: a Blob's own .type is used as-is; options.mimeType applies only when
  // wrapping a Uint8Array, so pass a Blob that already carries the right type.
  const blob =
    content instanceof Blob
      ? content
      : new Blob([toArrayBuffer(content)], { type: options.mimeType });

  if (pickerWindow.showSaveFilePicker) {
    try {
      const handle = await pickerWindow.showSaveFilePicker({
        suggestedName: fileName,
        types: options.browserTypes,
        excludeAcceptAllOption: false,
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return handle.name || fileName;
    } catch (error) {
      if (isAbortError(error)) return null;
      console.warn("Browser binary file save picker failed", error);
    }
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  return fileName;
}

export async function openLocalDataFileWithFallback(options: LocalDataFileOptions): Promise<{
  data?: ArrayBuffer;
  path: string;
  text?: string;
} | null> {
  if (isTauri()) {
    const selected = await open({
      multiple: false,
      filters: options.filters,
    });
    if (!selected || typeof selected !== "string") return null;
    const data = options.readBinary ? toArrayBuffer(await readFile(selected)) : undefined;
    const text = options.readText ? await readTextFile(selected) : undefined;
    return { data, path: selected, text };
  }

  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = options.accept;
    input.onchange = async () => {
      try {
        const file = input.files?.[0];
        if (!file) {
          resolve(null);
          return;
        }
        const data = options.readBinary ? await file.arrayBuffer() : undefined;
        const text = options.readText ? await file.text() : undefined;
        resolve({ data, path: file.name, text });
      } catch (error) {
        reject(error);
      }
    };
    // Resolve (rather than hang) when the dialog is dismissed without a pick;
    // `change` never fires on cancel, so without this the Promise never settles.
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}

export async function pickLocalPathWithFallback(
  options: PickLocalPathOptions = {},
): Promise<string | null> {
  if (isTauri()) {
    const selected = await open({
      directory: options.directory ?? false,
      filters: options.filters,
      multiple: false,
    });
    return typeof selected === "string" ? selected : null;
  }

  // Browsers cannot expose absolute filesystem paths, and Whitebox parameters
  // require a real path. Return null so callers surface the desktop-only
  // message rather than passing a non-resolvable bare file name.
  return null;
}

/**
 * Open the native folder picker and return the chosen directory (desktop only;
 * null off-desktop or on cancel). `recursive: true` extends the granted fs scope
 * to the picked directory's subtree, so the Browser panel can lazily {@link
 * listDirectory} subfolders within it — not just its top level.
 *
 * @returns The picked absolute directory path, or null.
 */
export async function pickLocalDirectory(): Promise<string | null> {
  if (!isTauri()) return null;
  const selected = await open({
    directory: true,
    multiple: false,
    recursive: true,
  });
  return typeof selected === "string" ? selected : null;
}

export async function pickSavePathWithFallback(
  options: PickSavePathOptions,
): Promise<string | null> {
  if (isTauri()) {
    return save({
      defaultPath: options.defaultName,
      filters: options.filters,
    });
  }

  const pickerWindow = window as BrowserFilePickerWindow;
  if (pickerWindow.showSaveFilePicker) {
    try {
      await pickerWindow.showSaveFilePicker({
        suggestedName: options.defaultName,
        types: options.browserTypes,
        excludeAcceptAllOption: false,
      });
    } catch (error) {
      if (isAbortError(error)) return null;
      console.warn("Browser save path picker failed", error);
    }
  }

  // The browser only exposes a leaf file name, never a real filesystem path,
  // so return null (matching pickLocalPathWithFallback) rather than handing a
  // non-resolvable name to a Whitebox path parameter.
  return null;
}

export async function openGeoJsonFile(): Promise<{
  data: FeatureCollection;
  path: string;
} | null> {
  if (!isTauri()) {
    console.warn("File dialog requires Tauri runtime");
    return null;
  }
  const selected = await open({
    multiple: false,
    filters: [{ name: "GeoJSON", extensions: ["geojson", "json"] }],
  });
  if (!selected || typeof selected !== "string") return null;
  const text = await readTextFile(selected);
  const data = await parseGeoJsonText(text);
  return { data, path: selected };
}

export async function openProjectFile(): Promise<{
  project: GeoLibreProject;
  path: string;
} | null> {
  if (!isTauri()) {
    return openProjectFileBrowser();
  }

  const selected = await open({
    multiple: false,
    filters: [{ name: "GeoLibre Project", extensions: ["geolibre", "json"] }],
  });
  if (!selected || typeof selected !== "string") return null;
  const text = await readTextFile(selected);
  const project = parseProject(text);
  return { project, path: selected };
}

/**
 * Thrown when a recent project is permanently gone (HTTP 404/410 or a local
 * file that no longer exists), signalling the caller that the entry can be
 * safely forgotten. Transient failures throw a plain `Error` instead so the
 * entry is preserved for a retry.
 */
export class RecentProjectGoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecentProjectGoneError";
  }
}

// Refuse to buffer absurdly large responses into memory (25 MB).
const MAX_PROJECT_URL_BYTES = 25 * 1024 * 1024;

function isFileMissingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  // Match filesystem "missing file" signals only. Avoid broad substrings like
  // "not found" / "cannot find" that also appear in transient IPC errors
  // (e.g. "Command not found", Windows os error 3 for a disconnected drive).
  return /no such file|os error 2|\benoent\b|cannot find the file|file not found|does not exist/i.test(
    message,
  );
}

export async function openRecentProjectFile(
  path: string,
  signal?: AbortSignal,
): Promise<{
  project: GeoLibreProject;
  path: string;
}> {
  if (isHttpUrl(path)) {
    const response = await fetch(path, {
      headers: { Accept: "application/json, text/plain;q=0.9, */*;q=0.8" },
      signal,
    });
    if (!response.ok) {
      const message = `Could not load project URL: HTTP ${response.status} ${response.statusText}`;
      if (response.status === 404 || response.status === 410) {
        throw new RecentProjectGoneError(message);
      }
      throw new Error(message);
    }

    // Only a present Content-Length lets us guard up front. `Number(null)` is
    // 0, which would silently pass for chunked/CDN responses that omit it.
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null && Number(contentLength) > MAX_PROJECT_URL_BYTES) {
      throw new Error("Project file is too large to load (over 25 MB).");
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (/\bhtml\b/i.test(contentType)) {
      throw new Error(
        `Unexpected content type "${contentType}" - the URL does not appear to be a project file.`,
      );
    }

    return { project: parseProject(await response.text()), path };
  }

  if (!isTauri()) {
    throw new Error("Recent local projects can only be reopened in GeoLibre Desktop.");
  }

  let text: string;
  try {
    text = await invoke<string>("read_project_file", { path });
  } catch (error) {
    if (isFileMissingError(error)) {
      throw new RecentProjectGoneError(`Project file no longer exists: ${path}`);
    }
    throw error;
  }

  return { project: parseProject(text), path };
}

export async function saveProjectFile(
  content: string,
  defaultName?: string,
): Promise<string | null> {
  if (!isTauri()) {
    return saveProjectFileBrowser(content, defaultName);
  }

  const path = await save({
    filters: [{ name: "GeoLibre Project", extensions: ["geolibre", "json"] }],
    defaultPath: defaultName ?? "project.geolibre.json",
  });
  if (!path) return null;
  await writeTextFile(path, content);
  return path;
}

/**
 * Save a project directly to an already-known local path without prompting.
 * Falls back to the save dialog when not running in Tauri (the browser never
 * has a writable filesystem path) or when the path is an HTTP(S) URL.
 */
export async function saveProjectFileToPath(content: string, path: string): Promise<string | null> {
  if (!isTauri() || isHttpUrl(path)) {
    return saveProjectFile(content, path);
  }
  await writeTextFile(path, content);
  return path;
}

/**
 * Write text directly to a known local path without prompting. Desktop-only —
 * the browser has no writable filesystem path — so callers must gate on
 * {@link isTauri} and a real (non-URL) path; the Python Editor's in-place Save
 * uses this and falls back to a save dialog otherwise.
 */
export async function writeTextFileToPath(path: string, content: string): Promise<void> {
  await writeTextFile(path, content);
}

export async function saveTextFileWithFallback(
  content: string,
  options: SaveTextFileOptions,
): Promise<string | null> {
  if (!isTauri()) {
    return saveTextFileBrowser(content, options);
  }

  const path = await save({
    filters: options.filters,
    defaultPath: options.defaultName,
  });
  if (!path) return null;
  await writeTextFile(path, content);
  return path;
}

export async function saveBinaryFileWithFallback(
  content: Uint8Array | Blob,
  options: SaveBinaryFileOptions,
): Promise<string | null> {
  if (!isTauri()) {
    return saveBinaryFileBrowser(content, options);
  }

  const path = await save({
    filters: options.filters,
    defaultPath: options.defaultName,
  });
  if (!path) return null;
  // The Tauri write needs raw bytes, so convert a Blob only here (after the
  // dialog is confirmed), not on every cancelled attempt. arrayBuffer() can
  // reject (e.g. OOM, or an unavailable backing store); that propagates to the
  // caller's catch.
  const bytes = content instanceof Blob ? new Uint8Array(await content.arrayBuffer()) : content;
  await writeFile(path, bytes);
  return path;
}

/** Browser fallback: pick a local GeoJSON file when not running in Tauri */
export function openGeoJsonFileBrowser(): Promise<{
  data: FeatureCollection;
  path: string;
} | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".geojson,.json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      const text = await file.text();
      resolve({
        data: await parseGeoJsonText(text),
        path: file.name,
      });
    };
    input.click();
  });
}

export async function openGeoJsonFileWithFallback(): Promise<{
  data: FeatureCollection;
  path: string;
} | null> {
  if (isTauri()) return openGeoJsonFile();
  return openGeoJsonFileBrowser();
}

export async function openVectorFileWithFallback(options?: DuckDbVectorLoadOptions): Promise<{
  data: FeatureCollection;
  path: string;
} | null> {
  if (isTauri()) return openVectorFileTauri(options);
  return openVectorFileBrowser(options);
}

export async function loadDroppedVectorFiles(
  droppedFiles: FileList | File[],
  options?: DuckDbVectorLoadOptions,
): Promise<LoadedLayer[]> {
  const droppedFileArray = Array.from(droppedFiles);
  const files = droppedFileArray.filter((file) => isVectorFileName(file.name));
  if (!files.length) return [];

  const filesByBaseName = new Map<string, File[]>();
  for (const file of droppedFileArray) {
    const baseName = pathWithoutExtension(file.name).toLowerCase();
    filesByBaseName.set(baseName, [...(filesByBaseName.get(baseName) ?? []), file]);
  }

  const layers: LoadedLayer[] = [];
  for (const file of files) {
    const extension = fileExtension(file.name);
    if (SHAPEFILE_SIDECAR_EXTENSIONS.includes(extension)) continue;

    if (extension === "gpx") {
      layers.push(...parseGpxTextLayers(await file.text(), file.name));
      continue;
    }

    if (extension === "kmz") {
      try {
        layers.push(...(await loadKmzLayers(await file.arrayBuffer(), file.name, options)));
      } catch (error) {
        if (isVectorLoadCancelled(error)) continue;
        throw error;
      }
      continue;
    }

    if (extension === "kml") {
      // Load the vector placemarks and the ground overlays independently so an
      // overlay-only KML still adds its overlays even when it has no readable
      // placemarks (which makes the vector load throw).
      const text = await file.text();
      const overlays = groundOverlaysFromKml(text, file.name);
      const models = options?.skipModels ? [] : await modelsFromKml(text, file.name);
      // Overlays go under the placemarks (added first), matching the KMZ path.
      layers.push(...overlays, ...models);
      try {
        // Only add a vector layer when it actually has features: the DuckDB
        // fallback for an overlay-only KML can return an empty collection, and
        // an empty vector layer alongside the overlay is just clutter.
        const vector = await loadBrowserVectorFile(file, [], options);
        if (vector.data.features.length > 0) layers.push(vector);
      } catch (error) {
        // Declining the oversized-vector prompt, or a genuine parse failure,
        // still leaves any ground overlays/models already added above (a real
        // non-cancellation failure with nothing to salvage is rethrown).
        // Cancellation is not surfaced; other failures are logged so they are
        // not fully invisible.
        if (!isVectorLoadCancelled(error)) {
          if (!overlays.length && !models.length) throw error;
          console.warn(
            `Loaded ground overlays/models from "${file.name}" but could not read its vector placemarks.`,
            error,
          );
        }
      }
      continue;
    }

    const siblingFiles =
      extension === "shp"
        ? await Promise.all(
            (filesByBaseName.get(pathWithoutExtension(file.name).toLowerCase()) ?? [])
              .filter((candidate) =>
                SHAPEFILE_SIDECAR_EXTENSIONS.includes(fileExtension(candidate.name)),
              )
              .map(fileToDuckDbVectorFile),
          )
        : [];
    try {
      layers.push(await loadBrowserVectorFile(file, siblingFiles, options));
    } catch (error) {
      // The user declined this oversized file: skip it without abandoning the
      // rest of the dropped batch.
      if (isVectorLoadCancelled(error)) continue;
      throw error;
    }
  }

  return layers;
}

export interface DroppedRaster {
  name: string;
  /**
   * The GeoTIFF/COG as a File. The raster control accepts a File directly and
   * manages its object URL, matching how the Add Raster panel loads local files.
   */
  source: File;
}

function fileBaseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** Collect dropped browser File objects that are rasters the map can load. */
export function loadDroppedRasterFiles(droppedFiles: FileList | File[]): DroppedRaster[] {
  return Array.from(droppedFiles)
    .filter((file) => isRasterFileName(file.name))
    .map((file) => ({ name: file.name, source: file }));
}

/**
 * Read dropped raster file paths (Tauri) into File objects the control can load.
 * There is no asset-protocol scope configured, so the bytes are read and wrapped
 * in a File, matching how local vector files are loaded.
 */
export async function loadDroppedRasterPaths(paths: string[]): Promise<DroppedRaster[]> {
  const rasterPaths = paths.filter(isRasterFileName);
  const rasters: DroppedRaster[] = [];
  for (const path of rasterPaths) {
    const bytes = await readFile(path);
    const name = fileBaseName(path);
    rasters.push({
      name,
      source: new File([bytes], name, { type: "image/tiff" }),
    });
  }
  return rasters;
}

/**
 * Open a multi-select image picker and read each pick into a browser `File`, so
 * the geotagged-photo importer reads EXIF and renders thumbnails the same way on
 * desktop (Tauri) and in the browser. Resolves to an empty array when the dialog
 * is cancelled.
 */
export async function pickImageFilesWithFallback(): Promise<File[]> {
  if (isTauri()) {
    const selected = await open({
      multiple: true,
      filters: [{ name: "Images", extensions: [...PHOTO_IMAGE_EXTENSIONS] }],
    });
    if (!selected) return [];
    const paths = (Array.isArray(selected) ? selected : [selected]).filter(isPhotoFileName);
    const files: File[] = [];
    for (const path of paths) {
      // Read each pick independently so one unreadable file does not abandon the
      // rest of the selection.
      try {
        files.push(new File([toArrayBuffer(await readFile(path))], browserSafeFileName(path)));
      } catch (error) {
        console.warn(`Could not read the selected image "${path}".`, error);
      }
    }
    return files;
  }

  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = "image/*";
    input.onchange = () => {
      resolve(input.files ? Array.from(input.files) : []);
    };
    // Resolve (rather than hang) when the dialog is dismissed without a pick.
    input.addEventListener("cancel", () => resolve([]));
    input.click();
  });
}

/**
 * Parse dropped browser `File`s that look like geotagged photos into a point
 * layer. Returns null when the drop contained no auto-importable image (so the
 * caller can fall through to the vector/raster pipeline). TIFF is intentionally
 * excluded here and handled as a raster instead.
 */
export async function loadDroppedPhotoFiles(
  droppedFiles: FileList | File[],
): Promise<GeotaggedPhotoResult | null> {
  const photos = Array.from(droppedFiles).filter((file) => isPhotoDropFileName(file.name));
  if (!photos.length) return null;
  const { loadGeotaggedPhotos } = await import("./geotagged-photos");
  return loadGeotaggedPhotos(photos);
}

/**
 * Read dropped image file paths (Tauri) into `File`s and parse them into a point
 * layer from their EXIF GPS. Returns null when no auto-importable image was
 * dropped (TIFF is excluded and loaded as a raster instead).
 */
export async function loadDroppedPhotoPaths(paths: string[]): Promise<GeotaggedPhotoResult | null> {
  const photoPaths = paths.filter(isPhotoDropFileName);
  if (!photoPaths.length) return null;
  const files: File[] = [];
  for (const path of photoPaths) {
    try {
      files.push(new File([toArrayBuffer(await readFile(path))], browserSafeFileName(path)));
    } catch (error) {
      console.warn(`Could not read dropped image "${path}".`, error);
    }
  }
  if (!files.length) return null;
  const { loadGeotaggedPhotos } = await import("./geotagged-photos");
  return loadGeotaggedPhotos(files);
}

export async function loadDroppedVectorPaths(
  paths: string[],
  options?: DuckDbVectorLoadOptions,
): Promise<LoadedLayer[]> {
  const vectorPaths = paths.filter(isVectorFileName);
  if (!vectorPaths.length) return [];

  const layers: LoadedLayer[] = [];
  for (const path of vectorPaths) {
    const extension = fileExtension(path);
    if (SHAPEFILE_SIDECAR_EXTENSIONS.includes(extension)) continue;
    if (extension === "gpx") {
      try {
        layers.push(...parseGpxTextLayers(await readLocalFileText(path), path));
      } catch (error) {
        // `read_local_file` rejects with a plain string, not an `Error`, so
        // fall back to `String(error)` to keep that detail instead of a generic
        // "Unknown error" when the fs-plugin fallback fails.
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Could not read this GPX file. ${detail}`);
      }
      continue;
    }
    if (extension === "kmz") {
      try {
        layers.push(...(await loadKmzLayers(await readLocalFileBytes(path), path, options)));
      } catch (error) {
        if (isVectorLoadCancelled(error)) continue;
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Could not read this KMZ file. ${detail}`);
      }
      continue;
    }
    if (extension === "kml") {
      // Load placemarks and ground overlays independently so an overlay-only
      // KML still contributes its overlays when the vector load throws.
      const kmlText = await readLocalFileText(path);
      const overlays = groundOverlaysFromKml(kmlText, path);
      const models = options?.skipModels ? [] : await modelsFromKml(kmlText, path);
      // Overlays go under the placemarks (added first), matching the KMZ path.
      layers.push(...overlays, ...models);
      try {
        // Only add a vector layer when it actually has features (an overlay-only
        // KML's DuckDB fallback can return an empty collection).
        const vector = await loadTauriVectorFile(path, options);
        if (vector.data.features.length > 0) layers.push(vector);
      } catch (error) {
        // Declining the oversized-vector prompt, or a genuine parse failure,
        // still leaves any ground overlays/models already added above (a real
        // non-cancellation failure with nothing to salvage is rethrown).
        // Cancellation is not surfaced; other failures are logged so they are
        // not fully invisible.
        if (!isVectorLoadCancelled(error)) {
          if (!overlays.length && !models.length) throw error;
          console.warn(
            `Loaded ground overlays/models from "${path}" but could not read its vector placemarks.`,
            error,
          );
        }
      }
      continue;
    }
    try {
      layers.push(await loadTauriVectorFile(path, options));
    } catch (error) {
      // The user declined this oversized file: skip it without abandoning the
      // rest of the dropped batch.
      if (isVectorLoadCancelled(error)) continue;
      throw error;
    }
  }

  return layers;
}

/** Split a CSV/TSV header line into trimmed column names. */
export function parseCsvHeaderLine(line: string): string[] {
  const header = line.replace(/^﻿/, "").replace(/[\r\n]+$/, "");
  if (!header) return [];
  // Reuse the project's quote-aware delimited-text parser for each candidate
  // delimiter and keep the one that yields the most columns. The candidate set
  // is shared with the drag-and-drop loader so both detect the same formats
  // (comma, tab, semicolon, pipe). Quoting is respected, so a quoted field
  // containing the delimiter (e.g. "city,state") neither skews detection nor
  // splits the header.
  let best: string[] = [];
  for (const delimiter of DELIMITER_CANDIDATES) {
    try {
      const fields = parseDelimitedTextFields(header, delimiter).filter(
        (name) => name.trim().length > 0,
      );
      if (fields.length > best.length) best = fields;
    } catch {
      // No header row for this delimiter; try the next candidate.
    }
  }
  return best.map((name) => name.trim()).filter((name) => name.length > 0);
}

/**
 * Read the header column names of a CSV from a browser File or a desktop path.
 * Reads only the first line so large CSVs are not loaded into memory.
 */
export async function readCsvHeaderColumns(source: File | string): Promise<string[]> {
  try {
    if (typeof source !== "string") {
      // Browser File: decode just the leading slice that holds the header.
      const text = await source.slice(0, 65536).text();
      return parseCsvHeaderLine(text.split(/\r?\n/, 1)[0] ?? "");
    }
    if (!isTauri()) return [];
    const lines = await readTextFileLines(source);
    for await (const line of lines) {
      return parseCsvHeaderLine(line);
    }
    return [];
  } catch (error) {
    console.warn("Could not read CSV header", error);
    return [];
  }
}
