import type { GeoLibreLayer } from "@geolibre/core";
import { type Bbox4326, exportCogSubset } from "@geolibre/processing";

import { saveBinaryFileWithFallback } from "./tauri-io";
import { fetchableUrl } from "./url-utils";

/**
 * A fetchable URL for a raster layer's underlying GeoTIFF/COG bytes, or null.
 *
 * Prefers the retained local-bytes blob URL (File-loaded rasters and Whitebox
 * tool outputs carry one on `metadata.localBytesUrl`), then the layer's source
 * URL. Tile-template rasters have no single file to export, so they return null.
 *
 * @param layer - The raster store layer.
 * @returns A URL whose bytes are a single GeoTIFF/COG, or null.
 */
export function rasterExportUrl(layer: GeoLibreLayer): string | null {
  const src = layer.source as Record<string, unknown>;
  return fetchableUrl(layer.metadata.localBytesUrl) ?? fetchableUrl(src.url);
}

/**
 * Whether a raster layer can be exported to a single GeoTIFF file.
 *
 * @param layer - The layer to test.
 * @returns True for raster/COG layers backed by a downloadable file.
 */
export function canExportRasterLayer(layer: GeoLibreLayer): boolean {
  return (
    (layer.type === "cog" || layer.type === "raster") &&
    rasterExportUrl(layer) !== null
  );
}

/**
 * Save a raster layer's GeoTIFF/COG bytes to disk through the native (Tauri) or
 * browser save dialog. Whitebox already writes Cloud Optimized GeoTIFFs, so the
 * bytes are saved as-is.
 *
 * @param layer - The raster store layer to export.
 * @param baseName - A sanitized base file name (without extension).
 * @returns The saved path, or null if the user cancelled the save dialog.
 * @throws If the raster has no downloadable source or its bytes cannot be read.
 */
export async function exportRasterLayer(
  layer: GeoLibreLayer,
  baseName: string,
): Promise<string | null> {
  const url = rasterExportUrl(layer);
  if (!url) {
    throw new Error("This raster has no downloadable source file.");
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error("Could not read the raster's data for export.");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  return saveBinaryFileWithFallback(bytes, {
    defaultName: `${baseName}.tif`,
    filters: [{ name: "GeoTIFF", extensions: ["tif", "tiff"] }],
    browserTypes: [
      { description: "GeoTIFF", accept: { "image/tiff": [".tif", ".tiff"] } },
    ],
    mimeType: "image/tiff",
  });
}

/**
 * Clip a raster layer to a drawn map extent and save the subset to disk. Unlike
 * {@link exportRasterLayer} (which downloads the whole source file), this reads
 * only the pixels inside `bbox`, so a small area of a large cloud-hosted COG is
 * cheap. The output preserves the source's raw data values (opengeos/GeoLibre#1155).
 *
 * A remote COG is opened by URL so the windowed read fetches just the tiles it
 * needs via HTTP range requests; a local/blob-backed raster is fetched into
 * memory first (blob URLs do not support range requests).
 *
 * @param layer - The raster/COG store layer to subset.
 * @param bbox - The export extent `[west, south, east, north]` in EPSG:4326.
 * @param baseName - A sanitized base file name (without extension).
 * @returns The saved path, or null if the user cancelled the save dialog.
 * @throws If the raster has no downloadable source or the extent does not overlap it.
 */
export async function exportRasterSubset(
  layer: GeoLibreLayer,
  bbox: Bbox4326,
  baseName: string,
): Promise<string | null> {
  const url = rasterExportUrl(layer);
  if (!url) {
    throw new Error("This raster has no downloadable source file.");
  }
  // Remote COGs read efficiently by URL (range requests); blob/local URLs must
  // be pulled into memory since they do not honour range requests.
  let source: string | ArrayBuffer = url;
  if (!/^https?:/i.test(url)) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error("Could not read the raster's data for export.");
    }
    source = await response.arrayBuffer();
  }
  const { bytes } = await exportCogSubset(source, bbox);
  return saveBinaryFileWithFallback(new Uint8Array(bytes), {
    defaultName: `${baseName}_subset.tif`,
    filters: [{ name: "GeoTIFF", extensions: ["tif", "tiff"] }],
    browserTypes: [
      { description: "GeoTIFF", accept: { "image/tiff": [".tif", ".tiff"] } },
    ],
    mimeType: "image/tiff",
  });
}
