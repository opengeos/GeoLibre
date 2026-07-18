/**
 * Built-in object-detection models for the Object Detection dialog (issue #902).
 *
 * These are stock COCO YOLO models exported to ONNX, hosted on jsDelivr (which
 * serves with permissive CORS, so the browser/webview can fetch them directly)
 * and pinned to immutable commit SHAs so the file can never change under us.
 * They let a user run detection without supplying their own `.onnx`.
 *
 * Source repos (MIT-licensed browser demos); the YOLOv5/v8 weights themselves
 * are AGPL-3.0 from Ultralytics. We link and download at runtime rather than
 * bundle them. Because they are COCO/ground-level models they detect everyday
 * objects well but perform poorly on top-down aerial imagery, where a
 * user-supplied overhead-trained model is the better choice.
 *
 * Provenance/trust note: these URLs point at a third-party individual's public
 * repos, not an official Ultralytics/ONNX-zoo source. The immutable commit-SHA
 * pin is the main mitigation (jsDelivr serves that exact byte content); the
 * remaining risk is availability if the account/repo is ever deleted. Follow-up:
 * mirror these files into a GeoLibre-controlled repo so the built-in option does
 * not depend on an external account.
 */

/** The 80 COCO class names, in model output order. */
export const COCO_CLASSES = [
  "person",
  "bicycle",
  "car",
  "motorcycle",
  "airplane",
  "bus",
  "train",
  "truck",
  "boat",
  "traffic light",
  "fire hydrant",
  "stop sign",
  "parking meter",
  "bench",
  "bird",
  "cat",
  "dog",
  "horse",
  "sheep",
  "cow",
  "elephant",
  "bear",
  "zebra",
  "giraffe",
  "backpack",
  "umbrella",
  "handbag",
  "tie",
  "suitcase",
  "frisbee",
  "skis",
  "snowboard",
  "sports ball",
  "kite",
  "baseball bat",
  "baseball glove",
  "skateboard",
  "surfboard",
  "tennis racket",
  "bottle",
  "wine glass",
  "cup",
  "fork",
  "knife",
  "spoon",
  "bowl",
  "banana",
  "apple",
  "sandwich",
  "orange",
  "broccoli",
  "carrot",
  "hot dog",
  "pizza",
  "donut",
  "cake",
  "chair",
  "couch",
  "potted plant",
  "bed",
  "dining table",
  "toilet",
  "tv",
  "laptop",
  "mouse",
  "remote",
  "keyboard",
  "cell phone",
  "microwave",
  "oven",
  "toaster",
  "sink",
  "refrigerator",
  "book",
  "clock",
  "vase",
  "scissors",
  "teddy bear",
  "hair drier",
  "toothbrush",
] as const;

/** A downloadable built-in detection model. */
export interface BuiltinDetectionModel {
  /** Stable id used in the dropdown and as a cache key discriminator. */
  id: string;
  /** Human label shown in the dropdown. */
  label: string;
  /** Direct, CORS-enabled URL to the `.onnx` file (pinned to a commit SHA). */
  url: string;
  /** Class names in model output order, used to name the detection layers. */
  classNames: readonly string[];
  /** The square input edge the model was exported with. */
  inputSize: number;
}

export const BUILTIN_DETECTION_MODELS: readonly BuiltinDetectionModel[] = [
  {
    id: "yolov8n-coco",
    label: "YOLOv8n (COCO, 80 classes)",
    url: "https://cdn.jsdelivr.net/gh/Hyuto/yolov8-onnxruntime-web@fc4a52c466d15ad4519873a0cef22fbc935b93b6/public/model/yolov8n.onnx",
    classNames: COCO_CLASSES,
    inputSize: 640,
  },
  {
    id: "yolov5n-coco",
    label: "YOLOv5n (COCO, 80 classes)",
    url: "https://cdn.jsdelivr.net/gh/Hyuto/yolov5-onnxruntime-web@203637cc45962e40a81b2a7e78f98813f93971db/public/model/yolov5n.onnx",
    classNames: COCO_CLASSES,
    inputSize: 640,
  },
];

/** Cache bucket holding downloaded model files so a model is fetched once. */
const MODEL_CACHE = "geolibre-detection-models";

/**
 * Download a built-in model's bytes, caching the response so subsequent runs
 * (and offline use) are instant.
 *
 * Uses the Cache API when available (and falls back to a plain fetch otherwise,
 * e.g. in a non-secure context). The jsDelivr URLs send permissive CORS
 * headers, so the response is readable and cacheable rather than opaque.
 *
 * @param url The model URL (from {@link BUILTIN_DETECTION_MODELS}).
 * @returns The `.onnx` file bytes.
 * @throws If the download fails (non-2xx or network error).
 */
export async function fetchDetectionModel(url: string): Promise<ArrayBuffer> {
  // Keep the Cache API operations in their own try/catch so only *cache*
  // failures are swallowed. A failed network fetch (404/5xx) must surface, not
  // be mistaken for a cache miss and silently retried; and a successful
  // download must never be discarded just because writing it to the cache
  // failed (quota/private mode).
  let cache: Cache | null = null;
  try {
    if (typeof caches !== "undefined") {
      cache = await caches.open(MODEL_CACHE);
      const cached = await cache.match(url);
      if (cached) return await cached.arrayBuffer();
    }
  } catch (err) {
    // Cache API unavailable (insecure context, quota, etc.): proceed uncached.
    console.debug("detection-models: cache unavailable, fetching directly", err);
    cache = null;
  }

  const response = await fetch(url, { mode: "cors" });
  if (!response.ok) {
    throw new Error(`Failed to download model (HTTP ${response.status}).`);
  }
  if (cache) {
    try {
      // Store a clone so the body we read below is not consumed.
      await cache.put(url, response.clone());
    } catch (err) {
      // A cache write failure must not discard the already-downloaded bytes.
      console.debug("detection-models: cache write failed", err);
    }
  }
  return await response.arrayBuffer();
}
