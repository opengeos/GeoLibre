import type { GeoLibreLayer } from "@geolibre/core";
import {
  extractCogSubset,
  extractWmsSubset,
  extractXyzTileSubset,
} from "@geolibre/processing";

import { saveBinaryFileWithFallback } from "./tauri-io";
import { fetchableUrl } from "./url-utils";

/** Raster layer families that support in-browser bounding-box subset export. */
export type RasterSubsetKind = "cog" | "wms" | "xyz";

/**
 * A user-confirmed extraction request. The bounding box is always in WGS84
 * (`EPSG:4326`) `[west, south, east, north]`, since the panel draws it on the
 * map in lng/lat.
 */
export interface RasterSubsetRequest {
  bbox: [number, number, number, number];
  /**
   * Optional output pixel size in degrees (COG/WMS). Omitted keeps the COG's
   * native resolution, and lets WMS default to a ~1024 px request.
   */
  resolution?: number;
  /** XYZ tile zoom level. Required for the `xyz` kind. */
  zoom?: number;
}

/**
 * The subset-extraction family a layer belongs to, or `null` when the layer's
 * type or source can't be extracted. A COG needs a fetchable file (an HTTP COG
 * or a File-loaded one); a WMS needs its endpoint and layer names; an XYZ needs
 * a tile-URL template.
 *
 * @param layer - The store layer to classify.
 * @returns The subset kind, or `null` if the layer can't be subset-extracted.
 */
export function rasterSubsetKind(layer: GeoLibreLayer): RasterSubsetKind | null {
  const source = layer.source as Record<string, unknown>;
  if (layer.type === "cog") {
    const url =
      fetchableUrl(layer.metadata.localBytesUrl) ?? fetchableUrl(source.url);
    return url ? "cog" : null;
  }
  if (layer.type === "wms") {
    const url = typeof source.url === "string" ? source.url.trim() : "";
    const layers = typeof source.layers === "string" ? source.layers.trim() : "";
    return url && layers ? "wms" : null;
  }
  if (layer.type === "xyz") {
    const tiles = Array.isArray(source.tiles) ? source.tiles : [];
    const template = typeof tiles[0] === "string" ? tiles[0] : "";
    return template ? "xyz" : null;
  }
  return null;
}

/** Whether a layer can be exported as a bounding-box raster subset. */
export function canExtractRasterSubset(layer: GeoLibreLayer): boolean {
  return rasterSubsetKind(layer) !== null;
}

/**
 * Resolve a COG layer to a source the WASM extractor can read. An HTTP(S) URL is
 * passed through so the extractor can byte-range only the tiles it needs; a
 * local (blob) source is fetched in full first, because range requests aren't
 * reliably served for blob URLs.
 */
async function resolveCogSource(
  layer: GeoLibreLayer,
): Promise<string | Uint8Array> {
  const source = layer.source as Record<string, unknown>;
  const httpUrl = fetchableUrl(source.url);
  if (httpUrl && /^https?:/i.test(httpUrl)) return httpUrl;
  const localUrl = fetchableUrl(layer.metadata.localBytesUrl) ?? httpUrl;
  if (!localUrl) {
    throw new Error("This raster has no readable source file.");
  }
  const response = await fetch(localUrl);
  if (!response.ok) {
    throw new Error("Could not read the raster's data for extraction.");
  }
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Coerce a tile source's `subdomains` into the string of letters the WASM XYZ
 * extractor expects (it rotates `{s}` by indexing into the string per tile). A
 * plain string is passed through; a MapLibre/Leaflet-style `string[]` of single
 * letters (as offline-tiles.ts models it) is joined so the rotation is
 * preserved. Anything else yields `undefined` (no `{s}` rotation).
 *
 * @param value - The source's `subdomains` field, of unknown shape.
 * @returns The subdomain letters as a string, or `undefined`.
 */
function normalizeSubdomains(value: unknown): string | undefined {
  if (typeof value === "string") return value || undefined;
  if (Array.isArray(value)) {
    const joined = value.filter((v) => typeof v === "string").join("");
    return joined || undefined;
  }
  return undefined;
}

/** WGS84 bounding box EPSG code; the panel always draws/edits in lng/lat. */
const WGS84 = 4326;

/**
 * Extract a bounding-box subset of a raster layer as Cloud Optimized GeoTIFF
 * bytes, dispatching to the COG / WMS / XYZ WASM extractor for the layer's kind.
 *
 * @param layer - The COG, WMS, or XYZ store layer.
 * @param request - The confirmed bounding box and sizing options.
 * @returns The subset GeoTIFF bytes.
 * @throws If the layer type is unsupported or its source is unreadable.
 */
export async function extractRasterSubset(
  layer: GeoLibreLayer,
  request: RasterSubsetRequest,
): Promise<Uint8Array> {
  const kind = rasterSubsetKind(layer);
  const source = layer.source as Record<string, unknown>;
  const { bbox, resolution } = request;

  if (kind === "cog") {
    const cogSource = await resolveCogSource(layer);
    return extractCogSubset(cogSource, { bbox, bboxCrs: WGS84, resolution });
  }
  if (kind === "wms") {
    return extractWmsSubset(String(source.url), {
      layers: String(source.layers ?? ""),
      styles: typeof source.styles === "string" ? source.styles : undefined,
      bbox,
      bboxCrs: WGS84,
      resolution,
      // The stored WMS format is for display (often PNG); the extractor needs a
      // GeoTIFF response, so always request one regardless of the display format.
      format: "image/geotiff",
      version: typeof source.version === "string" ? source.version : undefined,
    });
  }
  if (kind === "xyz") {
    const tiles = source.tiles as string[];
    return extractXyzTileSubset(tiles[0], {
      zoom: request.zoom ?? 0,
      bbox,
      bboxCrs: WGS84,
      tileSize:
        typeof source.tileSize === "number" ? source.tileSize : undefined,
      // The extractor rotates `{s}` by indexing into `subdomains` per tile, so a
      // string of letters ("abc") works directly. Some sources instead store the
      // MapLibre/Leaflet-style `string[]` (see offline-tiles.ts); join it into
      // the same per-letter string form so subdomain rotation isn't dropped.
      subdomains: normalizeSubdomains(source.subdomains),
    });
  }
  throw new Error("This layer type does not support subset extraction.");
}

/**
 * Save extracted subset bytes to disk through the native (Tauri) or browser save
 * dialog.
 *
 * @param bytes - The subset GeoTIFF bytes.
 * @param baseName - A sanitized base file name (without extension).
 * @returns The saved path, or `null` if the user cancelled the save dialog.
 */
export async function saveRasterSubset(
  bytes: Uint8Array,
  baseName: string,
): Promise<string | null> {
  return saveBinaryFileWithFallback(bytes, {
    defaultName: `${baseName}_subset.tif`,
    filters: [{ name: "GeoTIFF", extensions: ["tif", "tiff"] }],
    browserTypes: [
      { description: "GeoTIFF", accept: { "image/tiff": [".tif", ".tiff"] } },
    ],
    mimeType: "image/tiff",
  });
}
