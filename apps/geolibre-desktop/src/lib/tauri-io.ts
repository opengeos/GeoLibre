import { parseProject, type GeoLibreProject } from "@geolibre/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readFile, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { unzip } from "fflate";
import type { FeatureCollection } from "geojson";
import shp from "shpjs";
import type { DuckDbVectorFile } from "./duckdb-vector-loader";

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function browserSafeFileName(path: string): string {
  return path.split(/[/\\]/).pop() || "project.geolibre.json";
}

interface FileDialogFilter {
  name: string;
  extensions: string[];
}

interface LocalDataFileOptions {
  filters: FileDialogFilter[];
  accept: string;
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

const SHAPEFILE_SIDECAR_EXTENSIONS = ["dbf", "shx", "prj", "cpg"];

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

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function isHttpUrl(path: string): boolean {
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

async function parseGeoJsonText(
  text: string,
): Promise<FeatureCollection> {
  return assertFeatureCollection(JSON.parse(text));
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
): Promise<{
  data: FeatureCollection;
  path: string;
}> {
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

export async function openLocalDataFileWithFallback(
  options: LocalDataFileOptions,
): Promise<{
  path: string;
  text?: string;
} | null> {
  if (isTauri()) {
    const selected = await open({
      multiple: false,
      filters: options.filters,
    });
    if (!selected || typeof selected !== "string") return null;
    const text = options.readText ? await readTextFile(selected) : undefined;
    return { path: selected, text };
  }

  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = options.accept;
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      const text = options.readText ? await file.text() : undefined;
      resolve({ path: file.name, text });
    };
    input.click();
  });
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
  return /no such file|os error 2|enoent|cannot find|does not exist|not found/i.test(
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

    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_PROJECT_URL_BYTES) {
      throw new Error(
        "Project file is too large to load (over 25 MB).",
      );
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
    text = await readTextFile(path);
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
): Promise<Array<{ data: FeatureCollection; path: string }>> {
  const droppedFileArray = Array.from(droppedFiles);
  const files = droppedFileArray.filter((file) =>
    isVectorFileName(file.name),
  );
  if (!files.length) return [];

  const filesByBaseName = new Map<string, File[]>();
  for (const file of droppedFileArray) {
    const baseName = pathWithoutExtension(file.name).toLowerCase();
    filesByBaseName.set(baseName, [
      ...(filesByBaseName.get(baseName) ?? []),
      file,
    ]);
  }

  const layers: Array<{ data: FeatureCollection; path: string }> = [];
  for (const file of files) {
    const extension = fileExtension(file.name);
    if (SHAPEFILE_SIDECAR_EXTENSIONS.includes(extension)) continue;

    const siblingFiles =
      extension === "shp"
        ? await Promise.all(
            (
              filesByBaseName.get(pathWithoutExtension(file.name).toLowerCase()) ??
              []
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

export async function loadDroppedVectorPaths(
  paths: string[],
): Promise<Array<{ data: FeatureCollection; path: string }>> {
  const vectorPaths = paths.filter(isVectorFileName);
  if (!vectorPaths.length) return [];

  const layers: Array<{ data: FeatureCollection; path: string }> = [];
  for (const path of vectorPaths) {
    if (SHAPEFILE_SIDECAR_EXTENSIONS.includes(fileExtension(path))) continue;
    layers.push(await loadTauriVectorFile(path));
  }

  return layers;
}
