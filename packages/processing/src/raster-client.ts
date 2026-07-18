import { fromArrayBuffer, writeArrayBuffer } from "geotiff";
import type { RasterToolId } from "./raster-tools";
import { buildSpectralIndexExpression } from "./spectral-indices";

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
 * intended as a convenience fallback; for production-grade results (proper
 * geographic-CRS scaling, large rasters, multi-raster band math) prefer the
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
  /** NoData value, or null when the source declares none. */
  nodata: number | null;
  /** GeoTIFF GeoKeys carried through to the output so the CRS is preserved. */
  geoKeys: Record<string, unknown>;
}

/** The raster tools that have an in-browser implementation. */
export const CLIENT_RASTER_TOOL_IDS: ReadonlySet<RasterToolId> = new Set<RasterToolId>([
  "hillshade",
  "slope",
  "aspect",
  "clip-extent",
  "reclassify",
  "raster-calc",
  "spectral-index",
  "focal",
]);

/** Whether a tool can run in the browser without the sidecar. */
export function supportsClientRaster(id: string): boolean {
  return CLIENT_RASTER_TOOL_IDS.has(id as RasterToolId);
}

// --- GeoTIFF I/O -----------------------------------------------------------

/** GeoKeys the writer understands; copied from the source to keep the CRS. */
const PRESERVED_GEO_KEYS = [
  "GTModelTypeGeoKey",
  "GTRasterTypeGeoKey",
  "GeographicTypeGeoKey",
  "ProjectedCSTypeGeoKey",
  "GeogCitationGeoKey",
  "GTCitationGeoKey",
] as const;

/**
 * Upper bound on the Float32 pixel buffers the client engine will allocate
 * (512 MB). Larger rasters should use the sidecar, which streams from disk.
 */
const MAX_CLIENT_RASTER_BYTES = 512 * 1024 * 1024;

/** Decode GeoTIFF bytes into a {@link RasterData}. */
export async function readRasterData(bytes: ArrayBuffer): Promise<RasterData> {
  const tiff = await fromArrayBuffer(bytes);
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  // Guard against decoding a raster too large to hold in browser memory before
  // we materialize the band arrays (which would freeze or OOM the tab).
  const estimatedBytes =
    width * height * image.getSamplesPerPixel() * Float32Array.BYTES_PER_ELEMENT;
  if (!Number.isFinite(estimatedBytes) || estimatedBytes > MAX_CLIENT_RASTER_BYTES) {
    throw new Error(
      "This raster is too large for the in-browser engine. Use the sidecar (rasterio/GDAL) engine instead.",
    );
  }
  const [originX, originY] = image.getOrigin();
  const [resolutionX, resolutionY] = image.getResolution();

  const result = await image.readRasters();
  const rawBands = (Array.isArray(result) ? result : [result]) as ArrayLike<number>[];
  const bands = rawBands.map((band) => Float32Array.from(band));

  const noData = image.getGDALNoData();
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
    nodata: noData != null && Number.isFinite(noData) ? noData : null,
    geoKeys: (image.getGeoKeys() as Record<string, unknown>) ?? {},
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
  const bandCount = raster.bands.length;
  // Interleave bands into a single flat array the writer can consume (it infers
  // band count from `values.length / (width * height)`).
  let values: Float32Array;
  if (bandCount === 1) {
    values = raster.bands[0];
  } else {
    const pixels = raster.width * raster.height;
    values = new Float32Array(pixels * bandCount);
    for (let p = 0; p < pixels; p += 1) {
      for (let b = 0; b < bandCount; b += 1) {
        values[p * bandCount + b] = raster.bands[b][p];
      }
    }
  }

  const metadata: Record<string, unknown> = {
    width: raster.width,
    height: raster.height,
    ModelPixelScale: [raster.resX, raster.resY, 0],
    ModelTiepoint: [0, 0, 0, raster.originX, raster.originY, 0],
  };
  if (raster.nodata != null) metadata.GDAL_NODATA = String(raster.nodata);
  for (const key of PRESERVED_GEO_KEYS) {
    const value = raster.geoKeys[key];
    if (value != null) metadata[key] = value;
  }

  // The geotiff writer's metadata type is broad; the runtime accepts the fields
  // set above (it derives SampleFormat/BitsPerSample from the Float32Array).
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

export interface HillshadeParams {
  azimuth?: number;
  altitude?: number;
  z_factor?: number;
}

/** Shaded relief (0–255) via the ESRI/GDAL hillshade formula (Horn's method). */
export function hillshade(input: RasterData, params: HillshadeParams): RasterData {
  const band = input.bands[0];
  const { width, height, resX, resY, nodata } = input;
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
  const { width, height, resX, resY, nodata } = input;
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
  const { width, height, resX, resY, nodata } = input;

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
}

/**
 * Evaluate a single-input NumPy-style band-math expression. Band 1 is `A`;
 * specific bands are `A1`, `A2`, …. Multi-raster references (B, C) are not
 * supported in the browser; use the sidecar for those.
 */
export function rasterCalc(input: RasterData, params: RasterCalcParams): RasterData {
  const expr = params.expression.trim();
  if (!expr) throw new Error("Enter an expression.");
  // Allowlist the expression before handing it to `new Function` below: only
  // band refs (A, A1, A2…), the named math helpers, and numeric/arithmetic
  // tokens are permitted. This routes multi-raster math (B, C) to the sidecar
  // AND prevents the evaluated expression from reaching browser globals
  // (fetch, document, globalThis…) — important for shared Jupyter embeds.
  const HELPERS_RE = /\b(?:where|clip|log|exp|sqrt|abs|minimum|maximum|sin|cos|tan)\b/g;
  const withoutBands = expr.replace(HELPERS_RE, " ").replace(/\bA\d*\b/g, " ");
  if (/\b[B-Z]\d*\b/.test(withoutBands)) {
    throw new Error(
      "The client raster calculator supports a single input (A, A1, A2 …). Use the sidecar engine for multi-raster math.",
    );
  }
  // Strip numeric literals (incl. scientific notation) and check nothing
  // identifier-like remains.
  const residual = withoutBands.replace(/\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, " ");
  if (/[A-Za-z$_]/.test(residual)) {
    throw new Error(
      "Expression contains unsupported identifiers. Only A, A1, A2 … and the math helpers " +
        "(where, clip, log, exp, sqrt, abs, minimum, maximum, sin, cos, tan) are allowed.",
    );
  }
  // After identifiers/numbers/band refs are removed, only arithmetic,
  // comparison, and logical operators, parentheses and commas may remain. This
  // also catches non-ASCII identifiers (e.g. Greek/CJK letters) that the ASCII
  // check above misses, and blocks bracket/property access — so "JSFuck"-style
  // payloads (which need `[` and `]`) can't reach `new Function`. `!` is allowed
  // for `!=`/`!` since brackets stay blocked.
  if (/[^\s+\-*/%(),<>=&|!]/.test(residual)) {
    throw new Error(
      "Expression contains unsupported characters. Only A, A1, A2 …, the math helpers, " +
        "numbers, and arithmetic/comparison operators are allowed.",
    );
  }

  const bandCount = input.bands.length;
  const argNames = ["A", ...input.bands.map((_, i) => `A${i + 1}`)];
  const helperNames = [
    "where",
    "clip",
    "log",
    "exp",
    "sqrt",
    "abs",
    "minimum",
    "maximum",
    "sin",
    "cos",
    "tan",
  ];
  let fn: (...args: number[]) => number;
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    fn = new Function(...argNames, ...helperNames, `"use strict"; return (${expr});`) as (
      ...args: number[]
    ) => number;
  } catch (error) {
    throw new Error(`Invalid expression: ${(error as Error).message}`);
  }
  const helpers = [
    (c: number, a: number, b: number) => (c ? a : b),
    (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi),
    Math.log,
    Math.exp,
    Math.sqrt,
    Math.abs,
    Math.min,
    Math.max,
    Math.sin,
    Math.cos,
    Math.tan,
  ];

  const pixels = input.width * input.height;
  const out = new Float32Array(pixels);
  const outNoData = input.nodata ?? TERRAIN_NODATA;
  const args = new Array<number>(bandCount + 1);
  for (let p = 0; p < pixels; p += 1) {
    let bad = false;
    for (let b = 0; b < bandCount; b += 1) {
      const v = input.bands[b][p];
      if (isNoData(v, input.nodata)) {
        bad = true;
        break;
      }
      args[b + 1] = v;
    }
    if (bad) {
      out[p] = outNoData;
      continue;
    }
    args[0] = args[1]; // A === band 1
    const value = fn(...args, ...(helpers as unknown as number[]));
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
      raster = rasterCalc(input, { expression: String(parameters.expression ?? "") });
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

  messages.push(`Computed "${toolId}" in the browser.`);
  return { raster, bytes: writeRasterBands(raster), messages };
}
