/// <reference lib="webworker" />
import {
  handleRasterToolRequest,
  type RasterToolWorkerMessage,
  type RasterToolWorkerRequest,
} from "./raster-tool-protocol";

// Runs one browser raster tool off the main thread (issue #3701); the caller
// terminates the worker on the result (or on Cancel). See raster-tool-runner.ts.
const worker = self as unknown as DedicatedWorkerGlobalScope;

worker.addEventListener("message", (event: MessageEvent<RasterToolWorkerRequest>) => {
  void handleRasterToolRequest(event.data, (message, transfer) =>
    worker.postMessage(message, transfer),
  );
});

// Tell the caller the module loaded; it posts the run (and transfers the
// input bands) only after this, so a worker that fails to load leaves the
// inputs intact for the inline fallback.
worker.postMessage({ type: "ready" } satisfies RasterToolWorkerMessage);
