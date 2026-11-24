import type { RasterData } from "./raster-client";
import { toNorthUp } from "./raster-geo";
import { SENSOR_IDS, SENSOR_PRESETS } from "./spectral-indices";

/**
 * Bi-temporal change detection in the browser: band differencing, NDVI change
 * with a threshold, and a categorical transition matrix. Each tool takes a
 * "before" and an "after" raster on the same pixel grid (reproject/resample
 * one onto the other first) and treats NoData in either date as NoData.
 */

/** NoData written by the change tools. */
export const CHANGE_NODATA = -9999;

function valid(v: number, nodata: number | null): boolean {
  return Number.isFinite(v) && (nodata == null || v !== nodata);
}

/**
 * Throw unless two rasters share size, origin and pixel size (to a thousandth
 * of a pixel), which pixel-wise comparison needs.
 */
export function assertSameGrid(a: RasterData, b: RasterData, what: string): void {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(
      `The ${what} raster is ${b.width}x${b.height} but the first is ${a.width}x${a.height}; resample or clip them onto the same grid first.`,
    );
  }
  const tolX = 1e-3 * a.resX;
  const tolY = 1e-3 * a.resY;
  if (
    Math.abs(a.originX - b.originX) > tolX ||
    Math.abs(a.originY - b.originY) > tolY ||
    Math.abs(a.resX - b.resX) * a.width > tolX ||
    Math.abs(a.resY - b.resY) * a.height > tolY
  ) {
    throw new Error(
      `The ${what} raster is not on the same pixel grid as the first; reproject or resample it first.`,
    );
  }
}

function pickBand(raster: RasterData, band: number, label: string): Float32Array {
  const b = raster.bands[band - 1];
  if (!b) {
    throw new Error(`${label} has no band ${band} (it has ${raster.bands.length} band(s)).`);
  }
  return b;
}

export type DifferenceMode = "difference" | "percent" | "ratio" | "log-ratio";

export interface BandDifferenceParams {
  band?: number;
  mode?: DifferenceMode | string;
  output?: "continuous" | "classified" | string;
  threshold?: number;
}

/**
 * Per-pixel change between two dates of one band: `after - before`, percent
 * change, ratio, or log ratio (`10 * log10(after / before)`, the usual SAR
 * change metric in dB). With `output: "classified"` the change is thresholded
 * into -1 (decrease beyond `threshold`), 0 (no change) and 1 (increase).
 */
export function bandDifference(
  beforeInput: RasterData,
  afterInput: RasterData,
  params: BandDifferenceParams,
): { raster: RasterData; messages: string[] } {
  const before = toNorthUp(beforeInput);
  const after = toNorthUp(afterInput);
  assertSameGrid(before, after, "after");
  const bandNo = Math.trunc(Number(params.band ?? 1)) || 1;
  const a = pickBand(before, bandNo, "The before raster");
  const b = pickBand(after, bandNo, "The after raster");
  const mode = String(params.mode ?? "difference") as DifferenceMode;
  if (!["difference", "percent", "ratio", "log-ratio"].includes(mode)) {
    throw new Error(`Unknown change mode: ${mode}`);
  }
  const classified = params.output === "classified";
  const threshold = Number(params.threshold ?? 0);
  if (classified && !(threshold >= 0)) throw new Error("The change threshold must be >= 0.");
  // A ratio's "no change" is 1, every other metric's is 0.
  const neutral = mode === "ratio" ? 1 : 0;
  const out = new Float32Array(a.length);
  let inc = 0;
  let dec = 0;
  let same = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (!valid(x, before.nodata) || !valid(y, after.nodata)) {
      out[i] = CHANGE_NODATA;
      continue;
    }
    let v: number;
    if (mode === "difference") v = y - x;
    else if (mode === "percent") v = x === 0 ? Number.NaN : ((y - x) / Math.abs(x)) * 100;
    else if (mode === "ratio") v = x === 0 ? Number.NaN : y / x;
    else v = x > 0 && y > 0 ? 10 * Math.log10(y / x) : Number.NaN;
    if (!Number.isFinite(v)) {
      out[i] = CHANGE_NODATA;
      continue;
    }
    if (classified) {
      const d = v - neutral;
      const cls = d > threshold ? 1 : d < -threshold ? -1 : 0;
      if (cls > 0) inc += 1;
      else if (cls < 0) dec += 1;
      else same += 1;
      out[i] = cls;
    } else {
      out[i] = v;
    }
  }
  const messages = [`Change metric: ${mode} (after vs before, band ${bandNo}).`];
  if (classified) {
    messages.push(
      `Increase: ${inc} px, decrease: ${dec} px, no change: ${same} px (threshold ${threshold}).`,
    );
  }
  return {
    raster: { ...before, bands: [out], nodata: CHANGE_NODATA },
    messages,
  };
}

export interface NdviChangeParams {
  sensor?: string;
  red?: number;
  nir?: number;
  output?: "difference" | "classified" | string;
  threshold?: number;
}

function ndviBands(params: NdviChangeParams): { red: number; nir: number } {
  const sensor = String(params.sensor ?? "sentinel2");
  if (!(SENSOR_IDS as readonly string[]).includes(sensor)) {
    throw new Error(`Unknown sensor preset: ${sensor}`);
  }
  const preset = SENSOR_PRESETS[sensor as (typeof SENSOR_IDS)[number]];
  const red = sensor === "custom" ? Number(params.red) : preset.red;
  const nir = sensor === "custom" ? Number(params.nir) : preset.nir;
  for (const [name, band] of [
    ["red", red],
    ["nir", nir],
  ] as const) {
    if (!Number.isInteger(band) || (band as number) < 1) {
      throw new Error(`Set the ${name} band number (a whole number >= 1) for the Custom sensor.`);
    }
  }
  return { red: red as number, nir: nir as number };
}

/**
 * NDVI change between two multiband images: `NDVI(after) - NDVI(before)`,
 * optionally classified into -1 (vegetation loss: dNDVI < -threshold),
 * 0 (stable) and 1 (gain: dNDVI > threshold).
 */
export function ndviChange(
  beforeInput: RasterData,
  afterInput: RasterData,
  params: NdviChangeParams,
): { raster: RasterData; messages: string[] } {
  const before = toNorthUp(beforeInput);
  const after = toNorthUp(afterInput);
  assertSameGrid(before, after, "after");
  const { red, nir } = ndviBands(params);
  const r0 = pickBand(before, red, "The before raster");
  const n0 = pickBand(before, nir, "The before raster");
  const r1 = pickBand(after, red, "The after raster");
  const n1 = pickBand(after, nir, "The after raster");
  const classified = params.output === "classified";
  const threshold = Number(params.threshold ?? 0.2);
  if (classified && !(threshold >= 0)) throw new Error("The NDVI threshold must be >= 0.");
  const ndvi = (r: number, n: number) => (n + r === 0 ? Number.NaN : (n - r) / (n + r));
  const out = new Float32Array(r0.length);
  let loss = 0;
  let gain = 0;
  let stable = 0;
  for (let i = 0; i < out.length; i += 1) {
    if (
      !valid(r0[i], before.nodata) ||
      !valid(n0[i], before.nodata) ||
      !valid(r1[i], after.nodata) ||
      !valid(n1[i], after.nodata)
    ) {
      out[i] = CHANGE_NODATA;
      continue;
    }
    const d = ndvi(r1[i], n1[i]) - ndvi(r0[i], n0[i]);
    if (!Number.isFinite(d)) {
      out[i] = CHANGE_NODATA;
      continue;
    }
    if (classified) {
      const cls = d > threshold ? 1 : d < -threshold ? -1 : 0;
      if (cls > 0) gain += 1;
      else if (cls < 0) loss += 1;
      else stable += 1;
      out[i] = cls;
    } else {
      out[i] = d;
    }
  }
  const messages = [`NDVI bands: red ${red}, NIR ${nir}.`];
  if (classified) {
    messages.push(
      `Vegetation loss: ${loss} px, gain: ${gain} px, stable: ${stable} px (threshold ${threshold}).`,
    );
  }
  return {
    raster: { ...before, bands: [out], nodata: CHANGE_NODATA },
    messages,
  };
}

/** The from/to class transition counts between two categorical rasters. */
export interface TransitionMatrix {
  /** Sorted class values seen in either date. */
  classes: number[];
  /** `counts[i][j]`: pixels that went from `classes[i]` to `classes[j]`. */
  counts: number[][];
  /** Pixels valid in both dates. */
  total: number;
  /** Multiplier of the output code: `code = from * multiplier + to`. */
  multiplier: number;
}

const MAX_TRANSITION_CLASSES = 256;

export interface TransitionParams {
  band?: number;
}

/**
 * Cross-tabulate two categorical (integer class) rasters. Returns the
 * transition matrix and a raster coding each pixel as
 * `from * multiplier + to`, where `multiplier` is the smallest power of ten
 * above every class value (so 3 -> 5 with classes up to 9 reads as 35).
 */
export function transitionMatrix(
  beforeInput: RasterData,
  afterInput: RasterData,
  params: TransitionParams,
): { raster: RasterData; matrix: TransitionMatrix; messages: string[] } {
  const before = toNorthUp(beforeInput);
  const after = toNorthUp(afterInput);
  assertSameGrid(before, after, "after");
  const bandNo = Math.trunc(Number(params.band ?? 1)) || 1;
  const a = pickBand(before, bandNo, "The before raster");
  const b = pickBand(after, bandNo, "The after raster");
  const seen = new Set<number>();
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (!valid(x, before.nodata) || !valid(y, after.nodata)) continue;
    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      throw new Error(
        "Transition matrix needs integer class rasters; reclassify continuous values first.",
      );
    }
    if (x < 0 || y < 0) {
      throw new Error("Transition matrix needs non-negative class values.");
    }
    seen.add(x);
    seen.add(y);
    if (seen.size > MAX_TRANSITION_CLASSES) {
      throw new Error(`More than ${MAX_TRANSITION_CLASSES} classes; reclassify the rasters first.`);
    }
  }
  if (!seen.size) throw new Error("The two rasters have no overlapping valid pixels.");
  const classes = [...seen].sort((p, q) => p - q);
  const index = new Map(classes.map((c, i) => [c, i]));
  const maxClass = classes[classes.length - 1];
  const multiplier = 10 ** Math.max(1, Math.ceil(Math.log10(maxClass + 1)));
  if (!Number.isSafeInteger(multiplier) || maxClass * multiplier + maxClass > 16_777_216)
    throw new Error(
      "Transition codes exceed the exact Float32 integer range. Reclassify to smaller non-negative integers first.",
    );
  const counts = classes.map(() => classes.map(() => 0));
  const out = new Float32Array(a.length);
  let total = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (!valid(x, before.nodata) || !valid(y, after.nodata)) {
      out[i] = CHANGE_NODATA;
      continue;
    }
    counts[index.get(x)!][index.get(y)!] += 1;
    out[i] = x * multiplier + y;
    total += 1;
  }
  const matrix: TransitionMatrix = { classes, counts, total, multiplier };
  return {
    raster: { ...before, bands: [out], nodata: CHANGE_NODATA },
    matrix,
    messages: formatTransitionMatrix(matrix),
  };
}

/** Render a transition matrix as log lines (a CSV-style table plus a summary). */
export function formatTransitionMatrix(matrix: TransitionMatrix): string[] {
  const { classes, counts, total, multiplier } = matrix;
  let changed = 0;
  counts.forEach((row, i) =>
    row.forEach((n, j) => {
      if (i !== j) changed += n;
    }),
  );
  const pct = total ? ((100 * changed) / total).toFixed(2) : "0.00";
  const lines = [
    `Transition code = from x ${multiplier} + to. ${changed} of ${total} px changed class (${pct}%).`,
    `from\\to,${classes.join(",")}`,
  ];
  classes.forEach((c, i) => lines.push(`${c},${counts[i].join(",")}`));
  return lines;
}
