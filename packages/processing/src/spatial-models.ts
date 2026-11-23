/**
 * Numerical core for the spatial regression, clustering, and geostatistics
 * tools in `statistics-tools.ts`: ordinary least squares, geographically
 * weighted regression (GWR) with AICc bandwidth search, DBSCAN, HDBSCAN, and
 * ordinary-kriging variogram fitting with leave-one-out cross-validation.
 *
 * Everything here works on plain arrays and a caller-supplied distance, so the
 * same code runs on planar test fixtures (checked against GWR4, scikit-learn,
 * and hand-computed values in `tests/spatial-models.test.ts`) and on lon/lat
 * layers (with great-circle distances) in the tools.
 */

// ---------------------------------------------------------------------------
// Linear algebra
// ---------------------------------------------------------------------------

/**
 * Inverts a square matrix with Gauss-Jordan elimination and partial pivoting.
 *
 * @param matrix - Row-major square matrix (not modified).
 * @returns The inverse, or null when the matrix is singular to working
 *   precision (pivot below 1e-12 of the largest diagonal magnitude).
 */
export function invertMatrix(matrix: number[][]): number[][] | null {
  const n = matrix.length;
  const a = matrix.map((row) => Float64Array.from(row));
  const inv = Array.from({ length: n }, (_, i) => {
    const row = new Float64Array(n);
    row[i] = 1;
    return row;
  });
  let scale = 0;
  for (let i = 0; i < n; i++) scale = Math.max(scale, Math.abs(a[i][i]));
  for (const row of a) for (const v of row) scale = Math.max(scale, Math.abs(v));
  const tol = (scale || 1) * 1e-12;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    if (!(Math.abs(a[pivot][col]) > tol)) return null;
    if (pivot !== col) {
      [a[pivot], a[col]] = [a[col], a[pivot]];
      [inv[pivot], inv[col]] = [inv[col], inv[pivot]];
    }
    const p = a[col][col];
    const rowA = a[col];
    const rowI = inv[col];
    for (let j = 0; j < n; j++) {
      rowA[j] /= p;
      rowI[j] /= p;
    }
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = a[r][col];
      if (f === 0) continue;
      const ar = a[r];
      const ir = inv[r];
      for (let j = 0; j < n; j++) {
        ar[j] -= f * rowA[j];
        ir[j] -= f * rowI[j];
      }
    }
  }
  return inv.map((row) => Array.from(row));
}

// ---------------------------------------------------------------------------
// Distributions
// ---------------------------------------------------------------------------

/** Natural log of the gamma function (Lanczos approximation, g = 7). */
export function logGamma(x: number): number {
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - logGamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Continued fraction for the incomplete beta function (modified Lentz). */
function betaContinuedFraction(a: number, b: number, x: number): number {
  const tiny = 1e-300;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return h;
}

/** Regularized incomplete beta function I_x(a, b). */
export function regularizedBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  if (x < (a + 1) / (a + b + 2)) return (front * betaContinuedFraction(a, b, x)) / a;
  return 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

/** Two-sided p-value of Student's t with `df` degrees of freedom. */
export function studentTTwoSidedP(t: number, df: number): number {
  if (!Number.isFinite(t)) return Number.isNaN(t) ? NaN : 0;
  if (!(df > 0)) return NaN;
  return regularizedBeta(df / (df + t * t), df / 2, 0.5);
}

/** Upper-tail p-value of the F distribution with (d1, d2) degrees of freedom. */
export function fUpperP(f: number, d1: number, d2: number): number {
  if (!(f > 0)) return 1;
  if (!Number.isFinite(f)) return 0;
  return regularizedBeta(d2 / (d2 + d1 * f), d2 / 2, d1 / 2);
}

// ---------------------------------------------------------------------------
// Ordinary least squares
// ---------------------------------------------------------------------------

/** Result of {@link ols}. */
export interface OlsResult {
  n: number;
  /** Number of coefficients, including the intercept. */
  k: number;
  coefficients: number[];
  standardErrors: number[];
  tValues: number[];
  pValues: number[];
  fitted: number[];
  residuals: number[];
  /** Residual / sqrt(residual variance). */
  standardizedResiduals: number[];
  rss: number;
  r2: number;
  adjR2: number;
  /** Unbiased residual variance, RSS / (n - k). */
  sigma2: number;
  fStatistic: number;
  fPValue: number;
  logLikelihood: number;
  /** -2 logL + 2 (k + 1): the error variance counts as a parameter (GWR4). */
  aic: number;
  /** AICc on the GWR scale, so OLS and GWR models compare directly. */
  aicc: number;
}

/**
 * Ordinary least squares with an intercept.
 *
 * @param x - n rows of explanatory values (without the intercept column).
 * @param y - n dependent values.
 * @returns The fit, or null when X'X is singular (collinear variables) or
 *   there are too few observations.
 */
export function ols(x: number[][], y: number[]): OlsResult | null {
  const n = y.length;
  const k = (x[0]?.length ?? 0) + 1;
  if (n <= k) return null;
  const rows = x.map((row) => [1, ...row]);
  const xtx = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const xty = new Array<number>(k).fill(0);
  for (let i = 0; i < n; i++) {
    const r = rows[i];
    for (let a = 0; a < k; a++) {
      xty[a] += r[a] * y[i];
      for (let b = a; b < k; b++) xtx[a][b] += r[a] * r[b];
    }
  }
  for (let a = 0; a < k; a++) for (let b = 0; b < a; b++) xtx[a][b] = xtx[b][a];
  const inv = invertMatrix(xtx);
  if (!inv) return null;
  const beta = inv.map((row) => row.reduce((s, v, j) => s + v * xty[j], 0));
  const fitted = rows.map((r) => r.reduce((s, v, j) => s + v * beta[j], 0));
  const residuals = y.map((v, i) => v - fitted[i]);
  const rss = residuals.reduce((s, e) => s + e * e, 0);
  const mean = y.reduce((s, v) => s + v, 0) / n;
  const tss = y.reduce((s, v) => s + (v - mean) ** 2, 0);
  const df = n - k;
  const sigma2 = rss / df;
  const standardErrors = inv.map((row, j) => Math.sqrt(row[j] * sigma2));
  const tValues = beta.map((b, j) => b / standardErrors[j]);
  const r2 = tss > 0 ? 1 - rss / tss : NaN;
  const fStatistic = k > 1 && rss > 0 ? (tss - rss) / (k - 1) / sigma2 : NaN;
  const logLikelihood = (-n / 2) * (Math.log(2 * Math.PI) + Math.log(rss / n) + 1);
  return {
    n,
    k,
    coefficients: beta,
    standardErrors,
    tValues,
    pValues: tValues.map((t) => studentTTwoSidedP(t, df)),
    fitted,
    residuals,
    standardizedResiduals: residuals.map((e) => e / Math.sqrt(sigma2)),
    rss,
    r2,
    adjR2: 1 - ((1 - r2) * (n - 1)) / df,
    sigma2,
    fStatistic,
    fPValue: k > 1 ? fUpperP(fStatistic, k - 1, df) : NaN,
    logLikelihood,
    aic: -2 * logLikelihood + 2 * (k + 1),
    aicc: gwrAicc(rss, n, k),
  };
}

/** AICc on the GWR scale (Fotheringham et al. 2002): Infinity when undefined. */
function gwrAicc(rss: number, n: number, traceS: number): number {
  if (!(n - 2 - traceS > 0) || !(rss > 0)) return Infinity;
  return n * Math.log(rss / n) + n * Math.log(2 * Math.PI) + (n * (n + traceS)) / (n - 2 - traceS);
}

// ---------------------------------------------------------------------------
// Geographically weighted regression
// ---------------------------------------------------------------------------

export type GwrKernel = "bisquare" | "gaussian";

/** Kernel settings for {@link gwr}. */
export interface GwrKernelOptions {
  kernel: GwrKernel;
  /**
   * Adaptive: `bandwidth` is a neighbor count (the point itself included) and
   * each location's kernel reaches its bandwidth-th nearest neighbor. Fixed:
   * `bandwidth` is a distance.
   */
  adaptive: boolean;
}

/** Result of {@link gwr}. */
export interface GwrResult {
  n: number;
  k: number;
  bandwidth: number;
  /** n rows of local coefficients (intercept first). */
  coefficients: number[][];
  standardErrors: number[][];
  tValues: number[][];
  fitted: number[];
  residuals: number[];
  standardizedResiduals: number[];
  localR2: number[];
  /** Diagonal of the hat matrix (influence). */
  influence: number[];
  rss: number;
  r2: number;
  /** Adjusted R² as GWR4 reports it (NaN when `full` is false). */
  adjR2: number;
  /** Effective number of parameters, trace(S). */
  traceS: number;
  /** trace(S'S). */
  traceSS: number;
  /** Residual variance RSS / (n - 2 tr(S) + tr(S'S)). */
  sigma2: number;
  aicc: number;
}

/**
 * Precomputed pairwise distances shared by every bandwidth a search tries.
 */
export class DistanceMatrix {
  readonly n: number;
  readonly values: Float64Array;
  private sortedRows: Float64Array | null = null;

  constructor(n: number, dist: (i: number, j: number) => number) {
    this.n = n;
    this.values = new Float64Array(n * n);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const d = dist(i, j);
        this.values[i * n + j] = d;
        this.values[j * n + i] = d;
      }
    }
  }

  get(i: number, j: number): number {
    return this.values[i * this.n + j];
  }

  /** Distance from `i` to its `rank`-th nearest point (rank 1 is itself). */
  kth(i: number, rank: number): number {
    if (!this.sortedRows) {
      const n = this.n;
      this.sortedRows = new Float64Array(n * n);
      for (let r = 0; r < n; r++) {
        const row = this.values.slice(r * n, (r + 1) * n).sort();
        this.sortedRows.set(row, r * n);
      }
    }
    const idx = Math.max(0, Math.min(this.n - 1, Math.round(rank) - 1));
    return this.sortedRows[i * this.n + idx];
  }

  max(): number {
    let m = 0;
    for (const v of this.values) if (v > m) m = v;
    return m;
  }
}

function kernelWeights(
  dm: DistanceMatrix,
  i: number,
  bandwidth: number,
  options: GwrKernelOptions,
  out: Float64Array,
): void {
  const n = dm.n;
  // The 1.0000001 widening matches GWR4/mgwr, so the adaptive kernel keeps
  // the bandwidth-th neighbor itself (with a tiny positive weight).
  const b = options.adaptive ? dm.kth(i, bandwidth) * 1.0000001 : bandwidth;
  for (let j = 0; j < n; j++) {
    const z = b > 0 ? dm.get(i, j) / b : dm.get(i, j) === 0 ? 0 : Infinity;
    if (options.kernel === "bisquare") out[j] = z < 1 ? (1 - z * z) ** 2 : 0;
    else out[j] = Math.exp(-0.5 * z * z);
  }
}

/**
 * Fits a GWR at one bandwidth.
 *
 * @param x - n rows of explanatory values (without the intercept column).
 * @param y - n dependent values.
 * @param dm - Pairwise distances.
 * @param bandwidth - Neighbor count (adaptive) or distance (fixed).
 * @param options - Kernel settings.
 * @param full - Also compute standard errors, t-values and local R² (slower).
 * @returns The fit, or null if a local regression is singular.
 */
export function gwr(
  x: number[][],
  y: number[],
  dm: DistanceMatrix,
  bandwidth: number,
  options: GwrKernelOptions,
  full = true,
): GwrResult | null {
  const n = y.length;
  const k = (x[0]?.length ?? 0) + 1;
  const rows = x.map((row) => [1, ...row]);
  const w = new Float64Array(n);
  const coefficients: number[][] = [];
  const covariances: number[][][] = [];
  const fitted = new Array<number>(n);
  const influence = new Array<number>(n);
  let traceS = 0;
  let traceSS = 0;
  for (let i = 0; i < n; i++) {
    kernelWeights(dm, i, bandwidth, options, w);
    const xtwx = Array.from({ length: k }, () => new Array<number>(k).fill(0));
    const xtw2x = full ? Array.from({ length: k }, () => new Array<number>(k).fill(0)) : null;
    const xtwy = new Array<number>(k).fill(0);
    for (let j = 0; j < n; j++) {
      const wj = w[j];
      if (wj === 0) continue;
      const r = rows[j];
      for (let a = 0; a < k; a++) {
        const ra = r[a] * wj;
        xtwy[a] += ra * y[j];
        for (let b = a; b < k; b++) xtwx[a][b] += ra * r[b];
        if (xtw2x) for (let b = a; b < k; b++) xtw2x[a][b] += ra * wj * r[b];
      }
    }
    for (let a = 0; a < k; a++) {
      for (let b = 0; b < a; b++) {
        xtwx[a][b] = xtwx[b][a];
        if (xtw2x) xtw2x[a][b] = xtw2x[b][a];
      }
    }
    const inv = invertMatrix(xtwx);
    if (!inv) return null;
    const beta = inv.map((row) => row.reduce((s, v, j) => s + v * xtwy[j], 0));
    coefficients.push(beta);
    const xi = rows[i];
    fitted[i] = xi.reduce((s, v, j) => s + v * beta[j], 0);
    // S_ii = x_i (X'WX)^-1 x_i' w_ii.
    const ax = inv.map((row) => row.reduce((s, v, j) => s + v * xi[j], 0));
    const sii = w[i] * xi.reduce((s, v, j) => s + v * ax[j], 0);
    influence[i] = sii;
    traceS += sii;
    if (xtw2x) {
      // C_i C_i' = A X'W²X A, and sum_j S_ij² = x_i (C_i C_i') x_i'.
      const tmp = inv.map((row) =>
        xtw2x[0].map((_, c) => row.reduce((s, v, j) => s + v * xtw2x[j][c], 0)),
      );
      const cov = tmp.map((row) =>
        inv[0].map((_, c) => row.reduce((s, v, j) => s + v * inv[j][c], 0)),
      );
      covariances.push(cov);
      traceSS += xi.reduce((s, v, a) => s + v * cov[a].reduce((t, u, b) => t + u * xi[b], 0), 0);
    }
  }
  const residuals = y.map((v, i) => v - fitted[i]);
  const rss = residuals.reduce((s, e) => s + e * e, 0);
  const mean = y.reduce((s, v) => s + v, 0) / n;
  const tss = y.reduce((s, v) => s + (v - mean) ** 2, 0);
  const r2 = tss > 0 ? 1 - rss / tss : NaN;
  const result: GwrResult = {
    n,
    k,
    bandwidth,
    coefficients,
    standardErrors: [],
    tValues: [],
    fitted,
    residuals,
    standardizedResiduals: [],
    localR2: [],
    influence,
    rss,
    r2,
    // Filled in below with the GWR4 definition once tr(S'S) is known.
    adjR2: NaN,
    traceS,
    traceSS,
    sigma2: NaN,
    aicc: gwrAicc(rss, n, traceS),
  };
  if (!full) return result;
  const sigma2 = rss / (n - 2 * traceS + traceSS);
  result.sigma2 = sigma2;
  // GWR4: 1 - (1 - R²)(n - 1) / (n - 1 - k) with k = 2 tr(S) - tr(S'S).
  result.adjR2 = 1 - ((1 - r2) * (n - 1)) / (n - 1 - (2 * traceS - traceSS));
  result.standardErrors = covariances.map((cov) => cov.map((row, j) => Math.sqrt(row[j] * sigma2)));
  result.tValues = coefficients.map((beta, i) =>
    beta.map((b, j) => b / result.standardErrors[i][j]),
  );
  result.standardizedResiduals = residuals.map(
    (e, i) => e / Math.sqrt(sigma2 * Math.max(1e-12, 1 - influence[i])),
  );
  for (let i = 0; i < n; i++) {
    kernelWeights(dm, i, bandwidth, options, w);
    let sw = 0;
    let swy = 0;
    for (let j = 0; j < n; j++) {
      sw += w[j];
      swy += w[j] * y[j];
    }
    const ybar = swy / sw;
    let wtss = 0;
    let wrss = 0;
    for (let j = 0; j < n; j++) {
      wtss += w[j] * (y[j] - ybar) ** 2;
      wrss += w[j] * residuals[j] ** 2;
    }
    result.localR2.push(wtss > 0 ? (wtss - wrss) / wtss : NaN);
  }
  return result;
}

/** Default search interval for {@link searchGwrBandwidth}. */
export function gwrBandwidthBounds(
  dm: DistanceMatrix,
  k: number,
  options: GwrKernelOptions,
): [number, number] {
  const n = dm.n;
  if (options.adaptive) {
    // mgwr/GWR4 search from 40 + 2k neighbors up to n; smaller data starts
    // from the fewest neighbors that keep every local fit solvable.
    const lower = 40 + 2 * k < n ? 40 + 2 * k : Math.min(n, k + 2);
    return [lower, n];
  }
  let lower = 0;
  for (let i = 0; i < n; i++) lower = Math.max(lower, dm.kth(i, Math.min(n, k + 2)));
  return [lower, dm.max() * 2];
}

/**
 * Golden-section search for the bandwidth minimizing AICc. Adaptive (integer)
 * bandwidths finish with an exhaustive check of the last few neighbors.
 *
 * @returns The best bandwidth and its AICc.
 */
export function searchGwrBandwidth(
  x: number[][],
  y: number[],
  dm: DistanceMatrix,
  options: GwrKernelOptions,
  bounds?: [number, number],
): { bandwidth: number; aicc: number; evaluations: number } {
  const k = (x[0]?.length ?? 0) + 1;
  let [a, c] = bounds ?? gwrBandwidthBounds(dm, k, options);
  const integer = options.adaptive;
  const cache = new Map<number, number>();
  const score = (bw: number): number => {
    const key = integer ? Math.round(bw) : bw;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const fit = gwr(x, y, dm, key, options, false);
    const value = fit ? fit.aicc : Infinity;
    cache.set(key, value);
    return value;
  };
  const ratio = 0.38197;
  const span0 = c - a;
  let b = a + ratio * (c - a);
  let d = c - ratio * (c - a);
  for (let iter = 0; iter < 200; iter++) {
    if (integer) {
      b = Math.round(b);
      d = Math.round(d);
      if (c - a <= 4) break;
    } else if (c - a <= span0 * 1e-6) break;
    if (score(b) <= score(d)) {
      c = d;
      d = b;
      b = a + ratio * (c - a);
    } else {
      a = b;
      b = d;
      d = c - ratio * (c - a);
    }
  }
  let best = integer ? Math.round(b) : (a + c) / 2;
  let bestScore = score(best);
  if (integer) {
    for (let bw = Math.floor(a) - 1; bw <= Math.ceil(c) + 1; bw++) {
      if (bw < 2 || bw > dm.n) continue;
      const s = score(bw);
      if (s < bestScore) {
        bestScore = s;
        best = bw;
      }
    }
  } else {
    for (const bw of [a, b, d, c]) {
      const s = score(bw);
      if (s < bestScore) {
        bestScore = s;
        best = bw;
      }
    }
  }
  return { bandwidth: best, aicc: bestScore, evaluations: cache.size };
}

// ---------------------------------------------------------------------------
// Density clustering
// ---------------------------------------------------------------------------

/** Result of {@link dbscan}. */
export interface DbscanResult {
  /** Cluster id per point (0-based), or -1 for noise. */
  labels: number[];
  core: boolean[];
  clusterCount: number;
}

/**
 * DBSCAN (Ester et al. 1996) over points in 2D or 3D Euclidean space, using a
 * grid index. `minPoints` counts the point itself, as scikit-learn's
 * `min_samples` does, and clusters are numbered in the order their first core
 * point appears, so labels match scikit-learn exactly.
 *
 * @param points - Coordinates, all of the same dimension (2 or 3).
 * @param eps - Neighborhood radius (inclusive).
 * @param minPoints - Neighbors (self included) a core point needs.
 * @returns Labels and core flags.
 */
export function dbscan(points: number[][], eps: number, minPoints: number): DbscanResult {
  const n = points.length;
  const dim = points[0]?.length ?? 2;
  const cells = new Map<string, number[]>();
  const cellKey = (p: number[], offset?: number[]): string =>
    p.map((v, i) => Math.floor(v / eps) + (offset?.[i] ?? 0)).join(",");
  points.forEach((p, i) => {
    const key = cellKey(p);
    const bucket = cells.get(key);
    if (bucket) bucket.push(i);
    else cells.set(key, [i]);
  });
  const offsets: number[][] = [];
  const build = (prefix: number[]): void => {
    if (prefix.length === dim) {
      offsets.push(prefix);
      return;
    }
    for (const o of [-1, 0, 1]) build([...prefix, o]);
  };
  build([]);
  const eps2 = eps * eps;
  const neighbors = (i: number): number[] => {
    const p = points[i];
    const out: number[] = [];
    for (const offset of offsets) {
      const bucket = cells.get(cellKey(p, offset));
      if (!bucket) continue;
      for (const j of bucket) {
        let d2 = 0;
        for (let a = 0; a < dim; a++) d2 += (p[a] - points[j][a]) ** 2;
        if (d2 <= eps2) out.push(j);
      }
    }
    return out;
  };
  const hood: number[][] = [];
  const core: boolean[] = [];
  for (let i = 0; i < n; i++) {
    hood.push(neighbors(i));
    core.push(hood[i].length >= minPoints);
  }
  const labels = new Array<number>(n).fill(-1);
  let cluster = 0;
  for (let i = 0; i < n; i++) {
    if (labels[i] !== -1 || !core[i]) continue;
    const stack = [i];
    labels[i] = cluster;
    while (stack.length) {
      const p = stack.pop() as number;
      if (!core[p]) continue;
      for (const q of hood[p]) {
        if (labels[q] === -1) {
          labels[q] = cluster;
          stack.push(q);
        }
      }
    }
    cluster++;
  }
  return { labels, core, clusterCount: cluster };
}

/** Result of {@link hdbscan}. */
export interface HdbscanResult {
  /** Cluster id per point (0-based), or -1 for noise. */
  labels: number[];
  /** Membership strength in [0, 1] (0 for noise). */
  probabilities: number[];
  clusterCount: number;
  /** Stability of each selected cluster, by label. */
  stabilities: number[];
}

/**
 * HDBSCAN* (Campello, Moulavi & Sander 2013) with excess-of-mass cluster
 * selection, following scikit-learn's `HDBSCAN` defaults: core distance to the
 * `minSamples`-th nearest point (self included), mutual-reachability minimum
 * spanning tree, condensed tree with `minClusterSize`, no single root cluster.
 *
 * @param n - Number of points.
 * @param dist - Symmetric distance between points i and j.
 * @param minClusterSize - Smallest group that counts as a cluster.
 * @param minSamples - Density smoothing (defaults to `minClusterSize`).
 * @returns Labels, membership probabilities and cluster stabilities.
 */
export function hdbscan(
  n: number,
  dist: (i: number, j: number) => number,
  minClusterSize: number,
  minSamples = minClusterSize,
): HdbscanResult {
  if (n < 2) {
    return {
      labels: new Array(n).fill(-1),
      probabilities: new Array(n).fill(0),
      clusterCount: 0,
      stabilities: [],
    };
  }
  // Core distances.
  const core = new Float64Array(n);
  const row = new Float64Array(n);
  const rank = Math.min(n, Math.max(1, minSamples)) - 1;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) row[j] = i === j ? 0 : dist(i, j);
    core[i] = row.slice().sort()[rank];
  }
  // Prim's MST over mutual-reachability distances.
  const inTree = new Uint8Array(n);
  const best = new Float64Array(n).fill(Infinity);
  const from = new Int32Array(n).fill(-1);
  const edges: [number, number, number][] = [];
  let current = 0;
  inTree[0] = 1;
  for (let step = 1; step < n; step++) {
    let next = -1;
    let nextD = Infinity;
    for (let j = 0; j < n; j++) {
      if (inTree[j]) continue;
      const mr = Math.max(core[current], core[j], dist(current, j));
      if (mr < best[j]) {
        best[j] = mr;
        from[j] = current;
      }
      if (best[j] < nextD) {
        nextD = best[j];
        next = j;
      }
    }
    inTree[next] = 1;
    edges.push([from[next], next, nextD]);
    current = next;
  }
  edges.sort((p, q) => p[2] - q[2]);

  // Single-linkage tree: node ids n.. for merges, with sizes.
  const parent = new Int32Array(2 * n - 1).fill(-1);
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== -1) r = parent[r];
    while (parent[x] !== -1 && parent[x] !== r) {
      const nx = parent[x];
      parent[x] = r;
      x = nx;
    }
    return r;
  };
  const left: number[] = [];
  const right: number[] = [];
  const height: number[] = [];
  const size = new Int32Array(2 * n - 1).fill(1);
  edges.forEach(([a, b, d], idx) => {
    const ra = find(a);
    const rb = find(b);
    const node = n + idx;
    parent[ra] = node;
    parent[rb] = node;
    left.push(ra);
    right.push(rb);
    height.push(d);
    size[node] = size[ra] + size[rb];
  });

  // Condensed tree.
  const root = 2 * n - 2;
  const cParent: number[] = [];
  const cChild: number[] = [];
  const cLambda: number[] = [];
  const cSize: number[] = [];
  const relabel = new Int32Array(2 * n - 1);
  relabel[root] = n;
  let nextLabel = n + 1;
  const leaves = (node: number, out: number[]): void => {
    const stack = [node];
    while (stack.length) {
      const v = stack.pop() as number;
      if (v < n) out.push(v);
      else stack.push(left[v - n], right[v - n]);
    }
  };
  const queue = [root];
  for (let qi = 0; qi < queue.length; qi++) {
    const node = queue[qi];
    if (node < n) continue;
    const l = left[node - n];
    const r = right[node - n];
    const d = height[node - n];
    const lambda = d > 0 ? 1 / d : Infinity;
    const lc = size[l];
    const rc = size[r];
    const parentLabel = relabel[node];
    const fallOut = (child: number): void => {
      const pts: number[] = [];
      leaves(child, pts);
      for (const p of pts) {
        cParent.push(parentLabel);
        cChild.push(p);
        cLambda.push(lambda);
        cSize.push(1);
      }
    };
    if (lc >= minClusterSize && rc >= minClusterSize) {
      for (const [child, count] of [
        [l, lc],
        [r, rc],
      ]) {
        relabel[child] = nextLabel++;
        cParent.push(parentLabel);
        cChild.push(relabel[child]);
        cLambda.push(lambda);
        cSize.push(count);
        queue.push(child);
      }
    } else if (lc < minClusterSize && rc < minClusterSize) {
      fallOut(l);
      fallOut(r);
    } else if (lc < minClusterSize) {
      relabel[r] = parentLabel;
      fallOut(l);
      queue.push(r);
    } else {
      relabel[l] = parentLabel;
      fallOut(r);
      queue.push(l);
    }
  }

  // Stability = sum over children of (lambda - birth lambda) * size.
  const clusterCount = nextLabel - n;
  const birth = new Float64Array(clusterCount);
  const stability = new Float64Array(clusterCount);
  for (let i = 0; i < cParent.length; i++) {
    if (cSize[i] > 1 || cChild[i] >= n) birth[cChild[i] - n] = cLambda[i];
  }
  for (let i = 0; i < cParent.length; i++) {
    const p = cParent[i] - n;
    const lambda = Number.isFinite(cLambda[i]) ? cLambda[i] : 0;
    stability[p] += (lambda - birth[p]) * cSize[i];
  }
  const childClusters: number[][] = Array.from({ length: clusterCount }, () => []);
  for (let i = 0; i < cParent.length; i++) {
    if (cChild[i] >= n) childClusters[cParent[i] - n].push(cChild[i] - n);
  }

  // Excess-of-mass selection, leaves upward, root excluded.
  const selected = new Uint8Array(clusterCount);
  const subtreeStability = Float64Array.from(stability);
  for (let c = clusterCount - 1; c >= 1; c--) selected[c] = 1;
  for (let c = clusterCount - 1; c >= 1; c--) {
    const childSum = childClusters[c].reduce((s, ch) => s + subtreeStability[ch], 0);
    if (childClusters[c].length && childSum > subtreeStability[c]) {
      selected[c] = 0;
      subtreeStability[c] = childSum;
    } else {
      const stack = [...childClusters[c]];
      while (stack.length) {
        const s = stack.pop() as number;
        selected[s] = 0;
        stack.push(...childClusters[s]);
      }
    }
  }
  const chosen: number[] = [];
  for (let c = 1; c < clusterCount; c++) if (selected[c]) chosen.push(c);
  const labelOf = new Map<number, number>();
  chosen.forEach((c, i) => labelOf.set(c, i));

  // Labels: each point belongs to its nearest selected ancestor, if any.
  const clusterParent = new Int32Array(clusterCount).fill(-1);
  for (let i = 0; i < cParent.length; i++) {
    if (cChild[i] >= n) clusterParent[cChild[i] - n] = cParent[i] - n;
  }
  const labels = new Array<number>(n).fill(-1);
  const probabilities = new Array<number>(n).fill(0);
  // Highest lambda among each cluster's direct children (its "death").
  const deathLambda = new Float64Array(clusterCount);
  for (let i = 0; i < cParent.length; i++) {
    const p = cParent[i] - n;
    if (cLambda[i] > deathLambda[p]) deathLambda[p] = cLambda[i];
  }
  for (let i = 0; i < cParent.length; i++) {
    if (cChild[i] >= n) continue;
    const point = cChild[i];
    let c = cParent[i] - n;
    while (c >= 0 && !selected[c]) c = clusterParent[c];
    if (c < 0) continue;
    labels[point] = labelOf.get(c) as number;
    const maxLambda = deathLambda[c];
    const lambda = Math.min(cLambda[i], maxLambda);
    probabilities[point] = !Number.isFinite(maxLambda) || maxLambda === 0 ? 1 : lambda / maxLambda;
  }
  return {
    labels,
    probabilities,
    clusterCount: chosen.length,
    stabilities: chosen.map((c) => stability[c]),
  };
}

// ---------------------------------------------------------------------------
// Ordinary kriging diagnostics
// ---------------------------------------------------------------------------

export type VariogramModel = "spherical" | "exponential" | "gaussian" | "linear";

/** One lag bin of an empirical semivariogram. */
export interface VariogramBin {
  /** Bin centre. */
  lag: number;
  /** Mean of 0.5 (z_i - z_j)² over the pairs in the bin. */
  gamma: number;
  pairs: number;
}

/** A fitted variogram (sill excludes the nugget, as in the Interpolation tool). */
export interface VariogramFit {
  model: VariogramModel;
  nugget: number;
  /** Partial sill. */
  sill: number;
  range: number;
  /** Sum of squared errors against the empirical bins. */
  sse: number;
}

/** Variogram shape normalized to a unit sill, as a function of h / range. */
export function variogramShape(hOverR: number, model: VariogramModel): number {
  if (model === "exponential") return 1 - Math.exp(-3 * hOverR);
  if (model === "gaussian") return 1 - Math.exp(-3 * hOverR * hOverR);
  const t = Math.min(hOverR, 1);
  if (model === "linear") return t;
  return hOverR >= 1 ? 1 : 1.5 * t - 0.5 * t ** 3;
}

/** Semivariance of a fitted model at lag h (0 at h = 0, the exact convention). */
export function variogramValue(fit: VariogramFit, h: number): number {
  if (h <= 0) return 0;
  return fit.nugget + fit.sill * variogramShape(h / fit.range, fit.model);
}

/**
 * Empirical semivariogram with equal-width lag bins from 0 to `maxLag`.
 *
 * @param n - Number of points.
 * @param dist - Distance between points i and j.
 * @param z - Values.
 * @param bins - Number of lag bins.
 * @param maxLag - Largest lag; pairs farther apart are ignored. Defaults to the
 *   largest pair distance, as the sidecar Interpolation tool does.
 * @returns The non-empty bins and the max lag used.
 */
export function empiricalVariogram(
  n: number,
  dist: (i: number, j: number) => number,
  z: number[],
  bins: number,
  maxLag?: number,
): { bins: VariogramBin[]; maxLag: number } {
  let hmax = maxLag ?? 0;
  if (!(hmax > 0)) {
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) hmax = Math.max(hmax, dist(i, j));
  }
  const sums = new Float64Array(bins);
  const counts = new Float64Array(bins);
  const width = hmax / bins;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const h = dist(i, j);
      if (h > hmax) continue;
      const b = Math.min(bins - 1, Math.max(0, Math.floor(h / width)));
      sums[b] += 0.5 * (z[i] - z[j]) ** 2;
      counts[b]++;
    }
  }
  const out: VariogramBin[] = [];
  for (let b = 0; b < bins; b++) {
    if (counts[b] > 0)
      out.push({ lag: (b + 0.5) * width, gamma: sums[b] / counts[b], pairs: counts[b] });
  }
  return { bins: out, maxLag: hmax };
}

/**
 * Least-squares variogram fit: for 25 trial ranges from 0.1 to 1.5 times
 * `maxLag`, solve nugget and sill by linear least squares (clamped at 0), and
 * keep the range with the smallest squared error. This mirrors the sidecar
 * Interpolation tool's ordinary kriging fit.
 *
 * @returns The fitted model, or null with fewer than one usable bin.
 */
export function fitVariogram(
  bins: VariogramBin[],
  model: VariogramModel,
  maxLag: number,
): VariogramFit | null {
  if (!bins.length || !(maxLag > 0)) return null;
  let best: VariogramFit | null = null;
  for (let step = 0; step < 25; step++) {
    const range = maxLag * (0.1 + (1.4 * step) / 24);
    const shapes = bins.map((bin) => variogramShape(bin.lag / range, model));
    // Normal equations for gamma ~ c0 + c1 * shape.
    const m = shapes.length;
    let s1 = 0;
    let s2 = 0;
    let sg = 0;
    let ssg = 0;
    for (let i = 0; i < m; i++) {
      s1 += shapes[i];
      s2 += shapes[i] * shapes[i];
      sg += bins[i].gamma;
      ssg += shapes[i] * bins[i].gamma;
    }
    const det = m * s2 - s1 * s1;
    let c0: number;
    let c1: number;
    if (Math.abs(det) > 1e-300) {
      c0 = (s2 * sg - s1 * ssg) / det;
      c1 = (m * ssg - s1 * sg) / det;
    } else {
      // Every bin has the same shape value: numpy's minimum-norm solution.
      const mean = sg / m;
      const sh = s1 / m;
      c0 = mean / (1 + sh * sh);
      c1 = (mean * sh) / (1 + sh * sh);
    }
    const nugget = Math.max(0, c0);
    const sill = Math.max(1e-12, c1);
    let sse = 0;
    for (let i = 0; i < m; i++) sse += (nugget + sill * shapes[i] - bins[i].gamma) ** 2;
    if (!best || sse < best.sse) best = { model, nugget, sill, range, sse };
  }
  return best;
}

/** Leave-one-out cross-validation of ordinary kriging. */
export interface KrigingCrossValidation {
  predicted: number[];
  /** Predicted minus observed. */
  errors: number[];
  /** Kriging variance of each left-out prediction. */
  variances: number[];
  /** Error / kriging standard deviation. */
  standardizedErrors: number[];
  meanError: number;
  rmse: number;
  meanStandardizedError: number;
  /** Root-mean-square standardized error; near 1 means the variance is right. */
  rmsse: number;
  /** Pearson correlation of observed and predicted. */
  correlation: number;
}

/**
 * Leave-one-out cross-validation for ordinary kriging, computed from a single
 * matrix inversion with Dubrule's (1983) identity instead of n refits. With K
 * the variogram-form kriging matrix [[Γ, 1], [1', 0]] and B = K⁻¹, the
 * left-out residual at point i is (B [z; 0])_i / B_ii and its kriging
 * variance is -1 / B_ii. The test suite checks this against brute-force refits.
 * The variogram itself is fitted once on all points, as is usual for
 * cross-validating a variogram model.
 *
 * @param n - Number of points.
 * @param dist - Distance between points i and j.
 * @param z - Values.
 * @param fit - Variogram model.
 * @returns Per-point predictions and summary statistics, or null if the
 *   kriging system is singular (e.g. duplicate locations).
 */
export function krigingLeaveOneOut(
  n: number,
  dist: (i: number, j: number) => number,
  z: number[],
  fit: VariogramFit,
): KrigingCrossValidation | null {
  const size = n + 1;
  const k: number[][] = Array.from({ length: size }, () => new Array<number>(size).fill(1));
  for (let i = 0; i < n; i++) {
    k[i][i] = 0;
    for (let j = i + 1; j < n; j++) {
      const g = variogramValue(fit, dist(i, j));
      k[i][j] = g;
      k[j][i] = g;
    }
  }
  k[n][n] = 0;
  const inv = invertMatrix(k);
  if (!inv) return null;
  const predicted: number[] = [];
  const errors: number[] = [];
  const variances: number[] = [];
  const standardizedErrors: number[] = [];
  for (let i = 0; i < n; i++) {
    let bz = 0;
    for (let j = 0; j < n; j++) bz += inv[i][j] * z[j];
    const bii = inv[i][i];
    // Variogram-form Dubrule: z_i - ẑ_-i = (B z̃)_i / B_ii, σ²_-i = -1 / B_ii.
    const residual = bz / bii;
    const variance = -1 / bii;
    const pred = z[i] - residual;
    predicted.push(pred);
    errors.push(pred - z[i]);
    variances.push(variance);
    standardizedErrors.push(variance > 0 ? (pred - z[i]) / Math.sqrt(variance) : NaN);
  }
  const mean = (values: number[]): number => values.reduce((s, v) => s + v, 0) / values.length;
  const zMean = mean(z);
  const pMean = mean(predicted);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (z[i] - zMean) * (predicted[i] - pMean);
    sxx += (z[i] - zMean) ** 2;
    syy += (predicted[i] - pMean) ** 2;
  }
  const finiteStd = standardizedErrors.filter(Number.isFinite);
  return {
    predicted,
    errors,
    variances,
    standardizedErrors,
    meanError: mean(errors),
    rmse: Math.sqrt(mean(errors.map((e) => e * e))),
    meanStandardizedError: finiteStd.length ? mean(finiteStd) : NaN,
    rmsse: finiteStd.length ? Math.sqrt(mean(finiteStd.map((e) => e * e))) : NaN,
    correlation: sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN,
  };
}
