import { assertSameGrid } from "./raster-change";
import type { RasterData } from "./raster-client";
import { toNorthUp } from "./raster-geo";

/**
 * SAR (Sentinel-1) utilities that run in the browser: linear <-> dB
 * conversion, Lee and refined Lee speckle filters, a dual-pol (VV/VH) RGB
 * composite, and a threshold flood-mapping preset.
 *
 * Backscatter is a power quantity (sigma0/gamma0), so dB = 10 log10(x);
 * amplitude data uses 20 log10(x).
 */

export const SAR_NODATA = -9999;

function valid(v: number, nodata: number | null): boolean {
  return Number.isFinite(v) && (nodata == null || v !== nodata);
}

export interface DbConvertParams {
  direction?: "to-db" | "to-linear" | string;
  quantity?: "power" | "amplitude" | string;
}

/** Convert every band between linear units and decibels. */
export function sarDbConvert(input: RasterData, params: DbConvertParams): RasterData {
  const raster = toNorthUp(input);
  const toDb = (params.direction ?? "to-db") !== "to-linear";
  const factor = params.quantity === "amplitude" ? 20 : 10;
  const bands = raster.bands.map((band) => {
    const out = new Float32Array(band.length);
    for (let i = 0; i < band.length; i += 1) {
      const v = band[i];
      if (!valid(v, raster.nodata)) {
        out[i] = SAR_NODATA;
        continue;
      }
      // Zero/negative backscatter has no dB value (log of <= 0).
      const r = toDb ? (v > 0 ? factor * Math.log10(v) : Number.NaN) : 10 ** (v / factor);
      out[i] = Number.isFinite(r) ? r : SAR_NODATA;
    }
    return out;
  });
  return { ...raster, bands, nodata: SAR_NODATA };
}

/** Mean and population variance of the valid values in a window. */
function windowStats(
  band: Float64Array,
  ok: Uint8Array,
  width: number,
  height: number,
  cells: (r: number, c: number) => boolean,
  row: number,
  col: number,
  radius: number,
): { mean: number; variance: number; n: number } {
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let dr = -radius; dr <= radius; dr += 1) {
    const r = row + dr;
    if (r < 0 || r >= height) continue;
    for (let dc = -radius; dc <= radius; dc += 1) {
      const c = col + dc;
      if (c < 0 || c >= width || !cells(dr + radius, dc + radius)) continue;
      const i = r * width + c;
      if (!ok[i]) continue;
      sum += band[i];
      sumSq += band[i] * band[i];
      n += 1;
    }
  }
  if (!n) return { mean: Number.NaN, variance: Number.NaN, n };
  const mean = sum / n;
  return { mean, variance: Math.max(0, sumSq / n - mean * mean), n };
}

/**
 * Lee's minimum mean-square-error weight for multiplicative speckle:
 * `var_x = (var - mean^2 Cu^2) / (1 + Cu^2)`, `b = var_x / var` (clamped to
 * [0, 1]); the estimate is `mean + b (x - mean)`. `cu2 = 1 / ENL`.
 */
function leeEstimate(x: number, mean: number, variance: number, cu2: number): number {
  if (!(variance > 0)) return mean;
  const varX = Math.max(0, (variance - mean * mean * cu2) / (1 + cu2));
  const b = Math.min(1, varX / variance);
  return mean + b * (x - mean);
}

export interface SpeckleParams {
  method?: "lee" | "refined-lee" | string;
  size?: number;
  enl?: number;
  units?: "linear" | "db" | string;
}

/**
 * Speckle-filter every band. `lee` is the classic Lee (1980) filter over a
 * square window; `refined-lee` is Lee's (1981) edge-aligned filter: a 7x7
 * window is split into 3x3 sub-windows, the strongest of four edge gradients
 * picks a direction, and the statistics come from the half (or triangular
 * half) of the window on the pixel's side of that edge. Filtering happens in
 * linear power; dB input is converted and converted back.
 */
export function speckleFilter(
  input: RasterData,
  params: SpeckleParams,
): { raster: RasterData; messages: string[] } {
  const raster = toNorthUp(input);
  const method = String(params.method ?? "refined-lee");
  if (method !== "lee" && method !== "refined-lee") {
    throw new Error(`Unknown speckle filter: ${method}`);
  }
  const enl = Number(params.enl ?? 4.4);
  if (!(enl > 0)) throw new Error("The number of looks (ENL) must be > 0.");
  const cu2 = 1 / enl;
  let size = Math.max(3, Math.min(15, Math.round(Number(params.size ?? 7))));
  if (size % 2 === 0) size += 1;
  const db = params.units === "db";
  const { width, height } = raster;
  if (width * height * (method === "lee" ? size * size : 49 * 2) > 600_000_000) {
    throw new Error(
      "This raster is too large to speckle-filter in the browser; clip it to the area of interest first.",
    );
  }
  const bands = raster.bands.map((src) => {
    const n = src.length;
    const lin = new Float64Array(n);
    const ok = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) {
      const v = src[i];
      if (!valid(v, raster.nodata)) continue;
      const x = db ? 10 ** (v / 10) : v;
      if (!Number.isFinite(x)) continue;
      lin[i] = x;
      ok[i] = 1;
    }
    const filtered =
      method === "lee"
        ? leeFilter(lin, ok, width, height, size, cu2)
        : refinedLeeFilter(lin, ok, width, height, cu2);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      const v = filtered[i];
      if (!ok[i] || !Number.isFinite(v)) {
        out[i] = SAR_NODATA;
        continue;
      }
      out[i] = db ? (v > 0 ? 10 * Math.log10(v) : SAR_NODATA) : v;
    }
    return out;
  });
  return {
    raster: { ...raster, bands, nodata: SAR_NODATA },
    messages: [
      method === "lee"
        ? `Lee filter, ${size}x${size} window, ENL ${enl}.`
        : `Refined Lee filter (7x7 edge-aligned windows), ENL ${enl}.`,
    ],
  };
}

function leeFilter(
  band: Float64Array,
  ok: Uint8Array,
  width: number,
  height: number,
  size: number,
  cu2: number,
): Float64Array {
  const radius = (size - 1) / 2;
  const out = new Float64Array(band.length);
  const all = () => true;
  for (let r = 0; r < height; r += 1) {
    for (let c = 0; c < width; c += 1) {
      const i = r * width + c;
      if (!ok[i]) continue;
      const { mean, variance } = windowStats(band, ok, width, height, all, r, c, radius);
      out[i] = leeEstimate(band[i], mean, variance, cu2);
    }
  }
  return out;
}

/**
 * The eight 7x7 directional windows of the refined Lee filter, indexed
 * [row][col] with the centre at (3, 3). Each includes the dividing line.
 */
const REFINED_LEE_WINDOWS: Record<string, (r: number, c: number) => boolean> = {
  top: (r) => r <= 3,
  bottom: (r) => r >= 3,
  left: (_r, c) => c <= 3,
  right: (_r, c) => c >= 3,
  // Triangular halves on each side of a diagonal.
  topLeft: (r, c) => r + c <= 6,
  bottomRight: (r, c) => r + c >= 6,
  topRight: (r, c) => c >= r,
  bottomLeft: (r, c) => r >= c,
};

function refinedLeeFilter(
  band: Float64Array,
  ok: Uint8Array,
  width: number,
  height: number,
  cu2: number,
): Float64Array {
  // 3x3 means of every pixel, reused for the 9 sub-windows of each 7x7 window.
  const mean3 = new Float64Array(band.length);
  const all = () => true;
  for (let r = 0; r < height; r += 1) {
    for (let c = 0; c < width; c += 1) {
      mean3[r * width + c] = windowStats(band, ok, width, height, all, r, c, 1).mean;
    }
  }
  const out = new Float64Array(band.length);
  const sub = (r: number, c: number): number => {
    const rr = Math.min(height - 1, Math.max(0, r));
    const cc = Math.min(width - 1, Math.max(0, c));
    return mean3[rr * width + cc];
  };
  for (let r = 0; r < height; r += 1) {
    for (let c = 0; c < width; c += 1) {
      const i = r * width + c;
      if (!ok[i]) continue;
      // Sub-window means s[k], k = row-major over offsets (-2, 0, 2).
      const s: number[] = [];
      for (const dr of [-2, 0, 2]) for (const dc of [-2, 0, 2]) s.push(sub(r + dr, c + dc));
      const centre = s[4];
      // Lee's (1981) edge masks on the 3x3 grid of sub-window means, each with
      // the two sub-windows that stand for its sides. Orthogonal edges come
      // first so they win ties.
      const pairs: [number, number, string, string, number][] = [
        [3, 5, "left", "right", s[0] + s[3] + s[6] - (s[2] + s[5] + s[8])],
        [1, 7, "top", "bottom", s[0] + s[1] + s[2] - (s[6] + s[7] + s[8])],
        [0, 8, "topLeft", "bottomRight", s[0] + s[1] + s[3] - (s[5] + s[7] + s[8])],
        [2, 6, "topRight", "bottomLeft", s[1] + s[2] + s[5] - (s[3] + s[6] + s[7])],
      ];
      let best = -1;
      let bestGrad = -Infinity;
      pairs.forEach(([, , , , diff], k) => {
        const g = Math.abs(diff);
        if (Number.isFinite(g) && g > bestGrad) {
          bestGrad = g;
          best = k;
        }
      });
      let window = (_r: number, _c: number) => true;
      if (best >= 0) {
        const [p, q, sideP, sideQ] = pairs[best];
        // Keep the half on the side whose sub-window mean is closer to the centre.
        const side = Math.abs(s[p] - centre) <= Math.abs(s[q] - centre) ? sideP : sideQ;
        window = REFINED_LEE_WINDOWS[side];
      }
      const { mean, variance } = windowStats(band, ok, width, height, window, r, c, 3);
      out[i] = leeEstimate(band[i], mean, variance, cu2);
    }
  }
  return out;
}

export interface DualPolRgbParams {
  units?: "linear" | "db" | string;
  vv_band?: number;
  vh_band?: number;
  vv_min?: number;
  vv_max?: number;
  vh_min?: number;
  vh_max?: number;
  ratio_min?: number;
  ratio_max?: number;
}

/**
 * Sentinel-1 dual-pol false colour: R = VV (dB), G = VH (dB),
 * B = VV/VH ratio (VV dB - VH dB), each stretched linearly to 1..255 over the
 * given dB ranges (0 is reserved for NoData).
 */
export function dualPolRgb(
  vvInput: RasterData,
  vhInput: RasterData | null,
  params: DualPolRgbParams,
): { raster: RasterData; messages: string[] } {
  const vvRaster = toNorthUp(vvInput);
  const vvBand = Math.trunc(Number(params.vv_band ?? 1)) || 1;
  const vv = vvRaster.bands[vvBand - 1];
  if (!vv) throw new Error(`The VV raster has no band ${vvBand}.`);
  let vh: Float32Array | undefined;
  let vhNodata = vvRaster.nodata;
  if (vhInput) {
    const vhRaster = toNorthUp(vhInput);
    assertSameGrid(vvRaster, vhRaster, "VH");
    vh = vhRaster.bands[(Math.trunc(Number(params.vh_band ?? 1)) || 1) - 1];
    vhNodata = vhRaster.nodata;
  } else {
    const idx = Math.trunc(Number(params.vh_band ?? 2)) || 2;
    vh = vvRaster.bands[idx - 1];
    if (!vh) {
      throw new Error(
        `The raster has no band ${idx} for VH; pick a separate VH raster or set the VH band.`,
      );
    }
  }
  if (!vh) throw new Error("The VH raster has no such band.");
  const db = params.units === "db";
  const range = (lo: unknown, hi: unknown, dLo: number, dHi: number): [number, number] => {
    const a = lo === "" || lo == null ? dLo : Number(lo);
    const b = hi === "" || hi == null ? dHi : Number(hi);
    if (!(b > a)) throw new Error("Each stretch range needs max > min.");
    return [a, b];
  };
  const vvR = range(params.vv_min, params.vv_max, -25, 0);
  const vhR = range(params.vh_min, params.vh_max, -30, -5);
  const ratioR = range(params.ratio_min, params.ratio_max, 0, 15);
  const scale = (v: number, [lo, hi]: [number, number]) =>
    1 + Math.round(((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * 254);
  const toDb = (v: number) => (db ? v : v > 0 ? 10 * Math.log10(v) : Number.NaN);
  const n = vv.length;
  const red = new Float32Array(n);
  const green = new Float32Array(n);
  const blue = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    if (!valid(vv[i], vvRaster.nodata) || !valid(vh[i], vhNodata)) continue;
    const a = toDb(vv[i]);
    const b = toDb(vh[i]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    red[i] = scale(a, vvR);
    green[i] = scale(b, vhR);
    blue[i] = scale(a - b, ratioR);
  }
  return {
    raster: { ...vvRaster, bands: [red, green, blue], nodata: 0 },
    messages: [
      `R = VV [${vvR.join(", ")}] dB, G = VH [${vhR.join(
        ", ",
      )}] dB, B = VV/VH [${ratioR.join(", ")}] dB.`,
    ],
  };
}

export interface FloodMapParams {
  units?: "linear" | "db" | string;
  band?: number;
  threshold_db?: number;
  change_db?: number;
}

/**
 * Threshold flood mapping on VV backscatter: open water is specular and dark,
 * so pixels below `threshold_db` (default -18 dB) are water. With a
 * pre-event image the output separates permanent water (1: water before and
 * after) from new flooding (2: water after, not before, and at least
 * `change_db` darker); otherwise it is 1 = water, 0 = not water.
 */
export function floodMap(
  postInput: RasterData,
  preInput: RasterData | null,
  params: FloodMapParams,
): { raster: RasterData; messages: string[] } {
  const post = toNorthUp(postInput);
  const bandNo = Math.trunc(Number(params.band ?? 1)) || 1;
  const postBand = post.bands[bandNo - 1];
  if (!postBand) throw new Error(`The post-event raster has no band ${bandNo}.`);
  let pre: RasterData | null = null;
  let preBand: Float32Array | undefined;
  if (preInput) {
    pre = toNorthUp(preInput);
    assertSameGrid(post, pre, "pre-event");
    preBand = pre.bands[bandNo - 1];
    if (!preBand) throw new Error(`The pre-event raster has no band ${bandNo}.`);
  }
  const threshold = params.threshold_db == null ? -18 : Number(params.threshold_db);
  const changeDb = params.change_db == null ? 3 : Number(params.change_db);
  if (!Number.isFinite(threshold)) throw new Error("Set a water threshold in dB.");
  if (!(changeDb >= 0)) throw new Error("The change threshold must be >= 0 dB.");
  const db = params.units === "db";
  const toDb = (v: number) => (db ? v : v > 0 ? 10 * Math.log10(v) : Number.NaN);
  const NODATA = 255;
  const out = new Float32Array(postBand.length);
  const counts = [0, 0, 0];
  for (let i = 0; i < out.length; i += 1) {
    if (!valid(postBand[i], post.nodata)) {
      out[i] = NODATA;
      continue;
    }
    const after = toDb(postBand[i]);
    if (!Number.isFinite(after)) {
      out[i] = NODATA;
      continue;
    }
    let cls: number;
    if (preBand && pre) {
      if (!valid(preBand[i], pre.nodata)) {
        out[i] = NODATA;
        continue;
      }
      const before = toDb(preBand[i]);
      if (!Number.isFinite(before)) {
        out[i] = NODATA;
        continue;
      }
      const wetAfter = after < threshold;
      const wetBefore = before < threshold;
      if (wetAfter && wetBefore) cls = 1;
      else if (wetAfter && before - after >= changeDb) cls = 2;
      else cls = 0;
    } else {
      cls = after < threshold ? 1 : 0;
    }
    counts[cls] += 1;
    out[i] = cls;
  }
  const valid_ = counts[0] + counts[1] + counts[2];
  const pct = (k: number) => (valid_ ? ((100 * counts[k]) / valid_).toFixed(2) : "0.00");
  const messages = preBand
    ? [
        `Water threshold ${threshold} dB, change >= ${changeDb} dB.`,
        `New flooding: ${counts[2]} px (${pct(2)}%), permanent water: ${
          counts[1]
        } px (${pct(1)}%), dry: ${counts[0]} px.`,
      ]
    : [
        `Water threshold ${threshold} dB.`,
        `Water: ${counts[1]} px (${pct(1)}%), not water: ${counts[0]} px.`,
      ];
  return { raster: { ...post, bands: [out], nodata: NODATA }, messages };
}
