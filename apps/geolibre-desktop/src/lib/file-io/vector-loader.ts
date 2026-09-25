/**
 * Vector file loading entry points: the desktop and browser open paths,
 * drag-and-drop batches, the Add Vector Layer picker, and the native
 * duckdb-rs fast path. Dispatches to the format readers by extension.
 */

import { hasPathTraversal } from "@geolibre/core";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile, readTextFile } from "@tauri-apps/plugin-fs";
import type { FeatureCollection } from "geojson";
import i18next from "i18next";
import { IS_MAS_BUILD } from "../build-flags";
import {
  confirmLargeDataset,
  shouldRouteToDuckDb,
  type DuckDbVectorLoadOptions,
  type LargeVectorDataset,
} from "../duckdb-vector-guard";
import type { DuckDbVectorFile } from "../duckdb-vector-loader";
import type { FileDialogFilter } from "../file-dialog-filters";
import { isTauri } from "../is-tauri";
import { parseKmlText } from "../kml";
import { SHAPEFILE_COMPANION_EXTENSIONS, shapefileCompanionPathsFromSelection } from "../mas-build";
import {
  groundOverlaysFromKml,
  loadKmzLayers,
  modelsFromKml,
  parseKmz,
  splitKmlFolderLayers,
} from "./kml-kmz";
import {
  unregisterLoadedKmlSuperOverlays,
  type LoadedLayer,
  type LoadedVectorLayer,
} from "./loaded-layer";
import { localFileSizeBytes, readLocalFileBytes, readLocalFileText } from "./local-fs";
import {
  browserSafeFileName,
  fileExtension,
  isAbsoluteLocalPath,
  isVectorFileName,
  pathWithoutExtension,
  SHAPEFILE_SIDECAR_EXTENSIONS,
  VECTOR_FILE_DIALOG_EXTENSIONS,
} from "./paths";
import { loadShapefileZip } from "./shapefile-zip";
import { toArrayBuffer } from "./shared";
import {
  isDelimitedTextFileName,
  parseDelimitedTextFile,
  parseGeoJsonText,
  parseGpxText,
  parseGpxTextLayers,
  parsePolylineFileLayers,
  readDelimitedTextSource,
} from "./vector-text-formats";
import { assertFeatureCollection, isVectorLoadCancelled, loadDuckDbVector } from "./vector-shared";

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
      `[GeoLibre] "${file.name}" is ${Math.round(
        file.size / (1024 * 1024),
      )} MB; streaming it through DuckDB instead of the in-memory reader.`,
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
      `[GeoLibre] "${browserSafeFileName(path)}" is ${Math.round(
        (sizeBytes ?? 0) / (1024 * 1024),
      )} MB; streaming it through DuckDB instead of the in-memory reader.`,
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
          if (vector.data.features.length > 0) {
            layers.push(...splitKmlFolderLayers(vector.data, vector.path));
          }
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
          if (vector.data.features.length > 0) {
            layers.push(...splitKmlFolderLayers(vector.data, vector.path));
          }
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
