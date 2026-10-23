/// <reference lib="webworker" />
// Runs the Turf.js vector tools off the main thread (#2858). Turf has no yield
// points, so a buffer or overlay over a large layer held the UI for the whole
// run. vector-tool-runner.ts keeps one of these warm between runs and
// terminates it on abort or after an idle timeout; the session drops each run's
// layers when the run ends, so nothing but the loaded modules carries over.
import {
  createVectorToolSession,
  type VectorToolWorkerMessage,
  type VectorToolWorkerRequest,
} from "./vector-tool-protocol";

const worker = self as unknown as DedicatedWorkerGlobalScope;
const handle = createVectorToolSession((message) => worker.postMessage(message));

worker.addEventListener("message", (event: MessageEvent<VectorToolWorkerRequest>) => {
  void handle(event.data);
});

// Nothing is sent until this arrives, so a module that failed to load can fall
// back to an inline run without any doubt about whether the tool started.
worker.postMessage({ type: "ready" } satisfies VectorToolWorkerMessage);
