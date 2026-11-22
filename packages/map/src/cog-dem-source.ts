import { addProtocol, type RequestParameters } from "maplibre-gl";
import type { GeoTIFF, GeoTIFFImage, TypedArrayWithDimensions } from "geotiff";
import { resolveEpsgProjection } from "./epsg-proj4";

const PROTOCOL = "cog-dem";
const TILE_SIZE = 256;
/** Maximum source window dimension read when warping a projected DEM into a 256 px tile. */
const MAX_WARP_SOURCE_SIZE = 512;
/** Maximum native pixels allocated per single geotiff.js readRasters call (~16 MB for Float32). */
const MAX_NATIVE_WARP_PIXELS = 4_194_304;
/** Coarse warp-grid divisions per tile edge (16 cells = 17x17 proj4 evaluations per tile). */
const WARP_GRID_STEPS = 16;
const WEB_MERCATOR_HALF_WORLD = 20_037_508.342789244;
const MAX_MERCATOR_LATITUDE = 85.0511287798066;
// Halving each axis, 30 levels take the largest TIFF an offset can address down
// to a single pixel, so a real pyramid never reaches this. It bounds the
// getImage() fan-out for a file whose IFD chain claims far more.
const MAX_IFDS = 32;
/** TIFF NewSubfileType bit 0: the IFD is a reduced-resolution overview. */
const REDUCED_RESOLUTION_SUBFILE_TYPE = 0b001;
/** TIFF NewSubfileType bit 2: the IFD is a transparency mask, not imagery. */
const MASK_SUBFILE_TYPE = 0b100;

export type DemProjection = "EPSG:3857" | "EPSG:4326" | `EPSG:${number}`;

export type CoordinateTransform = (coord: [number, number]) => [number, number];

interface CogDemDataset {
  tiff: GeoTIFF;
  images: GeoTIFFImage[];
  sourceBounds: [number, number, number, number];
  /** Native CRS origin `[originX, originY]` of pixel (0, 0) from the base image. */
  origin: [number, number];
  /** True when the GeoTIFF declares `GTRasterTypeGeoKey === 2` (`RasterPixelIsPoint`). */
  pixelIsPoint: boolean;
  projection: DemProjection;
  /** Maps Web Mercator (EPSG:3857) coordinates to the DEM's native CRS when reprojecting. */
  mercatorToSource: CoordinateTransform | null;
  nodata: number | null;
  band: number;
  /** Tile reads still using the reader; see closeWhenIdle. */
  pendingReads: number;
  disposed: boolean;
  /** Fills pixels outside the DEM or on its nodata; see CogDemFallback. */
  fallback: CogDemFallback | null;
}

export interface ProjectedWindowAffine {
  /** World X of the outer edge of column 0 in the resampled source buffer. */
  originX: number;
  /** World Y of the outer edge of row 0 in the resampled source buffer. */
  originY: number;
  /** Signed world X step per column in the resampled source buffer (non-zero). */
  resX: number;
  /** Signed world Y step per row in the resampled source buffer (negative north-up, positive south-up). */
  resY: number;
}

/**
 * Elevations for one 256 x 256 XYZ tile from another terrain source, used to
 * fill what the COG does not cover. Row-major metres; NaN where it has none.
 * Resolves null when that source has nothing for the tile.
 */
export type CogDemFallback = (z: number, x: number, y: number) => Promise<ArrayLike<number> | null>;

/** Failure kinds the app layer can translate; see CogDemError. */
export type CogDemErrorCode = "empty-source" | "unsupported-band" | "unsupported-projection";

/**
 * A COG that could not be used as a terrain source, tagged with why. This
 * package is i18n-agnostic, so the message is English and the code is what the
 * app layer maps to a translated string.
 */
export class CogDemError extends Error {
  readonly code: CogDemErrorCode;

  constructor(code: CogDemErrorCode, message: string) {
    super(message);
    this.name = "CogDemError";
    this.code = code;
  }
}

export interface CogDemSourceRegistration {
  /** Tile template suitable for a MapLibre raster-dem source. */
  tiles: [string];
  /** Geographic extent reported by the COG, when it can be derived safely. */
  bounds?: [number, number, number, number];
  /** Render one terrain tile. Exposed for diagnostics and integration tests. */
  renderTile: (z: number, x: number, y: number) => Promise<Uint8ClampedArray>;
  /** Release the COG reader after this terrain source is replaced. */
  dispose: () => void;
  /**
   * Set or clear the source that fills pixels outside the DEM and on its
   * nodata. Takes effect for tiles rendered afterwards, so the caller re-adds
   * its terrain source to drop tiles already cached. Optional so a stand-in
   * registration (tests, other engines) need not implement it.
   */
  setFallback?: (fallback: CogDemFallback | null) => void;
}

const datasets = new Map<string, CogDemDataset>();
let datasetSequence = 0;
let protocolRegistered = false;

/**
 * Release a reader without letting a failed close surface as an unhandled
 * rejection. GeoTIFF.close() returns false for sources that need no closing.
 */
function closeQuietly(tiff: GeoTIFF): void {
  void Promise.resolve(tiff.close()).catch(() => undefined);
}

/**
 * Close a disposed dataset once its last tile read has finished. Switching the
 * terrain source mid-read would otherwise close the reader out from under an
 * in-flight readRasters and fail that tile.
 */
function closeWhenIdle(dataset: CogDemDataset): void {
  if (dataset.disposed && dataset.pendingReads === 0) closeQuietly(dataset.tiff);
}

/**
 * Fill a DEM tile's missing pixels (outside the COG, or its nodata) from a
 * fallback tile of the same size, in place. Pixels the fallback has no value
 * for stay missing. Exported for tests.
 *
 * @param elevations - The COG tile, row-major.
 * @param nodata - The COG's declared nodata, if any.
 * @param fallback - Elevations for the same pixels from another source.
 * @returns The same array, filled.
 */
export function fillMissingElevations(
  elevations: Float64Array,
  nodata: number | null,
  fallback: ArrayLike<number>,
): Float64Array {
  for (let index = 0; index < elevations.length; index += 1) {
    if (!isMissing(elevations[index], nodata)) continue;
    const value = Number(fallback[index]);
    if (Number.isFinite(value)) elevations[index] = value;
  }
  return elevations;
}

/** Whether any pixel of a tile is missing, so a fallback read is worth making. */
function hasMissing(elevations: ArrayLike<number>, nodata: number | null): boolean {
  for (let index = 0; index < elevations.length; index += 1) {
    if (isMissing(Number(elevations[index]), nodata)) return true;
  }
  return false;
}

/**
 * Render one tile's Terrarium RGBA: the COG's elevations, with the fallback
 * filling what the COG lacks when one is set. A failed fallback read leaves the
 * tile as the COG alone rather than failing it.
 */
async function renderDatasetTile(
  dataset: CogDemDataset,
  z: number,
  x: number,
  y: number,
): Promise<Uint8ClampedArray> {
  const elevations = Float64Array.from(await readTileHoldingReader(dataset, z, x, y));
  const fallback = dataset.fallback;
  if (!fallback || !hasMissing(elevations, dataset.nodata)) {
    return encodeTerrariumDem(elevations, dataset.nodata);
  }
  // The COG's nodata becomes NaN before the merge and the merged tile is
  // encoded without it: a fallback elevation that happens to equal the COG's
  // sentinel (255 m against nodata 255) is real ground, not a gap.
  for (let index = 0; index < elevations.length; index += 1) {
    if (isMissing(elevations[index], dataset.nodata)) elevations[index] = Number.NaN;
  }
  const filler = await fallback(z, x, y).catch(() => null);
  if (filler && filler.length === elevations.length) {
    fillMissingElevations(elevations, null, filler);
  }
  return encodeTerrariumDem(elevations, null);
}

/** Read one tile, holding the reader open for as long as the read needs it. */
async function readTileHoldingReader(
  dataset: CogDemDataset,
  z: number,
  x: number,
  y: number,
): Promise<ArrayLike<number>> {
  dataset.pendingReads += 1;
  try {
    return await readTile(dataset, z, x, y);
  } finally {
    dataset.pendingReads -= 1;
    closeWhenIdle(dataset);
  }
}

/**
 * Whether a NewSubfileType tag marks an IFD readTile may use as an overview.
 * getImageCount() counts every IFD, and a COG can also carry transparency masks
 * and further full-resolution images; either would be picked by the
 * resolution-based selection and read as elevations. COG requires an overview
 * to set the reduced-resolution bit, so that is the mark to look for.
 * Exported for tests.
 */
export function isDemOverviewIfd(subfileType: unknown): boolean {
  const flags = Number(subfileType ?? 0);
  if (!Number.isFinite(flags)) return false;
  return (flags & REDUCED_RESOLUTION_SUBFILE_TYPE) !== 0 && (flags & MASK_SUBFILE_TYPE) === 0;
}

/**
 * Read an eagerly parsed tag from a GeoTIFF file directory.
 *
 * geotiff.js 3 returns an `ImageFileDirectory` whose tags are reached through
 * `getValue`; indexing it like the plain record geotiff.js 2 returned yields
 * undefined for every tag, which silently dropped the declared nodata (so
 * -9999 drew as a pit) and every overview (so each tile read full resolution).
 * Both shapes are accepted so a plain record (tests, older readers) still works.
 * Synchronous on purpose, unlike the spectral profile's `loadValue` reader:
 * geotiff.js 3 parses both tags read here eagerly (its own `getGDALNoData`
 * reads `GDAL_NODATA` through `getValue` too), and the dataset is registered
 * synchronously after the IFD walk. Exported for tests.
 *
 * @param directory - The image's file directory.
 * @param name - The tag name, e.g. `GDAL_NODATA`.
 * @returns The tag's value, or undefined when absent or deferred.
 */
export function fileDirectoryValue(directory: unknown, name: string): unknown {
  if (!directory || typeof directory !== "object") return undefined;
  const reader = directory as { getValue?: unknown };
  if (typeof reader.getValue === "function") {
    try {
      return (reader.getValue as (tag: string) => unknown).call(directory, name);
    } catch {
      // A deferred tag needs an async load; neither tag read here is one.
      return undefined;
    }
  }
  return (directory as Record<string, unknown>)[name];
}

function isMissing(value: number, nodata: number | null): boolean {
  if (!Number.isFinite(value)) return true;
  if (nodata === null) return false;
  if (value === nodata) return true;
  // GDAL_NODATA is decimal text, so a float32 sentinel written with too few
  // digits parses to a float64 that never equals the upconverted float32
  // sample: "-3.4028235e+38" reads as -3.4028235e+38 while the pixel holds
  // -3.4028234663852886e+38. Comparing both at float32 makes those meet, and a
  // real elevation that collides is one no DEM carries.
  return Math.fround(value) === Math.fround(nodata);
}

/** Encode elevations in metres into Mapzen Terrarium RGB pixels. */
export function encodeTerrariumDem(
  elevations: ArrayLike<number>,
  nodata: number | null = null,
): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(elevations.length * 4);
  for (let index = 0; index < elevations.length; index += 1) {
    const elevation = Number(elevations[index]);
    const missing = isMissing(elevation, nodata);
    // MapLibre's raster-dem decoder has no missing-data representation. A flat
    // zero-metre pixel is the least surprising fill outside a partial DEM and
    // avoids the extreme spike that encoding NaN would otherwise produce.
    const encoded = Math.min(65_535.99609375, Math.max(0, (missing ? 0 : elevation) + 32_768));
    const red = Math.floor(encoded / 256);
    const greenBlue = encoded - red * 256;
    const offset = index * 4;
    rgba[offset] = red;
    rgba[offset + 1] = Math.floor(greenBlue);
    rgba[offset + 2] = Math.round((greenBlue - Math.floor(greenBlue)) * 256);
    rgba[offset + 3] = 255;
  }
  return rgba;
}

function mercatorTileBounds(z: number, x: number, y: number): [number, number, number, number] {
  const span = (WEB_MERCATOR_HALF_WORLD * 2) / 2 ** z;
  const minX = -WEB_MERCATOR_HALF_WORLD + x * span;
  const maxY = WEB_MERCATOR_HALF_WORLD - y * span;
  return [minX, maxY - span, minX + span, maxY];
}

function mercatorYToLatitude(y: number): number {
  return (Math.atan(Math.sinh(y / 6_378_137)) * 180) / Math.PI;
}

function longitudeFromMercatorX(x: number): number {
  return (x / WEB_MERCATOR_HALF_WORLD) * 180;
}

/**
 * Project a bounding box through a coordinate transform by sampling a 9x9 grid
 * across its edges and interior (captures curvature on UTM/conic projections).
 */
export function projectedBoundsFromTransform(
  bounds: readonly number[],
  transform: CoordinateTransform,
): [number, number, number, number] | null {
  const [minX, minY, maxX, maxY] = bounds;
  const steps = 8;
  let outMinX = Number.POSITIVE_INFINITY;
  let outMinY = Number.POSITIVE_INFINITY;
  let outMaxX = Number.NEGATIVE_INFINITY;
  let outMaxY = Number.NEGATIVE_INFINITY;
  for (let iy = 0; iy <= steps; iy += 1) {
    const y = minY + ((maxY - minY) * iy) / steps;
    for (let ix = 0; ix <= steps; ix += 1) {
      const x = minX + ((maxX - minX) * ix) / steps;
      try {
        const [px, py] = transform([x, y]);
        if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
        if (px < outMinX) outMinX = px;
        if (py < outMinY) outMinY = py;
        if (px > outMaxX) outMaxX = px;
        if (py > outMaxY) outMaxY = py;
      } catch {
        // Ignore individual corner singularities outside projection domain.
      }
    }
  }
  if (
    !Number.isFinite(outMinX) ||
    !Number.isFinite(outMinY) ||
    !Number.isFinite(outMaxX) ||
    !Number.isFinite(outMaxY)
  ) {
    return null;
  }
  return [outMinX, outMinY, outMaxX, outMaxY];
}

function geographicBounds(
  sourceBounds: number[],
  projection: DemProjection,
  toWgs84: CoordinateTransform | null,
): [number, number, number, number] {
  let bounds: number[];
  if (projection === "EPSG:3857") {
    bounds = [
      longitudeFromMercatorX(sourceBounds[0]),
      mercatorYToLatitude(sourceBounds[1]),
      longitudeFromMercatorX(sourceBounds[2]),
      mercatorYToLatitude(sourceBounds[3]),
    ];
  } else if (projection === "EPSG:4326") {
    bounds = sourceBounds;
  } else if (toWgs84) {
    const projected = projectedBoundsFromTransform(sourceBounds, toWgs84);
    if (!projected) {
      throw new CogDemError(
        "unsupported-projection",
        `Could not compute geographic bounds for ${projection} DEM.`,
      );
    }
    bounds = projected;
  } else {
    bounds = sourceBounds;
  }
  return [
    Math.max(-180, bounds[0]),
    Math.max(-MAX_MERCATOR_LATITUDE, bounds[1]),
    Math.min(180, bounds[2]),
    Math.min(MAX_MERCATOR_LATITUDE, bounds[3]),
  ];
}

/** Determine the DEM projection from GeoTIFF GeoKeys. Exported for tests. */
export function projectionFromGeoKeys(
  geoKeys: Record<string, unknown> | null,
): DemProjection | null {
  const projected = Number(geoKeys?.ProjectedCSTypeGeoKey);
  if (projected === 3857 || projected === 900913 || projected === 102100) return "EPSG:3857";
  // Standard projected EPSG CRS codes (UTM, national grids, state plane, etc.);
  // 32767 is GeoTIFF's "user-defined" sentinel which has no EPSG registry entry.
  if (Number.isInteger(projected) && projected > 0 && projected < 32767) {
    return `EPSG:${projected}`;
  }
  // User-defined projected CRS (32767) or GTModelTypeGeoKey === 1 without a
  // valid EPSG code must never fall through to GeographicTypeGeoKey === 4326.
  if ((Number.isFinite(projected) && projected > 0) || Number(geoKeys?.GTModelTypeGeoKey) === 1) {
    return null;
  }
  const geographic = Number(geoKeys?.GeographicTypeGeoKey);
  if (geographic === 4326) return "EPSG:4326";
  if (Number.isInteger(geographic) && geographic > 0 && geographic < 32767) {
    return `EPSG:${geographic}`;
  }
  return null;
}

/** Read the GDAL_NODATA tag as a number. Exported for tests. */
export function normalizeNoData(value: unknown): number | null {
  // GDAL writes GDAL_NODATA as a NUL-terminated ASCII field and geotiff.js
  // hands the NUL through, which Number() reads as NaN. parseFloat stops at the
  // terminator, so the sentinel survives and nodata pixels stay detectable.
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = typeof value === "string" ? parseFloat(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/** Round a tile-space edge to a whole pixel inside the 256 px tile. */
function clampTileEdge(value: number): number {
  return Math.max(0, Math.min(TILE_SIZE, Math.round(value)));
}

export interface DemTilePlacement {
  /** Pixel window to read from the image: [left, top, right, bottom]. */
  window: [number, number, number, number];
  /** Sub-rectangle of the 256 px tile those samples fill. */
  destLeft: number;
  destTop: number;
  destWidth: number;
  destHeight: number;
}

/**
 * Work out which image pixels a terrain tile needs and where they belong in it.
 * Both extents are in the DEM's own CRS. Returns null when the tile misses the
 * DEM entirely. Exported for tests: this is the pixel math a warped hillshade
 * would come from, and it fails silently rather than throwing.
 */
export function demTilePlacement(
  tileBounds: readonly number[],
  sourceBounds: readonly number[],
  imageWidth: number,
  imageHeight: number,
): DemTilePlacement | null {
  const [sourceMinX, sourceMinY, sourceMaxX, sourceMaxY] = sourceBounds;
  const clipped = [
    Math.max(sourceMinX, tileBounds[0]),
    Math.max(sourceMinY, tileBounds[1]),
    Math.min(sourceMaxX, tileBounds[2]),
    Math.min(sourceMaxY, tileBounds[3]),
  ];
  if (clipped[0] >= clipped[2] || clipped[1] >= clipped[3]) return null;
  // On a coarse overview a thin clipped extent can floor and ceil onto the same
  // pixel boundary, which would hand readRasters an empty window. Keep the
  // window at least one pixel wide and tall.
  const left = Math.min(
    imageWidth - 1,
    Math.max(0, Math.floor(((clipped[0] - sourceMinX) / (sourceMaxX - sourceMinX)) * imageWidth)),
  );
  const top = Math.min(
    imageHeight - 1,
    Math.max(0, Math.floor(((sourceMaxY - clipped[3]) / (sourceMaxY - sourceMinY)) * imageHeight)),
  );
  const window: [number, number, number, number] = [
    left,
    top,
    Math.min(
      imageWidth,
      Math.max(
        left + 1,
        Math.ceil(((clipped[2] - sourceMinX) / (sourceMaxX - sourceMinX)) * imageWidth),
      ),
    ),
    Math.min(
      imageHeight,
      Math.max(
        top + 1,
        Math.ceil(((sourceMaxY - clipped[1]) / (sourceMaxY - sourceMinY)) * imageHeight),
      ),
    ),
  ];
  // The window covers whole source pixels, so its own extent — not the extent
  // that was asked for — says where these samples belong in the tile. Resizing
  // the window straight to 256 x 256 would stretch a partial overlap across the
  // whole tile, so it is read at the size of the sub-rectangle it really
  // occupies and the rest of the tile is left as nodata.
  const pixelSpanX = (sourceMaxX - sourceMinX) / imageWidth;
  const pixelSpanY = (sourceMaxY - sourceMinY) / imageHeight;
  const tileColumn = (sourceX: number) =>
    clampTileEdge(((sourceX - tileBounds[0]) / (tileBounds[2] - tileBounds[0])) * TILE_SIZE);
  const tileRow = (sourceY: number) =>
    clampTileEdge(((tileBounds[3] - sourceY) / (tileBounds[3] - tileBounds[1])) * TILE_SIZE);
  const destLeft = tileColumn(sourceMinX + window[0] * pixelSpanX);
  const destTop = tileRow(sourceMaxY - window[1] * pixelSpanY);
  return {
    window,
    destLeft,
    destTop,
    destWidth: Math.max(1, tileColumn(sourceMinX + window[2] * pixelSpanX) - destLeft),
    destHeight: Math.max(1, tileRow(sourceMaxY - window[3] * pixelSpanY) - destTop),
  };
}

function remapGeographicRows(
  source: Float64Array,
  mercatorBounds: [number, number, number, number],
  nodata: number | null = null,
): Float64Array {
  const output = new Float64Array(TILE_SIZE * TILE_SIZE);
  const [, minY, , maxY] = mercatorBounds;
  const north = mercatorYToLatitude(maxY);
  const south = mercatorYToLatitude(minY);
  const latitudeSpan = north - south;
  for (let row = 0; row < TILE_SIZE; row += 1) {
    const mercatorY = maxY - ((row + 0.5) / TILE_SIZE) * (maxY - minY);
    const latitude = mercatorYToLatitude(mercatorY);
    // Both this row and the source rows are pixel centres, so the source index
    // is centre-to-centre: scale by TILE_SIZE and step back half a pixel.
    // Scaling by TILE_SIZE - 1 would mix a corner convention into a buffer
    // built with a centre one and shift the sample by up to half a row, worst
    // at the tile edges where the seam with the next tile shows.
    const sourceY = Math.max(
      0,
      Math.min(TILE_SIZE - 1, ((north - latitude) / latitudeSpan) * TILE_SIZE - 0.5),
    );
    const y0 = Math.floor(sourceY);
    const y1 = Math.min(TILE_SIZE - 1, y0 + 1);
    const fraction = sourceY - y0;
    for (let column = 0; column < TILE_SIZE; column += 1) {
      const a = source[y0 * TILE_SIZE + column];
      const b = source[y1 * TILE_SIZE + column];
      // Interpolating across a nodata sentinel (commonly -9999 or -3.4e38)
      // would produce a value near, but not equal to, the sentinel — slipping
      // past the equality check in encodeTerrariumDem and drawing a spike at
      // the DEM edge. Fall back to the nearer sample instead of blending.
      output[row * TILE_SIZE + column] =
        isMissing(a, nodata) || isMissing(b, nodata)
          ? fraction < 0.5
            ? a
            : b
          : a + (b - a) * fraction;
    }
  }
  return output;
}

/**
 * Warp a source DEM raster window (in an arbitrary projected or geographic CRS)
 * into a 256 x 256 Web Mercator elevation tile using nearest-neighbor sampling
 * (avoiding nodata bleed at DEM edges) over a bilinearly interpolated coarse
 * coordinate grid. Exported for tests.
 */
export function resampleProjectedTile(
  sourceValues: ArrayLike<number>,
  sourceWidth: number,
  sourceHeight: number,
  windowBounds: readonly [number, number, number, number],
  mercatorBounds: readonly [number, number, number, number],
  mercatorToSource: CoordinateTransform,
  affine?: ProjectedWindowAffine,
): Float64Array {
  const output = new Float64Array(TILE_SIZE * TILE_SIZE).fill(Number.NaN);
  const [winMinX, winMinY, winMaxX, winMaxY] = windowBounds;
  const winSpanX = winMaxX - winMinX;
  const winSpanY = winMaxY - winMinY;
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    return output;
  }
  const winOriginX = affine ? affine.originX : winMinX;
  const winOriginY = affine ? affine.originY : winMaxY;
  const winResX = affine ? affine.resX : winSpanX / sourceWidth;
  const winResY = affine ? affine.resY : -winSpanY / sourceHeight;
  if (!Number.isFinite(winResX) || !Number.isFinite(winResY) || winResX === 0 || winResY === 0) {
    return output;
  }
  const [mercMinX, mercMinY, mercMaxX, mercMaxY] = mercatorBounds;
  const mercSpanX = mercMaxX - mercMinX;
  const mercSpanY = mercMaxY - mercMinY;

  const gridStride = WARP_GRID_STEPS + 1;
  const gridX = new Float64Array(gridStride * gridStride);
  const gridY = new Float64Array(gridStride * gridStride);
  const cellPx = TILE_SIZE / WARP_GRID_STEPS;

  for (let gy = 0; gy <= WARP_GRID_STEPS; gy += 1) {
    const py = gy * cellPx;
    const my = mercMaxY - (py / TILE_SIZE) * mercSpanY;
    for (let gx = 0; gx <= WARP_GRID_STEPS; gx += 1) {
      const px = gx * cellPx;
      const mx = mercMinX + (px / TILE_SIZE) * mercSpanX;
      let sx = Number.NaN;
      let sy = Number.NaN;
      try {
        [sx, sy] = mercatorToSource([mx, my]);
      } catch {
        // Leave NaN so the cell falls back to direct projection per pixel.
      }
      gridX[gy * gridStride + gx] = sx;
      gridY[gy * gridStride + gx] = sy;
    }
  }

  for (let row = 0; row < TILE_SIZE; row += 1) {
    const gyF = (row + 0.5) / cellPx;
    const gy = Math.min(WARP_GRID_STEPS - 1, Math.floor(gyF));
    const ty = gyF - gy;
    const rowTop = gy * gridStride;
    const rowBot = (gy + 1) * gridStride;

    for (let col = 0; col < TILE_SIZE; col += 1) {
      const gxF = (col + 0.5) / cellPx;
      const gx = Math.min(WARP_GRID_STEPS - 1, Math.floor(gxF));
      const tx = gxF - gx;

      const x00 = gridX[rowTop + gx];
      const x10 = gridX[rowTop + gx + 1];
      const x01 = gridX[rowBot + gx];
      const x11 = gridX[rowBot + gx + 1];
      const y00 = gridY[rowTop + gx];
      const y10 = gridY[rowTop + gx + 1];
      const y01 = gridY[rowBot + gx];
      const y11 = gridY[rowBot + gx + 1];

      let sx: number;
      let sy: number;
      if (
        Number.isFinite(x00) &&
        Number.isFinite(x10) &&
        Number.isFinite(x01) &&
        Number.isFinite(x11) &&
        Number.isFinite(y00) &&
        Number.isFinite(y10) &&
        Number.isFinite(y01) &&
        Number.isFinite(y11)
      ) {
        const w00 = (1 - tx) * (1 - ty);
        const w10 = tx * (1 - ty);
        const w01 = (1 - tx) * ty;
        const w11 = tx * ty;
        sx = x00 * w00 + x10 * w10 + x01 * w01 + x11 * w11;
        sy = y00 * w00 + y10 * w10 + y01 * w01 + y11 * w11;
      } else {
        const mx = mercMinX + ((col + 0.5) / TILE_SIZE) * mercSpanX;
        const my = mercMaxY - ((row + 0.5) / TILE_SIZE) * mercSpanY;
        try {
          [sx, sy] = mercatorToSource([mx, my]);
        } catch {
          continue;
        }
      }

      const u = (sx - winOriginX) / winResX;
      const v = (sy - winOriginY) / winResY;
      if (u < 0 || u > sourceWidth || v < 0 || v > sourceHeight) continue;
      const srcCol = Math.min(sourceWidth - 1, Math.max(0, Math.floor(u)));
      const srcRow = Math.min(sourceHeight - 1, Math.max(0, Math.floor(v)));
      output[row * TILE_SIZE + col] = Number(sourceValues[srcRow * sourceWidth + srcCol]);
    }
  }
  return output;
}

async function readProjectedWindowBounded(
  image: GeoTIFFImage,
  window: [number, number, number, number],
  readWidth: number,
  readHeight: number,
  band: number,
): Promise<ArrayLike<number>> {
  const [left, top, right, bottom] = window;
  const winW = right - left;
  const winH = bottom - top;
  if (winW * winH <= MAX_NATIVE_WARP_PIXELS) {
    const rasters = await image.readRasters({
      window,
      width: readWidth,
      height: readHeight,
      samples: [band],
      interleave: true,
      resampleMethod: "nearest",
      fillValue: Number.NaN,
    });
    return rasters as TypedArrayWithDimensions;
  }

  // Fallback for huge un-pyramided GeoTIFFs: read in horizontal strips whose
  // native allocation stays within MAX_NATIVE_WARP_PIXELS.
  const combined = new Float64Array(readWidth * readHeight).fill(Number.NaN);
  const maxNativeRows = Math.max(1, Math.floor(MAX_NATIVE_WARP_PIXELS / Math.max(1, winW)));
  const destRowsPerStrip = Math.max(1, Math.floor((maxNativeRows / winH) * readHeight));
  for (let dstRow = 0; dstRow < readHeight; dstRow += destRowsPerStrip) {
    const stripOutRows = Math.min(destRowsPerStrip, readHeight - dstRow);
    const stripTop = top + Math.floor((dstRow / readHeight) * winH);
    const stripBottom = Math.min(
      bottom,
      Math.max(stripTop + 1, top + Math.ceil(((dstRow + stripOutRows) / readHeight) * winH)),
    );
    const strip = (await image.readRasters({
      window: [left, stripTop, right, stripBottom],
      width: readWidth,
      height: stripOutRows,
      samples: [band],
      interleave: true,
      resampleMethod: "nearest",
      fillValue: Number.NaN,
    })) as TypedArrayWithDimensions;
    const offset = dstRow * readWidth;
    for (let i = 0; i < strip.length && offset + i < combined.length; i += 1) {
      combined[offset + i] = Number(strip[i]);
    }
  }
  return combined;
}

async function readProjectedTile(
  dataset: CogDemDataset,
  bounds: [number, number, number, number],
  mercatorToSource: CoordinateTransform,
): Promise<ArrayLike<number>> {
  const sourceTileBounds = projectedBoundsFromTransform(bounds, mercatorToSource);
  if (!sourceTileBounds) return new Float64Array(TILE_SIZE * TILE_SIZE).fill(Number.NaN);

  const [srcMinX, srcMinY, srcMaxX, srcMaxY] = dataset.sourceBounds;
  const clipped: [number, number, number, number] = [
    Math.max(srcMinX, sourceTileBounds[0]),
    Math.max(srcMinY, sourceTileBounds[1]),
    Math.min(srcMaxX, sourceTileBounds[2]),
    Math.min(srcMaxY, sourceTileBounds[3]),
  ];
  if (clipped[0] >= clipped[2] || clipped[1] >= clipped[3]) {
    return new Float64Array(TILE_SIZE * TILE_SIZE).fill(Number.NaN);
  }

  const requestedResolution = Math.max(
    Math.abs(sourceTileBounds[2] - sourceTileBounds[0]) / TILE_SIZE,
    Math.abs(sourceTileBounds[3] - sourceTileBounds[1]) / TILE_SIZE,
  );
  let imageIndex = 0;
  for (let i = 0; i < dataset.images.length; i += 1) {
    const resolution = dataset.images[i].getResolution(dataset.images[0]);
    if (Math.max(Math.abs(resolution[0]), Math.abs(resolution[1])) <= requestedResolution) {
      imageIndex = i;
    } else {
      break;
    }
  }

  const [originX, originY] = dataset.origin;
  const pointShift = dataset.pixelIsPoint ? 0.5 : 0;
  const computeWindowForImage = (candidate: GeoTIFFImage) => {
    const imageWidth = candidate.getWidth();
    const imageHeight = candidate.getHeight();
    const [resX, resY] = candidate.getResolution(dataset.images[0]);
    const c0 = (clipped[0] - originX) / resX + pointShift;
    const c1 = (clipped[2] - originX) / resX + pointShift;
    const r0 = (clipped[1] - originY) / resY + pointShift;
    const r1 = (clipped[3] - originY) / resY + pointShift;
    // Pad by 1 pixel on each side so nearest sampling along curved projected edges
    // never clips a valid boundary sample.
    const left = Math.max(0, Math.min(imageWidth - 1, Math.floor(Math.min(c0, c1)) - 1));
    const right = Math.min(imageWidth, Math.max(left + 1, Math.ceil(Math.max(c0, c1)) + 1));
    const top = Math.max(0, Math.min(imageHeight - 1, Math.floor(Math.min(r0, r1)) - 1));
    const bottom = Math.min(imageHeight, Math.max(top + 1, Math.ceil(Math.max(r0, r1)) + 1));
    return { left, top, right, bottom, resX, resY };
  };

  let image = dataset.images[imageIndex];
  let win = computeWindowForImage(image);
  // If the native window exceeds the single-read pixel budget, step to a coarser
  // overview when available so geotiff.js does not allocate a huge native buffer.
  while (
    imageIndex + 1 < dataset.images.length &&
    (win.right - win.left) * (win.bottom - win.top) > MAX_NATIVE_WARP_PIXELS
  ) {
    imageIndex += 1;
    image = dataset.images[imageIndex];
    win = computeWindowForImage(image);
  }

  const readWidth = Math.min(MAX_WARP_SOURCE_SIZE, Math.max(1, win.right - win.left));
  const readHeight = Math.min(MAX_WARP_SOURCE_SIZE, Math.max(1, win.bottom - win.top));
  const values = await readProjectedWindowBounded(
    image,
    [win.left, win.top, win.right, win.bottom],
    readWidth,
    readHeight,
    dataset.band,
  );

  const winOriginX = originX + (win.left - pointShift) * win.resX;
  const winOriginY = originY + (win.top - pointShift) * win.resY;
  const winEndX = originX + (win.right - pointShift) * win.resX;
  const winEndY = originY + (win.bottom - pointShift) * win.resY;
  const windowBounds: [number, number, number, number] = [
    Math.min(winOriginX, winEndX),
    Math.min(winOriginY, winEndY),
    Math.max(winOriginX, winEndX),
    Math.max(winOriginY, winEndY),
  ];
  const affine: ProjectedWindowAffine = {
    originX: winOriginX,
    originY: winOriginY,
    resX: ((win.right - win.left) * win.resX) / readWidth,
    resY: ((win.bottom - win.top) * win.resY) / readHeight,
  };
  return resampleProjectedTile(
    values,
    readWidth,
    readHeight,
    windowBounds,
    bounds,
    mercatorToSource,
    affine,
  );
}

async function readTile(
  dataset: CogDemDataset,
  z: number,
  x: number,
  y: number,
): Promise<ArrayLike<number>> {
  const bounds = mercatorTileBounds(z, x, y);
  if (dataset.mercatorToSource) {
    return readProjectedTile(dataset, bounds, dataset.mercatorToSource);
  }
  const bbox =
    dataset.projection === "EPSG:3857"
      ? bounds
      : [
          longitudeFromMercatorX(bounds[0]),
          mercatorYToLatitude(bounds[1]),
          longitudeFromMercatorX(bounds[2]),
          mercatorYToLatitude(bounds[3]),
        ];
  const requestedResolution = Math.max(
    Math.abs(bbox[2] - bbox[0]) / TILE_SIZE,
    Math.abs(bbox[3] - bbox[1]) / TILE_SIZE,
  );
  // Pick the coarsest overview that is still at least as detailed as the
  // requested tile. Using GeoTIFF.readRasters({bbox}) here looks convenient,
  // but on a global 86,400 x 43,200 COG such as GEBCO it may allocate an
  // intermediate array for the base image before resizing it (hundreds of
  // billions of entries). Selecting the IFD and pixel window explicitly keeps
  // memory proportional to one 256 px terrain tile.
  let image = dataset.images[0];
  for (const candidate of dataset.images) {
    const resolution = candidate.getResolution(dataset.images[0]);
    if (Math.max(Math.abs(resolution[0]), Math.abs(resolution[1])) <= requestedResolution) {
      image = candidate;
    } else {
      break;
    }
  }
  const placement = demTilePlacement(
    bbox,
    dataset.sourceBounds,
    image.getWidth(),
    image.getHeight(),
  );
  if (!placement) return new Float64Array(TILE_SIZE * TILE_SIZE).fill(Number.NaN);
  const { window, destLeft, destTop, destWidth, destHeight } = placement;
  const rasters = await image.readRasters({
    window,
    width: destWidth,
    height: destHeight,
    samples: [dataset.band],
    interleave: true,
    // Nearest, not bilinear: bilinear blends real samples with the nodata
    // sentinel at void/ocean/DEM edges, and the blend lands near — but not on
    // — the sentinel, so encodeTerrariumDem reads it as a real elevation and
    // draws a spike. An overview at least as detailed as the tile is selected
    // above, so the resampling ratio is small either way.
    resampleMethod: "nearest",
    fillValue: Number.NaN,
  });
  const values = rasters as TypedArrayWithDimensions;
  const tile = new Float64Array(TILE_SIZE * TILE_SIZE).fill(Number.NaN);
  for (let row = 0; row < destHeight && destTop + row < TILE_SIZE; row += 1) {
    const target = (destTop + row) * TILE_SIZE + destLeft;
    for (let column = 0; column < destWidth && destLeft + column < TILE_SIZE; column += 1) {
      tile[target + column] = Number(values[row * destWidth + column]);
    }
  }
  return dataset.projection === "EPSG:4326"
    ? remapGeographicRows(tile, bounds, dataset.nodata)
    : tile;
}

async function rgbaToPng(rgba: Uint8ClampedArray): Promise<ArrayBuffer> {
  const imageData = new ImageData(
    new Uint8ClampedArray(
      rgba.buffer.slice(rgba.byteOffset, rgba.byteOffset + rgba.byteLength) as ArrayBuffer,
    ),
    TILE_SIZE,
    TILE_SIZE,
  );
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not create a canvas for the COG DEM tile.");
    context.putImageData(imageData, 0, 0);
    return (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer();
  }
  if (typeof document === "undefined") {
    throw new Error("COG DEM tiles require a browser canvas.");
  }
  const canvas = document.createElement("canvas");
  canvas.width = TILE_SIZE;
  canvas.height = TILE_SIZE;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not create a canvas for the COG DEM tile.");
  context.putImageData(imageData, 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (value) => (value ? resolve(value) : reject(new Error("Could not encode DEM PNG."))),
      "image/png",
    ),
  );
  return blob.arrayBuffer();
}

function parseTileRequest(request: RequestParameters): {
  key: string;
  z: number;
  x: number;
  y: number;
} {
  const match = /^cog-dem:\/\/([^/]+)\/(\d+)\/(\d+)\/(\d+)$/.exec(request.url);
  if (!match) throw new Error(`Invalid COG DEM tile URL: ${request.url}`);
  return { key: match[1], z: Number(match[2]), x: Number(match[3]), y: Number(match[4]) };
}

function ensureCogDemProtocol(): void {
  if (protocolRegistered) return;
  addProtocol(PROTOCOL, async (request: RequestParameters) => {
    const { key, z, x, y } = parseTileRequest(request);
    const dataset = datasets.get(key);
    if (!dataset) throw new Error("The COG DEM source is no longer available.");
    return { data: await rgbaToPng(await renderDatasetTile(dataset, z, x, y)) };
  });
  protocolRegistered = true;
}

/** Open and validate a single-band COG for use as a MapLibre terrain source. */
export async function registerCogDemSource(
  source: string | Blob,
  band = 1,
): Promise<CogDemSourceRegistration> {
  const normalizedSource = typeof source === "string" ? source.trim() : source;
  if (
    !normalizedSource ||
    (typeof Blob !== "undefined" && source instanceof Blob && source.size === 0)
  ) {
    throw new CogDemError("empty-source", "Choose a local COG DEM or enter its URL.");
  }
  const { fromArrayBuffer, fromBlob, fromUrl } = await import("geotiff");
  const tiff =
    typeof normalizedSource === "string"
      ? await fromUrl(normalizedSource)
      : typeof FileReader === "undefined"
        ? await fromArrayBuffer(await normalizedSource.arrayBuffer())
        : await fromBlob(normalizedSource);
  let image: GeoTIFFImage;
  try {
    image = await tiff.getImage();
  } catch (error) {
    // Same invariant as the checks below: no failure leaves the reader open.
    closeQuietly(tiff);
    throw error;
  }
  if (band < 1 || band > image.getSamplesPerPixel()) {
    closeQuietly(tiff);
    throw new CogDemError("unsupported-band", `Band ${band} does not exist in this COG.`);
  }
  const geoKeys = image.getGeoKeys() as Record<string, unknown> | null;
  const projection = projectionFromGeoKeys(geoKeys);
  if (!projection) {
    closeQuietly(tiff);
    throw new CogDemError(
      "unsupported-projection",
      "COG terrain requires a GeoTIFF with a supported EPSG projection.",
    );
  }
  const pixelIsPoint = geoKeys?.GTRasterTypeGeoKey === 2;
  let toWgs84: CoordinateTransform | null = null;
  let mercatorToSource: CoordinateTransform | null = null;
  if (projection !== "EPSG:3857" && projection !== "EPSG:4326") {
    const epsgCode = Number(projection.slice("EPSG:".length));
    const resolved = await resolveEpsgProjection(epsgCode);
    if (!resolved) {
      closeQuietly(tiff);
      throw new CogDemError(
        "unsupported-projection",
        `COG terrain could not resolve ${projection} via bundled proj4 definitions.`,
      );
    }
    const wgs84Conv = resolved.proj4(resolved.definition, "EPSG:4326");
    const mercConv = resolved.proj4("EPSG:3857", resolved.definition);
    toWgs84 = (coord) => wgs84Conv.forward(coord);
    mercatorToSource = (coord) => mercConv.forward(coord);
  }
  ensureCogDemProtocol();
  let images: GeoTIFFImage[];
  let sourceBounds: [number, number, number, number];
  let origin: [number, number];
  let bounds: [number, number, number, number];
  let nodata: number | null;
  try {
    // imageCount comes from the file's own IFD chain, so a corrupt or crafted
    // one can advertise an enormous pyramid and fan out into that many
    // concurrent getImage() calls before anything has had a chance to validate.
    const imageCount = Math.min(await tiff.getImageCount(), MAX_IFDS);
    const allImages = await Promise.all(
      Array.from({ length: imageCount }, (_, index) => tiff.getImage(index)),
    );
    // Keep the base image plus the reduced-resolution overviews; see
    // isDemOverviewIfd for why the other IFDs have to go.
    images = allImages.filter(
      (candidate, index) =>
        index === 0 ||
        isDemOverviewIfd(fileDirectoryValue(candidate.getFileDirectory(), "NewSubfileType")),
    );
    const rawOrigin = image.getOrigin();
    const rawRes = image.getResolution();
    if (
      !Number.isFinite(rawOrigin[0]) ||
      !Number.isFinite(rawOrigin[1]) ||
      !Number.isFinite(rawRes[0]) ||
      !Number.isFinite(rawRes[1]) ||
      rawRes[0] === 0 ||
      rawRes[1] === 0
    ) {
      throw new CogDemError(
        "unsupported-projection",
        "COG terrain requires an axis-aligned GeoTIFF with non-zero pixel resolution.",
      );
    }
    origin = [rawOrigin[0], rawOrigin[1]];
    sourceBounds = image.getBoundingBox() as [number, number, number, number];
    bounds = geographicBounds(sourceBounds, projection, toWgs84);
    nodata = normalizeNoData(fileDirectoryValue(image.getFileDirectory(), "GDAL_NODATA"));
  } catch (error) {
    // A truncated or corrupt overview IFD or missing georeferencing tags must
    // not leak the open reader.
    closeQuietly(tiff);
    throw error;
  }
  const key = String(++datasetSequence);
  const dataset: CogDemDataset = {
    tiff,
    images,
    sourceBounds,
    origin,
    pixelIsPoint,
    projection,
    mercatorToSource,
    nodata,
    band: band - 1,
    pendingReads: 0,
    disposed: false,
    fallback: null,
  };
  datasets.set(key, dataset);
  return {
    tiles: [`${PROTOCOL}://${key}/{z}/{x}/{y}`],
    bounds,
    renderTile: (z, x, y) => renderDatasetTile(dataset, z, x, y),
    dispose: () => {
      datasets.delete(key);
      dataset.disposed = true;
      closeWhenIdle(dataset);
    },
    setFallback: (fallback) => {
      dataset.fallback = fallback;
    },
  };
}
