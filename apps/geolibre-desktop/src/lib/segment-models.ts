/**
 * SlimSAM model files for the in-browser "Segment Everything" panel (issue #902).
 *
 * SlimSAM is a pruned Segment Anything model exported to ONNX by transformers.js.
 * Two files are needed: a ~23 MB image encoder and a ~16 MB prompt/mask decoder,
 * both self-contained single `.onnx` files small enough to run in
 * onnxruntime-web's CPU/WASM backend. The fp32 (not fp16) exports are used so
 * the `pixel_values`/`input_points` tensors we build stay plain Float32Array.
 * They are hosted on HuggingFace, which reflects the request Origin in its CORS
 * headers, so an anonymous cross-origin fetch from the app is allowed. Pinned to
 * an immutable commit SHA so the files can never change under us. Apache-2.0.
 */

const HF_BASE =
  "https://huggingface.co/Xenova/slimsam-77-uniform/resolve/5850ab45f587c112167512ffef949107115e26a0";

/** SlimSAM image encoder (fp32, single-file ONNX). */
export const SLIMSAM_ENCODER_URL = `${HF_BASE}/onnx/vision_encoder.onnx`;
/** SlimSAM prompt-encoder + mask-decoder (fp32, single-file ONNX). */
export const SLIMSAM_DECODER_URL = `${HF_BASE}/onnx/prompt_encoder_mask_decoder.onnx`;

/** Cache bucket holding the downloaded model files so they are fetched once. */
const MODEL_CACHE = "geolibre-segment-models";

/**
 * Download a model file's bytes, caching the response so subsequent runs (and
 * offline use) are instant. Mirrors {@link import("./detection-models")}'s
 * fetcher: cache failures are swallowed (proceed uncached), but a failed network
 * fetch surfaces and a successful download is never discarded on a cache-write
 * failure.
 *
 * @param url The model URL.
 * @returns The `.onnx` file bytes.
 * @throws If the download fails (non-2xx or network error).
 */
export async function fetchSegmentModel(url: string): Promise<ArrayBuffer> {
  let cache: Cache | null = null;
  try {
    if (typeof caches !== "undefined") {
      cache = await caches.open(MODEL_CACHE);
      const cached = await cache.match(url);
      if (cached) return await cached.arrayBuffer();
    }
  } catch (err) {
    console.debug("segment-models: cache unavailable, fetching directly", err);
    cache = null;
  }

  const response = await fetch(url, { mode: "cors" });
  if (!response.ok) {
    throw new Error(`Failed to download model (HTTP ${response.status}).`);
  }
  if (cache) {
    try {
      await cache.put(url, response.clone());
    } catch (err) {
      console.debug("segment-models: cache write failed", err);
    }
  }
  return await response.arrayBuffer();
}
