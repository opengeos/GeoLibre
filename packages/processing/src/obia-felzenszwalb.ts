/**
 * Felzenszwalb and Huttenlocher's graph-based segmentation, in the browser.
 *
 * It follows scikit-image's `felzenszwalb`, which the desktop app's sidecar
 * runs: bands standardized over the valid pixels, a Gaussian smoothing of
 * each band, 8-connected edges weighted by the Euclidean distance between
 * neighboring pixels, merging two components while the edge is no heavier
 * than either one's internal difference plus `scale / size`, then merging
 * components smaller than `minSize` into a neighbor.
 *
 * Edges are ordered by a counting sort on the top 16 bits of their weight
 * (about three significant digits), which keeps memory near 24 bytes per
 * pixel. Results are deterministic, but not identical to scikit-image's.
 */

/** Felzenszwalb parameters, as the native method takes them. */
export interface ObiaFelzenszwalbParams {
  /** Larger gives larger objects. */
  scale: number;
  /** Gaussian smoothing, in pixels (0 for none). */
  sigma: number;
  /** Objects smaller than this many pixels merge into a neighbor. */
  minSize: number;
}

/** The most pixels a browser Felzenszwalb run reads (4096 × 2048). */
export const OBIA_FELZENSZWALB_MAX_PIXELS = 4096 * 2048;

/**
 * Standardize each band over the valid pixels (invalid pixels become 0), so
 * no band dominates the distances.
 */
function standardize(bands: readonly Float32Array[], valid: Uint8Array): Float32Array[] {
  return bands.map((band) => {
    let n = 0;
    let sum = 0;
    for (let i = 0; i < band.length; i += 1) {
      if (valid[i]) {
        sum += band[i];
        n += 1;
      }
    }
    const mean = n ? sum / n : 0;
    let squares = 0;
    for (let i = 0; i < band.length; i += 1) {
      if (valid[i]) squares += (band[i] - mean) ** 2;
    }
    const std = n ? Math.sqrt(squares / n) || 1 : 1;
    const out = new Float32Array(band.length);
    for (let i = 0; i < band.length; i += 1) out[i] = valid[i] ? (band[i] - mean) / std : 0;
    return out;
  });
}

/**
 * Separable Gaussian smoothing with mirrored edges (scipy's "reflect"),
 * truncated at 4 sigma, as scipy.ndimage.gaussian_filter does.
 */
function gaussian(band: Float32Array, width: number, height: number, sigma: number): Float32Array {
  if (!(sigma > 0)) return band;
  const radius = Math.floor(4 * sigma + 0.5);
  const kernel = new Float64Array(2 * radius + 1);
  let total = 0;
  for (let k = -radius; k <= radius; k += 1) {
    const w = Math.exp((-0.5 * k * k) / (sigma * sigma));
    kernel[k + radius] = w;
    total += w;
  }
  for (let k = 0; k < kernel.length; k += 1) kernel[k] /= total;
  // Mirror an index into [0, n): d c b a | a b c d | d c b a.
  const mirror = (i: number, n: number) => {
    const period = 2 * n;
    let j = ((i % period) + period) % period;
    if (j >= n) j = period - 1 - j;
    return j;
  };
  const tmp = new Float32Array(band.length);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      let acc = 0;
      for (let k = -radius; k <= radius; k += 1) {
        acc += kernel[k + radius] * band[row + mirror(x + k, width)];
      }
      tmp[row + x] = acc;
    }
  }
  const out = new Float32Array(band.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let acc = 0;
      for (let k = -radius; k <= radius; k += 1) {
        acc += kernel[k + radius] * tmp[mirror(y + k, height) * width + x];
      }
      out[y * width + x] = acc;
    }
  }
  return out;
}

/** The pixel offsets of the 8-connected edge directions: right, down, down-right, up-right. */
const DIRECTIONS = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
] as const;

/** A weight's sort key: the top 16 bits of its float32 form (weights are >= 0). */
const keyView = new DataView(new ArrayBuffer(4));
function sortKey(weight: number): number {
  keyView.setFloat32(0, weight);
  return keyView.getUint32(0) >>> 16;
}
/** The weight a sort key stands for: the middle of its range. */
function keyWeight(key: number): number {
  keyView.setUint32(0, ((key << 16) | 0x8000) >>> 0);
  return keyView.getFloat32(0);
}

/**
 * Segment bands with Felzenszwalb's method.
 *
 * @param bands One array per band, row-major, `width * height` long.
 * @param width Grid width.
 * @param height Grid height.
 * @param valid 1 where the pixel has data in every band; null for all.
 * @param params Scale, smoothing and minimum object size.
 * @returns Labels 1..n in raster order of first appearance, 0 where invalid.
 */
export function felzenszwalbLabels(
  bands: readonly Float32Array[],
  width: number,
  height: number,
  valid: Uint8Array | null,
  params: ObiaFelzenszwalbParams,
): Int32Array {
  const n = width * height;
  const ok = valid ?? new Uint8Array(n).fill(1);
  const image = standardize(bands, ok).map((band) => gaussian(band, width, height, params.sigma));

  // Edge e = pixel * 4 + direction, between valid pixels only.
  const keys = new Uint16Array(n * 4);
  const present = new Uint8Array(n * 4);
  const counts = new Uint32Array(65537);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = y * width + x;
      if (!ok[p]) continue;
      for (let d = 0; d < 4; d += 1) {
        const qx = x + DIRECTIONS[d][0];
        const qy = y + DIRECTIONS[d][1];
        if (qx < 0 || qx >= width || qy < 0 || qy >= height) continue;
        const q = qy * width + qx;
        if (!ok[q]) continue;
        let sq = 0;
        for (const band of image) sq += (band[p] - band[q]) ** 2;
        const key = sortKey(Math.sqrt(sq));
        const e = p * 4 + d;
        keys[e] = key;
        present[e] = 1;
        counts[key + 1] += 1;
      }
    }
  }
  for (let k = 1; k < counts.length; k += 1) counts[k] += counts[k - 1];
  const edgeCount = counts[65536];
  const order = new Uint32Array(edgeCount);
  const next = counts.slice(0, 65536);
  for (let e = 0; e < n * 4; e += 1) {
    if (present[e]) order[next[keys[e]]++] = e;
  }

  const parent = new Int32Array(n);
  for (let i = 0; i < n; i += 1) parent[i] = i;
  const size = new Int32Array(n).fill(1);
  const internal = new Float32Array(n);
  const find = (i: number) => {
    let root = i;
    while (parent[root] !== root) root = parent[root];
    while (parent[i] !== root) {
      const up = parent[i];
      parent[i] = root;
      i = up;
    }
    return root;
  };
  const other = (e: number) => {
    const p = Math.floor(e / 4);
    const d = DIRECTIONS[e % 4];
    return p + d[1] * width + d[0];
  };
  const join = (a: number, b: number, weight: number) => {
    const [root, child] = a < b ? [a, b] : [b, a];
    parent[child] = root;
    size[root] += size[child];
    internal[root] = weight;
  };

  // scikit-image divides the scale by 255 (to behave like the reference
  // implementation on 8-bit images); so does this, so a scale means the same
  // in both engines.
  const scale = params.scale / 255;
  const { minSize } = params;
  for (let i = 0; i < edgeCount; i += 1) {
    const e = order[i];
    const a = find(Math.floor(e / 4));
    const b = find(other(e));
    if (a === b) continue;
    const weight = keyWeight(keys[e]);
    if (weight <= Math.min(internal[a] + scale / size[a], internal[b] + scale / size[b])) {
      join(a, b, weight);
    }
  }
  // Small components merge into a neighbor, lightest edge first.
  for (let i = 0; i < edgeCount; i += 1) {
    const e = order[i];
    const a = find(Math.floor(e / 4));
    const b = find(other(e));
    if (a !== b && (size[a] < minSize || size[b] < minSize)) {
      join(a, b, Math.max(internal[a], internal[b]));
    }
  }

  const labels = new Int32Array(n);
  const labelOf = new Map<number, number>();
  for (let p = 0; p < n; p += 1) {
    if (!ok[p]) continue;
    const root = find(p);
    let label = labelOf.get(root);
    if (label === undefined) labelOf.set(root, (label = labelOf.size + 1));
    labels[p] = label;
  }
  return labels;
}
