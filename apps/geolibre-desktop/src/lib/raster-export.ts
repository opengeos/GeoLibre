import type { GeoLibreLayer } from "@geolibre/core";

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
  return (layer.type === "cog" || layer.type === "raster") && rasterExportUrl(layer) !== null;
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
    browserTypes: [{ description: "GeoTIFF", accept: { "image/tiff": [".tif", ".tiff"] } }],
    mimeType: "image/tiff",
  });
}
