// Client-side raster subset extraction backed by geolibre-wasm's Rust tools
// (`extract_cog_subset` / `extract_wms_subset` / `extract_xyz_tile_subset`),
// compiled to WebAssembly. Each returns a Cloud Optimized GeoTIFF (Uint8Array)
// for the requested bounding box, fetched directly in the browser (byte-range
// reads for a COG, a WMS GetMap request, or an XYZ tile mosaic) - no Python
// sidecar required. These are thin, lazily-loaded wrappers so the ~5 MB WASI
// runtime only downloads the first time a subset is extracted.
import type {
  ExtractCogSubsetOptions,
  ExtractWmsSubsetOptions,
  ExtractXyzTileSubsetOptions,
} from "geolibre-wasm/tools";

export type { ExtractCogSubsetOptions, ExtractWmsSubsetOptions, ExtractXyzTileSubsetOptions };

/** The subset of `geolibre-wasm/tools` used by the raster-subset extractors. */
interface SubsetModule {
  extractCogSubset: (
    source: string | Uint8Array | ArrayBuffer,
    opts: ExtractCogSubsetOptions,
  ) => Promise<Uint8Array>;
  extractWmsSubset: (url: string, opts: ExtractWmsSubsetOptions) => Promise<Uint8Array>;
  extractXyzTileSubset: (url: string, opts: ExtractXyzTileSubsetOptions) => Promise<Uint8Array>;
}

let subsetModulePromise: Promise<SubsetModule> | null = null;

/**
 * Lazily import the WASI tool runner once. Mirrors {@link loadToolsModule} in
 * wasm-client.ts: the memoized promise is reset on failure so a transient error
 * (e.g. a network blip during the chunk download) retries on the next call
 * instead of staying permanently rejected for the session.
 */
function loadSubsetModule(): Promise<SubsetModule> {
  subsetModulePromise ??= (import("geolibre-wasm/tools") as unknown as Promise<SubsetModule>).catch(
    (error) => {
      subsetModulePromise = null;
      throw error;
    },
  );
  return subsetModulePromise;
}

/**
 * Extract a bounding-box subset from a local or HTTP Cloud Optimized GeoTIFF.
 * HTTP sources are read with byte-range requests, so only the overview and tiles
 * covering the box are fetched.
 *
 * @param source - The COG URL, or its raw bytes.
 * @param opts - Bounding box, CRS, and optional resolution/output CRS/nodata.
 * @returns The subset as Cloud Optimized GeoTIFF bytes.
 */
export async function extractCogSubset(
  source: string | Uint8Array | ArrayBuffer,
  opts: ExtractCogSubsetOptions,
): Promise<Uint8Array> {
  const module = await loadSubsetModule();
  return module.extractCogSubset(source, opts);
}

/**
 * Request a bounding-box subset from a WMS GetMap endpoint and return it as a
 * Cloud Optimized GeoTIFF. The endpoint must be able to serve a GeoTIFF format
 * (`opts.format` defaults to `image/geotiff`).
 *
 * @param url - The WMS service (GetMap) endpoint.
 * @param opts - Layer name(s), bounding box, CRS, and optional sizing.
 * @returns The subset as Cloud Optimized GeoTIFF bytes.
 */
export async function extractWmsSubset(
  url: string,
  opts: ExtractWmsSubsetOptions,
): Promise<Uint8Array> {
  const module = await loadSubsetModule();
  return module.extractWmsSubset(url, opts);
}

/**
 * Fetch XYZ raster tiles covering a bounding box at a given zoom, mosaic them,
 * and return an RGB Cloud Optimized GeoTIFF.
 *
 * @param url - The XYZ tile URL template (`{z}`/`{x}`/`{y}`, optional `{s}`).
 * @param opts - Zoom, bounding box, CRS, and optional sizing/subdomains.
 * @returns The subset as Cloud Optimized GeoTIFF bytes.
 */
export async function extractXyzTileSubset(
  url: string,
  opts: ExtractXyzTileSubsetOptions,
): Promise<Uint8Array> {
  const module = await loadSubsetModule();
  return module.extractXyzTileSubset(url, opts);
}
