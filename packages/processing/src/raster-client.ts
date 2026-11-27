import { fromArrayBuffer, writeArrayBuffer } from "geotiff";
import type { FeatureCollection } from "geojson";
import type { RasterToolId } from "./raster-tools";
import { buildSpectralIndexExpression } from "./spectral-indices";
import { compileRasterExpression } from "./raster-expr";
import {
  bandDifference,
  ndviChange,
  transitionMatrix,
  type TransitionMatrix,
} from "./raster-change";
import {
  crsTransform,
  epsgDefinition,
  geojsonEpsg,
  geojsonFeatures,
  mapGeometry,
  rasterCrsDefinition,
  rasterEpsg,
  toNorthUp,
} from "./raster-geo";
import { interpolatePoints } from "./raster-interpolate";
import { dualPolRgb, floodMap, sarDbConvert, speckleFilter } from "./raster-sar";
import {
  clipRasterByMask,
  contourRaster,
  polygonizeRaster,
  zonalStatistics,
} from "./raster-vector";
import {
  cutFill,
  isGeographicRaster,
  projectedAreaScale,
  projectedMetersPerUnit,
  type CutFillParams,
  type CutFillSummary,
} from "./raster-volume";
import { buildingShadows, type BuildingShadowParams } from "./raster-shadow";
import { mosaicRasters, reprojectRaster, resampleRaster } from "./raster-warp";

/**
 * In-browser raster processing engine.
 *
 * Mirrors the vector-tools client fallback (Turf.js): a subset of the raster
 * toolbox runs entirely in the browser with `geotiff.js`, so the toolbox is
 * usable without the Python sidecar. Tools read a GeoTIFF into a
 * {@link RasterData} (band arrays + georeferencing), compute a new band, and
 * write a fresh GeoTIFF the map can render directly.
 *
 * Compute follows the de-facto ESRI/GDAL DEM formulas (Horn's method) and is
 * intended as a convenience fallback; for production-grade results (large
 * rasters, multi-raster band math, south-up georeferencing) prefer the
 * rasterio sidecar engine.
 */

/** NoData value written to terrain outputs (hillshade/slope/aspect/focal). */
export const TERRAIN_NODATA = -9999;

/**
 * A decoded single- or multi-band raster with its georeferencing. Pixel arrays
 * are row-major with a top-left origin (row 0 is the northern edge).
 */
export interface RasterData {
  /** One Float32Array per band, each of length `width * height`. */
  bands: Float32Array[];
  width: number;
  height: number;
  /** World X of the top-left corner of pixel (0, 0). */
  originX: number;
  /** World Y of the top-left corner of pixel (0, 0). */
  originY: number;
  /** Pixel width in CRS units (positive; see `flipX` for the original sign). */
  resX: number;
  /** Pixel height in CRS units (positive; see `flipY` for the original sign). */
  resY: number;
  /** True when the source pixel X resolution was negative (east-to-west, rare):
   * world X decreases with pixel column. Absent/false = normal west-to-east. */
  flipX?: boolean;
  /** True when the source pixel Y resolution was positive (south-up): world Y
   * increases with pixel row. Absent/false = normal north-up (originY is the
   * northern edge). Lets georeferencing consumers handle flipped rasters. */
  flipY?: boolean;
  /** True when the source GeoTIFF carried non-zero ModelTransformation rotation/shear terms. */
  rotated?: boolean;
  /** NoData value, or null when the source declares none. */
  nodata: number | null;
  /** GeoTIFF GeoKeys carried through to the output so the CRS is preserved. */
  geoKeys: Record<string, unknown>;
}

/**
 * The raster tools that have an in-browser implementation: every tool of the
 * raster toolbox. The first group runs synchronously through
 * {@link runRasterToolClient}; the rest need CRS lookups, vector inputs or a
 * second raster and run through {@link runRasterToolClientAsync}.
 */
export const CLIENT_RASTER_TOOL_IDS: ReadonlySet<RasterToolId> = new Set<RasterToolId>([
  "hillshade",
  "slope",
  "aspect",
  "clip-extent",
  "reclassify",
  "raster-calc",
  "spectral-index",
  "focal",
  "reproject",
  "resample",
  "clip-mask",
  "polygonize",
  "contour",
  "interpolate",
  "zonal",
  "mosaic",
  "change-difference",
  "ndvi-change",
  "transition-matrix",
  "sar-db",
  "speckle-filter",
  "sar-rgb",
  "flood-map",
  "cut-fill",
  "building-shadows",
]);

/** Whether a tool can run in the browser without the sidecar. */
export function supportsClientRaster(id: string): boolean {
  return CLIENT_RASTER_TOOL_IDS.has(id as RasterToolId);
}

// --- GeoTIFF I/O -----------------------------------------------------------

/**
 * GeoKeys the writer understands; copied from the source to keep the CRS and
 * the angular unit the terrain scaling keys off (dropping the unit tag would
 * make re-read tool output default to degrees and rescale wrongly).
 */
const PRESERVED_GEO_KEYS = [
  "GTModelTypeGeoKey",
  "GTRasterTypeGeoKey",
  "GeographicTypeGeoKey",
  "ProjectedCSTypeGeoKey",
  "GeogAngularUnitsGeoKey",
] as const;

/**
 * Upper bound on the Float32 pixel buffers the client engine will allocate
 * (512 MB). Larger rasters should use the sidecar, which streams from disk.
 */
export const MAX_CLIENT_RASTER_BYTES = 512 * 1024 * 1024;

const SAMPLE_FORMAT_TAG = 339;

type GeoTiffImage = Awaited<ReturnType<Awaited<ReturnType<typeof fromArrayBuffer>>["getImage"]>>;

/**
 * Let geotiff.js decode a multi-band file whose SampleFormat tag holds fewer
 * values than SamplesPerPixel. TIFF sizes the tag per sample, but writers
 * (including geolibre-wasm's COG converter before the whitebox-wasm fix) emit
 * a single value; geotiff.js indexes it per sample and throws "Unsupported data
 * format/bitsPerSample" for band 2+. Reusing the last value matches GDAL.
 */
export function padShortSampleFormat(image: GeoTiffImage): void {
  const samples = image.getSamplesPerPixel();
  const formats = image.fileDirectory.getValue("SampleFormat") as ArrayLike<number> | undefined;
  if (!formats || formats.length === 0 || formats.length >= samples) return;
  const padded = Uint16Array.from({ length: samples }, (_, i) =>
    i < formats.length ? formats[i] : formats[formats.length - 1],
  );
  // geotiff.js reads the tag from several places (getSampleFormat and the
  // per-sample readers), so replace the parsed value itself. 339 = SampleFormat.
  const fields = (image.fileDirectory as unknown as { actualizedFields?: unknown })
    .actualizedFields;
  if (!(fields instanceof Map)) {
    // A geotiff.js upgrade moved this private map (docs/maintenance.md).
    console.warn(
      "readRasterData: cannot pad a short SampleFormat tag; band 2+ may fail to decode.",
    );
    return;
  }
  fields.set(SAMPLE_FORMAT_TAG, padded);
}

/**
 * Inspect only the GeoTIFF header to estimate the Float32 buffer size needed
 * to decode this raster, without allocating or reading pixel data.
 */
export async function estimateRasterDataBytes(
  bytes: ArrayBuffer,
  options: { samples?: readonly number[] } = {},
): Promise<number> {
  const tiff = await fromArrayBuffer(bytes);
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  const sampleCount = options.samples?.length ?? image.getSamplesPerPixel();
  return width * height * sampleCount * Float32Array.BYTES_PER_ELEMENT;
}

/**
 * Decode GeoTIFF bytes into a {@link RasterData}.
 *
 * @param bytes GeoTIFF bytes.
 * @param options `samples`: 0-based bands to decode, in this order (all bands
 *   when omitted), so a caller needing a few bands of a large image does not
 *   decode the rest.
 */
export async function readRasterData(
  bytes: ArrayBuffer,
  options: { samples?: readonly number[] } = {},
): Promise<RasterData> {
  const tiff = await fromArrayBuffer(bytes);
  const image = await tiff.getImage();
  padShortSampleFormat(image);
  const width = image.getWidth();
  const height = image.getHeight();
  // Guard against decoding a raster too large to hold in browser memory before
  // we materialize the band arrays (which would freeze or OOM the tab).
  const estimatedBytes =
    width *
    height *
    (options.samples?.length ?? image.getSamplesPerPixel()) *
    Float32Array.BYTES_PER_ELEMENT;
  if (!Number.isFinite(estimatedBytes) || estimatedBytes > MAX_CLIENT_RASTER_BYTES) {
    throw new Error(
      "This raster is too large for the in-browser engine. Use the sidecar (rasterio/GDAL) engine instead.",
    );
  }
  let [originX, originY] = image.getOrigin();
  let [resolutionX, resolutionY] = image.getResolution();
  let rotated = false;
  const modelTransform = image.fileDirectory.getValue("ModelTransformation") as
    | ArrayLike<number>
    | undefined;
  if (modelTransform && modelTransform.length >= 16) {
    if (Math.abs(modelTransform[1]) > 1e-12 || Math.abs(modelTransform[4]) > 1e-12) {
      rotated = true;
    } else if (
      Number.isFinite(modelTransform[0]) &&
      Number.isFinite(modelTransform[5]) &&
      modelTransform[0] !== 0 &&
      modelTransform[5] !== 0
    ) {
      resolutionX = modelTransform[0];
      resolutionY = modelTransform[5];
    }
  }

  const result = await image.readRasters(
    options.samples ? { samples: [...options.samples] } : undefined,
  );
  const rawBands = (Array.isArray(result) ? result : [result]) as ArrayLike<number>[];
  const noData = image.getGDALNoData();
  // Preserve masks before integer/Float64 values can collide when rounded to
  // Float32. Float32 sources already have a distinguishable stored sentinel.
  const outputNoData =
    noData == null
      ? null
      : !Number.isFinite(Math.fround(noData)) ||
          rawBands.some(
            (band) =>
              band instanceof Float64Array ||
              (!(band instanceof Float32Array) && Math.abs(noData) >= 2 ** 24),
          )
        ? Number.NaN
        : Math.fround(noData);
  const bands = rawBands.map((band) => {
    const sourceNoData =
      band instanceof Float32Array && noData != null ? Math.fround(noData) : noData;
    if (noData == null || outputNoData === sourceNoData || Number.isNaN(noData))
      return Float32Array.from(band);
    return Float32Array.from(band, (value) => (value === sourceNoData ? outputNoData! : value));
  });
  const geoKeys = (image.getGeoKeys() as Record<string, unknown>) ?? {};
  if (Number(geoKeys.GTRasterTypeGeoKey) === 2) {
    originX -= resolutionX / 2;
    originY -= resolutionY / 2;
  }
  return {
    bands,
    width,
    height,
    originX,
    originY,
    resX: Math.abs(resolutionX),
    resY: Math.abs(resolutionY),
    // Preserve the resolution sign (discarded by the abs above) so georeferencing
    // consumers can handle mirrored / south-up rasters instead of silently
    // placing features at the wrong location.
    flipX: resolutionX < 0,
    flipY: resolutionY > 0,
    ...(rotated ? { rotated: true } : {}),
    nodata: outputNoData,
    geoKeys,
  };
}

/**
 * Encode a {@link RasterData} as a Float32 GeoTIFF `ArrayBuffer`. Convenience
 * alias for {@link writeRasterBands}; both write every band of the raster.
 */
export function writeRasterData(raster: RasterData): ArrayBuffer {
  return writeRasterBands(raster);
}

/** Encode all bands of a {@link RasterData} as a Float32 GeoTIFF. */
export function writeRasterBands(raster: RasterData): ArrayBuffer {
  return writeInterleaved(raster, raster.bands, Float32Array);
}

/**
 * Encode 8-bit bands with a raster's georeferencing as a uint8 GeoTIFF, e.g. a
 * class-code raster or an RGB rendering. Each band holds `width * height`
 * values; `nodata` (when given) is written as the GDAL NoData value.
 *
 * @param grid Size, georeferencing and GeoKeys to copy (its own bands are ignored).
 * @param bands The 8-bit bands to write.
 * @param nodata NoData value, or null for none.
 */
export function writeUint8Bands(
  grid: RasterData,
  bands: Uint8Array[],
  nodata: number | null,
): ArrayBuffer {
  return writeInterleaved({ ...grid, nodata }, bands, Uint8Array);
}

function writeInterleaved<T extends Float32Array | Uint8Array>(
  raster: RasterData,
  bands: T[],
  ArrayType: { new (length: number): T },
): ArrayBuffer {
  const bandCount = bands.length;
  // Interleave bands into a single flat array the writer can consume (it infers
  // band count from `values.length / (width * height)`).
  let values: T;
  if (bandCount === 1) {
    values = bands[0];
  } else {
    const pixels = raster.width * raster.height;
    values = new ArrayType(pixels * bandCount);
    for (let p = 0; p < pixels; p += 1) {
      for (let b = 0; b < bandCount; b += 1) {
        values[p * bandCount + b] = bands[b][p];
      }
    }
  }
  const metadata: Record<string, unknown> = {
    width: raster.width,
    height: raster.height,
    ModelPixelScale: [raster.resX, raster.resY, 0],
    ModelTiepoint: [
      0,
      0,
      0,
      raster.originX + (Number(raster.geoKeys.GTRasterTypeGeoKey) === 2 ? raster.resX / 2 : 0),
      raster.originY - (Number(raster.geoKeys.GTRasterTypeGeoKey) === 2 ? raster.resY / 2 : 0),
      0,
    ],
  };
  if (raster.nodata != null)
    metadata.GDAL_NODATA = Number.isNaN(raster.nodata) ? "nan" : String(raster.nodata);
  for (const key of PRESERVED_GEO_KEYS) {
    const value = raster.geoKeys[key];
    if (value != null) metadata[key] = value;
  }
  // The geotiff writer's metadata type is broad; the runtime accepts the fields
  // set above (it derives SampleFormat/BitsPerSample from the typed array).
  const bytes: ArrayBuffer = writeArrayBuffer(
    values,
    metadata as Parameters<typeof writeArrayBuffer>[1],
  );
  return bytes;
}

// --- Compute helpers -------------------------------------------------------

const DEG = Math.PI / 180;

/** True when `v` is the raster's NoData value or otherwise non-finite. */
function isNoData(v: number, nodata: number | null): boolean {
  return !Number.isFinite(v) || (nodata != null && v === nodata);
}

/**
 * Read a 3×3 Horn window centred on (row, col) into `win` (top-left first).
 * Returns false when the centre or any neighbour is NoData (edges replicate the
 * nearest in-bounds pixel, matching the common DEM-tool edge behaviour).
 */
function fillWindow(
  band: Float32Array,
  width: number,
  height: number,
  row: number,
  col: number,
  nodata: number | null,
  win: number[],
): boolean {
  let k = 0;
  for (let dr = -1; dr <= 1; dr += 1) {
    const r = Math.min(height - 1, Math.max(0, row + dr));
    for (let dc = -1; dc <= 1; dc += 1) {
      const c = Math.min(width - 1, Math.max(0, col + dc));
      const v = band[r * width + c];
      if (isNoData(v, nodata)) return false;
      win[k] = v;
      k += 1;
    }
  }
  return true;
}

/** Horn east-west gradient (dz/dx) from a filled 3×3 window. */
function gradX(win: number[], resX: number): number {
  return (win[2] + 2 * win[5] + win[8] - (win[0] + 2 * win[3] + win[6])) / (8 * resX);
}

/** Horn north-south gradient (dz/dy) from a filled 3×3 window. */
function gradY(win: number[], resY: number): number {
  return (win[6] + 2 * win[7] + win[8] - (win[0] + 2 * win[1] + win[2])) / (8 * resY);
}

/**
 * Metres per degree of latitude on WGS84 (same constant terrain-viewshed uses).
 */
const METERS_PER_DEGREE_LAT = 111320;

/**
 * Degrees spanned by one GeoTIFF angular unit, keyed by the EPSG unit codes
 * the spec assigns (GeoTIFF 1.0, "Angular Units Codes": 9101 radian, 9102
 * degree, 9103 arc-minute, 9104 arc-second). The spec default when the key is
 * absent is degrees.
 */
const DEGREES_PER_ANGULAR_UNIT: Record<number, number> = {
  9101: 180 / Math.PI, // radian
  9102: 1, // degree
  9103: 1 / 60, // arc-minute
  9104: 1 / 3600, // arc-second
};

/**
 * Terrain gradients compare elevation (metres) against horizontal distance, so
 * their denominators must be metres. Rasters stored in a geographic CRS (the
 * distribution format of SRTM/AW3D30/Copernicus DEM) have cell sizes in
 * degrees, which are converted with the gdaldem convention (its documented
 * default scale for lat/long DEMs) plus a cos(latitude) correction on the
 * east-west axis, where a degree of longitude shrinks away from the equator.
 * Without this, slope on a 4326 DEM comes back ~111,320x too steep and
 * saturates at 90 degrees.
 */
function gradientResolutions(input: RasterData): {
  resX: number;
  resY: number;
} {
  const geoKeys = input.geoKeys ?? {};
  const modelType = geoKeys.GTModelTypeGeoKey as number | undefined;
  const isGeographic =
    modelType === 2 || (modelType == null && geoKeys.GeographicTypeGeoKey != null);
  if (!isGeographic) {
    return { resX: input.resX, resY: input.resY };
  }
  const unitKey = geoKeys.GeogAngularUnitsGeoKey as number | undefined;
  const degreesPerUnit = unitKey == null ? 1 : DEGREES_PER_ANGULAR_UNIT[unitKey];
  if (degreesPerUnit == null) {
    // Grads, gons and other codes we cannot convert: fail loudly rather than
    // hand raw angular cell sizes to the terrain math as if they were metres.
    throw new Error(
      `Unsupported geographic angular unit (GeogAngularUnitsGeoKey ${unitKey}). Convert the raster or use the sidecar (rasterio/GDAL) engine instead.`,
    );
  }
  // North-up GeoTIFFs put originY on the top (northern) edge; south-up rasters
  // (flipY) put it on the southern edge, so the mid-latitude sign follows flipY.
  const halfSpan = (input.height * input.resY) / 2;
  const midLat =
    (input.flipY ? input.originY + halfSpan : input.originY - halfSpan) * degreesPerUnit;
  // Clamped so near-polar extents (cos -> 0) cannot collapse the east-west
  // denominators to zero; at the clamp the correction is meaningless anyway.
  const lonScale = Math.max(Math.cos((midLat * Math.PI) / 180), 1e-4);
  return {
    resX: input.resX * degreesPerUnit * METERS_PER_DEGREE_LAT * lonScale,
    resY: input.resY * degreesPerUnit * METERS_PER_DEGREE_LAT,
  };
}

export interface HillshadeParams {
  azimuth?: number;
  altitude?: number;
  z_factor?: number;
}

/** Shaded relief (0–255) via the ESRI/GDAL hillshade formula (Horn's method). */
export function hillshade(input: RasterData, params: HillshadeParams): RasterData {
  const band = input.bands[0];
  const { width, height, nodata } = input;
  const { resX, resY } = gradientResolutions(input);
  const azimuth = params.azimuth ?? 315;
  const altitude = params.altitude ?? 45;
  const zFactor = params.z_factor ?? 1;

  const zenithRad = (90 - altitude) * DEG;
  const azimuthRad = ((360 - azimuth + 90) % 360) * DEG;
  const cosZenith = Math.cos(zenithRad);
  const sinZenith = Math.sin(zenithRad);

  const out = new Float32Array(width * height);
  const win = new Array<number>(9);
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const i = row * width + col;
      if (!fillWindow(band, width, height, row, col, nodata, win)) {
        out[i] = TERRAIN_NODATA;
        continue;
      }
      const dzdx = gradX(win, resX) * zFactor;
      const dzdy = gradY(win, resY) * zFactor;
      const slopeRad = Math.atan(Math.sqrt(dzdx * dzdx + dzdy * dzdy));
      let aspectRad: number;
      if (dzdx !== 0) {
        aspectRad = Math.atan2(dzdy, -dzdx);
        if (aspectRad < 0) aspectRad += 2 * Math.PI;
      } else if (dzdy > 0) {
        aspectRad = Math.PI / 2;
      } else if (dzdy < 0) {
        aspectRad = (3 * Math.PI) / 2;
      } else {
        aspectRad = 0;
      }
      const value =
        255 *
        (cosZenith * Math.cos(slopeRad) +
          sinZenith * Math.sin(slopeRad) * Math.cos(azimuthRad - aspectRad));
      out[i] = Math.max(0, Math.min(255, value));
    }
  }
  return singleBandResult(input, out, TERRAIN_NODATA);
}

export interface SlopeParams {
  units?: "degrees" | "percent";
  z_factor?: number;
}

/** Slope (steepness) in degrees or percent (Horn's method). */
export function slope(input: RasterData, params: SlopeParams): RasterData {
  const band = input.bands[0];
  const { width, height, nodata } = input;
  const { resX, resY } = gradientResolutions(input);
  const zFactor = params.z_factor ?? 1;
  const percent = params.units === "percent";

  const out = new Float32Array(width * height);
  const win = new Array<number>(9);
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const i = row * width + col;
      if (!fillWindow(band, width, height, row, col, nodata, win)) {
        out[i] = TERRAIN_NODATA;
        continue;
      }
      const dzdx = gradX(win, resX) * zFactor;
      const dzdy = gradY(win, resY) * zFactor;
      const rise = Math.sqrt(dzdx * dzdx + dzdy * dzdy);
      out[i] = percent ? rise * 100 : Math.atan(rise) / DEG;
    }
  }
  return singleBandResult(input, out, TERRAIN_NODATA);
}

/**
 * Aspect (compass direction of steepest descent, 0–360°). Flat cells have no
 * meaningful direction and are emitted as NoData (rather than GDAL's `-1`
 * sentinel) so the COG renderer masks them instead of colouring a value just
 * below zero.
 */
export function aspect(input: RasterData): RasterData {
  const band = input.bands[0];
  const { width, height, nodata } = input;
  const { resX, resY } = gradientResolutions(input);

  const out = new Float32Array(width * height);
  const win = new Array<number>(9);
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const i = row * width + col;
      if (!fillWindow(band, width, height, row, col, nodata, win)) {
        out[i] = TERRAIN_NODATA;
        continue;
      }
      const dzdx = gradX(win, resX);
      const dzdy = gradY(win, resY);
      if (dzdx === 0 && dzdy === 0) {
        out[i] = TERRAIN_NODATA; // flat: no aspect, masked by the renderer
        continue;
      }
      let a = Math.atan2(dzdy, -dzdx) / DEG;
      if (a < 0) a = 90 - a;
      else if (a > 90) a = 360 - a + 90;
      else a = 90 - a;
      out[i] = a;
    }
  }
  return singleBandResult(input, out, TERRAIN_NODATA);
}

export interface ClipExtentParams {
  minx: number;
  miny: number;
  maxx: number;
  maxy: number;
}

/** Crop a raster to a bounding box (in the raster's CRS). Preserves all bands. */
export function clipByExtent(input: RasterData, params: ClipExtentParams): RasterData {
  const { width, height, originX, originY, resX, resY } = input;
  const col0 = Math.max(0, Math.floor((params.minx - originX) / resX));
  const col1 = Math.min(width, Math.ceil((params.maxx - originX) / resX));
  const row0 = Math.max(0, Math.floor((originY - params.maxy) / resY));
  const row1 = Math.min(height, Math.ceil((originY - params.miny) / resY));
  const outW = col1 - col0;
  const outH = row1 - row0;
  if (outW <= 0 || outH <= 0) {
    throw new Error("The clip extent does not overlap the raster.");
  }

  const bands = input.bands.map((band) => {
    const out = new Float32Array(outW * outH);
    for (let r = 0; r < outH; r += 1) {
      const srcRow = (row0 + r) * width + col0;
      out.set(band.subarray(srcRow, srcRow + outW), r * outW);
    }
    return out;
  });

  return {
    ...input,
    bands,
    width: outW,
    height: outH,
    originX: originX + col0 * resX,
    originY: originY - row0 * resY,
  };
}

export interface ReclassifyParams {
  band?: number;
  table: string;
  unmatched?: "nodata" | "original";
}

interface ReclassRule {
  min: number;
  max: number;
  value: number;
}

/** Parse a "min:max:newvalue" rule table (blank/min/max mean ±∞). */
export function parseReclassTable(table: string): ReclassRule[] {
  const rules: ReclassRule[] = [];
  for (const raw of table.split(/[\n,]/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(":");
    if (parts.length !== 3) {
      throw new Error(`Invalid reclassify rule "${line}" (expected min:max:newvalue).`);
    }
    const bound = (token: string, fallback: number): number => {
      const t = token.trim().toLowerCase();
      if (t === "" || t === "min" || t === "max") return fallback;
      const n = Number(t);
      if (!Number.isFinite(n)) throw new Error(`Invalid number "${token}" in rule "${line}".`);
      return n;
    };
    const value = Number(parts[2].trim());
    if (!Number.isFinite(value)) {
      throw new Error(`Invalid output value "${parts[2]}" in rule "${line}".`);
    }
    rules.push({
      min: bound(parts[0], -Infinity),
      max: bound(parts[1], Infinity),
      value,
    });
  }
  if (!rules.length) throw new Error("The reclassify rule table is empty.");
  return rules;
}

/** Remap value ranges to new class values using a half-open [min, max) table. */
export function reclassify(input: RasterData, params: ReclassifyParams): RasterData {
  const band = input.bands[(params.band ?? 1) - 1];
  if (!band) throw new Error(`Band ${params.band ?? 1} is out of range.`);
  const rules = parseReclassTable(params.table);
  const keepOriginal = params.unmatched === "original";
  const outNoData = input.nodata ?? TERRAIN_NODATA;

  const out = new Float32Array(band.length);
  for (let i = 0; i < band.length; i += 1) {
    const v = band[i];
    if (isNoData(v, input.nodata)) {
      out[i] = outNoData;
      continue;
    }
    const rule = rules.find((r) => v >= r.min && v < r.max);
    if (rule) out[i] = rule.value;
    else out[i] = keepOriginal ? v : outNoData;
  }
  return singleBandResult(input, out, outNoData);
}

export interface RasterCalcParams {
  expression: string;
  /**
   * Optional additional raster inputs keyed by uppercase letter (`B`, `C`, ...).
   * Each additional raster must match the width and height of input `A`.
   */
  additionalInputs?: Record<string, RasterData>;
}

function gridsMatch(a: RasterData, b: RasterData): string | null {
  if (a.rotated || b.rotated) {
    return "uses a rotated or sheared transform that the in-browser calculator cannot combine";
  }
  if (a.width !== b.width || a.height !== b.height) {
    return `dimensions (${b.width}×${b.height}) do not match raster A (${a.width}×${a.height})`;
  }
  if (Boolean(a.flipX) !== Boolean(b.flipX) || Boolean(a.flipY) !== Boolean(b.flipY)) {
    return "axis orientation does not match raster A";
  }
  const absResX = Math.abs(a.resX);
  const absResY = Math.abs(a.resY);
  // Measure origin shift in pixel fractions independent of absolute CRS coordinates.
  const originTolX = 1e-3 * (absResX > 0 ? absResX : 1);
  const originTolY = 1e-3 * (absResY > 0 ? absResY : 1);
  if (
    Math.abs(a.originX - b.originX) > originTolX ||
    Math.abs(a.originY - b.originY) > originTolY
  ) {
    return "origin does not match raster A";
  }
  // Check accumulated pixel displacement across the full raster width and height.
  const farEdgeShiftX = Math.abs(a.resX - b.resX) * a.width;
  const farEdgeShiftY = Math.abs(a.resY - b.resY) * a.height;
  if (farEdgeShiftX > originTolX || farEdgeShiftY > originTolY) {
    return "pixel resolution does not match raster A";
  }
  const regA = a.geoKeys?.GTRasterTypeGeoKey ?? 1;
  const regB = b.geoKeys?.GTRasterTypeGeoKey ?? 1;
  if (regA !== regB) {
    return "pixel registration (PixelIsArea vs PixelIsPoint) does not match raster A";
  }
  for (const crsKey of ["GeographicTypeGeoKey", "ProjectedCSTypeGeoKey"]) {
    const av = a.geoKeys?.[crsKey];
    const bv = b.geoKeys?.[crsKey];
    if (av === 32767 || bv === 32767) {
      return `uses a user-defined CRS (${crsKey}=32767) that the in-browser calculator cannot verify`;
    }
  }
  for (const crsKey of ["GTModelTypeGeoKey", "GeographicTypeGeoKey", "ProjectedCSTypeGeoKey"]) {
    const av = a.geoKeys?.[crsKey];
    const bv = b.geoKeys?.[crsKey];
    if (av != null && bv != null && av !== bv) {
      return `CRS (${crsKey}=${String(bv)}) does not match raster A (${crsKey}=${String(av)})`;
    }
  }
  return null;
}

/**
 * Evaluate a CSP-safe band-math expression over one or more rasters.
 * Band 1 of each input is `A`, `B`, `C`, ... and specific bands are `A1`, `A2`,
 * `B1`, `B2`, .... Uses a recursive-descent parser with zero `eval`/`new Function`.
 */
export function rasterCalc(input: RasterData, params: RasterCalcParams): RasterData {
  const expr = params.expression.trim();
  if (!expr) throw new Error("Enter an expression.");

  const rasters: Record<string, RasterData> = { A: input };
  if (params.additionalInputs) {
    for (const [rawKey, extra] of Object.entries(params.additionalInputs)) {
      const key = rawKey.trim().toUpperCase();
      if (!/^[B-Z]$/.test(key)) {
        throw new Error(`Invalid secondary raster key "${rawKey}". Expected a single letter B–Z.`);
      }
      if (key in rasters) {
        throw new Error(`Duplicate secondary raster key "${key}".`);
      }
      const mismatch = gridsMatch(input, extra);
      if (mismatch) {
        throw new Error(
          `Raster ${key} ${mismatch}; align or reproject inputs before running the calculator.`,
        );
      }
      rasters[key] = extra;
    }
  }

  const bandMap: Record<string, readonly Float32Array[]> = {};
  for (const [key, r] of Object.entries(rasters)) {
    bandMap[key] = r.bands;
  }

  const compiled = compileRasterExpression(expr, bandMap);
  const usedSources = compiled.referencedBands.map((ref) => ({
    band: rasters[ref.raster].bands[ref.band - 1],
    nodata: rasters[ref.raster].nodata,
  }));

  const pixels = input.width * input.height;
  const out = new Float32Array(pixels);
  const outNoData = input.nodata ?? TERRAIN_NODATA;
  const usedCount = usedSources.length;

  for (let p = 0; p < pixels; p += 1) {
    let bad = false;
    for (let u = 0; u < usedCount; u += 1) {
      const src = usedSources[u];
      if (isNoData(src.band[p], src.nodata)) {
        bad = true;
        break;
      }
    }
    if (bad) {
      out[p] = outNoData;
      continue;
    }
    const value = compiled.evaluate(p);
    out[p] = Number.isFinite(value) ? value : outNoData;
  }
  return singleBandResult(input, out, outNoData);
}

export type FocalStatistic = "mean" | "median" | "min" | "max" | "sum" | "std" | "range";

export interface FocalParams {
  band?: number;
  statistic?: FocalStatistic;
  size?: number;
}

/** Apply a moving-window (neighbourhood) statistic to a raster band. */
export function focalStatistics(input: RasterData, params: FocalParams): RasterData {
  const band = input.bands[(params.band ?? 1) - 1];
  if (!band) throw new Error(`Band ${params.band ?? 1} is out of range.`);
  const { width, height, nodata } = input;
  const stat = params.statistic ?? "mean";
  let size = Math.max(3, Math.min(25, Math.round(params.size ?? 3)));
  if (size % 2 === 0) size += 1; // window must be odd
  // Focal is O(pixels × window²); a large window on a large raster can freeze
  // the tab for tens of seconds. Cap the total work and steer to the sidecar.
  if (width * height * size * size > 500_000_000) {
    throw new Error(
      `A ${size}×${size} window on a ${width}×${height} raster is too large for the ` +
        "in-browser engine. Use a smaller window or the sidecar (rasterio/GDAL) engine.",
    );
  }
  const radius = (size - 1) / 2;
  const outNoData = nodata ?? TERRAIN_NODATA;

  const out = new Float32Array(width * height);
  const buf: number[] = [];
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const i = row * width + col;
      if (isNoData(band[i], nodata)) {
        out[i] = outNoData;
        continue;
      }
      buf.length = 0;
      for (let dr = -radius; dr <= radius; dr += 1) {
        const r = row + dr;
        if (r < 0 || r >= height) continue;
        for (let dc = -radius; dc <= radius; dc += 1) {
          const c = col + dc;
          if (c < 0 || c >= width) continue;
          const v = band[r * width + c];
          if (!isNoData(v, nodata)) buf.push(v);
        }
      }
      out[i] = buf.length ? aggregate(buf, stat) : outNoData;
    }
  }
  return singleBandResult(input, out, outNoData);
}

/** Reduce a window of values to a single focal statistic. */
function aggregate(values: number[], stat: FocalStatistic): number {
  const n = values.length;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  switch (stat) {
    case "sum":
      return sum;
    case "min":
      return min;
    case "max":
      return max;
    case "range":
      return max - min;
    case "median": {
      const sorted = [...values].sort((a, b) => a - b);
      const mid = n >> 1;
      return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }
    case "std": {
      const mean = sum / n;
      let acc = 0;
      for (const v of values) acc += (v - mean) ** 2;
      return Math.sqrt(acc / n);
    }
    case "mean":
    default:
      return sum / n;
  }
}

/** Wrap a computed single-band array in a {@link RasterData}, keeping geo info. */
function singleBandResult(input: RasterData, band: Float32Array, nodata: number): RasterData {
  return { ...input, bands: [band], nodata };
}

// --- Dispatcher ------------------------------------------------------------

export interface ClientRasterResult {
  raster: RasterData;
  bytes: ArrayBuffer;
  messages: string[];
  detailMessages: string[];
}

/**
 * Run a client-side raster tool and return the result raster plus a freshly
 * encoded GeoTIFF the map can render. Throws for tools without a client
 * implementation (callers should gate on {@link supportsClientRaster}).
 */
export function runRasterToolClient(
  toolId: string,
  input: RasterData,
  parameters: Record<string, unknown>,
  additionalInputs?: Record<string, RasterData>,
): ClientRasterResult {
  const messages: string[] = [
    `Loaded raster: ${input.width}×${input.height}, ${input.bands.length} band(s).`,
  ];
  const num = (key: string, fallback?: number): number => {
    const v = parameters[key];
    // Number("") is 0, so treat empty/missing explicitly rather than silently
    // running a tool with an unintended zero extent/parameter.
    if (v === "" || v == null) {
      if (fallback !== undefined) return fallback;
      throw new Error(`"${key}" is required.`);
    }
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n)) return n;
    if (fallback !== undefined) return fallback;
    throw new Error(`"${key}" is required.`);
  };

  let raster: RasterData;
  switch (toolId) {
    case "hillshade":
      raster = hillshade(input, {
        azimuth: num("azimuth", 315),
        altitude: num("altitude", 45),
        z_factor: num("z_factor", 1),
      });
      break;
    case "slope":
      raster = slope(input, {
        units: (parameters.units as "degrees" | "percent") ?? "degrees",
        z_factor: num("z_factor", 1),
      });
      break;
    case "aspect":
      raster = aspect(input);
      break;
    case "clip-extent":
      raster = clipByExtent(input, {
        minx: num("minx"),
        miny: num("miny"),
        maxx: num("maxx"),
        maxy: num("maxy"),
      });
      break;
    case "reclassify":
      raster = reclassify(input, {
        band: num("band", 1),
        table: String(parameters.table ?? ""),
        unmatched: (parameters.unmatched as "nodata" | "original") ?? "nodata",
      });
      break;
    case "raster-calc":
      raster = rasterCalc(input, {
        expression: String(parameters.expression ?? ""),
        additionalInputs,
      });
      break;
    case "spectral-index": {
      const { expression, bands } = buildSpectralIndexExpression(parameters);
      if (bands.length === 0) {
        throw new Error("Spectral index produced no band references.");
      }
      const maxBand = Math.max(...bands);
      if (maxBand > input.bands.length) {
        throw new Error(
          `This index needs band ${maxBand}, but the raster has only ${input.bands.length} band(s). ` +
            "Check the sensor preset or set band numbers with the Custom sensor.",
        );
      }
      messages.push(`Index expression: ${expression}`);
      raster = rasterCalc(input, { expression });
      break;
    }
    case "focal":
      raster = focalStatistics(input, {
        band: num("band", 1),
        statistic: (parameters.statistic as FocalStatistic) ?? "mean",
        size: num("size", 3),
      });
      break;
    default:
      throw new Error(`"${toolId}" has no client-side implementation.`);
  }

  const detailMessages = messages.slice(1);
  messages.push(`Computed "${toolId}" in the browser.`);
  return { raster, bytes: writeRasterBands(raster), messages, detailMessages };
}

// --- Async dispatcher (every tool) -----------------------------------------

/** Inputs for {@link runRasterToolClientAsync}. */
export interface ClientToolInputs {
  /** The primary raster (absent for `interpolate`, whose input is points). */
  raster?: RasterData;
  /**
   * Secondary rasters keyed by parameter id (`raster_2`, `after_path`, ...),
   * or by letter (`B`, `C`) for the raster calculator.
   */
  rasters?: Record<string, RasterData>;
  /**
   * GeoJSON inputs keyed by parameter id (`mask_path`, `zones_path`); the
   * primary point layer of `interpolate` is keyed `input`.
   */
  vectors?: Record<string, unknown>;
}

/** The outcome of a client tool run: a raster or a vector layer. */
export type ClientToolResult =
  | {
      kind: "raster";
      raster: RasterData;
      bytes: ArrayBuffer;
      messages: string[];
      /** Engine diagnostics excluding loaded/computed lifecycle summaries. */
      detailMessages: string[];
      /** The transition matrix, for `transition-matrix`. */
      matrix?: TransitionMatrix;
      /** The volume totals, for `cut-fill`. */
      cutFill?: CutFillSummary;
    }
  | {
      kind: "vector";
      /** The GeoJSON as the sidecar writes it (source CRS, legacy `crs` member). */
      geojson: FeatureCollection;
      /** The same features in WGS84, or null for an unreferenced download. */
      wgs84: FeatureCollection | null;
      messages: string[];
      detailMessages: string[];
    };

/** Tools {@link runRasterToolClient} computes synchronously. */
const SYNC_CLIENT_TOOLS = new Set([
  "hillshade",
  "slope",
  "aspect",
  "clip-extent",
  "reclassify",
  "raster-calc",
  "spectral-index",
  "focal",
]);

/** Whether a tool's primary input is a GeoJSON layer rather than a raster. */
export function rasterToolTakesVectorInput(toolId: string): boolean {
  return toolId === "interpolate" || toolId === "building-shadows";
}

async function toWgs84(fc: FeatureCollection, definition: string): Promise<FeatureCollection> {
  if (definition === "EPSG:4326") return { type: "FeatureCollection", features: fc.features };
  const fn = await crsTransform(definition, "EPSG:4326");
  return {
    type: "FeatureCollection",
    features: fc.features.map((f) => ({
      ...f,
      geometry: f.geometry ? mapGeometry(f.geometry, fn) : f.geometry,
    })),
  };
}

function requireRaster(inputs: ClientToolInputs, toolId: string): RasterData {
  if (!inputs.raster) throw new Error(`"${toolId}" needs an input raster.`);
  return inputs.raster;
}

function requireVector(inputs: ClientToolInputs, key: string, label: string): unknown {
  const v = inputs.vectors?.[key];
  if (v == null) throw new Error(`Choose the ${label} GeoJSON file.`);
  return v;
}

function requireSecondary(inputs: ClientToolInputs, key: string, label: string): RasterData {
  const r = inputs.rasters?.[key];
  if (!r) throw new Error(`Choose the ${label} raster.`);
  return r;
}

/**
 * Progress of a long client tool run. Only the steps that can take seconds on
 * their own report it: today the sun positions of the Building shadows day
 * modes.
 */
export interface ClientToolProgress {
  /** What is being counted. */
  stage: "sun-positions";
  /** Steps finished so far. */
  done: number;
  /** Steps in the whole run. */
  total: number;
}

/** Options for {@link runRasterToolClientAsync}. */
export interface ClientToolRunOptions {
  /** Called as a long run advances; see {@link ClientToolProgress}. */
  onProgress?: (progress: ClientToolProgress) => void;
}

/**
 * Run any raster tool in the browser and return a raster (with encoded
 * GeoTIFF bytes) or a vector result. Tools that need a CRS resolve it from the
 * raster's GeoKeys; GeoJSON inputs follow the sidecar's convention (a legacy
 * `crs` member, else WGS84).
 *
 * This runs on the calling thread; the Raster tools dialog goes through
 * `runRasterToolInBackground` (raster-tool-runner.ts), which runs it on a Web
 * Worker.
 *
 * @param toolId - The raster tool id.
 * @param inputs - The decoded rasters and parsed GeoJSON inputs.
 * @param parameters - The tool parameters.
 * @param options - Progress reporting.
 * @returns The raster or vector result.
 */
export async function runRasterToolClientAsync(
  toolId: string,
  inputs: ClientToolInputs,
  parameters: Record<string, unknown>,
  options: ClientToolRunOptions = {},
): Promise<ClientToolResult> {
  if (SYNC_CLIENT_TOOLS.has(toolId)) {
    const { raster, bytes, messages, detailMessages } = runRasterToolClient(
      toolId,
      requireRaster(inputs, toolId),
      parameters,
      inputs.rasters,
    );
    return { kind: "raster", raster, bytes, messages, detailMessages };
  }
  const messages: string[] = [];
  if (inputs.raster) {
    messages.push(
      `Loaded raster: ${inputs.raster.width}×${inputs.raster.height}, ${inputs.raster.bands.length} band(s).`,
    );
  }
  const rasterResult = (
    raster: RasterData,
    extra: string[] = [],
  ): Extract<ClientToolResult, { kind: "raster" }> => {
    messages.push(...extra, `Computed "${toolId}" in the browser.`);
    return {
      kind: "raster",
      raster,
      bytes: writeRasterBands(raster),
      messages,
      detailMessages: extra,
    };
  };
  const vectorResult = async (
    geojson: FeatureCollection,
    definition: string | null,
    extra: string[],
    exportWgs84 = false,
  ): Promise<ClientToolResult> => {
    messages.push(...extra, `Computed "${toolId}" in the browser.`);
    const detailMessages = [...extra];
    const diagnostic = (line: string): void => {
      messages.push(line);
      detailMessages.push(line);
    };
    const wgs84 = definition ? await toWgs84(geojson, definition) : null;
    const download =
      exportWgs84 && wgs84 ? wgs84 : definition ? geojson : { ...geojson, crs: null };
    if (!definition)
      diagnostic(
        "The raster has no CRS. The vector download retains unreferenced coordinates and is not added to the map.",
      );
    else if (exportWgs84)
      diagnostic(
        "The source uses a custom CRS. The vector download is transformed to WGS84 (EPSG:4326).",
      );
    return {
      kind: "vector",
      geojson: download,
      wgs84,
      messages,
      detailMessages,
    };
  };
  const p = parameters;
  switch (toolId) {
    case "reproject":
      return rasterResult(
        await reprojectRaster(requireRaster(inputs, toolId), {
          dst_crs: String(p.dst_crs ?? ""),
          resampling: (p.resampling as string) ?? "nearest",
        }),
        [`Reprojected to ${String(p.dst_crs)}.`],
      );
    case "resample":
      return rasterResult(
        resampleRaster(requireRaster(inputs, toolId), {
          resolution: Number(p.resolution),
          resampling: (p.resampling as string) ?? "bilinear",
        }),
      );
    case "clip-mask": {
      const out = await clipRasterByMask(
        requireRaster(inputs, toolId),
        requireVector(inputs, "mask_path", "mask"),
        { crop: p.crop !== false, all_touched: p.all_touched === true },
      );
      return rasterResult(out.raster, out.messages);
    }
    case "mosaic": {
      const extras = ["raster_2", "raster_3", "raster_4", "raster_5"]
        .map((k) => inputs.rasters?.[k])
        .filter((r): r is RasterData => r != null);
      const out = mosaicRasters([requireRaster(inputs, toolId), ...extras], p.method);
      return rasterResult(out.raster, [...out.messages, `Merged ${extras.length + 1} rasters.`]);
    }
    case "interpolate": {
      const out = await interpolatePoints(requireVector(inputs, "input", "point"), p as never);
      return rasterResult(out.raster, out.messages);
    }
    case "polygonize":
    case "contour": {
      const raster = requireRaster(inputs, toolId);
      // Resolve a declared CRS before computing; unknown image coordinates
      // remain useful for download but must not be placed on a geographic map.
      const keys = raster.geoKeys ?? {};
      const hasCrs =
        [1, 2, 3].includes(Number(keys.GTModelTypeGeoKey)) ||
        Object.keys(keys).some((key) => /^(?:Projected|Geographic|Geog|Proj)/.test(key));
      const definition = hasCrs ? await rasterCrsDefinition(raster, toolId) : null;
      const out =
        toolId === "polygonize"
          ? polygonizeRaster(raster, p as never)
          : contourRaster(raster, p as never);
      return vectorResult(
        out.geojson,
        definition,
        out.messages,
        definition !== null && rasterEpsg(raster) === null,
      );
    }
    case "zonal": {
      const zones = requireVector(inputs, "zones_path", "zones");
      const out = await zonalStatistics(requireRaster(inputs, toolId), zones, p as never);
      return vectorResult(out.geojson, await epsgDefinition(geojsonEpsg(zones)), out.messages);
    }
    case "change-difference": {
      const out = bandDifference(
        requireRaster(inputs, toolId),
        requireSecondary(inputs, "after_path", "after"),
        p as never,
      );
      return rasterResult(out.raster, out.messages);
    }
    case "ndvi-change": {
      const out = ndviChange(
        requireRaster(inputs, toolId),
        requireSecondary(inputs, "after_path", "after"),
        p as never,
      );
      return rasterResult(out.raster, out.messages);
    }
    case "transition-matrix": {
      const out = transitionMatrix(
        requireRaster(inputs, toolId),
        requireSecondary(inputs, "after_path", "after"),
        p as never,
      );
      messages.push(...out.messages, `Computed "${toolId}" in the browser.`);
      return {
        kind: "raster",
        raster: out.raster,
        bytes: writeRasterBands(out.raster),
        messages,
        detailMessages: out.messages,
        matrix: out.matrix,
      };
    }
    case "sar-db":
      return rasterResult(sarDbConvert(requireRaster(inputs, toolId), p as never));
    case "speckle-filter": {
      const out = speckleFilter(requireRaster(inputs, toolId), p as never);
      return rasterResult(out.raster, out.messages);
    }
    case "sar-rgb": {
      const out = dualPolRgb(
        requireRaster(inputs, toolId),
        inputs.rasters?.vh_path ?? null,
        p as never,
      );
      return rasterResult(out.raster, out.messages);
    }
    case "flood-map": {
      const out = floodMap(
        requireRaster(inputs, toolId),
        inputs.rasters?.pre_path ?? null,
        p as never,
      );
      return rasterResult(out.raster, out.messages);
    }
    case "cut-fill": {
      const looksLikeLonLat = (r: RasterData) =>
        r.originX >= -180 &&
        r.originX + r.width * r.resX <= 360 &&
        r.originY <= 90 &&
        r.originY - r.height * r.resY >= -90;
      // North-up first: the area-scale lattice is indexed by north-up rows.
      let existing = toNorthUp(requireRaster(inputs, toolId));
      let surface =
        p.reference === "surface"
          ? requireSecondary(inputs, "surface_path", "reference surface")
          : null;
      const extra: string[] = [];
      const boundary = inputs.vectors?.boundary_path;
      if (boundary != null) {
        // Both surfaces share a grid, so the same mask crops them to the same
        // window and they stay aligned.
        const clipped = await clipRasterByMask(existing, boundary, { crop: true });
        existing = clipped.raster;
        extra.push(...clipped.messages);
        if (surface) surface = (await clipRasterByMask(surface, boundary, { crop: true })).raster;
      }
      let metersPerUnit = 1;
      let areaScale: ((row: number, col: number) => number) | null = null;
      if (!isGeographicRaster(existing)) {
        let definition: string | null = null;
        try {
          definition = await rasterCrsDefinition(existing, "cut-fill");
        } catch (error) {
          // A raster tagged with a projected CRS that cannot be resolved has
          // an unknown unit and distortion; guessing metres could be off by
          // 10x for a feet grid, so stop. Only untagged rasters fall through.
          const keys = existing.geoKeys ?? {};
          if (keys.ProjectedCSTypeGeoKey != null || keys.ProjCoordTransGeoKey != null) throw error;
          definition = null;
        }
        const resolved = projectedMetersPerUnit(existing, definition);
        if (resolved != null) metersPerUnit = resolved;
        if (definition) {
          // The projection's own area distortion, via its inverse.
          try {
            const inverse = await crsTransform(definition, "EPSG:4326");
            const projected = projectedAreaScale(existing, inverse, metersPerUnit);
            areaScale = projected.scaleAt;
            if (projected.failedNodes > 0) {
              extra.push(
                `Warning: ${projected.failedNodes} sample point(s) could not be inverse-projected (outside the projection's valid area?); cells near them use no area correction.`,
              );
            }
          } catch {
            extra.push(
              "Warning: the raster's CRS could not be inverse-projected; cell sizes are taken with no projection correction.",
            );
          }
        } else if (
          existing.resX < 0.1 &&
          existing.resY < 0.1 &&
          looksLikeLonLat(existing) &&
          (Math.abs(existing.originX) > 1 || Math.abs(existing.originY) > 1)
        ) {
          // Sub-0.1 cells inside the lon/lat range, away from a local grid's
          // (0, 0) origin, are almost certainly degrees with no CRS tag (arc-
          // second to arc-minute DEMs); treating them as metres would
          // understate volume by about 10^10.
          throw new Error(
            "The raster has no usable CRS and its cell size looks like degrees, so cell areas cannot be computed. Assign a CRS first.",
          );
        } else if (existing.resX < 1 && existing.resY < 1 && looksLikeLonLat(existing)) {
          extra.push(
            "Warning: the raster has no usable CRS and its cells may be degrees; if they are, these totals are unusable, so assign a CRS.",
          );
        } else {
          extra.push(
            "Warning: the raster's CRS could not be resolved; cell sizes use its linear unit (metres if none) with no projection correction.",
          );
        }
      }
      const out = cutFill(existing, surface, p as CutFillParams, metersPerUnit, areaScale);
      return { ...rasterResult(out.raster, [...extra, ...out.messages]), cutFill: out.summary };
    }
    case "building-shadows": {
      const buildings = requireVector(inputs, "input", "buildings");
      const epsg = geojsonEpsg(buildings);
      const collection: FeatureCollection = {
        type: "FeatureCollection",
        features: geojsonFeatures(buildings),
      };
      // The shadow grid is built in lon/lat; a projected input is brought there first.
      const wgs84 =
        epsg === 4326 ? collection : await toWgs84(collection, await epsgDefinition(epsg));
      const { onProgress } = options;
      const out = buildingShadows(wgs84.features, p as BuildingShadowParams, {
        onProgress: onProgress
          ? (done, total) => onProgress({ stage: "sun-positions", done, total })
          : undefined,
      });
      return rasterResult(out.raster, out.messages);
    }
    default:
      throw new Error(`"${toolId}" has no client-side implementation.`);
  }
}
