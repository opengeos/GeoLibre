import type { RasterData } from "./raster-client";
import { epsgDefinition, geoKeysForEpsg, geojsonEpsg } from "./raster-geo";

/**
 * In-browser point interpolation (IDW and ordinary kriging), a line-by-line
 * port of the sidecar's `interpolate` worker so both engines produce the same
 * surface: the same grid (the points' extent at the requested cell size),
 * the same overflow-safe IDW weighting, and the same kriging pipeline (12-bin
 * empirical semivariogram, a 25-step range sweep with least-squares
 * nugget/sill, exact-interpolating ordinary kriging).
 *
 * The kriging system is solved once (dual form) instead of inverting it; for
 * a non-singular system this is algebraically identical to the sidecar's
 * `pinv` route. A singular system (e.g. duplicate sample locations) is
 * rejected with a pointer to the sidecar.
 */

const NODATA = -9999;
const MAX_IDW_POINTS = 200_000;
const MAX_CELLS_IDW = 6_000_000;
const MAX_CELLS_KRIGE = 1_000_000;
const MAX_KRIGE_POINTS = 1500;

export type VariogramModel = "spherical" | "exponential" | "gaussian" | "linear";

export interface InterpolateParams {
  field: string;
  method?: "idw" | "kriging" | string;
  resolution: number;
  power?: number;
  variogram_model?: VariogramModel | string;
}

/** Python `float()` on a JSON value: numbers, booleans and numeric strings. */
function pyFloat(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const t = value.trim();
    if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(t)) return Number(t);
  }
  return Number.NaN;
}

/** Python's `:.4g` formatting for log lines. */
function g4(value: number): string {
  return String(Number(value.toPrecision(4)));
}

/** Normalised variogram shape (sill = 1) at h / range. */
function variogramShape(t: number, model: string): number {
  if (model === "exponential") return 1 - Math.exp(-3 * t);
  if (model === "gaussian") return 1 - Math.exp(-3 * t * t);
  const c = Math.min(t, 1);
  if (model === "linear") return c;
  return t >= 1 ? 1 : 1.5 * c - 0.5 * c ** 3;
}

/**
 * Minimum-norm least squares for an m x 2 design `[1, s]` (NumPy `lstsq`
 * semantics, including the rank-deficient case where `s` is constant).
 */
function lstsq2(s: number[], g: number[]): [number, number] {
  let a11 = 0;
  let a12 = 0;
  let a22 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let i = 0; i < s.length; i += 1) {
    a11 += 1;
    a12 += s[i];
    a22 += s[i] * s[i];
    b1 += g[i];
    b2 += s[i] * g[i];
  }
  // Eigen-decomposition of the 2x2 normal matrix; singular values are sqrt(l).
  const tr = a11 + a22;
  const det = a11 * a22 - a12 * a12;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l1 = tr / 2 + disc;
  const l2 = Math.max(0, tr / 2 - disc);
  const vec = (l: number): [number, number] => {
    let vx: number;
    let vy: number;
    if (Math.abs(a12) > 1e-300) {
      vx = l - a22;
      vy = a12;
    } else if (a11 >= a22) {
      [vx, vy] = l === l1 ? [1, 0] : [0, 1];
    } else {
      [vx, vy] = l === l1 ? [0, 1] : [1, 0];
    }
    const norm = Math.hypot(vx, vy) || 1;
    return [vx / norm, vy / norm];
  };
  const cutoff = Number.EPSILON * Math.max(s.length, 2) * Math.sqrt(l1);
  let x0 = 0;
  let x1 = 0;
  for (const l of [l1, l2]) {
    if (!(Math.sqrt(l) > cutoff)) continue;
    const [vx, vy] = vec(l);
    const proj = (vx * b1 + vy * b2) / l;
    x0 += vx * proj;
    x1 += vy * proj;
  }
  return [x0, x1];
}

/** Solve a dense symmetric system with partial-pivot LU; null when singular. */
function solveDense(a: Float64Array, b: Float64Array, n: number): Float64Array | null {
  let maxAbs = 0;
  for (let i = 0; i < a.length; i += 1) maxAbs = Math.max(maxAbs, Math.abs(a[i]));
  const tol = 1e-12 * (maxAbs || 1);
  for (let k = 0; k < n; k += 1) {
    let p = k;
    let best = Math.abs(a[k * n + k]);
    for (let r = k + 1; r < n; r += 1) {
      const v = Math.abs(a[r * n + k]);
      if (v > best) {
        best = v;
        p = r;
      }
    }
    if (best <= tol) return null;
    if (p !== k) {
      for (let c = 0; c < n; c += 1) {
        const t = a[k * n + c];
        a[k * n + c] = a[p * n + c];
        a[p * n + c] = t;
      }
      const t = b[k];
      b[k] = b[p];
      b[p] = t;
    }
    const pivot = a[k * n + k];
    for (let r = k + 1; r < n; r += 1) {
      const f = a[r * n + k] / pivot;
      if (f === 0) continue;
      a[r * n + k] = 0;
      for (let c = k + 1; c < n; c += 1) a[r * n + c] -= f * a[k * n + c];
      b[r] -= f * b[k];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r -= 1) {
    let acc = b[r];
    for (let c = r + 1; c < n; c += 1) acc -= a[r * n + c] * x[c];
    x[r] = acc / a[r * n + r];
  }
  return x;
}

/** NumPy `linspace(start, stop, num)` with the exact endpoint. */
function linspace(start: number, stop: number, num: number): number[] {
  const step = (stop - start) / (num - 1);
  const out: number[] = [];
  for (let i = 0; i < num; i += 1) out.push(i * step + start);
  out[num - 1] = stop;
  return out;
}

/**
 * Interpolate a point GeoJSON's numeric attribute onto a raster covering the
 * points' extent, using IDW or ordinary kriging.
 */
export async function interpolatePoints(
  pointsGeojson: unknown,
  params: InterpolateParams,
): Promise<{ raster: RasterData; messages: string[] }> {
  const field = String(params.field ?? "").trim();
  if (!field) throw new Error("Value field is required");
  const method = String(params.method ?? "idw").toLowerCase();
  const resolution = Number(params.resolution ?? 0) || 0;
  if (resolution <= 0) throw new Error("Output pixel size (resolution) must be > 0");
  const power = params.power == null ? 2 : Number(params.power);
  if (method === "idw" && !(power > 0)) throw new Error("IDW power must be > 0");
  const model = String(params.variogram_model ?? "spherical").toLowerCase();
  const messages: string[] = [];

  const gj = pointsGeojson as { type?: string; features?: unknown[] } | null;
  let feats: unknown[];
  if (gj?.type === "FeatureCollection") feats = Array.isArray(gj.features) ? gj.features : [];
  else if (gj?.type === "Feature") feats = [gj];
  else throw new Error("Input must be a GeoJSON Feature or FeatureCollection of points");

  const px: number[] = [];
  const py: number[] = [];
  const pz: number[] = [];
  let skipped = 0;
  for (const f of feats) {
    const feat = (f ?? {}) as {
      geometry?: { type?: string; coordinates?: unknown };
      properties?: Record<string, unknown>;
    };
    const geom = feat.geometry ?? {};
    const coords = geom.coordinates as number[] | undefined;
    if (geom.type !== "Point" || !Array.isArray(coords) || coords.length < 2) {
      skipped += 1;
      continue;
    }
    const z = pyFloat((feat.properties ?? {})[field]);
    if (!Number.isFinite(z)) {
      skipped += 1;
      continue;
    }
    px.push(Number(coords[0]));
    py.push(Number(coords[1]));
    pz.push(z);
  }
  if (pz.length < 3) {
    throw new Error(
      `Interpolation needs at least 3 point features with a numeric '${field}' value (found ${pz.length}).`,
    );
  }
  if (method === "idw" && pz.length > MAX_IDW_POINTS) {
    throw new Error(
      `IDW is capped at ${MAX_IDW_POINTS} points (got ${pz.length}). Thin the layer or aggregate it first.`,
    );
  }
  if (skipped) {
    messages.push(`Skipped ${skipped} feature(s) without a Point geometry or numeric '${field}'.`);
  }

  const epsg = geojsonEpsg(pointsGeojson);
  const definition = await epsgDefinition(epsg);
  const geographic =
    definition === "EPSG:4326" || /\+proj=(?:longlat|latlong|lonlat|latlon)\b/.test(definition);

  const minx = Math.min(...px);
  let maxx = Math.max(...px);
  const miny = Math.min(...py);
  let maxy = Math.max(...py);
  // A degenerate extent (all points share an x or y) still needs a 1-cell span.
  if (maxx <= minx) maxx = minx + resolution;
  if (maxy <= miny) maxy = miny + resolution;
  const width = Math.max(1, Math.ceil((maxx - minx) / resolution));
  const height = Math.max(1, Math.ceil((maxy - miny) / resolution));
  const cells = width * height;
  const cap = method === "kriging" ? MAX_CELLS_KRIGE : MAX_CELLS_IDW;
  if (cells > cap) {
    throw new Error(
      `Output grid is ${width}x${height} = ${cells} cells, above the ${cap} limit for ${method}. Increase the pixel size.`,
    );
  }
  const gx = Float64Array.from({ length: width }, (_, i) => minx + (i + 0.5) * resolution);
  const gy = Float64Array.from({ length: height }, (_, j) => maxy - (j + 0.5) * resolution);

  const n = pz.length;
  const out = new Float32Array(cells);
  if (method === "idw") {
    const half = power / 2;
    for (let j = 0; j < height; j += 1) {
      for (let i = 0; i < width; i += 1) {
        const x = gx[i];
        const y = gy[j];
        let minD2 = Infinity;
        let hit = -1;
        for (let k = 0; k < n; k += 1) {
          const dx = x - px[k];
          const dy = y - py[k];
          const d2 = dx * dx + dy * dy;
          if (d2 === 0) {
            if (hit === -1) hit = k;
          } else if (d2 < minD2) minD2 = d2;
        }
        let value: number;
        if (hit !== -1) {
          value = pz[hit];
        } else {
          const scale = Number.isFinite(minD2) && minD2 > 0 ? minD2 : 1;
          let wsum = 0;
          let acc = 0;
          for (let k = 0; k < n; k += 1) {
            const dx = x - px[k];
            const dy = y - py[k];
            const w = 1 / Math.pow((dx * dx + dy * dy) / scale, half);
            wsum += w;
            acc += w * pz[k];
          }
          value = wsum > 0 ? acc / wsum : Number.NaN;
        }
        out[j * width + i] = Number.isFinite(value) ? value : NODATA;
      }
    }
  } else if (method === "kriging") {
    if (n > MAX_KRIGE_POINTS) {
      throw new Error(
        `Ordinary kriging is capped at ${MAX_KRIGE_POINTS} points (got ${n}). Use IDW for larger point sets.`,
      );
    }
    const dist = new Float64Array(n * n);
    const h: number[] = [];
    const gamma: number[] = [];
    for (let a = 0; a < n; a += 1) {
      for (let b = 0; b < n; b += 1) {
        const d = Math.sqrt((px[a] - px[b]) ** 2 + (py[a] - py[b]) ** 2);
        dist[a * n + b] = d;
        if (b > a) {
          h.push(d);
          gamma.push(0.5 * (pz[a] - pz[b]) ** 2);
        }
      }
    }
    const hmax = Math.max(...h);
    if (!(hmax > 0)) throw new Error("All points are coincident; cannot krige.");
    const nbins = 12;
    const edges = linspace(0, hmax, nbins + 1);
    const centers = edges.slice(0, -1).map((e, k) => 0.5 * (e + edges[k + 1]));
    const sums = new Float64Array(nbins);
    const counts = new Float64Array(nbins);
    for (let k = 0; k < h.length; k += 1) {
      // np.digitize (right=False) - 1, clipped to [0, nbins - 1].
      let idx = 0;
      while (idx < edges.length && edges[idx] <= h[k]) idx += 1;
      const bin = Math.min(nbins - 1, Math.max(0, idx - 1));
      sums[bin] += gamma[k];
      counts[bin] += 1;
    }
    const binH: number[] = [];
    const binG: number[] = [];
    for (let b = 0; b < nbins; b += 1) {
      if (counts[b] > 0) {
        binH.push(centers[b]);
        binG.push(sums[b] / counts[b]);
      }
    }
    if (!binH.length)
      throw new Error("Could not build an empirical semivariogram from the points.");
    let best: {
      sse: number;
      range: number;
      sill: number;
      nugget: number;
    } | null = null;
    for (const r of linspace(hmax * 0.1, hmax * 1.5, 25)) {
      const shape = binH.map((hh) => variogramShape(hh / r, model));
      const [c0, c1] = lstsq2(shape, binG);
      const nugget = Math.max(0, c0);
      const sill = Math.max(1e-12, c1);
      let sse = 0;
      for (let k = 0; k < shape.length; k += 1) sse += (nugget + sill * shape[k] - binG[k]) ** 2;
      // Smallest range among (near-)equal fits, as the sidecar does: past the
      // largest bin the SSE is flat in r and only rounding noise differs.
      if (!best || sse < best.sse * (1 - 1e-9)) best = { sse, range: r, sill, nugget };
    }
    const { range, sill, nugget } = best!;
    messages.push(
      `Variogram (${model}): range=${g4(range)}, sill=${g4(sill)}, nugget=${g4(nugget)}`,
    );
    const gammaModel = (hh: number) =>
      hh <= 0 ? 0 : nugget + sill * variogramShape(hh / range, model);
    const m = n + 1;
    const big = new Float64Array(m * m).fill(1);
    for (let a = 0; a < n; a += 1) {
      for (let b = 0; b < n; b += 1) big[a * m + b] = gammaModel(dist[a * n + b]);
    }
    big[n * m + n] = 0;
    const rhs = new Float64Array(m);
    for (let a = 0; a < n; a += 1) rhs[a] = pz[a];
    const dual = solveDense(big, rhs, m);
    if (!dual) {
      throw new Error(
        "The kriging system is singular (duplicate or collinear sample locations?). Use the sidecar (rasterio/GDAL) engine, which solves it with a pseudo-inverse.",
      );
    }
    for (let j = 0; j < height; j += 1) {
      for (let i = 0; i < width; i += 1) {
        let value = dual[n];
        for (let k = 0; k < n; k += 1) {
          value += dual[k] * gammaModel(Math.sqrt((gx[i] - px[k]) ** 2 + (gy[j] - py[k]) ** 2));
        }
        out[j * width + i] = Number.isFinite(value) ? value : NODATA;
      }
    }
  } else {
    throw new Error(`Unknown interpolation method: ${method}`);
  }
  messages.push(`Interpolated ${n} points (${method}) into a ${width}x${height} raster.`);
  return {
    raster: {
      bands: [out],
      width,
      height,
      originX: minx,
      originY: maxy,
      resX: resolution,
      resY: resolution,
      nodata: NODATA,
      geoKeys: geoKeysForEpsg(epsg, geographic),
    },
    messages,
  };
}
