// In-browser GeoTIFF -> Cloud Optimized GeoTIFF conversion, backed by the
// `geolibre-wasm` wasm-bindgen module (GeoTiffReader + CogBuilder). This is the
// MAIN geolibre-wasm module, distinct from `geolibre-wasm/tools` used by
// wasm-client.ts (a separate WASI binary); the two load independent wasm files.
//
// The raster panel can only stream tiles from an internally tiled COG, so a
// plain striped GeoTIFF (the kind desktop GIS tools like QGIS export) fails to
// display. This module reads such a file fully into memory, re-encodes it as a
// tiled COG with overviews, and hands the bytes back so the caller can load the
// result instead. It runs entirely client-side, so it works in the browser
// build with no Python sidecar. See opengeos/GeoLibre#789.
import init, { CogBuilder, GeoTiffReader, geotiff_info } from "geolibre-wasm";

/** Header-only metadata for a GeoTIFF, parsed from {@link geotiff_info}. Cheap:
 * reads only the TIFF header, never the pixel data, so it is safe on large
 * files. */
export interface GeoTiffInfo {
  ok: boolean;
  width: number;
  height: number;
  bands: number;
  epsg?: number;
  nodata?: number;
  bits_per_sample: number;
  /** GDAL-style sample format: `"uint"`, `"int"`, or `"ieeefloat"`. */
  sample_format: string;
  compression: string;
  /** Whether the primary image is internally tiled (a COG requirement). */
  tiled: boolean;
  bigtiff: boolean;
}

/** Tile size (px) for the encoded COG. 512 matches the COGs GeoLibre's sample
 * data ships with and the upstream reader's expectations. */
const COG_TILE_SIZE = 512;

/**
 * Compressions {@link CogBuilder} can encode for *any* pixel type, and so the
 * set the browser build offers for Raster to COG.
 *
 * Deliberately narrower than the sidecar's rio-cogeo list: `zstd` and `raw` are
 * not implemented by CogBuilder at all, and `webp`/`jpeg`/`jpegxl` reject
 * anything but 8-bit samples ("Unsupported sample format"), which would fail on
 * the Int16/Float32 DEMs this tool is most often pointed at. Desktop keeps the
 * full rio-cogeo list via the sidecar.
 */
export const COG_WASM_COMPRESSIONS = ["deflate", "lzw", "packbits", "none"] as const;

export type CogWasmCompression = (typeof COG_WASM_COMPRESSIONS)[number];

export interface ConvertGeoTiffToCogOptions {
  /** Tile compression codec. Defaults to `"deflate"`. */
  compression?: CogWasmCompression;
}

let wasmReady: Promise<void> | null = null;

/**
 * Initialise the geolibre-wasm module exactly once. In the browser the
 * argument is omitted and wasm-bindgen fetches the bundled `.wasm` asset; tests
 * (or other non-bundler hosts) can pass the wasm bytes or a URL explicitly.
 *
 * @param moduleOrPath - Optional wasm bytes / URL / module for non-browser hosts.
 * @returns A promise that resolves once the module is ready.
 */
export function initCogWasm(moduleOrPath?: ArrayBuffer | Uint8Array | URL | string): Promise<void> {
  if (!wasmReady) {
    wasmReady = init(
      moduleOrPath === undefined ? undefined : { module_or_path: moduleOrPath },
    ).then(
      () => undefined,
      (error: unknown) => {
        // Do not cache a rejection: a transient failure (e.g. fetching the wasm
        // asset) would otherwise make every later conversion reject until the
        // page reloads. Mirrors getRasterControlClass in maplibre-raster.ts.
        wasmReady = null;
        throw error;
      },
    );
  }
  return wasmReady;
}

/**
 * Read header-only metadata from GeoTIFF bytes.
 *
 * @param bytes - The raw GeoTIFF file bytes.
 * @returns Parsed {@link GeoTiffInfo}.
 */
export async function readGeoTiffInfo(bytes: Uint8Array): Promise<GeoTiffInfo> {
  await initCogWasm();
  return JSON.parse(geotiff_info(bytes)) as GeoTiffInfo;
}

/**
 * Whether GeoTIFF bytes are already an internally tiled image (so the raster
 * panel can render them directly without conversion).
 *
 * @param bytes - The raw GeoTIFF file bytes.
 * @returns `true` if the primary image is tiled.
 */
export async function isTiledGeoTiff(bytes: Uint8Array): Promise<boolean> {
  return (await readGeoTiffInfo(bytes)).tiled;
}

/** Decimation factors for the overview pyramid, halving until the coarsest
 * level is no larger than ~a couple of tiles. Empty for small images that need
 * no overviews. */
function overviewLevels(width: number, height: number): Uint32Array {
  const levels: number[] = [];
  let factor = 2;
  while (Math.max(width, height) / factor > 256) {
    levels.push(factor);
    factor *= 2;
  }
  return Uint32Array.from(levels);
}

/**
 * Re-encode a GeoTIFF (typically a striped, non-tiled file) as a tiled Cloud
 * Optimized GeoTIFF with overviews, preserving georeferencing, the nodata
 * value, and band count. Reads the whole raster into memory, so the caller
 * should warn for very large inputs.
 *
 * The output pixel type is narrowed to what {@link CogBuilder} can encode: 8-bit
 * unsigned data stays `u8`; everything else (Int16 DEMs, Float32/64, etc.) is
 * written as Float32, which is exact for typical display data and keeps the
 * file small. Multi-band data is encoded pixel-interleaved, matching the reader.
 *
 * @param bytes - The raw source GeoTIFF bytes.
 * @param options - Optional encoder settings; see {@link ConvertGeoTiffToCogOptions}.
 * @returns The COG file bytes.
 */
export async function convertGeoTiffToCog(
  bytes: Uint8Array,
  options: ConvertGeoTiffToCogOptions = {},
): Promise<Uint8Array> {
  await initCogWasm();
  const reader = new GeoTiffReader(bytes);
  try {
    const info = JSON.parse(reader.info_json()) as GeoTiffInfo;
    if (!info.ok) throw new Error("Not a readable GeoTIFF.");
    const { width, height, bands } = reader;
    const builder = new CogBuilder(width, height, bands);
    try {
      const epsg = reader.epsg;
      if (typeof epsg === "number" && Number.isFinite(epsg)) {
        builder.set_epsg(epsg);
      }
      const geoTransform = reader.geo_transform();
      if (geoTransform.length >= 6) builder.set_geo_transform(geoTransform);
      const nodata = reader.nodata;
      if (typeof nodata === "number" && Number.isFinite(nodata)) {
        builder.set_nodata(nodata);
      }
      builder.set_tile_size(COG_TILE_SIZE);
      builder.set_compression(options.compression ?? "deflate");
      builder.set_overview_levels(overviewLevels(width, height));

      // read_all_f64 is the one reader that decodes any source dtype (Int16,
      // Float32, ...) to a common type; the typed per-band readers
      // (read_band_f32, ...) require the source to already be that type and
      // throw otherwise. So decode to f64 once, then narrow to the COG's pixel
      // type. The transient f64 + f32 copies are bounded by the caller's
      // large-raster warning. The data is pixel-interleaved (band0,band1,... per
      // pixel), matching what CogBuilder expects.
      const pixels = reader.read_all_f64();
      const isByte = info.sample_format === "uint" && info.bits_per_sample <= 8;
      return isByte
        ? builder.write_u8(Uint8Array.from(pixels))
        : builder.write_f32(Float32Array.from(pixels));
    } finally {
      builder.free();
    }
  } finally {
    reader.free();
  }
}
