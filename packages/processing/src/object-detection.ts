/**
 * In-browser object detection with ONNX/YOLO models (issue #902).
 *
 * Complements the AI Segmentation toolbox (which proxies SAM3 through the Python
 * sidecar) with a fully client-side path: a user-supplied YOLO model exported to
 * ONNX runs against a chosen raster via `onnxruntime-web`, and the detected
 * bounding boxes come back in source-raster pixel coordinates. The caller
 * (the detection dialog) georeferences those pixel boxes with the raster's
 * geotransform and turns each class into a GeoJSON layer.
 *
 * Keeping inference in the browser means detection works in the web build with
 * no sidecar, mirroring how the client raster tools (`raster-client.ts`) run on
 * `geotiff.js` alone. The heavy `onnxruntime-web` module is imported lazily so
 * this file (and the rest of `@geolibre/processing`) loads without pulling the
 * WASM runtime until a detection is actually requested.
 *
 * Supported model outputs: the standard Ultralytics exports for YOLOv8/v11
 * (`[1, 4 + numClasses, anchors]`, boxes in input pixels, class scores already
 * sigmoid-activated) and YOLOv5 (`[1, anchors, 5 + numClasses]`, with an extra
 * objectness channel). Both decode to the same detection list.
 */

import { loadOrt } from "./ort";
import type { RasterData } from "./raster-client";

/** A single detection in **source raster pixel** coordinates. */
export interface Detection {
  /** Bounding box `[minX, minY, maxX, maxY]` in source pixels (top-left origin). */
  bbox: [number, number, number, number];
  /** Zero-based class index from the model output. */
  classIndex: number;
  /** Confidence score in `[0, 1]`. */
  score: number;
}

/** Tuning knobs for {@link detectObjects}. */
export interface DetectionOptions {
  /** Square model input size in pixels (YOLO default 640). */
  inputSize?: number;
  /** Minimum confidence to keep a detection. */
  confidenceThreshold?: number;
  /** IoU threshold for non-maximum suppression. */
  iouThreshold?: number;
}

const DEFAULT_INPUT_SIZE = 640;
// Upper bound on the model input edge. A 4096 input allocates
// 3 × 4096² × 4 ≈ 200 MB of Float32, which is the most we let a single
// detection tensor consume; larger values are rejected before allocation so a
// stray/huge `inputSize` cannot OOM the tab.
const MAX_INPUT_SIZE = 4096;
const DEFAULT_CONFIDENCE = 0.25;
const DEFAULT_IOU = 0.45;
/** Letterbox padding colour (YOLO uses 114/255 grey). */
const PAD_VALUE = 114 / 255;

// Re-exported for the guard test (tests/object-detection.test.ts), which asserts
// the CDN WASM version matches the pinned onnxruntime-web dependency.
export { ORT_VERSION } from "./ort";

/**
 * Pull three colour channels and a normalisation divisor out of a
 * {@link RasterData}.
 *
 * Uses the first three bands as R/G/B; a single-band raster is replicated to
 * greyscale. The divisor maps raw band values to roughly 0-1 for the model:
 * data already in 0-1 is left as-is, 8-bit imagery is scaled by 255, and
 * higher-bit-depth data (e.g. 16-bit) is scaled by its own observed maximum so
 * it still lands in 0-1 rather than feeding the model values far above 1.
 * NoData and non-finite samples are excluded from that maximum so a sea of
 * NoData (or a few sentinel pixels) cannot skew the scale.
 *
 * @param raster The decoded source raster.
 * @returns The per-channel band arrays, the divisor, and the source NoData.
 */
export function rgbBands(raster: RasterData): {
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
  divisor: number;
  nodata: number | null;
} {
  const { bands, nodata } = raster;
  const r = bands[0];
  const g = bands.length > 1 ? bands[1] : bands[0];
  const b = bands.length > 2 ? bands[2] : bands[0];
  // Sample the red band to decide the value range, ignoring NoData/non-finite
  // pixels. Aerial/RGB imagery is almost always 8-bit (0-255); reflectance
  // products may already be 0-1; higher-bit-depth data exceeds 255.
  let max = 0;
  let hasValid = false;
  const step = Math.max(1, Math.floor(r.length / 4096));
  for (let i = 0; i < r.length; i += step) {
    const v = r[i];
    if (!Number.isFinite(v) || v === nodata) continue;
    hasValid = true;
    if (v > max) max = v;
  }
  // If sampling found no valid pixels (e.g. the stride skipped every valid one
  // in a mostly-NoData raster), assume 8-bit range so the tensor receives 0-1
  // values rather than raw 0-255 counts.
  if (!hasValid) max = 255;
  // Only treat a raster as 8-bit when its sampled max is a whole number in
  // (1.5, 255]: floats never land on exact integers, so a reflectance/index/DEM
  // raster peaking in that range auto-scales by its own max instead of being
  // divided by 255 (which would push a value of 2.0 to a near-black 0.008).
  const divisor = max <= 1.5 ? 1 : max <= 255 && Number.isInteger(max) ? 255 : max;
  return { r, g, b, divisor, nodata };
}

/**
 * Bilinear sample of a band at fractional source pixel `(x, y)`.
 *
 * Returns `NaN` when any of the four contributing pixels is NoData or
 * non-finite, so the caller can substitute the padding value instead of
 * blending an invalid pixel into the model input.
 */
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
  // Unrolled (no array allocation) since this runs once per input pixel/channel.
  if (!Number.isFinite(v00) || v00 === nodata) return NaN;
  if (!Number.isFinite(v10) || v10 === nodata) return NaN;
  if (!Number.isFinite(v01) || v01 === nodata) return NaN;
  if (!Number.isFinite(v11) || v11 === nodata) return NaN;
  const top = v00 + (v10 - v00) * dx;
  const bottom = v01 + (v11 - v01) * dx;
  return top + (bottom - top) * dy;
}

/** Geometry of the letterbox transform from source pixels to model input. */
interface Letterbox {
  scale: number;
  padX: number;
  padY: number;
}

/**
 * Resize a raster into a square `inputSize` NCHW float tensor, letterboxed to
 * preserve aspect ratio (padding the short side with grey).
 *
 * @returns The `[1, 3, inputSize, inputSize]` data and the {@link Letterbox}
 *   needed to map detections back to source pixels.
 */
function preprocess(
  raster: RasterData,
  inputSize: number,
): { data: Float32Array; letterbox: Letterbox } {
  const { width, height } = raster;
  const { r, g, b, divisor, nodata } = rgbBands(raster);
  const scale = Math.min(inputSize / width, inputSize / height);
  const newW = Math.round(width * scale);
  const newH = Math.round(height * scale);
  const padX = (inputSize - newW) / 2;
  const padY = (inputSize - newH) / 2;

  const plane = inputSize * inputSize;
  const data = new Float32Array(3 * plane).fill(PAD_VALUE);
  const channels: [Float32Array, number][] = [
    [r, 0],
    [g, plane],
    [b, 2 * plane],
  ];
  // NOTE: this loop is O(inputSize²) and runs synchronously on the main thread.
  // At the default 640 it is imperceptible; near the 4096 cap it can stall the
  // UI for a second or two. Running it (and the WASM inference) in a Web Worker
  // is the proper fix and a tracked follow-up.
  for (let dy = 0; dy < inputSize; dy += 1) {
    const sy = (dy + 0.5 - padY) / scale - 0.5;
    if (sy < -0.5 || sy > height - 0.5) continue;
    for (let dx = 0; dx < inputSize; dx += 1) {
      const sx = (dx + 0.5 - padX) / scale - 0.5;
      if (sx < -0.5 || sx > width - 0.5) continue;
      const dst = dy * inputSize + dx;
      for (const [band, offset] of channels) {
        const sampled = sampleBilinear(band, width, height, sx, sy, nodata);
        // NoData/invalid pixels keep the prefilled padding value; valid pixels
        // are normalised and clamped so non-8-bit overshoot never exceeds 0-1.
        if (Number.isFinite(sampled)) {
          data[offset + dst] = Math.min(1, Math.max(0, sampled / divisor));
        }
      }
    }
  }
  return { data, letterbox: { scale, padX, padY } };
}

/** Intersection-over-union of two `[x1, y1, x2, y2]` boxes. */
function iou(a: [number, number, number, number], b: [number, number, number, number]): number {
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

export interface Candidate {
  box: [number, number, number, number];
  classIndex: number;
  score: number;
}

/**
 * Greedy per-class non-maximum suppression.
 *
 * @param candidates Detections (input-space boxes) to filter.
 * @param iouThreshold Boxes overlapping a kept box above this IoU are dropped.
 * @returns The surviving detections, highest score first.
 */
export function nonMaxSuppression(candidates: Candidate[], iouThreshold: number): Candidate[] {
  const sorted = [...candidates].sort((p, q) => q.score - p.score);
  const kept: Candidate[] = [];
  for (const cand of sorted) {
    let overlaps = false;
    for (const keep of kept) {
      if (keep.classIndex === cand.classIndex && iou(keep.box, cand.box) > iouThreshold) {
        overlaps = true;
        break;
      }
    }
    if (!overlaps) kept.push(cand);
  }
  return kept;
}

/**
 * Decode a YOLO output tensor into candidate boxes (input-pixel space).
 *
 * Auto-detects the Ultralytics YOLOv8/v11 layout (`[1, 4 + nc, anchors]`, no
 * objectness) versus the YOLOv5 layout (`[1, anchors, 5 + nc]`, with an
 * objectness channel) by matching each trailing dim against the anchor count a
 * standard head produces at `inputSize`.
 *
 * Assumes the model output is already sigmoid-activated, which is true of the
 * standard Ultralytics ONNX export (`yolo export format=onnx`) for both v5 and
 * v8/v11. A raw-logit export (rare) would need a sigmoid applied here; we do not
 * apply one unconditionally because that would double-activate the common case.
 *
 * @param data Flat output values.
 * @param dims Output tensor dimensions.
 * @param confidenceThreshold Minimum score to keep a box.
 * @param inputSize The square model input edge (drives the anchor-count match).
 * @returns Candidate detections before NMS.
 */
export function decodeYolo(
  data: Float32Array,
  dims: readonly number[],
  confidenceThreshold: number,
  inputSize: number,
): Candidate[] {
  if (dims.length !== 3) {
    throw new Error(
      `Unexpected model output shape [${dims.join(", ")}]. Export the model with a single [1, C, N] detection head.`,
    );
  }
  const d1 = dims[1];
  const d2 = dims[2];
  // Pick the anchor axis by which trailing dim is closest to the anchor count a
  // standard 3-level (stride 8/16/32) head yields at `inputSize`. This beats a
  // bare "anchors > channels" ratio, which misfires at very small inputSize with
  // many classes (few anchors, but more channels), silently swapping the axes.
  // The channel axis is then the other dim; whether it sits on d1 (v8/v11, no
  // objectness) or d2 (v5, with objectness) determines the layout.
  const expectedAnchors = (inputSize / 8) ** 2 + (inputSize / 16) ** 2 + (inputSize / 32) ** 2;
  const d2IsAnchors = Math.abs(d2 - expectedAnchors) <= Math.abs(d1 - expectedAnchors);
  const numAnchors = d2IsAnchors ? d2 : d1;
  const numChannels = d2IsAnchors ? d1 : d2;
  const v8 = d2IsAnchors;
  const hasObjectness = !v8;
  const numClasses = numChannels - (hasObjectness ? 5 : 4);
  if (numClasses < 1) {
    throw new Error(`Model output has too few channels (${numChannels}) to contain class scores.`);
  }

  // Read one channel `c` of anchor `i` from either memory layout.
  const at = v8
    ? (c: number, i: number) => data[c * numAnchors + i]
    : (c: number, i: number) => data[i * numChannels + c];

  const candidates: Candidate[] = [];
  const classOffset = hasObjectness ? 5 : 4;
  for (let i = 0; i < numAnchors; i += 1) {
    const objectness = hasObjectness ? at(4, i) : 1;
    // v5 only: skip anchors whose objectness is already below the threshold.
    // (For v8/v11 objectness is a constant 1, so this guard is a no-op there.)
    if (hasObjectness && objectness < confidenceThreshold) continue;
    let bestClass = 0;
    let bestProb = -Infinity;
    for (let c = 0; c < numClasses; c += 1) {
      const prob = at(classOffset + c, i);
      if (prob > bestProb) {
        bestProb = prob;
        bestClass = c;
      }
    }
    const score = bestProb * objectness;
    if (score < confidenceThreshold) continue;
    const cx = at(0, i);
    const cy = at(1, i);
    const w = at(2, i);
    const h = at(3, i);
    candidates.push({
      box: [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2],
      classIndex: bestClass,
      score,
    });
  }
  return candidates;
}

/**
 * Run an ONNX YOLO model over a raster and return the detected boxes in source
 * raster pixel coordinates.
 *
 * @param raster The decoded source raster (from `readRasterData`).
 * @param modelBytes The `.onnx` model file bytes.
 * @param options Input size and confidence/NMS thresholds.
 * @returns Detections in source-pixel space, after non-maximum suppression.
 * @throws If the model cannot be loaded or produces an unrecognised output.
 */
export async function detectObjects(
  raster: RasterData,
  modelBytes: ArrayBuffer,
  options: DetectionOptions = {},
): Promise<Detection[]> {
  const inputSize = options.inputSize ?? DEFAULT_INPUT_SIZE;
  const confidenceThreshold = options.confidenceThreshold ?? DEFAULT_CONFIDENCE;
  const iouThreshold = options.iouThreshold ?? DEFAULT_IOU;

  // Validate the knobs before allocating anything: `inputSize` drives a
  // `3 * inputSize²` Float32 allocation, and out-of-range thresholds silently
  // break filtering/NMS. Fail fast with a clear message instead of OOMing or
  // returning nonsense.
  if (!Number.isInteger(inputSize) || inputSize < 32 || inputSize > MAX_INPUT_SIZE) {
    throw new Error(`inputSize must be an integer between 32 and ${MAX_INPUT_SIZE}.`);
  }
  if (!Number.isFinite(confidenceThreshold) || confidenceThreshold < 0 || confidenceThreshold > 1) {
    throw new Error("confidenceThreshold must be between 0 and 1.");
  }
  if (!Number.isFinite(iouThreshold) || iouThreshold < 0 || iouThreshold > 1) {
    throw new Error("iouThreshold must be between 0 and 1.");
  }

  const ort = await loadOrt();
  let session: import("onnxruntime-web/wasm").InferenceSession;
  try {
    session = await ort.InferenceSession.create(new Uint8Array(modelBytes), {
      executionProviders: ["wasm"],
    });
  } catch (err) {
    throw new Error(
      `Could not load the ONNX model: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Always release the session's WASM heap (model weights/graph), even on
  // error: onnxruntime-web does not free it deterministically on GC, so
  // repeated detection runs would otherwise leak unbounded native memory.
  try {
    const { data, letterbox } = preprocess(raster, inputSize);
    const inputName = session.inputNames[0];
    const tensor = new ort.Tensor("float32", data, [1, 3, inputSize, inputSize]);
    const outputs = await session.run({ [inputName]: tensor });
    const outputName = session.outputNames[0];
    const output = outputs[outputName];
    if (!output) {
      throw new Error(
        `Model produced no usable output. Available outputs: ${session.outputNames.join(", ")}. ` +
          "Export a detection model with a single [1, C, N] head (no baked-in NMS).",
      );
    }
    // decodeYolo reads the buffer as float32. A model exported with an fp16 or
    // int8-quantised output head returns a Uint16Array/Uint8Array here (ORT does
    // not upcast), so the values would be misread as garbage boxes/scores; fail
    // with a clear message instead. Re-export the model with a float32 head.
    if (output.type !== "float32") {
      throw new Error(
        `Model output dtype "${output.type}" is not supported. Export the model with a float32 detection head.`,
      );
    }
    const outData = output.data as Float32Array;

    const candidates = decodeYolo(outData, output.dims, confidenceThreshold, inputSize);
    const kept = nonMaxSuppression(candidates, iouThreshold);

    // Undo the letterbox (input pixels -> source pixels) and clamp to the raster.
    const { scale, padX, padY } = letterbox;
    const { width, height } = raster;
    const toSrcX = (x: number) => Math.min(width, Math.max(0, (x - padX) / scale));
    const toSrcY = (y: number) => Math.min(height, Math.max(0, (y - padY) / scale));
    return kept.map((cand) => ({
      bbox: [
        toSrcX(cand.box[0]),
        toSrcY(cand.box[1]),
        toSrcX(cand.box[2]),
        toSrcY(cand.box[3]),
      ] as [number, number, number, number],
      classIndex: cand.classIndex,
      score: cand.score,
    }));
  } finally {
    // Swallow a cleanup failure so it can never replace the primary error (a
    // decode/inference throw in the try) as the caller-visible message.
    await session.release().catch((err) => {
      console.warn("object-detection: session.release() failed", err);
    });
  }
}
