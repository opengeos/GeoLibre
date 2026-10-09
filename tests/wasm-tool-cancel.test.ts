import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
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

  it("still cancels after a dead parked worker is replaced", async () => {
    // The first worker answers once (and is parked), then never acknowledges;
    // the second hangs. Cancel must reach the replacement.
    let spawned = 0;
    class AnsweringOnceWorker {
      private listeners = new Set<(event: MessageEvent) => void>();
      private answered = false;
      readonly n = ++spawned;
      addEventListener(type: string, listener: (event: MessageEvent) => void) {
        if (type === "message") this.listeners.add(listener);
      }
      removeEventListener(type: string, listener: (event: MessageEvent) => void) {
        if (type === "message") this.listeners.delete(listener);
      }
      postMessage() {
        if (this.n !== 1 || this.answered) return;
        this.answered = true;
        const data = { ok: true, result: { exitCode: 0, stdout: [], files: {} } };
        queueMicrotask(() => {
          for (const listener of this.listeners) listener({ data } as MessageEvent);
        });
      }
      terminate() {
        terminated += 1;
      }
    }
    globalThis.Worker = AnsweringOnceWorker as unknown as typeof Worker;
    await runWasmToolInBackground({ tool: "first", args: [], input: {} });
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const controller = new AbortController();
      const run = runWasmToolInBackground(
        { tool: "image_segmentation", args: [], input: {} },
        { signal: controller.signal },
      );
      mock.timers.tick(10_000);
      assert.equal(spawned, 2, "the silent parked worker was replaced");
      controller.abort();
      await assert.rejects(run, (err: Error) => err.name === "AbortError");
      assert.equal(terminated, 2);
    } finally {
      mock.timers.reset();
    }
  });
});
