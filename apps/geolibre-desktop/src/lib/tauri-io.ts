import {
  hasPathTraversal,
  parseProject,
  type GeoLibreProject,
} from "@geolibre/core";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  readFile,
  readTextFile,
  readTextFileLines,
  writeFile,
  writeTextFile,
} from "@tauri-apps/plugin-fs";
import { unzip } from "fflate";
import type { FeatureCollection } from "geojson";
import i18next from "i18next";
import shp from "shpjs";
import {
  DELIMITER_CANDIDATES,
  NO_VALID_COORDINATES_MESSAGE,
  detectCoordinateFields,
  detectDelimitedTextDelimiter,
  parseDelimitedTextFields,
  parseDelimitedTextLayer,
} from "./delimited-text";
import type { DuckDbVectorFile } from "./duckdb-vector-loader";
import type { DuckDbVectorLoadOptions } from "./duckdb-vector-guard";
import { parseGpxLayer } from "./gpx";
import { isTauri } from "./is-tauri";
import { parseKmlText } from "./kml";

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

const RESTORABLE_VECTOR_PATH = new RegExp(
  `\\.(${VECTOR_FILE_DIALOG_EXTENSIONS.join("|")})$`,
  "i",
);

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
  if (browserSafeFileName(path).toLowerCase().endsWith(".shp.xml"))
    return false;
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
  throw new Error(
    "The selected file did not produce a GeoJSON FeatureCollection.",
  );
}

// DuckDB-wasm (pthreads build) can hand back a Uint8Array backed by a
// SharedArrayBuffer, which `Blob`'s BlobPart type rejects. Copy into a plain
// ArrayBuffer so the binary save path type-checks and stays portable.
function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(data.byteLength);
  new Uint8Array(buffer).set(data);
  return buffer;
}

function mergeFeatureCollections(
  collections: FeatureCollection[],
): FeatureCollection {
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

function parseGpxText(text: string): FeatureCollection {
  const result = parseGpxLayer(text);
  return mergeFeatureCollections([
    result.waypoints,
    result.tracks,
    result.routes,
  ]);
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
function parseDelimitedTextFile(
  text: string,
  path: string,
): FeatureCollection | null {
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

async function parseShapefileZip(
  data: ArrayBuffer | Uint8Array,
): Promise<FeatureCollection> {
  return normalizeShapefileResult(await shp(data));
}

function unzipArchive(
  data: ArrayBuffer | Uint8Array,
): Promise<Record<string, Uint8Array>> {
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

async function readKmzKmlFiles(
  data: ArrayBuffer | Uint8Array,
): Promise<DuckDbVectorFile[]> {
  const entries = await unzipArchive(data);
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
    const entryBaseName =
      browserSafeFileName(entryName) || `document-${index + 1}.kml`;
    return {
      name:
        kmlEntries.length === 1
          ? entryBaseName
          : `${index + 1}-${entryBaseName}`,
      extension: "kml",
      data: toDuckDbVectorData(data),
    };
  });
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

async function loadDuckDbVector(
  file: DuckDbVectorFile,
  options?: DuckDbVectorLoadOptions,
) {
  const { loadDuckDbVectorFile } = await import("./duckdb-vector-loader");
  return loadDuckDbVectorFile(file, options);
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
  return (
    error instanceof Error && error.name === "VectorLoadCancelledError"
  );
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
    try {
      return {
        data: await parseShapefileZip(await file.arrayBuffer()),
        path: file.name,
      };
    } catch {
      // DuckDB Spatial may be able to read zipped vector data that shpjs cannot.
    }
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

async function openVectorFileBrowser(
  options?: DuckDbVectorLoadOptions,
): Promise<{
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

async function openVectorFileTauri(
  options?: DuckDbVectorLoadOptions,
): Promise<{
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
  const paths = (Array.isArray(selected) ? selected : [selected]).filter(
    isVectorFileName,
  );
  const picked: PickedVectorFile[] = [];
  for (const path of paths) {
    // Read each pick independently so one unreadable file (e.g. moved between
    // pick and read, or an unreadable sidecar) does not abandon the rest.
    try {
      const file = new File(
        [toArrayBuffer(await readFile(path))],
        browserSafeFileName(path),
      );
      const companionFiles =
        fileExtension(path) === "shp"
          ? (await readShapefileSiblings(path)).map(
              (sibling) => new File([toArrayBuffer(sibling.data)], sibling.name),
            )
          : [];
      picked.push({ file, companionFiles, sourcePath: path });
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
export async function readVectorFileWithSidecars(
  path: string,
): Promise<{ file: File; companionFiles: File[] } | null> {
  // Reject `..` segments as well as relative paths: the path comes from a
  // (possibly hand-edited) project file, so a traversal must not reach outside
  // wherever Tauri's filesystem scope allows. The scope is the real boundary;
  // this is cheap defense-in-depth.
  if (!isTauri() || !isAbsoluteLocalPath(path) || hasPathTraversal(path)) {
    return null;
  }
  try {
    const file = new File(
      [toArrayBuffer(await readFile(path))],
      browserSafeFileName(path),
    );
    const companionFiles =
      fileExtension(path) === "shp"
        ? (await readShapefileSiblings(path)).map(
            (sibling) => new File([toArrayBuffer(sibling.data)], sibling.name),
          )
        : [];
    return { file, companionFiles };
  } catch (error) {
    console.warn(`Could not read local vector file "${path}".`, error);
    return null;
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
        data: await parseGeoJsonText(await readTextFile(path)),
        path,
      };
    } catch {
      // Some GDAL-backed vector formats use .json but are not GeoJSON
      // FeatureCollections. Let DuckDB Spatial try them before failing.
    }
  }

  if (extension === "zip") {
    try {
      return {
        data: await parseShapefileZip(await readFile(path)),
        path,
      };
    } catch {
      // DuckDB Spatial may be able to read zipped vector data that shpjs cannot.
    }
  }

  if (extension === "kmz") {
    try {
      return {
        data: await parseKmz(await readFile(path), options),
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
        data: parseKmlText(await readTextFile(path)),
        path,
      };
    } catch {
      // The styled reader does not cover this KML; let DuckDB Spatial try it.
    }
  }

  if (extension === "gpx") {
    try {
      return {
        data: parseGpxText(await readTextFile(path)),
        path,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown error";
      throw new Error(`Could not read this GPX file. ${detail}`);
    }
  }

  if (isDelimitedTextFileName(path)) {
    const points = parseDelimitedTextFile(await readTextFile(path), path);
    // No lon/lat columns: fall through to DuckDB so spatial CSV variants
    // (e.g. a WKT geometry column) still load.
    if (points) {
      return { data: points, path };
    }
  }

  try {
    const siblingFiles =
      extension === "shp" ? await readShapefileSiblings(path) : [];
    return {
      data: await loadDuckDbVector(
        {
          name: browserSafeFileName(path),
          extension,
          data: await readFile(path),
          siblingFiles,
        },
        options,
      ),
      path,
    };
  } catch (error) {
    if (isVectorLoadCancelled(error)) throw error;
    const detail = error instanceof Error ? error.message : "Unknown error";
    throw new Error(
      `Could not convert this vector file with DuckDB-WASM. ${detail}`,
    );
  }
}

async function readShapefileSiblings(
  path: string,
): Promise<DuckDbVectorFile[]> {
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
  return (
    typeof (window as BrowserFilePickerWindow).showSaveFilePicker !== "function"
  );
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
  content: Uint8Array,
  options: SaveBinaryFileOptions,
): Promise<string | null> {
  const fileName = browserSafeFileName(options.defaultName);
  const pickerWindow = window as BrowserFilePickerWindow;
  const blob = new Blob([toArrayBuffer(content)], { type: options.mimeType });

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

export async function openLocalDataFileWithFallback(
  options: LocalDataFileOptions,
): Promise<{
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
    const data = options.readBinary
      ? toArrayBuffer(await readFile(selected))
      : undefined;
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
    if (
      contentLength !== null &&
      Number(contentLength) > MAX_PROJECT_URL_BYTES
    ) {
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
    throw new Error(
      "Recent local projects can only be reopened in GeoLibre Desktop.",
    );
  }

  let text: string;
  try {
    text = await invoke<string>("read_project_file", { path });
  } catch (error) {
    if (isFileMissingError(error)) {
      throw new RecentProjectGoneError(
        `Project file no longer exists: ${path}`,
      );
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
export async function saveProjectFileToPath(
  content: string,
  path: string,
): Promise<string | null> {
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
export async function writeTextFileToPath(
  path: string,
  content: string,
): Promise<void> {
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
  content: Uint8Array,
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
  await writeFile(path, content);
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

export async function openVectorFileWithFallback(
  options?: DuckDbVectorLoadOptions,
): Promise<{
  data: FeatureCollection;
  path: string;
} | null> {
  if (isTauri()) return openVectorFileTauri(options);
  return openVectorFileBrowser(options);
}

export async function loadDroppedVectorFiles(
  droppedFiles: FileList | File[],
  options?: DuckDbVectorLoadOptions,
): Promise<LoadedVectorLayer[]> {
  const droppedFileArray = Array.from(droppedFiles);
  const files = droppedFileArray.filter((file) => isVectorFileName(file.name));
  if (!files.length) return [];

  const filesByBaseName = new Map<string, File[]>();
  for (const file of droppedFileArray) {
    const baseName = pathWithoutExtension(file.name).toLowerCase();
    filesByBaseName.set(baseName, [
      ...(filesByBaseName.get(baseName) ?? []),
      file,
    ]);
  }

  const layers: LoadedVectorLayer[] = [];
  for (const file of files) {
    const extension = fileExtension(file.name);
    if (SHAPEFILE_SIDECAR_EXTENSIONS.includes(extension)) continue;

    if (extension === "gpx") {
      layers.push(...parseGpxTextLayers(await file.text(), file.name));
      continue;
    }

    const siblingFiles =
      extension === "shp"
        ? await Promise.all(
            (
              filesByBaseName.get(
                pathWithoutExtension(file.name).toLowerCase(),
              ) ?? []
            )
              .filter((candidate) =>
                SHAPEFILE_SIDECAR_EXTENSIONS.includes(
                  fileExtension(candidate.name),
                ),
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
export function loadDroppedRasterFiles(
  droppedFiles: FileList | File[],
): DroppedRaster[] {
  return Array.from(droppedFiles)
    .filter((file) => isRasterFileName(file.name))
    .map((file) => ({ name: file.name, source: file }));
}

/**
 * Read dropped raster file paths (Tauri) into File objects the control can load.
 * There is no asset-protocol scope configured, so the bytes are read and wrapped
 * in a File, matching how local vector files are loaded.
 */
export async function loadDroppedRasterPaths(
  paths: string[],
): Promise<DroppedRaster[]> {
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

export async function loadDroppedVectorPaths(
  paths: string[],
  options?: DuckDbVectorLoadOptions,
): Promise<LoadedVectorLayer[]> {
  const vectorPaths = paths.filter(isVectorFileName);
  if (!vectorPaths.length) return [];

  const layers: LoadedVectorLayer[] = [];
  for (const path of vectorPaths) {
    const extension = fileExtension(path);
    if (SHAPEFILE_SIDECAR_EXTENSIONS.includes(extension)) continue;
    if (extension === "gpx") {
      try {
        layers.push(...parseGpxTextLayers(await readTextFile(path), path));
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Unknown error";
        throw new Error(`Could not read this GPX file. ${detail}`);
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
export async function readCsvHeaderColumns(
  source: File | string,
): Promise<string[]> {
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
