/**
 * GeoTIFF/COG raster and geotagged-photo files: drag-and-drop, native
 * pickers, and reloading a raster a saved project references by path.
 */

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import i18next from "i18next";
import type { GeotaggedPhotoResult } from "../geotagged-photos";
import { PHOTO_IMAGE_EXTENSIONS, isPhotoDropFileName, isPhotoFileName } from "../geotagged-photos";
import { isDesktopRuntime } from "../is-mobile";
import { isTauri } from "../is-tauri";
import {
  browserSafeFileName,
  fileBaseName,
  isRasterFileName,
  RASTER_DROP_EXTENSIONS,
} from "./paths";
import { toArrayBuffer } from "./shared";

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
    // Desktop uses a native picker and one-shot reader, so selected photos do
    // not enter either persisted scope. Mobile keeps the plugin picker because
    // its selections can be content URIs.
    const desktop = isDesktopRuntime();
    const selected = desktop
      ? await invoke<string[]>("pick_image_paths")
      : await open({
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
        const bytes = desktop
          ? await invoke<ArrayBuffer>("read_selected_image", { path })
          : await readFile(path);
        files.push(new File([bytes], browserSafeFileName(path)));
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
  const { loadGeotaggedPhotos } = await import("../geotagged-photos");
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
  const { loadGeotaggedPhotos } = await import("../geotagged-photos");
  return loadGeotaggedPhotos(files);
}
