import {
  batchDecodePolylines,
  hasPathTraversal,
  isAbsoluteFilesystemPath,
  parseProject,
  type GeoLibreProject,
} from "@geolibre/core";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  BaseDirectory,
  mkdir,
  readDir,
  readFile,
  readTextFile,
  readTextFileLines,
  stat,
  writeFile,
  writeTextFile,
} from "@tauri-apps/plugin-fs";
import type { StartupSettings } from "../hooks/useDesktopSettings";
import { unzip } from "fflate";
import type { FeatureCollection } from "geojson";
import i18next from "i18next";
import { combine, parseDbf, parseShp } from "shpjs";
import {
  DELIMITER_CANDIDATES,
  NO_VALID_COORDINATES_MESSAGE,
  countDelimitedTextRows,
  detectCoordinateFields,
  detectDelimitedTextDelimiter,
  firstDelimitedTextLine,
  hasCompleteHeaderLine,
  parseDelimitedTextFields,
  parseDelimitedTextLayer,
} from "./delimited-text";
import { isAndroidContentUri, writeInPlaceWithAndroidFallback } from "./android-content-uri";
import { startupProjectPath } from "./startup-project";
import {
  readStartupSnapshot,
  STARTUP_SNAPSHOT_DIR,
  writeStartupSnapshot,
  type StartupSnapshotIo,
  type StartupSnapshotSlot,
} from "./startup-project-snapshot";
import { IS_MAS_BUILD } from "./build-flags";
import type { DuckDbVectorFile } from "./duckdb-vector-loader";
import {
  confirmLargeDataset,
  shouldRouteToDuckDb,
  type DuckDbVectorLoadOptions,
  type LargeVectorDataset,
} from "./duckdb-vector-guard";
import type { GeotaggedPhotoResult } from "./geotagged-photos";
import { PHOTO_IMAGE_EXTENSIONS, isPhotoDropFileName, isPhotoFileName } from "./geotagged-photos";
import { projectedGeoJsonCrs } from "./crs-utils";
import { nativeFileDialogFilters, type FileDialogFilter } from "./file-dialog-filters";
import { parseGpxLayer } from "./gpx";
import { isTauri } from "./is-tauri";
import { SHAPEFILE_COMPANION_EXTENSIONS, shapefileCompanionPathsFromSelection } from "./mas-build";
import {
  parseKmlGroundOverlays,
  parseKmlModels,
  parseKmlText,
  type KmlGroundOverlay,
  type KmlModel,
} from "./kml";
import {
  registerKmlSuperOverlay,
  setKmlSuperOverlayResolver,
  unregisterKmlSuperOverlay,
  type KmlSuperOverlayTile,
} from "./kml-super-overlay";
import {
  findArchiveEntry,
  findArchiveEntryKey,
  imageMimeFromName,
  isTiffImageName,
  normalizeArchivePath,
} from "./kml-overlays";
import { tiffBytesToPngBytes } from "./tiff-image";

// Re-exported so existing `import { isTauri } from "./tauri-io"` consumers keep
// working; the implementation lives in the lightweight ./is-tauri module.
export { isTauri };

function browserSafeFileName(path: string): string {
  return path.split(/[/\\]/).pop() || "project.geolibre.json";
}

export type { FileDialogFilter } from "./file-dialog-filters";

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
  androidFilters?: FileDialogFilter[];
  accept: string;
  /** Extensions that should be read as bytes instead of text when readText is set. */
  binaryExtensions?: string[];
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
// The MAS build adds the shapefile companion extensions: the App Sandbox
// denies the automatic sibling read, so companions must be selectable in the
// dialog for `readShapefileCompanionFiles` to forward them. Deliberately NOT
// added to VECTOR_FILE_DIALOG_EXTENSIONS, which doubles as the restore
// whitelist SYNCed with the Rust guard.
function vectorFileDialogFilters(): FileDialogFilter[] {
  return [
    {
      name: i18next.t("toolbar.item.vectorDataFilter"),
      extensions: IS_MAS_BUILD
        ? [...VECTOR_FILE_DIALOG_EXTENSIONS, ...SHAPEFILE_COMPANION_EXTENSIONS]
        : VECTOR_FILE_DIALOG_EXTENSIONS,
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

/** A tiled KML Super-Overlay registered with GeoLibre's in-memory tile protocol. */
export interface LoadedKmlSuperOverlay {
  kind: "kml-super-overlay";
  name: string;
  path: string;
  url: string;
  bounds: [number, number, number, number];
  minzoom: number;
  maxzoom: number;
  tileSize: number;
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
export type LoadedLayer =
  | LoadedVectorLayer
  | LoadedImageOverlay
  | LoadedKmlSuperOverlay
  | LoadedModel;

/** Narrow a {@link LoadedLayer} to its image-overlay variant. */
export function isLoadedImageOverlay(layer: LoadedLayer): layer is LoadedImageOverlay {
  return "kind" in layer && layer.kind === "image-overlay";
}

export function isLoadedKmlSuperOverlay(layer: LoadedLayer): layer is LoadedKmlSuperOverlay {
  return "kind" in layer && layer.kind === "kml-super-overlay";
}

/** Free protocol archives accumulated by a batch that ultimately rejects. */
function unregisterLoadedKmlSuperOverlays(layers: readonly LoadedLayer[]): void {
  for (const layer of layers) {
    if (isLoadedKmlSuperOverlay(layer)) unregisterKmlSuperOverlay(layer.url);
  }
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
  const fc = assertFeatureCollection(JSON.parse(text));
  // A projected GeoJSON declares a non-WGS84 CRS via a legacy top-level `crs`
  // member and carries raw projected coordinates MapLibre cannot render. When
  // one is present, reproject to WGS84 (the heavy DuckDB loader is pulled in
  // only then). A blank/WGS84 member takes the cheap path below and never loads
  // DuckDB, keeping the common case light.
  const sourceCrs = projectedGeoJsonCrs(fc);
  if (sourceCrs) {
    const { reprojectFeatureCollectionToWgs84 } = await import("./duckdb-vector-loader");
    return reprojectFeatureCollectionToWgs84(fc, sourceCrs);
  }
  // Drop the deprecated `crs` member (RFC 7946 mandates WGS84) so it does not
  // linger on an already-WGS84 collection.
  const { crs: _deprecatedCrs, ...stripped } = fc as FeatureCollection & {
    crs?: unknown;
  };
  return stripped as FeatureCollection;
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

/**
 * A local file's size in bytes, read from filesystem metadata so the size is
 * known *before* the file is read into memory. Returns undefined outside Tauri
 * (the browser has no path-based `stat`; those callers use `File.size`) or when
 * the `stat` fails — an unreadable path surfaces its own error at read time, so
 * a metadata failure must not block the load.
 */
async function localFileSizeBytes(path: string): Promise<number | undefined> {
  if (!isTauri()) return undefined;
  try {
    return (await stat(path)).size;
  } catch (error) {
    console.debug(`[GeoLibre] Could not stat "${path}" for the large-file guard.`, error);
    return undefined;
  }
}

/**
 * Extensions whose in-memory reader is bypassed by the size route.
 *
 * Containers (`zip`, `kmz`) unpack first and decide from their contents.
 * Delimited text and GPX always use the JS parser: `loadDuckDbVector` passes no
 * `layer` argument, so `ST_Read` would read only a GPX's first OGR layer
 * (usually `waypoints`) and silently discard its tracks and routes, and it
 * cannot build points from a CSV's lon/lat columns.
 */
const ROUTABLE_TEXT_EXTENSIONS = new Set(["geojson", "json", "kml"]);

/**
 * Read a dropped file as text, yielding "" when it cannot be read.
 *
 * KML overlay/model extraction needs the whole document as a string, and there
 * is no way around that: `TextDecoder.decode()` over the full buffer builds one
 * JS string exactly as `File.text()` does, so both hit the same
 * `RangeError: Invalid string length` past the engine's cap. Rather than
 * pretend to avoid it, the failure is caught here — a file too large to read as
 * text contributes no overlays instead of aborting the whole drop batch.
 */
async function readVectorFileTextOrEmpty(file: File): Promise<string> {
  try {
    return await file.text();
  } catch (error) {
    console.warn(`[GeoLibre] Could not read "${file.name}" as text; skipping its overlays.`, error);
    return "";
  }
}

/** Path counterpart to {@link readVectorFileTextOrEmpty}. */
async function readLocalFileTextOrEmpty(path: string): Promise<string> {
  try {
    return await readLocalFileText(path);
  } catch (error) {
    console.warn(`[GeoLibre] Could not read "${path}" as text; skipping its overlays.`, error);
    return "";
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

/**
 * Checks whether a decoded polyline FeatureCollection contains valid, non-empty WGS84 coordinates.
 *
 * Rejects collections with no features or 0 total coordinates, non-finite values,
 * or coordinate values falling outside the valid WGS84 domain ([-180, 180] lon, [-90, 90] lat).
 */
function hasValidPolylineCoordinates(fc: FeatureCollection): boolean {
  if (!fc.features || fc.features.length === 0) return false;
  let totalPoints = 0;
  for (const feature of fc.features) {
    const geometry = feature.geometry;
    if (!geometry) continue;
    if (geometry.type === "LineString") {
      for (const coord of geometry.coordinates) {
        const [lon, lat] = coord;
        if (
          !Number.isFinite(lon) ||
          !Number.isFinite(lat) ||
          lon < -180 ||
          lon > 180 ||
          lat < -90 ||
          lat > 90
        ) {
          return false;
        }
        totalPoints++;
      }
    } else if (geometry.type === "MultiLineString") {
      for (const line of geometry.coordinates) {
        for (const coord of line) {
          const [lon, lat] = coord;
          if (
            !Number.isFinite(lon) ||
            !Number.isFinite(lat) ||
            lon < -180 ||
            lon > 180 ||
            lat < -90 ||
            lat > 90
          ) {
            return false;
          }
          totalPoints++;
        }
      }
    }
  }
  return totalPoints > 0;
}

/**
 * Parses raw polyline text from a dropped/opened file into a vector layer.
 *
 * Encoded polyline format does not self-describe its precision factor. Auto-detection
 * first attempts standard precision 5 (Google Maps / OSRM standard, factor 1e5).
 * If precision 5 yields coordinates outside valid WGS84 bounds (which occurs when
 * precision 6 data with latitude > 9° or longitude > 18° is scaled up by 10x),
 * it falls back to precision 6 (Valhalla / Mapbox standard, factor 1e6).
 *
 * That bounds check only settles the cases it can: the two decodes of the same
 * bytes differ by exactly a factor of 10, so whenever precision 5 lands in
 * bounds precision 6 necessarily does too, and nothing in the data says which
 * one the author meant. Precision-6 data close to the prime meridian and the
 * equator (|lon| <= 18°, |lat| <= 9°) therefore imports at precision 5, ten
 * times too large, with no error. Drag-and-drop has nowhere to ask, so it takes
 * the more common of the two; Add Data → Encoded Polyline is the path with an
 * explicit precision picker and a preview to check the result against.
 */
function parsePolylineFileLayers(text: string, path: string): LoadedVectorLayer[] {
  let fc = batchDecodePolylines(text, { precision: 5, unescape: true });
  if (!hasValidPolylineCoordinates(fc)) {
    fc = batchDecodePolylines(text, { precision: 6, unescape: true });
  }
  if (!hasValidPolylineCoordinates(fc)) {
    throw new Error("No valid polyline coordinates could be decoded from this file.");
  }
  const baseName = pathWithoutExtension(browserSafeFileName(path)) || "Polyline";
  return [
    {
      data: fc,
      name: baseName,
      path,
    },
  ];
}

/** Delimited text formats the drag-and-drop / open path loads as points. */
const DELIMITED_TEXT_DROP_EXTENSIONS = ["csv", "tsv"];

/** Whether a filename looks like a delimited text table (CSV/TSV). */
function isDelimitedTextFileName(path: string): boolean {
  return DELIMITED_TEXT_DROP_EXTENSIONS.includes(fileExtension(path));
}

/**
 * How much of a delimited file to decode when only its header is wanted. Large
 * enough for any realistic header (the widest seen in the wild are a few tens
 * of KB), and the read falls back to the whole file if no line break turns up
 * within it, so an unusual file loses efficiency rather than correctness.
 */
const DELIMITED_TEXT_HEADER_PROBE_BYTES = 1024 * 1024;

/**
 * Reads enough of a delimited file to contain its header row, paired with a
 * reader for the file's whole text.
 *
 * Only a genuine partial probe leaves a full read still to do. Whenever the
 * header text *is* the whole file, which is every file under the probe size,
 * it is handed back for reuse rather than decoded a second time.
 *
 * Decoding a slice can split a multi-byte character at the cut, but the damage
 * is confined to the truncated tail, past the header the caller reads.
 *
 * @param file - The delimited file.
 * @returns The header text and a reader for the full text.
 */
async function readDelimitedTextSource(file: File): Promise<{
  headerText: string;
  readFullText: () => Promise<string>;
}> {
  const alreadyWhole = (text: string) => ({
    headerText: text,
    readFullText: async () => text,
  });
  if (file.size <= DELIMITED_TEXT_HEADER_PROBE_BYTES) return alreadyWhole(await file.text());
  const probe = await file.slice(0, DELIMITED_TEXT_HEADER_PROBE_BYTES).text();
  // Deliberately not "does the probe contain a line break": blank lines before
  // the header contribute breaks of their own, so a header that overruns the
  // probe would still look terminated and be handed back truncated.
  if (hasCompleteHeaderLine(probe)) return { headerText: probe, readFullText: () => file.text() };
  return alreadyWhole(await file.text());
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
 *
 * @param source - `headerText` needs only to reach the end of the header row;
 *   `readFullText` is called solely once coordinate columns are confirmed, so a
 *   CSV large enough to have been probed rather than read whole is never
 *   materialized as text just to be handed to the DuckDB fallback.
 * @param path - The file name or path, used in the messages.
 * @param options - Carries the caller's large-dataset guard.
 */
async function parseDelimitedTextFile(
  source: { headerText: string; readFullText: () => Promise<string> },
  path: string,
  options?: DuckDbVectorLoadOptions,
): Promise<FeatureCollection | null> {
  const name = browserSafeFileName(path);
  const pickColumns = `Use Add Data → Delimited Text to choose the coordinate columns for ${name}.`;
  // Detect the delimiter and the coordinate columns from the header alone, so
  // this preflight neither parses nor even reads the body. parseDelimitedText-
  // Layer re-reads the header internally, so recovering the column names by
  // parsing the whole file here would double the work.
  //
  // A header cell containing a quoted newline is cut short here (see
  // firstDelimitedTextLine for why that cannot be resolved before the delimiter
  // is known). That only ever costs auto-detection, never correctness: the
  // column names below are resolved against a full, quote-aware parse of the
  // file, so the worst case is that lon/lat columns past the cut go unnoticed
  // and the file falls through to DuckDB, whose failure points at Add Data ->
  // Delimited Text, where the user picks the columns by hand.
  const headerLine = firstDelimitedTextLine(source.headerText);
  if (!headerLine) {
    throw new Error(`${name} appears to be empty. ${pickColumns}`);
  }
  const delimiter = detectDelimitedTextDelimiter(headerLine);
  const fields = parseDelimitedTextFields(headerLine, delimiter);
  const coordinateFields = detectCoordinateFields(fields);
  if (!coordinateFields) return null;

  const text = await source.readFullText();
  // Delimited text is the one vector path that never reaches the DuckDB loader
  // (which has no lon/lat column detection), so it was also the one path with
  // no oversized-import guard at all. Counting is a scan that allocates
  // nothing, unlike the materialization it guards, so it runs for every file
  // rather than only past some size: a CSV of short rows can clear the warn
  // threshold on row count while staying far below any byte threshold.
  if (options?.onLargeDataset) {
    await confirmLargeDataset(
      { name, featureCount: countDelimitedTextRows(text, delimiter) },
      options.onLargeDataset,
    );
  }
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
 *
 * A `.shp` at or above {@link DUCKDB_VECTOR_ROUTE_BYTES} skips shpjs and streams
 * through DuckDB: shpjs would otherwise freeze the main thread reprojecting
 * every coordinate synchronously, with no progress, no cancel, and no
 * feature-count guard. The threshold is measured on the *uncompressed* `.shp`,
 * which is the number that governs the parse cost — shapefiles compress heavily,
 * so the zip's own size says little about it.
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
  if (shouldRouteToDuckDb(unzipped.file.data.byteLength)) {
    console.info(
      `[GeoLibre] "${unzipped.file.name}" is ${Math.round(unzipped.file.data.byteLength / (1024 * 1024))} MB uncompressed; reading it with DuckDB instead of shpjs to keep the parse off the main thread.`,
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
// URL directly). An archive-embedded TIFF is transcoded to PNG first, since no
// browser can paint TIFF. Overlays whose image is missing, oversized, or in a
// format browsers cannot render are skipped with a warning.
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
    if (isHttpUrl(overlay.href)) {
      if (isRemoteTiffOverlay(overlay.href)) continue;
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
    if (isOverlayImageTooLarge(data, overlay.href)) continue;

    // Global Mapper and gdal2tiles both write `.tif` overlay images, which no
    // browser can decode, so re-encode them as PNG. The PNG is what gets
    // inlined, so it is size-checked in turn: a compressed TIFF can transcode
    // into a much larger file.
    let image = data;
    let mime = imageMimeFromName(overlay.href);
    if (isTiffImageName(overlay.href)) {
      try {
        image = await tiffBytesToPngBytes(data);
      } catch (error) {
        console.warn(
          `Skipping a KML ground overlay: its TIFF image "${overlay.href}" could not be decoded.`,
          error,
        );
        continue;
      }
      if (isOverlayImageTooLarge(image, overlay.href)) continue;
      mime = "image/png";
    }
    overlays.push(imageOverlayLayer(overlay, await bytesToDataUrl(image, mime), path));
  }
  return sequenceTimeOverlays(overlays);
}

// Whether an overlay's image is a TIFF that lives at an absolute URL. Unlike an
// archive-embedded TIFF, which is transcoded to PNG on import, a remote one
// cannot be re-encoded: fetching it needs CORS the overlay host rarely grants,
// and MapLibre would be handed a URL no browser can paint.
function isRemoteTiffOverlay(href: string): boolean {
  if (!isTiffImageName(href)) return false;
  console.warn(
    `Skipping a KML ground overlay: browsers cannot render the remote TIFF image "${href}".`,
  );
  return true;
}

// Whether an overlay image is over the inline limit, warning when it is.
function isOverlayImageTooLarge(image: Uint8Array, href: string): boolean {
  if (image.length <= MAX_OVERLAY_IMAGE_BYTES) return false;
  console.warn(
    `Skipping a KML ground overlay: its image "${href}" is ${Math.round(
      image.length / (1024 * 1024),
    )} MB, over the ${Math.round(MAX_OVERLAY_IMAGE_BYTES / (1024 * 1024))} MB inline limit.`,
  );
  return true;
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
    if (isRemoteTiffOverlay(overlay.href)) continue;
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
        `Skipping a KML model: "${href}" converts to ${Math.round(
          glb.length / (1024 * 1024),
        )} MB, over the ${Math.round(MAX_MODEL_GLB_BYTES / (1024 * 1024))} MB inline limit.`,
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
        `Skipping a KML model: its mesh "${model.href}" is ${Math.round(
          data.length / (1024 * 1024),
        )} MB, over the ${Math.round(MAX_DAE_SOURCE_BYTES / (1024 * 1024))} MB limit.`,
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
          `Skipping a KML model texture "${texturePath}": ${Math.round(
            bytes.length / (1024 * 1024),
          )} MB, over the ${Math.round(MAX_OVERLAY_IMAGE_BYTES / (1024 * 1024))} MB limit.`,
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
        `Skipping a KML model: "${href}" is ${Math.round(
          Number(contentLength) / (1024 * 1024),
        )} MB, over the ${Math.round(MAX_DAE_SOURCE_BYTES / (1024 * 1024))} MB limit.`,
      );
      return null;
    }
    const daeText = await response.text();
    // Measure real byte size (not UTF-16 code units) so the cap matches the
    // archive path's `Uint8Array.length` check.
    const daeBytes = new Blob([daeText]).size;
    if (daeBytes > MAX_DAE_SOURCE_BYTES) {
      console.warn(
        `Skipping a KML model: "${href}" is ${Math.round(daeBytes / (1024 * 1024))} MB, over the ${Math.round(
          MAX_DAE_SOURCE_BYTES / (1024 * 1024),
        )} MB limit.`,
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
  entries: Record<string, Uint8Array>,
  options?: DuckDbVectorLoadOptions,
): Promise<FeatureCollection> {
  let cancellation: unknown;
  const settled = await Promise.all(
    kmlFiles.map((file) =>
      loadKmlFile(file, options).then(
        async (collection): Promise<FeatureCollection | null> => {
          await resolveKmzFeatureIcons(collection, entries, file.name);
          return collection;
        },
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

const KML_ICON_HREF_PROPERTY = "__geolibre_kml_icon_href";
const KML_ICON_URL_PROPERTY = "__geolibre_kml_icon_url";

/** Replace archive-relative KML icon hrefs with persistent inline raster URLs. */
async function resolveKmzFeatureIcons(
  collection: FeatureCollection,
  entries: Record<string, Uint8Array>,
  kmlEntryName: string,
): Promise<void> {
  const resolved = new Map<string, Promise<string | null>>();
  const iconUrl = (href: string): Promise<string | null> => {
    const cached = resolved.get(href);
    if (cached) return cached;
    const promise = (async () => {
      const key = findArchiveEntryKey(entries, resolveArchiveRelativeHref(kmlEntryName, href));
      if (!key) {
        console.warn(`Could not resolve embedded KMZ icon: ${href}`);
        return null;
      }
      const mime = imageMimeFromName(key);
      if (!mime.startsWith("image/") || mime === "image/svg+xml") return null;
      if (entries[key].byteLength > MAX_OVERLAY_IMAGE_BYTES) {
        console.warn(`Skipping oversized embedded KMZ icon: ${key}`);
        return null;
      }
      return bytesToDataUrl(entries[key], mime);
    })();
    resolved.set(href, promise);
    return promise;
  };

  await Promise.all(
    collection.features.map(async (feature) => {
      const properties = feature.properties;
      const href = properties?.[KML_ICON_HREF_PROPERTY];
      if (!properties || typeof href !== "string") return;
      const url = await iconUrl(href);
      delete properties[KML_ICON_HREF_PROPERTY];
      if (url) properties[KML_ICON_URL_PROPERTY] = url;
    }),
  );
}

function resolveArchiveRelativeHref(owner: string, href: string): string {
  if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("//")) return href;
  const parts = href.startsWith("/") ? [] : owner.replaceAll("\\", "/").split("/").slice(0, -1);
  for (const part of href.replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
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
  const kmlDocs = readKmlDocs(entries);

  // A Super-Overlay is a linked raster pyramid, not thousands of independent
  // persistent image layers, so it becomes one lazy tile source instead. The
  // `<Region>` + `<NetworkLink>` shape it is detected by is also how a plain
  // *vector* regionated KML is built, so the pyramid is only claimed once its
  // raster tiles actually resolve; anything else falls through to the normal
  // overlay/vector parse below rather than failing the whole import.
  // A pyramid node is a KML doc carrying a `<Region>`, and its overlays are that
  // level's tiles. The grain is deliberately the document, not the element: KML
  // attaches a `<Region>` to the enclosing Feature, so a gdal2tiles node's
  // `<GroundOverlay>` is the Region's *sibling*, and filtering by containment
  // would reject every real tile. A doc with no Region holds no tiles, so its
  // overlays (a legend, an inset, a full-extent image) load as their own image
  // layers instead of being given a pyramid level and folded into its bounds.
  // The residual gap is a hand-composed node that bundles an unrelated overlay
  // beside its tile; that one would still be swept in.
  const pyramidDocs = looksLikeSuperOverlay(kmlDocs) ? superOverlayDocNames(kmlDocs) : new Set();
  const superOverlayTiles = pyramidDocs.size
    ? superOverlayTilesFromKmz(
        entries,
        kmlDocs.filter((doc) => pyramidDocs.has(doc.name)),
      )
    : [];
  if (superOverlayTiles.length > 0) {
    const source = await registerKmlSuperOverlay(superOverlayTiles, {
      // Keyed by the source file, so the tile URL saved into a project resolves
      // again after `kmlSuperOverlayResolver` re-reads the KMZ on reopen. A
      // browser File has no re-readable path and gets a session-only key.
      ...(isAbsoluteLocalPath(path) ? { key: path } : {}),
    });
    try {
      // A composite export can carry standalone overlays, placemarks, or models
      // alongside its raster pyramid; returning only the tile layer would
      // silently drop them. The standalone overlays draw above the imagery.
      const plainDocs = kmlDocs.filter((doc) => !pyramidDocs.has(doc.name));
      const layers: LoadedLayer[] = [
        {
          kind: "kml-super-overlay",
          name: `${pathWithoutExtension(fileBaseName(path))} Super-Overlay`,
          path,
          ...source,
        },
        ...(plainDocs.length > 0 ? await groundOverlaysFromKmz(entries, plainDocs, path) : []),
        ...(options?.skipModels ? [] : await modelsFromKmz(entries, kmlDocs, path)),
      ];
      const placemarkEntries = placemarkKmlEntries(entries, kmlDocs);
      if (placemarkEntries) {
        try {
          const features = await kmzVectorFeatures(
            readKmlEntries(placemarkEntries),
            entries,
            options,
          );
          if (features.features.length > 0) layers.push({ data: features, path });
        } catch (error) {
          // Declining the oversized-vector prompt must not throw away the
          // pyramid, which is already registered and loads on its own.
          if (!isVectorLoadCancelled(error)) throw error;
        }
      }
      return layers;
    } catch (error) {
      // The caller never gets the layer, so nothing will ever reference the
      // tile URL — and an archive that never goes live is never pruned. Free
      // it here or a failed import (e.g. an unreadable bundled `.dae`) pins
      // the whole pyramid's bytes for the session.
      unregisterKmlSuperOverlay(source.url);
      throw error;
    }
  }

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
    const features = await kmzVectorFeatures(kmlFiles, entries, options);
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

interface KmlDoc {
  name: string;
  text: string;
}

// `(?:\w+:)?` so a namespace-prefixed `<kml:Region>` (valid but rare) still
// matches, mirroring the model filter in `modelsFromKmz`.
const KML_REGION = /<(?:\w+:)?Region(?:\s|>)/i;
const KML_NETWORK_LINK = /<(?:\w+:)?NetworkLink(?:\s|>)/i;
const KML_PLACEMARK = /<(?:\w+:)?Placemark(?:\s|>)/i;

function readKmlDocs(entries: Record<string, Uint8Array>): KmlDoc[] {
  return Object.entries(entries)
    .filter(([name]) => name.toLowerCase().endsWith(".kml"))
    .map(([name, bytes]) => ({
      name,
      text: new TextDecoder("utf-8").decode(bytes),
    }));
}

/**
 * Whether an archive has the shape of a Super-Overlay: several KML nodes, at
 * least one carrying both a `<Region>` and a `<NetworkLink>`. Regionated
 * *vector* KML is built the same way, so this only narrows the candidates —
 * the caller confirms the pyramid by resolving its raster tiles.
 */
function looksLikeSuperOverlay(kmlDocs: KmlDoc[]): boolean {
  return (
    kmlDocs.length > 1 &&
    kmlDocs.some((doc) => KML_REGION.test(doc.text) && KML_NETWORK_LINK.test(doc.text))
  );
}

/**
 * The names of the KML nodes that make up the pyramid: every node carrying a
 * `<Region>`, plus everything those nodes link to transitively.
 *
 * Membership cannot be `<Region>` alone. A gdal2tiles-style export regionates
 * its *inner* nodes but writes the deepest level as a bare `<GroundOverlay>`
 * with no Region — issue #1598's sample has 1,256 regionated nodes and 3,640
 * such leaves — so keying on Region would leave every leaf tile to load as its
 * own persistent image layer (each one inlined as a data URL), which is enough
 * to hang the app, and would silently drop the pyramid's deepest zoom.
 * Following the `<NetworkLink>` graph instead claims exactly the nodes the
 * pyramid reaches, so an overlay in a node it never links to — a legend, an
 * inset, a full-extent image — still loads on its own.
 */
export function superOverlayDocNames(kmlDocs: KmlDoc[]): Set<string> {
  const byName = new Map<string, KmlDoc>();
  for (const doc of kmlDocs) byName.set(normalizeArchivePath(doc.name), doc);
  const linked = new Set<string>();
  const queue: KmlDoc[] = [];
  for (const doc of kmlDocs) {
    if (!KML_REGION.test(doc.text)) continue;
    linked.add(doc.name);
    queue.push(doc);
  }
  while (queue.length > 0) {
    const doc = queue.pop() as KmlDoc;
    for (const href of kmlNodeHrefs(doc.text)) {
      const target =
        byName.get(normalizeArchivePath(archiveDirname(doc.name) + href)) ??
        byName.get(normalizeArchivePath(href));
      if (!target || linked.has(target.name)) continue;
      linked.add(target.name);
      queue.push(target);
    }
  }
  return linked;
}

/**
 * The archive-local KML nodes an `<href>` in this document points at. Matching
 * on the extension rather than the enclosing element keeps this a text scan (a
 * pyramid holds thousands of nodes): a `<GroundOverlay>`'s own href names an
 * image, never another node.
 */
function kmlNodeHrefs(text: string): string[] {
  return [...text.matchAll(/<href>([^<]+)<\/href>/gi)]
    .map((match) => match[1].trim())
    .filter((href) => !isHttpUrl(href) && /\.kml$/i.test(normalizeArchivePath(href)));
}

/** Every archive-local `<GroundOverlay>` image in a KMZ, as pyramid tiles. */
function superOverlayTilesFromKmz(
  entries: Record<string, Uint8Array>,
  kmlDocs: KmlDoc[],
): KmlSuperOverlayTile[] {
  return kmlDocs.flatMap((doc) =>
    parseKmlGroundOverlays(doc.text).flatMap((overlay) => {
      // A remote tile is not archive-local, so it is not part of the pyramid
      // this protocol serves. TIFF tiles stay in: the protocol decodes them
      // through geotiff when it paints them.
      if (isHttpUrl(overlay.href)) return [];
      const data =
        findArchiveEntry(entries, archiveDirname(doc.name) + overlay.href) ??
        findArchiveEntry(entries, overlay.href);
      return data ? [{ overlay, bytes: data }] : [];
    }),
  );
}

/**
 * The archive with its placemark-free KML nodes dropped, or null when no node
 * holds a `<Placemark>`. Lets a Super-Overlay's supplementary vector content
 * still load, without sending the pyramid's thousands of NetworkLink-only
 * nodes through DuckDB.
 */
function placemarkKmlEntries(
  entries: Record<string, Uint8Array>,
  kmlDocs: KmlDoc[],
): Record<string, Uint8Array> | null {
  const withPlacemarks = new Set(
    kmlDocs.filter((doc) => KML_PLACEMARK.test(doc.text)).map((doc) => doc.name),
  );
  if (withPlacemarks.size === 0) return null;
  const kept = { ...entries };
  for (const doc of kmlDocs) {
    if (!withPlacemarks.has(doc.name)) delete kept[doc.name];
  }
  return kept;
}

// Only the tile URL of a Super-Overlay layer persists into a project, never the
// pyramid's bytes, so a reopened project re-reads them from the source KMZ the
// first time MapLibre asks the protocol for a tile. The path comes out of a
// saved project, so it is whitelisted exactly like `restoreLocalFileLayers`
// before anything is read off disk.
setKmlSuperOverlayResolver(async (path) => {
  if (
    !isTauri() ||
    !isAbsoluteLocalPath(path) ||
    hasPathTraversal(path) ||
    !isRestorableVectorPath(path)
  ) {
    return null;
  }
  const entries = await unzipArchive(await readLocalFileBytes(path));
  const docs = readKmlDocs(entries);
  const pyramidDocs = superOverlayDocNames(docs);
  return superOverlayTilesFromKmz(
    entries,
    docs.filter((doc) => pyramidDocs.has(doc.name)),
  );
});

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
  // Browser counterpart to the metadata preflight in `loadTauriVectorFile`;
  // `File.size` is known without reading the blob, so the same rule applies.
  const streamViaDuckDb = shouldRouteToDuckDb(file.size);
  // `zip`/`kmz` ignore this flag (the archive is unpacked first and
  // `loadShapefileZip` decides from the *uncompressed* `.shp`), so announcing a
  // route here would be misleading for a container near the threshold.
  if (streamViaDuckDb && ROUTABLE_TEXT_EXTENSIONS.has(extension)) {
    console.info(
      `[GeoLibre] "${file.name}" is ${Math.round(file.size / (1024 * 1024))} MB; streaming it through DuckDB instead of the in-memory reader.`,
    );
  }

  if (!streamViaDuckDb && (extension === "geojson" || extension === "json")) {
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

  if (!streamViaDuckDb && extension === "kml") {
    try {
      return {
        data: parseKmlText(await file.text()),
        path: file.name,
      };
    } catch {
      // The styled reader does not cover this KML; let DuckDB Spatial try it.
    }
  }

  // Not gated on `streamViaDuckDb`: see ROUTABLE_TEXT_EXTENSIONS — the DuckDB
  // reader would return only this GPX's first OGR layer.
  if (extension === "gpx") {
    return {
      data: parseGpxText(await file.text()),
      path: file.name,
    };
  }

  if (extension === "polyline") {
    const text = await file.text();
    const [layer] = parsePolylineFileLayers(text, file.name);
    return {
      data: layer.data,
      path: file.name,
    };
  }

  // Deliberately NOT gated on `streamViaDuckDb`: `loadDuckDbVectorFile` has no
  // longitude/latitude column detection (that lives only in the GeoParquet
  // conversion path), so routing a plain lon/lat CSV to DuckDB fails with
  // "DuckDB did not find a geometry column in this file." A big CSV therefore
  // has to be parsed here rather than routed away, and carries its own
  // oversized-import guard instead.
  if (isDelimitedTextFileName(file.name)) {
    // Only the header decides whether this is a lon/lat CSV, and a `File` can
    // be read in part, so a large CSV headed for the DuckDB fallback below is
    // never decoded as text in full first.
    const points = await parseDelimitedTextFile(
      await readDelimitedTextSource(file),
      file.name,
      options,
    );
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
  const selectedPaths = Array.isArray(selected) ? selected : [selected];
  // `isVectorFileName` drops rasters, project files, and shapefile sidecars, so
  // a sidecar picked on its own never becomes its own (unreadable) layer.
  const paths = selectedPaths.filter(isVectorFileName);
  const picked: PickedVectorFile[] = [];
  for (const path of paths) {
    // Read each pick independently so one unreadable file (e.g. moved between
    // pick and read, or an unreadable sidecar) does not abandon the rest.
    try {
      const file = new File([toArrayBuffer(await readFile(path))], browserSafeFileName(path));
      const companionFiles =
        fileExtension(path) === "shp" ? await readShapefileCompanionFiles(path, selectedPaths) : [];
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
    extension === "polyline" ||
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
  // Delegates to core so record normalization (which cannot import this module)
  // validates a persisted path by exactly the same rule; see
  // `isAbsoluteFilesystemPath` for why UNC paths are rejected.
  return isAbsoluteFilesystemPath(path);
}

async function loadTauriVectorFile(
  path: string,
  options?: DuckDbVectorLoadOptions,
): Promise<{
  data: FeatureCollection;
  path: string;
}> {
  const extension = fileExtension(path);
  // Decided from filesystem metadata, before the first byte is read, so an
  // oversized file never starts a text parse that would freeze the UI.
  const sizeBytes = await localFileSizeBytes(path);
  const streamViaDuckDb = shouldRouteToDuckDb(sizeBytes);
  // See `loadBrowserVectorFile`: containers decide their own routing later.
  if (streamViaDuckDb && ROUTABLE_TEXT_EXTENSIONS.has(extension)) {
    console.info(
      `[GeoLibre] "${browserSafeFileName(path)}" is ${Math.round((sizeBytes ?? 0) / (1024 * 1024))} MB; streaming it through DuckDB instead of the in-memory reader.`,
    );
  }

  if (!streamViaDuckDb && (extension === "geojson" || extension === "json")) {
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

  if (!streamViaDuckDb && extension === "kml") {
    try {
      return {
        data: parseKmlText(await readLocalFileText(path)),
        path,
      };
    } catch {
      // The styled reader does not cover this KML; let DuckDB Spatial try it.
    }
  }

  // Not gated on `streamViaDuckDb`; see the browser counterpart.
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

  if (extension === "polyline") {
    try {
      const text = await readLocalFileText(path);
      const [layer] = parsePolylineFileLayers(text, path);
      return {
        data: layer.data,
        path,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown error";
      throw new Error(`Could not read this Polyline file. ${detail}`);
    }
  }

  // Not gated on `streamViaDuckDb` — see the note in `loadBrowserVectorFile`:
  // the DuckDB reader cannot build points from lon/lat columns.
  if (isDelimitedTextFileName(path)) {
    // Unlike the browser path there is no ranged read here, so the text is read
    // once and serves as both the header probe and the body.
    const text = await readLocalFileText(path);
    const points = await parseDelimitedTextFile(
      { headerText: text, readFullText: async () => text },
      path,
      options,
    );
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

/**
 * Reads a picked `.shp`'s companion files as browser `File`s: the automatic
 * sibling read first, then (Mac App Store build only) any companions the user
 * multi-selected in the same dialog. Under the App Sandbox the sibling read is
 * denied for files the user did not pick, so the selection is the only way a
 * loose shapefile keeps its attributes there; picked paths are readable because
 * the dialog's powerbox grant covers them. Deduplicated by lowercased name with
 * the sibling read winning, so non-MAS behavior is unchanged.
 *
 * @param path - The absolute path of the picked `.shp`.
 * @param selectedPaths - Every path in the same dialog selection.
 * @returns The companion `File`s to pass alongside the `.shp`.
 */
async function readShapefileCompanionFiles(path: string, selectedPaths: string[]): Promise<File[]> {
  const files = (await readShapefileSiblings(path)).map(
    (sibling) => new File([toArrayBuffer(sibling.data)], sibling.name),
  );
  if (!IS_MAS_BUILD) return files;
  const seen = new Set(files.map((file) => file.name.toLowerCase()));
  for (const companionPath of shapefileCompanionPathsFromSelection(path, selectedPaths)) {
    const name = browserSafeFileName(companionPath);
    if (seen.has(name.toLowerCase())) continue;
    try {
      files.push(new File([toArrayBuffer(await readFile(companionPath))], name));
      seen.add(name.toLowerCase());
    } catch (error) {
      console.warn(`Could not read the selected shapefile companion "${companionPath}".`, error);
    }
  }
  return files;
}

async function openProjectFileBrowser(): Promise<{
  project: GeoLibreProject;
  path: string;
  text: string;
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
      const text = await file.text();
      return {
        project: parseProject(text),
        path: handle.name || file.name,
        text,
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
    text: result.text,
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
  const shouldReadBinaryByExtension = (path: string) => {
    const extension = path.split(".").pop()?.toLowerCase();
    return Boolean(
      extension && options.binaryExtensions?.some((item) => item.toLowerCase() === extension),
    );
  };

  if (isTauri()) {
    const selected = await open({
      multiple: false,
      filters: nativeFileDialogFilters(options.filters, options.androidFilters),
    });
    if (!selected || typeof selected !== "string") return null;
    const binaryByExtension = shouldReadBinaryByExtension(selected);
    const data =
      options.readBinary || binaryByExtension ? toArrayBuffer(await readFile(selected)) : undefined;
    const text = options.readText && !binaryByExtension ? await readTextFile(selected) : undefined;
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
        const binaryByExtension = shouldReadBinaryByExtension(file.name);
        const data = options.readBinary || binaryByExtension ? await file.arrayBuffer() : undefined;
        const text = options.readText && !binaryByExtension ? await file.text() : undefined;
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

/** Open a multi-file picker and read every selected file as bytes. */
export async function openLocalDataFilesWithFallback(
  options: LocalDataFileOptions,
): Promise<Array<{ data: ArrayBuffer; path: string }>> {
  if (isTauri()) {
    const selected = await open({
      multiple: true,
      filters: nativeFileDialogFilters(options.filters, options.androidFilters),
    });
    const paths = Array.isArray(selected) ? selected : selected ? [selected] : [];
    return Promise.all(
      paths.map(async (path) => ({ data: toArrayBuffer(await readFile(path)), path })),
    );
  }

  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = options.accept;
    input.onchange = async () => {
      try {
        const files = Array.from(input.files ?? []);
        resolve(
          await Promise.all(
            files.map(async (file) => ({ data: await file.arrayBuffer(), path: file.name })),
          ),
        );
      } catch (error) {
        reject(error);
      }
    };
    input.addEventListener("cancel", () => resolve([]));
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

/** Pick several native filesystem paths (desktop only). */
export async function pickLocalPathsWithFallback(
  options: PickLocalPathOptions = {},
): Promise<string[]> {
  if (!isTauri()) return [];
  const selected = await open({
    directory: options.directory ?? false,
    filters: options.filters,
    multiple: true,
  });
  return Array.isArray(selected) ? selected : selected ? [selected] : [];
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

/**
 * Pick a GeoLibre project and parse it.
 *
 * @returns The parsed project, the path it came from, and the raw text — which
 *   {@link saveStartupProjectSnapshot} copies verbatim rather than re-serializing
 *   the parsed form. Null if the picker was cancelled.
 */
export async function openProjectFile(): Promise<{
  project: GeoLibreProject;
  path: string;
  text: string;
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
  return { project, path: selected, text };
}

/** Pick a QGIS project and return its raw bytes for the import converter. */
export async function openQgisProjectFile(): Promise<{
  data: ArrayBuffer;
  path: string;
} | null> {
  const result = await openLocalDataFileWithFallback({
    filters: [{ name: "QGIS Project", extensions: ["qgz", "qgs"] }],
    accept: ".qgz,.qgs",
    readBinary: true,
  });
  if (!result?.data) return null;
  return { data: result.data, path: result.path };
}

/** Pick an ArcGIS Pro project/map and return its raw bytes for the CIM converter. */
export async function openArcgisProjectFile(): Promise<{
  data: ArrayBuffer;
  path: string;
} | null> {
  const result = await openLocalDataFileWithFallback({
    filters: [{ name: "ArcGIS Pro Project", extensions: ["aprx", "mapx"] }],
    accept: ".aprx,.mapx",
    readBinary: true,
  });
  if (!result?.data) return null;
  return { data: result.data, path: result.path };
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

/**
 * Snapshot files live in the app's private data directory, the one place the
 * `fs` plugin's default scope allows without a dialog having handed us the path
 * — and on Android the one place still readable after the process restart that
 * kills a `content://` grant.
 */
const startupSnapshotIo: StartupSnapshotIo = {
  write: async (file, content) => {
    await mkdir(STARTUP_SNAPSHOT_DIR, { baseDir: BaseDirectory.AppLocalData, recursive: true });
    await writeTextFile(`${STARTUP_SNAPSHOT_DIR}/${file}`, content, {
      baseDir: BaseDirectory.AppLocalData,
    });
  },
  read: (file) =>
    readTextFile(`${STARTUP_SNAPSHOT_DIR}/${file}`, { baseDir: BaseDirectory.AppLocalData }),
};

/**
 * Keep a restorable copy of a project the startup preference will reopen
 * (GeoLibre#1948). A no-op unless the path is an Android `content://` URI, whose
 * read grant does not survive the process — every other path can simply be
 * re-read.
 *
 * @param path - The path or content URI the project was opened from or saved to.
 * @param text - The serialized project.
 * @param settings - The committed startup preference.
 * @returns The slot written, or null when nothing was.
 */
export async function saveStartupProjectSnapshot(
  path: string,
  text: string,
  settings: StartupSettings,
): Promise<StartupSnapshotSlot | null> {
  if (!isTauri()) return null;
  return writeStartupSnapshot(path, text, settings, startupSnapshotIo);
}

/**
 * Make sure the project a *newly saved* startup preference points at has a
 * restorable copy, reading it now rather than waiting for the next open or save.
 *
 * This is the moment the user's own steps land on: open a project from device
 * storage, then go to Settings and ask for it back on the next launch. Nothing
 * re-reads the project in between, so without this the preference would be
 * saved with no copy behind it and the next launch would still come up empty.
 * Reading works here and only here, because the picker's `content://` grant is
 * alive until this process ends -- which is exactly what the copy outlives.
 *
 * @param settings - The startup preference being committed.
 * @param recentProjects - Recent projects, to resolve "reopen the last project".
 * @returns The slot written, or null when there was nothing to copy.
 */
export async function ensureStartupProjectSnapshot(
  settings: StartupSettings,
  recentProjects: readonly { path: string }[],
): Promise<StartupSnapshotSlot | null> {
  if (!isTauri()) return null;
  const path = startupProjectPath(settings, recentProjects);
  // Only a content URI needs a copy; every other path can be re-read on its own.
  if (!path || !isAndroidContentUri(path)) return null;
  let text: string;
  try {
    text = await readTextFile(path);
  } catch (error) {
    // The grant is already gone -- the project was opened in an earlier session
    // and only reopened from the recent list, say. Nothing to copy, so the next
    // launch reports the unavailable-project banner and the copy is made the
    // next time the project is actually opened or saved.
    console.warn("Could not read the startup project to keep a restorable copy.", error);
    return null;
  }
  return writeStartupSnapshot(path, text, settings, startupSnapshotIo);
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

/**
 * Reopen a project from a remembered path, URL, or Android content URI.
 *
 * @param path - The remembered location.
 * @param signal - Abort signal for the URL branch's fetch.
 * @returns The parsed project, the path it came from, and the raw text -- which
 *   callers hand to {@link saveStartupProjectSnapshot} so reopening from Open
 *   Recent keeps the restorable copy pointing at the project that is now the
 *   most recent one.
 */
export async function openRecentProjectFile(
  path: string,
  signal?: AbortSignal,
): Promise<{
  project: GeoLibreProject;
  path: string;
  text: string;
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

    const body = await response.text();
    return { project: parseProject(body), path, text: body };
  }

  if (!isTauri()) {
    throw new Error("Recent local projects can only be reopened in GeoLibre Desktop.");
  }

  let text: string;
  try {
    // A content URI is not a filesystem path, so `read_project_file` refuses it
    // outright; the `fs` plugin resolves it through Android's ContentResolver
    // instead. That succeeds while the picker's read grant is still alive —
    // reopening from Open Recent in the same session — and fails once the
    // process has restarted, which the stored copy below covers.
    text = isAndroidContentUri(path)
      ? await readTextFile(path)
      : await invoke<string>("read_project_file", { path });
  } catch (error) {
    // Fall back to the copy kept for exactly this project, if there is one
    // (GeoLibre#1948). Only Android content URIs ever have one, and the source
    // path has to match, so this can never substitute a different project.
    //
    // Deliberately ahead of the missing-file check. On a real filesystem "no
    // such file" means the project is gone and the entry can be dropped; on a
    // dead SAF grant it means nothing reliable, because content providers differ
    // in how they report one -- the emulator's ExternalStorageProvider raises a
    // SecurityException, but Drive, Downloads and some OEM file managers are
    // known to report a revoked URI as a FileNotFoundException. Treating that as
    // "gone" would make `useStartupProject` forget the recent entry and reset a
    // "specific" preference to the default, silently wiping the user's chosen
    // startup project on exactly the failure this copy exists to survive.
    const snapshot = await readStartupSnapshot(path, startupSnapshotIo);
    if (snapshot !== null) {
      console.warn(
        `Reopening the stored copy of "${path}"; the original could not be read.`,
        error,
      );
      return { project: parseProject(snapshot), path, text: snapshot };
    }
    if (isFileMissingError(error)) {
      throw new RecentProjectGoneError(`Project file no longer exists: ${path}`);
    }
    throw error;
  }

  return { project: parseProject(text), path, text };
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
 *
 * @param content - The serialized project to write.
 * @param path - The path the project was opened from or last saved to.
 * @param fallbackName - File name for the save dialog when an attempted
 *   in-place write is refused, and only when the path carries no usable name of
 *   its own. The two branches below never attempt one, so they pass the path
 *   itself as the dialog's name and ignore this.
 * @returns The path actually written, or null if a fallback dialog was
 *   cancelled.
 */
export async function saveProjectFileToPath(
  content: string,
  path: string,
  fallbackName?: string,
): Promise<string | null> {
  if (!isTauri() || isHttpUrl(path)) {
    return saveProjectFile(content, path);
  }
  // On Android a project opened through the document picker carries a read-only
  // `content://` grant, so writing back to it is refused and Save fails outright
  // (GeoLibre#1833). The save dialog asks Android to *create* the document,
  // which does grant write, so the fallback below recovers; see
  // `writeInPlaceWithAndroidFallback` for why it cannot lose data.
  return writeInPlaceWithAndroidFallback(content, path, fallbackName, {
    write: writeTextFile,
    saveAs: saveProjectFile,
  });
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
  try {
    for (const file of files) {
      const extension = fileExtension(file.name);
      if (SHAPEFILE_SIDECAR_EXTENSIONS.includes(extension)) continue;

      if (extension === "gpx") {
        layers.push(...parseGpxTextLayers(await file.text(), file.name));
        continue;
      }

      if (extension === "polyline") {
        layers.push(...parsePolylineFileLayers(await file.text(), file.name));
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
        // Overlay/model extraction needs the whole document as text. A file too
        // large for that yields no overlays rather than aborting the batch; the
        // guarded vector load below still runs and routes it to DuckDB.
        const text = await readVectorFileTextOrEmpty(file);
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
  } catch (error) {
    // A successful Super-Overlay earlier in a batch is not handed to the
    // caller when a later file rejects, so its in-memory archive can never be
    // claimed by a store layer. Free it before propagating the batch failure.
    unregisterLoadedKmlSuperOverlays(layers);
    throw error;
  }

  return layers;
}

export interface DroppedRaster {
  name: string;
  /**
   * The GeoTIFF/COG as a File. The raster control accepts a File directly and
   * manages its object URL, matching how the Add Raster panel loads local files.
   */
  source: File | string;
  /**
   * The absolute path the bytes were read from, when there is one (Tauri).
   * Recorded on the layer so a saved project can reload the raster; absent for
   * a browser drag-and-drop, which has no path.
   */
  path?: string;
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
 * Convert dropped raster paths (Tauri) to asset-protocol URLs. Tauri serves
 * these with byte-range support, so a COG opens lazily instead of copying the
 * entire file over IPC and then copying it again into a browser File.
 */
export async function loadDroppedRasterPaths(
  paths: string[],
  options?: {
    /**
     * The project file the raster paths came from, when they were read out of
     * an imported project rather than picked directly. Accepts QGIS
     * (`.qgs`/`.qgz`) and ArcGIS Pro (`.aprx`/`.mapx`); the Rust side grants
     * the asset scope only because the user selected that project themselves.
     */
    importProjectPath?: string;
  },
): Promise<DroppedRaster[]> {
  const rasterPaths = paths.filter(isRasterFileName);
  await Promise.all(
    rasterPaths.map((path) =>
      invoke("allow_raster_asset", {
        path,
        ...(options?.importProjectPath ? { importProjectPath: options.importProjectPath } : {}),
      }),
    ),
  );
  return rasterPaths.map((path) => ({
    name: fileBaseName(path),
    source: convertFileSrc(path),
    path,
  }));
}

/**
 * Read one raster file off disk into a browser `File`, for reloading a raster a
 * saved project references by path (issue #1463). Rejects when the file is
 * gone; the caller then drops that layer with a notice.
 *
 * @param path - The absolute path recorded when the raster was first added.
 * @returns The file, named after its basename.
 */
export async function readRasterFileAtPath(path: string): Promise<string> {
  await invoke("allow_raster_asset", { path });
  return convertFileSrc(path);
}

/**
 * Open a native file dialog for raster files and read each pick, keeping the
 * absolute path alongside the bytes. Used in place of the raster panel's own
 * `<input type="file">`, whose `File` carries no path. Resolves to an empty
 * array when the dialog is cancelled or the app is not running under Tauri.
 *
 * @returns The picked rasters, each with its file and path.
 */
export async function pickLocalRasterFiles(): Promise<{ file: File | string; path: string }[]> {
  if (!isTauri()) return [];
  const selected = await open({
    multiple: true,
    filters: [
      {
        name: i18next.t("raster.filePickerLabel"),
        extensions: [...RASTER_DROP_EXTENSIONS],
      },
    ],
  });
  if (!selected) return [];
  const paths = (Array.isArray(selected) ? selected : [selected]).filter(isRasterFileName);
  const picked: { file: File | string; path: string }[] = [];
  for (const path of paths) {
    // Read each pick independently so one unreadable file does not abandon the
    // rest of the selection, matching pickImageFilesWithFallback.
    try {
      picked.push({ file: await readRasterFileAtPath(path), path });
    } catch (error) {
      console.warn(`Could not read the selected raster "${path}".`, error);
    }
  }
  return picked;
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
  try {
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
      if (extension === "polyline") {
        try {
          layers.push(...parsePolylineFileLayers(await readLocalFileText(path), path));
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(`Could not read this Polyline file. ${detail}`);
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
        // See the browser counterpart: too large to read as text means no
        // overlays, not a failed drop.
        const kmlText = await readLocalFileTextOrEmpty(path);
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
  } catch (error) {
    unregisterLoadedKmlSuperOverlays(layers);
    throw error;
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
