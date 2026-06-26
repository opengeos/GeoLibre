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
const DEFAULT_CONFIDENCE = 0.25;
const DEFAULT_IOU = 0.45;
/** Letterbox padding colour (YOLO uses 114/255 grey). */
const PAD_VALUE = 114 / 255;

// onnxruntime-web ships its WASM artifacts in its own dist/. Bundlers do not
// rewrite the runtime's internal fetch of those files, so point the runtime at
// the pinned CDN copy (already allowed by the Tauri CSP's jsdelivr/npm entry).
const ORT_VERSION = "1.27.0";
const ORT_WASM_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;

let ortConfigured = false;

/**
 * Lazily import and configure `onnxruntime-web`.
 *
 * Forces single-threaded WASM so the runtime never needs `SharedArrayBuffer`
 * (which requires cross-origin isolation headers the dev/web server does not
 * set), and points `wasmPaths` at the CDN so the runtime can fetch its `.wasm`.
 *
 * @returns The configured `onnxruntime-web` module namespace.
 */
async function loadOrt(): Promise<typeof import("onnxruntime-web")> {
  const ort = await import("onnxruntime-web");
  if (!ortConfigured) {
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.wasmPaths = ORT_WASM_BASE;
    ortConfigured = true;
  }
  return ort;
}

/**
 * Pull three normalised colour channels (0-1) out of a {@link RasterData}.
 *
 * Uses the first three bands as R/G/B; a single-band raster is replicated to
 * greyscale. Eight-bit imagery stored as floats (0-255) is scaled to 0-1; data
 * already in 0-1 is left untouched, decided from the observed maximum.
 *
 * @param raster The decoded source raster.
 * @returns The per-channel band arrays and the divisor used to normalise them.
 */
function rgbBands(raster: RasterData): {
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
  divisor: number;
} {
  const { bands } = raster;
  const r = bands[0];
  const g = bands.length > 1 ? bands[1] : bands[0];
  const b = bands.length > 2 ? bands[2] : bands[0];
  // Sample the red band to decide the value range. Aerial/RGB imagery is almost
  // always 8-bit (0-255); reflectance products may already be 0-1.
  let max = 0;
  const step = Math.max(1, Math.floor(r.length / 4096));
  for (let i = 0; i < r.length; i += step) {
    const v = r[i];
    if (Number.isFinite(v) && v > max) max = v;
  }
  const divisor = max > 1.5 ? 255 : 1;
  return { r, g, b, divisor };
}

/** Bilinear sample of a band at fractional source pixel `(x, y)`. */
function sampleBilinear(
  band: Float32Array,
  width: number,
  height: number,
  x: number,
  y: number,
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
  const { r, g, b, divisor } = rgbBands(raster);
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
  for (let dy = 0; dy < inputSize; dy += 1) {
    const sy = (dy + 0.5 - padY) / scale - 0.5;
    if (sy < -0.5 || sy > height - 0.5) continue;
    for (let dx = 0; dx < inputSize; dx += 1) {
      const sx = (dx + 0.5 - padX) / scale - 0.5;
      if (sx < -0.5 || sx > width - 0.5) continue;
      const dst = dy * inputSize + dx;
      for (const [band, offset] of channels) {
        data[offset + dst] = sampleBilinear(band, width, height, sx, sy) / divisor;
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

interface Candidate {
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
function nonMaxSuppression(candidates: Candidate[], iouThreshold: number): Candidate[] {
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
 * objectness channel) from the relative size of the two trailing dimensions.
 *
 * @param data Flat output values.
 * @param dims Output tensor dimensions.
 * @param confidenceThreshold Minimum score to keep a box.
 * @returns Candidate detections before NMS.
 */
function decodeYolo(
  data: Float32Array,
  dims: readonly number[],
  confidenceThreshold: number,
): Candidate[] {
  if (dims.length !== 3) {
    throw new Error(
      `Unexpected model output shape [${dims.join(", ")}]. Export the model with a single [1, C, N] detection head.`,
    );
  }
  const d1 = dims[1];
  const d2 = dims[2];
  // v8/v11: channels (4 + nc) are fewer than the anchor count, so the smaller
  // trailing dim is the channel axis and there is no objectness term.
  const v8 = d1 < d2;
  const numAnchors = v8 ? d2 : d1;
  const numChannels = v8 ? d1 : d2;
  const hasObjectness = !v8;
  const numClasses = numChannels - (hasObjectness ? 5 : 4);
  if (numClasses < 1) {
    throw new Error(
      `Model output has too few channels (${numChannels}) to contain class scores.`,
    );
  }

  // Read one channel `c` of anchor `i` from either memory layout.
  const at = v8
    ? (c: number, i: number) => data[c * numAnchors + i]
    : (c: number, i: number) => data[i * numChannels + c];

  const candidates: Candidate[] = [];
  const classOffset = hasObjectness ? 5 : 4;
  for (let i = 0; i < numAnchors; i += 1) {
    const objectness = hasObjectness ? at(4, i) : 1;
    if (objectness < confidenceThreshold) continue;
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

  const ort = await loadOrt();
  let session: import("onnxruntime-web").InferenceSession;
  try {
    session = await ort.InferenceSession.create(new Uint8Array(modelBytes), {
      executionProviders: ["wasm"],
    });
  } catch (err) {
    throw new Error(
      `Could not load the ONNX model: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const { data, letterbox } = preprocess(raster, inputSize);
  const inputName = session.inputNames[0];
  const tensor = new ort.Tensor("float32", data, [1, 3, inputSize, inputSize]);
  const outputs = await session.run({ [inputName]: tensor });
  const outputName = session.outputNames[0];
  const output = outputs[outputName];
  const outData = output.data as Float32Array;

  const candidates = decodeYolo(outData, output.dims, confidenceThreshold);
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
}
