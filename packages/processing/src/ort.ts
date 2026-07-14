// Shared onnxruntime-web loader for the client-side ML tools (object detection,
// SAM "segment everything"). Both import the `/wasm` subpath and force
// single-threaded WASM so no tool needs SharedArrayBuffer / cross-origin
// isolation, and both point `wasmPaths` at the pinned CDN copy.

// onnxruntime-web ships its WASM artifacts in its own dist/. Bundlers do not
// rewrite the runtime's internal fetch of those files, so point the runtime at
// the pinned CDN copy (already allowed by the Tauri CSP's jsdelivr/npm entry).
// MUST stay in lockstep with the `onnxruntime-web` pin in
// packages/processing/package.json; a guard test asserts they match
// (tests/object-detection.test.ts) so a dependency bump that forgets this
// constant fails CI instead of breaking inference at runtime.
export const ORT_VERSION = "1.27.0";
const ORT_WASM_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;

// A promise singleton: the import-and-configure runs exactly once and every
// caller awaits the same settled promise, so concurrent tool calls cannot race
// on configuration.
let ortPromise: Promise<typeof import("onnxruntime-web/wasm")> | null = null;

/**
 * Lazily import and configure `onnxruntime-web` (CPU WASM backend only).
 *
 * Imports the `/wasm` subpath rather than the default entry, which also bundles
 * the ~26 MB WebGPU/jsep WASM; we force the WASM execution provider anyway, so
 * that artifact is dead weight and (being over Cloudflare Pages' 25 MiB per-file
 * limit) breaks the preview deploy. Forces single-threaded WASM to avoid
 * `SharedArrayBuffer`, and points `wasmPaths` at the CDN so the runtime can
 * fetch its `.wasm`.
 */
export function loadOrt(): Promise<typeof import("onnxruntime-web/wasm")> {
  if (!ortPromise) {
    ortPromise = import("onnxruntime-web/wasm")
      .then((ort) => {
        ort.env.wasm.numThreads = 1;
        ort.env.wasm.wasmPaths = ORT_WASM_BASE;
        return ort;
      })
      .catch((err) => {
        // Clear the singleton so a transient failure (network blip, blocked
        // CDN) does not permanently poison every later retry with the same
        // rejected promise; the next call re-attempts the import.
        ortPromise = null;
        throw err;
      });
  }
  return ortPromise;
}
