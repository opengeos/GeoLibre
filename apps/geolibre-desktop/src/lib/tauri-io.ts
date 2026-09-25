/**
 * Local file I/O for the desktop (Tauri) and browser builds.
 *
 * The implementation lives in `./file-io/`, one module per concern; this file
 * re-exports the public surface so existing `./tauri-io` imports keep working.
 * New code can import from the focused module directly.
 *
 * - `file-io/paths` — file name and path predicates (pure)
 * - `file-io/local-fs` — direct local path reads/writes and directory listing
 * - `file-io/file-dialogs` — open/save pickers with browser fallbacks
 * - `file-io/project-files` — GeoLibre/QGIS/ArcGIS project open, save, reopen
 * - `file-io/loaded-layer` — vector-load result types and guards
 * - `file-io/vector-loader` — vector open/drop/pick entry points
 * - `file-io/vector-text-formats` — GeoJSON, GPX, polyline, CSV/TSV readers
 * - `file-io/shapefile-zip` — zipped shapefile reader
 * - `file-io/kml-kmz` — KML/KMZ placemarks, overlays, models, Super-Overlays
 * - `file-io/raster-photo-files` — GeoTIFF/COG rasters and geotagged photos
 */

import { isTauri } from "./is-tauri";

// Re-exported so existing `import { isTauri } from "./tauri-io"` consumers keep
// working; the implementation lives in the lightweight ./is-tauri module.
export { isTauri };

export type { FileDialogFilter } from "./file-dialog-filters";

export {
  isGeoLibreProjectFileName,
  isRestorableVectorPath,
  isLoadableFilePath,
  isRasterFileName,
  isHttpUrl,
  isAbsoluteLocalPath,
} from "./file-io/paths";
export {
  listDirectory,
  readLocalFileBytes,
  readLocalFileText,
  writeTextFileToPath,
  type LocalDirectoryEntry,
} from "./file-io/local-fs";
export {
  isLoadedImageOverlay,
  isLoadedKmlSuperOverlay,
  isLoadedModel,
  isLoadedVectorLayer,
  type LoadedVectorLayer,
  type LoadedImageOverlay,
  type LoadedKmlSuperOverlay,
  type LoadedModel,
  type LoadedLayer,
} from "./file-io/loaded-layer";
export {
  KML_PLACEMARK_LAYER_LIMIT,
  KML_TIME_FRAME_LAYER_LIMIT,
  splitKmlFolderLayers,
  sequenceTimeFrames,
  superOverlayDocNames,
} from "./file-io/kml-kmz";
export {
  shapefileShapeType,
  readShapefileZipForDuckDb,
  type UnzippedShapefile,
} from "./file-io/shapefile-zip";
export {
  pickVectorFilesWithSidecars,
  readVectorFileWithSidecars,
  loadDroppedVectorFiles,
  loadDroppedVectorPaths,
  type PickedVectorFile,
} from "./file-io/vector-loader";
export {
  browserSaveFallsBackToDownload,
  openLocalDataFileWithFallback,
  openLocalDataFilesWithFallback,
  pickLocalPathWithFallback,
  pickLocalPathsWithFallback,
  pickLocalDirectory,
  pickSavePathWithFallback,
  saveTextFileWithFallback,
  saveBinaryFileWithFallback,
} from "./file-io/file-dialogs";
export {
  openProjectFile,
  openQgisProjectFile,
  openArcgisProjectFile,
  RecentProjectGoneError,
  saveStartupProjectSnapshot,
  ensureStartupProjectSnapshot,
  openRecentProjectFile,
  saveProjectFile,
  saveProjectFileToPath,
} from "./file-io/project-files";
export {
  loadDroppedRasterFiles,
  loadDroppedRasterPaths,
  readRasterFileAtPath,
  pickLocalRasterFiles,
  pickImageFilesWithFallback,
  loadDroppedPhotoFiles,
  loadDroppedPhotoPaths,
  type DroppedRaster,
} from "./file-io/raster-photo-files";
export { parseCsvHeaderLine, readCsvHeaderColumns } from "./file-io/vector-text-formats";
