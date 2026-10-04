/// <reference lib="webworker" />
// Runs the Turf.js vector tools off the main thread (#2858). Turf has no yield
// points, so a buffer or overlay over a large layer held the UI for the whole
// run. One run per worker: vector-tool-runner.ts spawns this for a run and
// terminates it afterwards (or on abort), so no state carries over.
import { createVectorToolSession, type VectorToolWorkerRequest } from "./vector-tool-protocol";

const worker = self as unknown as DedicatedWorkerGlobalScope;
const handle = createVectorToolSession((message) => worker.postMessage(message));

worker.addEventListener("message", (event: MessageEvent<VectorToolWorkerRequest>) => {
  void handle(event.data);
});
