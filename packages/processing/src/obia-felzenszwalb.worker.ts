/// <reference lib="webworker" />
import { felzenszwalbLabels, type ObiaFelzenszwalbParams } from "./obia-felzenszwalb";

// Runs one Felzenszwalb segmentation off the main thread; the caller
// terminates the worker on the reply (or on Cancel).
const worker = self as unknown as DedicatedWorkerGlobalScope;

/** The request: the bands, their grid, the valid mask and the parameters. */
export interface FelzenszwalbWorkerRequest {
  bands: Float32Array[];
  width: number;
  height: number;
  valid: Uint8Array;
  params: ObiaFelzenszwalbParams;
}

/** The single message this worker posts back. */
export type FelzenszwalbWorkerResponse =
  | { ok: true; labels: Int32Array }
  | { ok: false; error: string };

worker.addEventListener("message", (event: MessageEvent<FelzenszwalbWorkerRequest>) => {
  const { bands, width, height, valid, params } = event.data;
  try {
    const labels = felzenszwalbLabels(bands, width, height, valid, params);
    worker.postMessage({ ok: true, labels } satisfies FelzenszwalbWorkerResponse, [
      labels.buffer as ArrayBuffer,
    ]);
  } catch (error) {
    worker.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    } satisfies FelzenszwalbWorkerResponse);
  }
});
