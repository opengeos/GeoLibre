import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import {
  releaseIdleWasmToolWorkers,
  runWasmToolInBackground,
} from "../packages/processing/src/wasm-tool-runner";
import { setMockWasmCapabilities } from "../packages/processing/src/wasm-capabilities";
import {
  resetWasmRuntimeConfig,
  setWasmRuntimeConfig,
} from "../packages/processing/src/wasm-config";

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
  setMockWasmCapabilities(null);
  resetWasmRuntimeConfig();
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

  it("rejects cleanly, terminates the dead worker, and drains queued jobs when respawning throws", async () => {
    setMockWasmCapabilities({
      hasSimd: true,
      hasSharedArrayBuffer: true,
      hasSharedMemory: true,
      isCrossOriginIsolated: true,
    });
    setWasmRuntimeConfig({ executionMode: "threaded-simd", maxThreads: 1 });
    let spawned = 0;
    class ThrowOnSecondSpawnWorker {
      private listeners = new Set<(event: MessageEvent) => void>();
      private answered = false;
      readonly n: number;
      constructor() {
        this.n = ++spawned;
        if (this.n === 2) throw new Error("worker spawn boom");
      }
      addEventListener(type: string, listener: (event: MessageEvent) => void) {
        if (type === "message") this.listeners.add(listener);
      }
      removeEventListener(type: string, listener: (event: MessageEvent) => void) {
        if (type === "message") this.listeners.delete(listener);
      }
      postMessage() {
        if (this.n === 1 && this.answered) return;
        this.answered = true;
        const data = {
          ok: true,
          result: { exitCode: 0, stdout: [`worker-${this.n}`], files: {} },
        };
        queueMicrotask(() => {
          for (const listener of this.listeners) listener({ data } as MessageEvent);
        });
      }
      terminate() {
        terminated += 1;
      }
    }
    globalThis.Worker = ThrowOnSecondSpawnWorker as unknown as typeof Worker;
    await runWasmToolInBackground({ tool: "first", args: [], input: {} });
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const failingRun = runWasmToolInBackground({ tool: "second", args: [], input: {} });
      const queuedRun = runWasmToolInBackground({ tool: "third", args: [], input: {} });
      mock.timers.tick(10_000);
      await assert.rejects(failingRun, /worker spawn boom/);
      const queuedResult = await queuedRun;
      assert.equal(queuedResult.exitCode, 0);
      assert.deepEqual(queuedResult.stdout, ["worker-3"]);
      assert.equal(terminated, 1, "the unresponsive parked worker must be terminated");
    } finally {
      mock.timers.reset();
    }
  });
});
