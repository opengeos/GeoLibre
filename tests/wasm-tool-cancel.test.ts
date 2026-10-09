import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  releaseIdleWasmToolWorkers,
  runWasmToolInBackground,
} from "../packages/processing/src/wasm-tool-runner";

const originalWorker = globalThis.Worker;
let terminated = 0;

/** A worker that never answers, so only cancellation can end the run. */
class HangingWorker {
  addEventListener() {}
  removeEventListener() {}
  postMessage() {}
  terminate() {
    terminated += 1;
  }
}

afterEach(() => {
  releaseIdleWasmToolWorkers();
  if (originalWorker === undefined) delete (globalThis as { Worker?: typeof Worker }).Worker;
  else globalThis.Worker = originalWorker;
  terminated = 0;
});

describe("runWasmToolInBackground cancellation", () => {
  it("rejects with an AbortError and terminates the worker when aborted", async () => {
    globalThis.Worker = HangingWorker as unknown as typeof Worker;
    const controller = new AbortController();
    const run = runWasmToolInBackground(
      { tool: "image_segmentation", args: [], input: {} },
      { signal: controller.signal },
    );
    controller.abort();
    await assert.rejects(run, (err: Error) => err.name === "AbortError");
    assert.equal(terminated, 1);
  });

  it("does not start a run whose signal is already aborted", async () => {
    globalThis.Worker = HangingWorker as unknown as typeof Worker;
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      runWasmToolInBackground(
        { tool: "image_segmentation", args: [], input: {} },
        { signal: controller.signal },
      ),
      (err: Error) => err.name === "AbortError",
    );
    assert.equal(terminated, 0);
  });
});
