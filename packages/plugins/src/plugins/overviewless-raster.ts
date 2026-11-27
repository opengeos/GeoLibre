/**
 * Detection for a tiled GeoTIFF that has no overviews and is too large to draw
 * zoomed out.
 *
 * The WASM tiler (`cog-tiler-wasm`) reads a raster from the overview closest to
 * the view's resolution. Without overviews it can only read full resolution,
 * and it refuses any read over {@link TILER_WINDOW_SAMPLES} source samples so
 * a zoomed-out view cannot allocate gigabytes. Such a raster loads without an
 * error but stays blank until the user zooms far in, with the only explanation
 * in the browser console. This module spots the case so the app can say so.
 *
 * Split out of `maplibre-raster.ts` so it can be imported (and tested) without
 * pulling in `maplibre-gl` and the raster control's DOM setup.
 */

/**
 * The tiler's read ceiling in source samples (pixels x bands read). Mirrors
 * `MAX_WINDOW_SAMPLES` in cog-tiler-wasm (`1 << 24`), which it does not export;
 * re-verify when bumping that package.
 */
export const TILER_WINDOW_SAMPLES = 1 << 24;

/** The structure of a GeoTIFF that decides whether it draws zoomed out. */
export interface RasterPyramidShape {
  /** Full-resolution width in pixels. */
  width: number;
  /** Full-resolution height in pixels. */
  height: number;
  /** Samples per pixel. */
  bands: number;
  /** Whether the full-resolution image is internally tiled. */
  tiled: boolean;
  /** Whether any reduced-resolution image (an overview) follows it. */
  hasOverviews: boolean;
}

/**
 * Whether a raster is tiled, has no overviews, and is too large for the tiler
 * to draw at its full extent.
 *
 * The tiler reads three bands for an RGB composite (three or more bands) and
 * one otherwise, so that is the band count its ceiling applies to. A striped
 * (untiled) file is excluded: it fails to load outright and has its own
 * convert-to-COG flow (`setNonTiledRasterHandler`).
 *
 * @param shape - The raster's structure.
 * @returns True when the raster stays blank until zoomed well in.
 */
export function needsOverviewsToDrawZoomedOut(shape: RasterPyramidShape): boolean {
  if (!shape.tiled || shape.hasOverviews) return false;
  const bandsRead = shape.bands >= 3 ? 3 : 1;
  return shape.width * shape.height * bandsRead > TILER_WINDOW_SAMPLES;
}

/** The slice of a geotiff.js image this module reads. */
interface PyramidImage {
  getWidth(): number;
  getHeight(): number;
  getSamplesPerPixel(): number;
  isTiled: boolean;
}

/** The slice of a geotiff.js `GeoTIFF` this module reads. */
interface PyramidTiff {
  getImage(index: number): Promise<PyramidImage>;
}

/** Most directories to look through for an overview before giving up. */
const MAX_DIRECTORIES = 64;

/**
 * Read a GeoTIFF's pyramid structure, stopping as soon as the answer is known.
 *
 * The full-resolution image decides most files on its own: a striped one, or
 * one small enough for the tiler, needs no notice, so no further directory is
 * read. Otherwise the later directories are walked one at a time until an
 * overview turns up (usually the very next one). `getImageCount()` is avoided
 * because it reads every directory in the file before returning. Any later
 * image narrower than the first counts as an overview; a GDAL internal mask
 * has the full size, so it does not.
 *
 * @param tiff - An opened geotiff.js GeoTIFF (only its headers are read).
 * @returns The raster's structure. `hasOverviews` is only meaningful when the
 *   first image alone does not rule the raster out (see
 *   {@link needsOverviewsToDrawZoomedOut}); it is reported `false` unchecked.
 */
export async function readRasterPyramidShape(tiff: PyramidTiff): Promise<RasterPyramidShape> {
  const first = await tiff.getImage(0);
  const shape: RasterPyramidShape = {
    width: first.getWidth(),
    height: first.getHeight(),
    bands: first.getSamplesPerPixel(),
    tiled: first.isTiled,
    hasOverviews: false,
  };
  if (!needsOverviewsToDrawZoomedOut(shape)) return shape;
  for (let i = 1; i < MAX_DIRECTORIES; i++) {
    let image: PyramidImage;
    try {
      image = await tiff.getImage(i);
    } catch {
      break; // past the last directory
    }
    if (image.getWidth() < shape.width) {
      shape.hasOverviews = true;
      break;
    }
  }
  return shape;
}
