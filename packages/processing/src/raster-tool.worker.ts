/// <reference lib="webworker" />
import { handleRasterToolRequest, type RasterToolWorkerRequest } from "./raster-tool-protocol";

// Runs one browser raster tool off the main thread (issue #3701); the caller
// terminates the worker on the result (or on Cancel). See raster-tool-runner.ts.
const worker = self as unknown as DedicatedWorkerGlobalScope;

worker.addEventListener("message", (event: MessageEvent<RasterToolWorkerRequest>) => {
  void handleRasterToolRequest(event.data, (message, transfer) =>
    worker.postMessage(message, transfer),
  );
});
