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

// Injected by vite.config.ts; declared locally (module scope, so it does not
// collide with the app's global declaration in vite-env.d.ts) because this
// package must stay importable from a plain Node test where the define is
// absent.
declare const __NO_EXTERNAL_CDN__: boolean;

/**
 * True when the build strips every external CDN reference, which leaves the
 * runtime with no host to fetch its `.wasm` from — so inference is disabled
 * rather than left to fail on a blocked request.
 */
const NO_EXTERNAL_CDN = typeof __NO_EXTERNAL_CDN__ !== "undefined" && __NO_EXTERNAL_CDN__;

const ORT_WASM_BASE = NO_EXTERNAL_CDN
  ? ""
  : `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;

/**
 * Whether the ONNX Runtime WASM backend can load at all in this build.
 *
 * False only in a no-external-CDN build, where the runtime has no host to fetch
 * its `.wasm` from and `loadOrt()` always rejects. UI that would otherwise let
 * a user select an image and a model, then fail at the end of the run, should
 * check this up front and fail closed instead.
 */
export function isOrtAvailable(): boolean {
  return !NO_EXTERNAL_CDN;
}

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
    if (NO_EXTERNAL_CDN) {
      ortPromise = Promise.reject(
        new Error(
          "ONNX Runtime WASM is unavailable in this build (external CDN resources are disabled).",
        ),
      );
      return ortPromise;
    }
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
