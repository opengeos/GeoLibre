/**
 * In-browser automatic "segment everything" with SlimSAM (issue #902).
 *
 * Runs a lightweight Segment Anything model (SlimSAM, exported to ONNX by
 * transformers.js) fully client-side via `onnxruntime-web`: the image encoder
 * runs once, then a grid of foreground points is fed through the prompt/mask
 * decoder to produce a mask per object with no user clicks — the browser
 * equivalent of samgeo's automatic mask generator. Each surviving mask is traced
 * to a polygon in source-raster pixel coordinates; the caller georeferences
 * those with the raster's geotransform and adds them as a GeoJSON layer.
 *
 * SAM has no in-browser automatic-mask pipeline, so the grid sampling, mask
 * selection (multimask + predicted-IoU + stability), de-duplication (box NMS),
 * and mask→polygon tracing are implemented here.
 */

import { loadOrt } from "./ort";
import type { RasterData } from "./raster-client";

/** A single automatic mask, as a polygon in **source raster pixel** coords. */
export interface SegmentMask {
  /** Closed exterior ring `[[x, y], …]` in source pixels (top-left origin). */
  polygon: [number, number][];
  /** Predicted IoU / quality score for the mask. */
  score: number;
  /** Mask area in source pixels². */
  area: number;
}

/** Tuning knobs for {@link segmentEverything}. */
export interface SegmentEverythingOptions {
  /** Points sampled per image edge (grid is `pointsPerSide²`). Default 16. */
  pointsPerSide?: number;
  /** Minimum predicted IoU to keep a mask. Default 0.85. */
  predIouThreshold?: number;
  /** Minimum stability score to keep a mask. Default 0.9. */
  stabilityScoreThreshold?: number;
  /** Minimum mask area, as a fraction of the image area. Default 0.0008. */
  minAreaFraction?: number;
  /** Box-IoU above which the lower-scoring of two masks is dropped. Default 0.7. */
  boxNmsThreshold?: number;
  /** Points per decoder call. Default 64 (caps the output-tensor memory). */
  pointBatchSize?: number;
  /** Progress callback: `done`/`total` grid-point batches. */
  onProgress?: (done: number, total: number) => void;
  /** Abort signal; checked between decoder batches. */
  signal?: AbortSignal;
}

const SAM_INPUT = 1024;
const MASK_SIZE = 256;
const MASK_UPSCALE = SAM_INPUT / MASK_SIZE; // 4
// SAM ImageNet normalisation (applied after the raster is scaled to 0-1).
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
// Logit offset for the stability score (SAM's default mask threshold is 0).
const STABILITY_OFFSET = 1.0;
const DEFAULT_POINTS_PER_SIDE = 16;
const DEFAULT_PRED_IOU = 0.85;
const DEFAULT_STABILITY = 0.9;
const DEFAULT_MIN_AREA_FRACTION = 0.0008;
const DEFAULT_BOX_NMS = 0.7;
const DEFAULT_POINT_BATCH = 64;
const MAX_POINTS_PER_SIDE = 48;

/** Bilinear sample of a band at fractional source `(x, y)`; NaN on NoData. */
function sampleBilinear(
  band: Float32Array,
  width: number,
  height: number,
  x: number,
  y: number,
  nodata: number | null,
): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const cx0 = Math.min(width - 1, Math.max(0, x0));
  const cy0 = Math.min(height - 1, Math.max(0, y0));
  const dx = x - x0;
  const dy = y - y0;
  const v00 = band[cy0 * width + cx0];
  const v10 = band[cy0 * width + x1];
  const v01 = band[y1 * width + cx0];
  const v11 = band[y1 * width + x1];
  if (!Number.isFinite(v00) || v00 === nodata) return NaN;
  if (!Number.isFinite(v10) || v10 === nodata) return NaN;
  if (!Number.isFinite(v01) || v01 === nodata) return NaN;
  if (!Number.isFinite(v11) || v11 === nodata) return NaN;
  const top = v00 + (v10 - v00) * dx;
  const bottom = v01 + (v11 - v01) * dx;
  return top + (bottom - top) * dy;
}

/** Observed max of the raster's red band (ignoring NoData), to scale to 0-1. */
function bandDivisor(r: Float32Array, nodata: number | null): number {
  let max = 0;
  let hasValid = false;
  const step = Math.max(1, Math.floor(r.length / 4096));
  for (let i = 0; i < r.length; i += step) {
    const v = r[i];
    if (!Number.isFinite(v) || v === nodata) continue;
    hasValid = true;
    if (v > max) max = v;
  }
  if (!hasValid) max = 255;
  return max <= 1.5 ? 1 : max <= 255 && Number.isInteger(max) ? 255 : max;
}

interface Preprocessed {
  pixelValues: Float32Array;
  scale: number;
  newW: number;
  newH: number;
}

/**
 * Resize a raster to SAM's 1024-longest-edge input (aspect preserved, padded
 * bottom/right with zeros) and normalise into an NCHW float tensor.
 */
function preprocess(raster: RasterData): Preprocessed {
  const { width, height, bands, nodata } = raster;
  const r = bands[0];
  const g = bands.length > 1 ? bands[1] : bands[0];
  const b = bands.length > 2 ? bands[2] : bands[0];
  const divisor = bandDivisor(r, nodata);
  const scale = SAM_INPUT / Math.max(width, height);
  const newW = Math.round(width * scale);
  const newH = Math.round(height * scale);

  const plane = SAM_INPUT * SAM_INPUT;
  const data = new Float32Array(3 * plane); // zeros = padding (post-normalise)
  const channels: [Float32Array, number, number, number][] = [
    [r, 0, MEAN[0], STD[0]],
    [g, plane, MEAN[1], STD[1]],
    [b, 2 * plane, MEAN[2], STD[2]],
  ];
  for (let dy = 0; dy < newH; dy += 1) {
    const sy = (dy + 0.5) / scale - 0.5;
    for (let dx = 0; dx < newW; dx += 1) {
      const sx = (dx + 0.5) / scale - 0.5;
      const dst = dy * SAM_INPUT + dx;
      for (const [band, offset, mean, std] of channels) {
        const sampled = sampleBilinear(band, width, height, sx, sy, nodata);
        // NoData/invalid pixels stay at the padding value (0 after normalise).
        if (Number.isFinite(sampled)) {
          const v01 = Math.min(1, Math.max(0, sampled / divisor));
          data[offset + dst] = (v01 - mean) / std;
        }
      }
    }
  }
  return { pixelValues: data, scale, newW, newH };
}

/** Trace the exterior boundary of the mask's first component (Moore-neighbour,
 * 8-connected). Returns a pixel ring in mask (256) coordinates, or null. */
function traceContour(mask: Uint8Array, w: number, h: number): [number, number][] | null {
  const at = (x: number, y: number): number =>
    x < 0 || y < 0 || x >= w || y >= h ? 0 : mask[y * w + x];
  let sx = -1;
  let sy = -1;
  outer: for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (mask[y * w + x]) {
        sx = x;
        sy = y;
        break outer;
      }
    }
  }
  if (sx < 0) return null;
  // Neighbour offsets, clockwise starting north.
  const N8 = [
    [0, -1],
    [1, -1],
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1],
  ];
  const ring: [number, number][] = [[sx, sy]];
  let cx = sx;
  let cy = sy;
  // Enter the start pixel from the west (background side while scan-finding it).
  let backDir = 6;
  const maxSteps = w * h * 8;
  for (let step = 0; step < maxSteps; step += 1) {
    let found = false;
    for (let k = 1; k <= 8; k += 1) {
      const dir = (backDir + k) % 8;
      const nx = cx + N8[dir][0];
      const ny = cy + N8[dir][1];
      if (at(nx, ny)) {
        cx = nx;
        cy = ny;
        // New backtrack points from the entered pixel back to where we came.
        backDir = (dir + 4) % 8;
        ring.push([nx, ny]);
        found = true;
        break;
      }
    }
    if (!found) break; // isolated pixel
    if (cx === sx && cy === sy) break; // closed the loop
  }
  return ring.length >= 3 ? ring : null;
}

/** Perpendicular distance of point p from the line a→b. */
function perpDist(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / len;
}

/** Douglas–Peucker ring simplification (open polyline; caller re-closes). */
function simplifyRing(ring: [number, number][], epsilon: number): [number, number][] {
  if (ring.length < 3) return ring;
  let maxDist = 0;
  let index = 0;
  const end = ring.length - 1;
  for (let i = 1; i < end; i += 1) {
    const d = perpDist(ring[i], ring[0], ring[end]);
    if (d > maxDist) {
      maxDist = d;
      index = i;
    }
  }
  if (maxDist <= epsilon) return [ring[0], ring[end]];
  const left = simplifyRing(ring.slice(0, index + 1), epsilon);
  const right = simplifyRing(ring.slice(index), epsilon);
  return [...left.slice(0, -1), ...right];
}

interface Candidate {
  polygon: [number, number][];
  score: number;
  area: number;
  bbox: [number, number, number, number];
}

/** Absolute area of a closed polygon ring (shoelace formula). */
function polygonArea(ring: [number, number][]): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return Math.abs(sum) / 2;
}

/** IoU of two `[minX, minY, maxX, maxY]` boxes. */
function boxIou(a: [number, number, number, number], b: [number, number, number, number]): number {
  const ix1 = Math.max(a[0], b[0]);
  const iy1 = Math.max(a[1], b[1]);
  const ix2 = Math.min(a[2], b[2]);
  const iy2 = Math.min(a[3], b[3]);
  const iw = Math.max(0, ix2 - ix1);
  const ih = Math.max(0, iy2 - iy1);
  const inter = iw * ih;
  if (inter <= 0) return 0;
  const areaA = (a[2] - a[0]) * (a[3] - a[1]);
  const areaB = (b[2] - b[0]) * (b[3] - b[1]);
  return inter / (areaA + areaB - inter);
}

/** Greedy box NMS: keep highest-scoring masks, drop overlaps above threshold. */
function boxNms(cands: Candidate[], threshold: number): Candidate[] {
  const sorted = [...cands].sort((p, q) => q.score - p.score);
  const kept: Candidate[] = [];
  for (const c of sorted) {
    if (kept.some((k) => boxIou(k.bbox, c.bbox) > threshold)) continue;
    kept.push(c);
  }
  return kept;
}

/** Stability score: IoU of the mask thresholded at ±offset (SAM's measure). */
function stabilityScore(logits: Float32Array): number {
  let high = 0;
  let low = 0;
  for (let i = 0; i < logits.length; i += 1) {
    if (logits[i] > STABILITY_OFFSET) high += 1;
    if (logits[i] > -STABILITY_OFFSET) low += 1;
  }
  return low === 0 ? 0 : high / low;
}

/**
 * Run SlimSAM automatically over a raster and return one polygon per detected
 * object, in source-raster pixel coordinates.
 *
 * @param raster The decoded source raster (from `readRasterData`).
 * @param encoderBytes The SlimSAM image-encoder `.onnx` bytes.
 * @param decoderBytes The SlimSAM prompt-encoder/mask-decoder `.onnx` bytes.
 * @param options Grid density and mask-quality thresholds.
 * @returns Masks as source-pixel polygons, after de-duplication.
 */
export async function segmentEverything(
  raster: RasterData,
  encoderBytes: ArrayBuffer,
  decoderBytes: ArrayBuffer,
  options: SegmentEverythingOptions = {},
): Promise<SegmentMask[]> {
  const pointsPerSide = options.pointsPerSide ?? DEFAULT_POINTS_PER_SIDE;
  const predIou = options.predIouThreshold ?? DEFAULT_PRED_IOU;
  const stabilityThreshold = options.stabilityScoreThreshold ?? DEFAULT_STABILITY;
  const minAreaFraction = options.minAreaFraction ?? DEFAULT_MIN_AREA_FRACTION;
  const boxNmsThreshold = options.boxNmsThreshold ?? DEFAULT_BOX_NMS;
  const pointBatch = options.pointBatchSize ?? DEFAULT_POINT_BATCH;

  if (
    !Number.isInteger(pointsPerSide) ||
    pointsPerSide < 2 ||
    pointsPerSide > MAX_POINTS_PER_SIDE
  ) {
    throw new Error(`pointsPerSide must be an integer between 2 and ${MAX_POINTS_PER_SIDE}.`);
  }

  const ort = await loadOrt();
  const encoder = await ort.InferenceSession.create(new Uint8Array(encoderBytes), {
    executionProviders: ["wasm"],
  });
  let decoder: import("onnxruntime-web/wasm").InferenceSession;
  try {
    decoder = await ort.InferenceSession.create(new Uint8Array(decoderBytes), {
      executionProviders: ["wasm"],
    });
  } catch (err) {
    // Release the already-created encoder so its WASM heap doesn't leak when
    // decoder creation fails (both sessions live outside the finally below).
    await encoder.release().catch(() => {});
    throw err;
  }

  try {
    const { width, height } = raster;
    const { pixelValues, scale, newW, newH } = preprocess(raster);
    const tensor = new ort.Tensor("float32", pixelValues, [1, 3, SAM_INPUT, SAM_INPUT]);
    const embeds = await encoder.run({ pixel_values: tensor });
    const imageEmbeddings = embeds.image_embeddings;
    const imagePositional = embeds.image_positional_embeddings;

    // Sample a regular grid of foreground points, in the resized (pre-pad) input
    // coordinate space the model expects. Skip the outermost half-cell margin so
    // points sit inside objects (SAM's default grid convention).
    const points: [number, number][] = [];
    for (let gi = 0; gi < pointsPerSide; gi += 1) {
      for (let gj = 0; gj < pointsPerSide; gj += 1) {
        const srcX = ((gj + 0.5) * width) / pointsPerSide;
        const srcY = ((gi + 0.5) * height) / pointsPerSide;
        points.push([srcX * scale, srcY * scale]);
      }
    }

    // Mask coordinates beyond the resized image are padding; clip there.
    const maskMaxX = Math.min(MASK_SIZE, Math.ceil(newW / MASK_UPSCALE));
    const maskMaxY = Math.min(MASK_SIZE, Math.ceil(newH / MASK_UPSCALE));
    const imageArea = width * height;
    const minArea = minAreaFraction * imageArea;
    const simplifyEps = Math.max(1, (2 * MASK_UPSCALE) / scale);

    const candidates: Candidate[] = [];
    const totalBatches = Math.ceil(points.length / pointBatch);
    for (let bi = 0; bi < totalBatches; bi += 1) {
      if (options.signal?.aborted) throw new Error("aborted");
      const batch = points.slice(bi * pointBatch, (bi + 1) * pointBatch);
      const p = batch.length;
      const ptData = new Float32Array(p * 2);
      const lblData = new BigInt64Array(p);
      for (let i = 0; i < p; i += 1) {
        ptData[i * 2] = batch[i][0];
        ptData[i * 2 + 1] = batch[i][1];
        lblData[i] = 1n; // foreground
      }
      const out = await decoder.run({
        input_points: new ort.Tensor("float32", ptData, [1, p, 1, 2]),
        input_labels: new ort.Tensor("int64", lblData, [1, p, 1]),
        image_embeddings: imageEmbeddings,
        image_positional_embeddings: imagePositional,
      });
      const iou = out.iou_scores.data as Float32Array;
      const masks = out.pred_masks.data as Float32Array;
      const maskStride = MASK_SIZE * MASK_SIZE;

      for (let i = 0; i < p; i += 1) {
        // Pick the highest-quality of the 3 multimask predictions.
        let bestK = 0;
        let bestScore = -Infinity;
        for (let k = 0; k < 3; k += 1) {
          const s = iou[i * 3 + k];
          if (s > bestScore) {
            bestScore = s;
            bestK = k;
          }
        }
        if (bestScore < predIou) continue;

        const base = (i * 3 + bestK) * maskStride;
        const logits = masks.subarray(base, base + maskStride);
        if (stabilityScore(logits) < stabilityThreshold) continue;

        // Binarise into the valid (non-padding) region only.
        const bin = new Uint8Array(maskStride);
        let count = 0;
        for (let my = 0; my < maskMaxY; my += 1) {
          for (let mx = 0; mx < maskMaxX; mx += 1) {
            if (logits[my * MASK_SIZE + mx] > 0) {
              bin[my * MASK_SIZE + mx] = 1;
              count += 1;
            }
          }
        }
        // Cheap pre-filter on the thresholded pixel count (all blobs) before the
        // more expensive contour trace; the reported `area` below is taken from
        // the traced polygon so it stays consistent with the emitted geometry.
        const px2 = (MASK_UPSCALE / scale) * (MASK_UPSCALE / scale);
        if (count * px2 < minArea) continue;

        const ring = traceContour(bin, MASK_SIZE, MASK_SIZE);
        if (!ring) continue;
        const simplified = simplifyRing(ring, simplifyEps / (MASK_UPSCALE / scale));
        if (simplified.length < 3) continue;

        // Map ring vertices from mask (256) space to source pixels and close.
        // traceContour walks only the first connected component, so `polygon`,
        // its `bbox`, and its `area` all describe that one blob consistently.
        const polygon: [number, number][] = simplified.map(([mx, my]) => [
          Math.min(width, (mx * MASK_UPSCALE) / scale),
          Math.min(height, (my * MASK_UPSCALE) / scale),
        ]);
        polygon.push(polygon[0]);
        const area = polygonArea(polygon);
        if (area < minArea) continue;

        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const [x, y] of polygon) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
        candidates.push({
          polygon,
          score: bestScore,
          area,
          bbox: [minX, minY, maxX, maxY],
        });
      }
      options.onProgress?.(bi + 1, totalBatches);
    }

    return boxNms(candidates, boxNmsThreshold).map((c) => ({
      polygon: c.polygon,
      score: c.score,
      area: c.area,
    }));
  } finally {
    // Swallow cleanup failures so a release() error can never mask the primary
    // error from the try above.
    await encoder.release().catch(() => {});
    await decoder.release().catch(() => {});
  }
}
