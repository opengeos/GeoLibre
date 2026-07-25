import { loadGeoTIFF, summarizeGeoTIFF, type MetadataSummary } from "maplibre-gl-raster";

/**
 * The `gdalinfo`-style facts about a raster that the store layer does not
 * carry: the native CRS, the pixel size and extent in that CRS, the pixel grid
 * dimensions, and the storage details (data type, compression, tiling,
 * overviews). The store's raster metadata only knows the WGS84 bounds and the
 * band count, so these are read back from the GeoTIFF header on demand (#1420).
 */
export type RasterInfo = {
  /** CRS label, e.g. `"EPSG:32643"` or `"User-defined: World_Mollweide"`. */
  crs: string;
  /** EPSG code when the file declares one; null for a user-defined CRS. */
  epsg: number | null;
  /** CRS citation from the geo keys, when the file carries one. */
  crsCitation?: string;
  /**
   * Pixel size `[x, y]` in CRS units (degrees for a geographic CRS), from
   * `ModelPixelScale`. Both values are positive magnitudes, so the y size is
   * unsigned here where `gdalinfo` prints it negative. Omitted when the file
   * has no pixel scale (e.g. it is georeferenced by tie points alone).
   */
  pixelSize?: [number, number];
  /** Extent `[minX, minY, maxX, maxY]` in CRS units. */
  extent?: [number, number, number, number];
  /** Pixel grid width (columns). */
  width: number;
  /** Pixel grid height (rows). */
  height: number;
  bandCount: number;
  /** Sample data type, e.g. `"uint8"` or `"float32"`. */
  dataType: string;
  /**
   * Dataset nodata value, or null when the file declares none. A NaN nodata
   * (common in float rasters) is reported as the string `"nan"`, since
   * `JSON.stringify` turns NaN into `null` and would read as "no nodata".
   */
  nodata: number | "nan" | null;
  /** Compression label, e.g. `"Deflate"` or `"none"`. */
  compression: string;
  /** Internal tile size `[width, height]`. */
  tileSize: [number, number];
  /** Number of overview (reduced-resolution) levels. */
  overviewCount: number;
};

/**
 * Derives the reported raster facts from an already-parsed GeoTIFF summary.
 * Pure, so it is unit-testable without a network fetch.
 *
 * @param summary - A `summarizeGeoTIFF` result.
 * @returns The raster facts shown in the layer metadata dialog.
 */
export function rasterInfoFromSummary(summary: MetadataSummary): RasterInfo {
  const { crs, image, overviews } = summary;
  const scale = crs.pixelScale;
  const pixelSize: [number, number] | null = scale
    ? [Math.abs(scale[0]), Math.abs(scale[1])]
    : null;
  const bbox = crs.bbox;
  const extent: [number, number, number, number] | null =
    Array.isArray(bbox) && bbox.length === 4 ? [bbox[0], bbox[1], bbox[2], bbox[3]] : null;
  return {
    crs: crs.label,
    epsg: crs.code,
    ...(crs.citation ? { crsCitation: crs.citation } : {}),
    ...(pixelSize ? { pixelSize } : {}),
    ...(extent ? { extent } : {}),
    width: image.width,
    height: image.height,
    bandCount: image.bandCount,
    dataType: image.dtype,
    nodata: typeof image.nodata === "number" && Number.isNaN(image.nodata) ? "nan" : image.nodata,
    compression: image.compression,
    tileSize: [image.tileWidth, image.tileHeight],
    overviewCount: overviews.length,
  };
}

/**
 * Reads a raster's CRS, pixel size, and storage details straight from its
 * GeoTIFF header. Only the header (and the COG's tag pages) is fetched, not the
 * pixel data, so this stays cheap for large remote rasters.
 *
 * @param url - A fetchable URL for the GeoTIFF/COG bytes (see `rasterExportUrl`).
 * @returns The raster facts for the layer metadata dialog.
 * @throws If the URL cannot be fetched or is not a readable GeoTIFF.
 */
export async function readRasterInfo(url: string): Promise<RasterInfo> {
  const tiff = await loadGeoTIFF(url);
  return rasterInfoFromSummary(summarizeGeoTIFF(tiff));
}
