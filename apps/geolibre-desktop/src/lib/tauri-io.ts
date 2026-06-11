import { parseProject, type GeoLibreProject } from "@geolibre/core";
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
import shp from "shpjs";
import { parseDelimitedTextFields } from "./delimited-text";
import type { DuckDbVectorFile } from "./duckdb-vector-loader";
import { parseGpxLayer } from "./gpx";
import { isTauri } from "./is-tauri";

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
): Promise<FeatureCollection> {
  const kmlFiles = await readKmzKmlFiles(data);
  const collections = await Promise.all(kmlFiles.map(loadDuckDbVector));
  return mergeFeatureCollections(collections);
}

async function loadDuckDbVector(file: DuckDbVectorFile) {
  const { loadDuckDbVectorFile } = await import("./duckdb-vector-loader");
  return loadDuckDbVectorFile(file);
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
      data: await parseKmz(await file.arrayBuffer()),
      path: file.name,
    };
  }

  if (extension === "gpx") {
    return {
      data: parseGpxText(await file.text()),
      path: file.name,
    };
  }

  return {
    data: await loadDuckDbVector({
      name: file.name,
      extension,
      data: new Uint8Array(await file.arrayBuffer()),
      siblingFiles,
    }),
    path: file.name,
  };
}

async function openVectorFileBrowser(): Promise<{
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

        resolve(await loadBrowserVectorFile(file));
      } catch (error) {
        reject(error);
      }
    };
    input.click();
  });
}

async function openVectorFileTauri(): Promise<{
  data: FeatureCollection;
  path: string;
} | null> {
  const selected = await open({
    multiple: false,
  });
  if (!selected || typeof selected !== "string") return null;
  return loadTauriVectorFile(selected);
}

async function loadTauriVectorFile(path: string): Promise<{
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
        data: await parseKmz(await readFile(path)),
        path,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown error";
      throw new Error(`Could not read this KMZ file. ${detail}`);
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

  try {
    const siblingFiles =
      extension === "shp" ? await readShapefileSiblings(path) : [];
    return {
      data: await loadDuckDbVector({
        name: browserSafeFileName(path),
        extension,
        data: await readFile(path),
        siblingFiles,
      }),
      path,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown error";
    throw new Error(
      `Could not convert this vector file with DuckDB-WASM. ${detail}`,
    );
  }
}

async function readShapefileSiblings(
  path: string,
): Promise<DuckDbVectorFile[]> {
  const basePath = pathWithoutExtension(path);
  const siblings = await Promise.all(
    SHAPEFILE_SIDECAR_EXTENSIONS.map(async (extension) => {
      const siblingPath = `${basePath}.${extension}`;
      try {
        return {
          name: browserSafeFileName(siblingPath),
          extension,
          data: await readFile(siblingPath),
        };
      } catch {
        return null;
      }
    }),
  );

  return siblings.filter(
    (sibling): sibling is DuckDbVectorFile => sibling !== null,
  );
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

export async function openVectorFileWithFallback(): Promise<{
  data: FeatureCollection;
  path: string;
} | null> {
  if (isTauri()) return openVectorFileTauri();
  return openVectorFileBrowser();
}

export async function loadDroppedVectorFiles(
  droppedFiles: FileList | File[],
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
    layers.push(await loadBrowserVectorFile(file, siblingFiles));
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
    layers.push(await loadTauriVectorFile(path));
  }

  return layers;
}

/** Split a CSV/TSV header line into trimmed column names. */
export function parseCsvHeaderLine(line: string): string[] {
  const header = line.replace(/^﻿/, "").replace(/[\r\n]+$/, "");
  if (!header) return [];
  // Reuse the project's quote-aware delimited-text parser for each candidate
  // delimiter (comma, tab, semicolon) and keep the one that yields the most
  // columns. Quoting is respected, so a quoted field containing the delimiter
  // (e.g. "city,state") neither skews detection nor splits the header.
  let best: string[] = [];
  for (const delimiter of [",", "\t", ";"]) {
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
