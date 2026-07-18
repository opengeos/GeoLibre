import type { GeoLibreLayer } from "@geolibre/core";
import { extractCogSubset, extractWmsSubset, extractXyzTileSubset } from "@geolibre/processing";

import { normalizeSubdomains, rasterSubsetKind, type RasterSubsetKind } from "./raster-subset-kind";
import { saveBinaryFileWithFallback } from "./tauri-io";
import { fetchableUrl } from "./url-utils";

// Classification helpers live in the dependency-light `raster-subset-kind`
// module (importable from Node tests); re-exported here so existing importers
// of this module keep working.
export {
  canExtractRasterSubset,
  normalizeSubdomains,
  rasterSubsetKind,
  type RasterSubsetKind,
} from "./raster-subset-kind";

/**
 * A user-confirmed extraction request. The bounding box is always in WGS84
 * (`EPSG:4326`) `[west, south, east, north]`, since the panel draws it on the
 * map in lng/lat.
 */
export interface RasterSubsetRequest {
  bbox: [number, number, number, number];
  /**
   * Optional output pixel size, in the output CRS's units (degrees for a
   * geographic `outputCrs`, meters/units for a projected one). Omitted keeps the
   * COG's native resolution and lets WMS/XYZ default their sizing.
   */
  resolution?: number;
  /** XYZ tile zoom level. Required for the `xyz` kind. */
  zoom?: number;
  /** Optional output EPSG code. Omitted keeps the box's CRS (WGS84). */
  outputCrs?: number;
  /** Optional output nodata value. */
  nodata?: number;
  /**
   * Extra extractor options merged over the derived ones (e.g. `level`, `width`,
   * `height`, `tileSize`, `format`, `version`, `styles`), for power users. Later
   * keys win, so this can override a derived value.
   */
  extra?: Record<string, unknown>;
  /**
   * Optional signal to cancel the extraction (its network requests). The panel
   * aborts this when it is closed so a stalled COG/WMS/XYZ request never leaves
   * the UI stuck on "Extracting...".
   */
  signal?: AbortSignal;
}

/**
 * Cap for reading a local (blob) COG fully into memory before extraction. Beyond
 * this we fail fast rather than risk an out-of-memory tab crash; a remote COG
 * URL (byte-range read) has no such limit.
 */
const MAX_LOCAL_COG_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Resolve a COG layer to a source the WASM extractor can read. The retained
 * local-bytes blob (File-loaded rasters and Whitebox outputs) takes priority so
 * an edited layer extracts from its current bytes, matching `rasterExportUrl`'s
 * precedence; it is fetched in full because range requests aren't reliably
 * served for blob URLs. Otherwise a plain HTTP(S) source is passed through so
 * the extractor can byte-range only the tiles it needs.
 */
async function resolveCogSource(
  layer: GeoLibreLayer,
  signal?: AbortSignal,
): Promise<string | Uint8Array> {
  const source = layer.source as Record<string, unknown>;
  const localUrl = fetchableUrl(layer.metadata.localBytesUrl);
  const httpUrl = fetchableUrl(source.url);
  // Only the plain HTTP(S) path (no retained local bytes) uses byte-range reads.
  if (!localUrl && httpUrl && /^https?:/i.test(httpUrl)) return httpUrl;
  const url = localUrl ?? httpUrl;
  if (!url) {
    throw new Error("This raster has no readable source file.");
  }
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error("Could not read the raster's data for extraction.");
  }
  // The local/blob path reads the whole file into memory (no range requests), so
  // guard against loading a multi-GB raster that would spike memory or crash the
  // tab. The byte-range HTTP path above never reaches here, so remote COGs of any
  // size are unaffected.
  const tooLarge = (bytes: number) =>
    new Error(
      `This raster is too large (${Math.round(bytes / 1e6)} MB) to extract a subset from in the browser. Load it as an HTTP/COG URL so only the requested area is read.`,
    );
  // Fail fast on a declared size, when present, so the message carries the size.
  const declaredBytes = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredBytes) && declaredBytes > MAX_LOCAL_COG_BYTES) {
    throw tooLarge(declaredBytes);
  }
  // Otherwise stream and count, so the cap still holds when Content-Length is
  // absent (e.g. a chunked response); abort as soon as the cap is exceeded
  // instead of buffering the whole file first.
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(await response.arrayBuffer());
  const chunks: Uint8Array[] = [];
  let total = 0;
  let result = await reader.read();
  while (!result.done) {
    total += result.value.byteLength;
    if (total > MAX_LOCAL_COG_BYTES) {
      await reader.cancel();
      throw tooLarge(total);
    }
    chunks.push(result.value);
    result = await reader.read();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** WGS84 bounding box EPSG code; the panel always draws/edits in lng/lat. */
export const WGS84 = 4326;

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
  const { bbox, resolution, outputCrs, nodata, extra, signal } = request;
  // Forwarded to each extractor's internal fetches (COG byte-range reads, the
  // WMS GetMap request, XYZ tile requests) so the caller can cancel them.
  const fetchOptions = signal ? { signal } : undefined;
  // Options every extractor accepts. `extra` is spread first so a power-user
  // option without a dedicated field (e.g. level/width/height) is honored, but
  // the validated fields are applied after it so `extra` can't bypass their
  // range checks (resolution/outputCrs/nodata) or corrupt the extent (bbox is
  // always the panel's lng/lat box; bboxCrs stays WGS84).
  const common = {
    ...extra,
    resolution,
    outputCrs,
    nodata,
    bbox,
    bboxCrs: WGS84,
  };

  if (kind === "cog") {
    const cogSource = await resolveCogSource(layer, signal);
    return extractCogSubset(cogSource, { ...common, fetchOptions });
  }
  if (kind === "wms") {
    return extractWmsSubset(String(source.url), {
      layers: String(source.layers ?? ""),
      styles: typeof source.styles === "string" ? source.styles : undefined,
      ...common,
      // Request the subset as WMS 1.1.1 regardless of the layer's display
      // version: 1.1.1 uses SRS=EPSG:4326 with lon/lat BBOX order, matching the
      // `[west, south, east, north]` box sent here. WMS 1.3.0 flips EPSG:4326 to
      // lat/lon axis order, which the extractor does not compensate for, so a
      // 1.3.0 request would return shifted/empty imagery.
      version: "1.1.1",
      // The stored WMS format is for display (often PNG); the extractor needs a
      // GeoTIFF response, so always request one regardless of the display format
      // or any user-supplied `format` in `extra` (applied after the spread so it
      // can't be overridden into a non-GeoTIFF request).
      format: "image/geotiff",
      fetchOptions,
    });
  }
  if (kind === "xyz") {
    const tiles = source.tiles as string[];
    return extractXyzTileSubset(tiles[0], {
      tileSize: typeof source.tileSize === "number" ? source.tileSize : undefined,
      // The extractor rotates `{s}` by indexing into `subdomains` per tile, so a
      // string of letters ("abc") works directly. Some sources instead store the
      // MapLibre/Leaflet-style `string[]` (see offline-tiles.ts); join it into
      // the same per-letter string form so subdomain rotation isn't dropped.
      subdomains: normalizeSubdomains(source.subdomains),
      ...common,
      // Applied after `...common` so the panel's validated (0-30) zoom wins over
      // any `zoom` in the additional options.
      zoom: request.zoom ?? 0,
      fetchOptions,
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
    browserTypes: [{ description: "GeoTIFF", accept: { "image/tiff": [".tif", ".tiff"] } }],
    mimeType: "image/tiff",
  });
}
