import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  auditAlgorithm,
  detectSharedMemorySupport,
  detectSimdSupport,
  getWasmDiagnostics,
  getWasmRuntimeConfig,
  getWasmToolPoolCapacity,
  getWasmToolWorkerPoolStats,
  isAlgorithmParallelizable,
  isAlgorithmSimdEligible,
  getWasmCapabilities,
  releaseIdleWasmToolWorkers,
  resetWasmCapabilitiesCache,
  resetWasmRuntimeConfig,
  resolveExecutionMode,
  runParallelWasmTools,
  runWasmToolInBackground,
  setWasmRuntimeConfig,
  terminateAllWasmToolWorkers,
  type WasmExecutionMode,
  type WasmToolRequest,
  type WasmToolResponse,
} from "../packages/processing/src/index";
// Test-only override, deliberately not part of the package's public API.
import { setMockWasmCapabilities } from "../packages/processing/src/wasm-capabilities";

// Mock worker for pool and concurrency testing
class MockWorker {
  static instances: MockWorker[] = [];
  static postMessageFail: Error | null = null;

  public posted: unknown[] = [];
  public terminated = false;
  private listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(
    public url: URL,
    public options?: { type?: string },
  ) {
    MockWorker.instances.push(this);
  }

  addEventListener(type: string, fn: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, fn: (event: unknown) => void): void {
    const list = (this.listeners.get(type) ?? []).filter((it) => it !== fn);
    this.listeners.set(type, list);
  }

  postMessage(message: unknown): void {
    if (MockWorker.postMessageFail) {
      throw MockWorker.postMessageFail;
    }
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(type: string, event: unknown): void {
    const list = this.listeners.get(type) ?? [];
    for (const fn of list) {
      fn(event);
    }
  }
}

describe("WebAssembly Capability Detection & Mode Resolution", () => {
  it("probes SIMD128, SharedArrayBuffer and hardware concurrency safely", () => {
    const caps = getWasmCapabilities();
    assert.equal(typeof caps.hasSimd, "boolean");
    assert.equal(typeof caps.hasSharedMemory, "boolean");
    assert.equal(typeof caps.isCrossOriginIsolated, "boolean");
    assert.equal(typeof caps.hardwareConcurrency, "number");
    assert.ok(caps.hardwareConcurrency >= 1);
    assert.ok(caps.recommendedThreads >= 1);
  });

  it("detects WebAssembly shared memory with the real probe", () => {
    resetWasmCapabilitiesCache();
    // Node has supported threads/shared memory since v16; a malformed probe
    // module fails validation and silently disables threaded-simd everywhere.
    assert.equal(detectSharedMemorySupport(), true);
    assert.equal(detectSimdSupport(), true);
  });

  it("falls back to one thread for a non-finite maxThreads", () => {
    const mockCaps = {
      hasWasm: true,
      hasSimd: true,
      hasSharedArrayBuffer: true,
      hasSharedMemory: true,
      isCrossOriginIsolated: true,
      hardwareConcurrency: 8,
      recommendedThreads: 4,
    };
    const resolution = resolveExecutionMode({ maxThreads: Number.NaN }, mockCaps);
    assert.equal(resolution.mode, "threaded-simd");
    assert.equal(resolution.threads, 1);
  });

  it("resolves to simd-single-thread when SIMD is present but crossOriginIsolated is false", () => {
    const mockCaps = {
      hasWasm: true,
      hasSimd: true,
      hasSharedArrayBuffer: true,
      hasSharedMemory: true,
      isCrossOriginIsolated: false,
      hardwareConcurrency: 8,
      recommendedThreads: 4,
    };
    const resolution = resolveExecutionMode({ executionMode: "auto" }, mockCaps);
    assert.equal(resolution.mode, "simd-single-thread");
    assert.ok(
      resolution.fallbackReason?.includes("Cross-origin isolation"),
      "Should explain lack of COOP/COEP",
    );
  });

  it("resolves to portable-single-thread when SIMD128 is unsupported", () => {
    const mockCaps = {
      hasWasm: true,
      hasSimd: false,
      hasSharedArrayBuffer: true,
      hasSharedMemory: true,
      isCrossOriginIsolated: true,
      hardwareConcurrency: 8,
      recommendedThreads: 4,
    };
    const resolution = resolveExecutionMode({ executionMode: "auto" }, mockCaps);
    assert.equal(resolution.mode, "portable-single-thread");
    assert.ok(
      resolution.fallbackReason?.includes("SIMD128 is not supported"),
      "Should explain lack of SIMD",
    );
  });

  it("resolves to threaded-simd when SIMD, threads, and isolation are all satisfied", () => {
    const mockCaps = {
      hasWasm: true,
      hasSimd: true,
      hasSharedArrayBuffer: true,
      hasSharedMemory: true,
      isCrossOriginIsolated: true,
      hardwareConcurrency: 8,
      recommendedThreads: 4,
    };
    const resolution = resolveExecutionMode({ executionMode: "auto" }, mockCaps);
    assert.equal(resolution.mode, "threaded-simd");
    assert.equal(resolution.fallbackReason, undefined);
  });

  it("respects user configuration disabling threads or SIMD", () => {
    const mockCaps = {
      hasWasm: true,
      hasSimd: true,
      hasSharedArrayBuffer: true,
      hasSharedMemory: true,
      isCrossOriginIsolated: true,
      hardwareConcurrency: 8,
      recommendedThreads: 4,
    };
    const noThreads = resolveExecutionMode(
      { executionMode: "auto", enableThreads: false, enableSIMD: true },
      mockCaps,
    );
    assert.equal(noThreads.mode, "simd-single-thread");
    assert.ok(noThreads.fallbackReason?.includes("disabled by configuration"));

    const noSimd = resolveExecutionMode(
      { executionMode: "auto", enableThreads: true, enableSIMD: false },
      mockCaps,
    );
    assert.equal(noSimd.mode, "portable-single-thread");
  });

  it("falls back gracefully when explicit threaded-simd is requested in an incompatible environment", () => {
    const mockCaps = {
      hasWasm: true,
      hasSimd: true,
      hasSharedArrayBuffer: false,
      hasSharedMemory: false,
      isCrossOriginIsolated: false,
      hardwareConcurrency: 4,
      recommendedThreads: 2,
    };
    const resolution = resolveExecutionMode({ executionMode: "threaded-simd" }, mockCaps);
    assert.equal(resolution.mode, "simd-single-thread");
    assert.ok(resolution.fallbackReason?.includes("Explicitly requested"));
  });
});

describe("WASM Runtime Configuration & Diagnostics", () => {
  beforeEach(() => {
    resetWasmRuntimeConfig();
  });

  afterEach(() => {
    resetWasmRuntimeConfig();
  });

  it("allows setting and getting runtime config and reports diagnostics", () => {
    setWasmRuntimeConfig({
      executionMode: "simd-single-thread",
      maxThreads: 2,
      debugPerformance: true,
    });
    const config = getWasmRuntimeConfig();
    assert.equal(config.executionMode, "simd-single-thread");
    assert.equal(config.maxThreads, 2);
    assert.equal(config.debugPerformance, true);

    const diag = getWasmDiagnostics();
    assert.equal(diag.activeMode, "simd-single-thread");
    assert.equal(diag.activeThreads, 1);
  });
});

describe("Algorithm Audit & Classification", () => {
  it("correctly audits stencil and filter algorithms as parallelizable", () => {
    const slopeAudit = auditAlgorithm("slope");
    assert.ok(slopeAudit);
    assert.equal(slopeAudit.pattern, "tileable-stencil");
    assert.equal(slopeAudit.supportsThreading, true);
    assert.equal(slopeAudit.supportsSimd, true);
    assert.equal(slopeAudit.haloPixels, 1);

    const aspectAudit = auditAlgorithm("aspect");
    assert.ok(aspectAudit);
    assert.equal(aspectAudit.supportsThreading, true);

    const gaussianAudit = auditAlgorithm("gaussian_filter");
    assert.ok(gaussianAudit);
    assert.equal(gaussianAudit.pattern, "tileable-stencil");
    assert.equal(gaussianAudit.supportsThreading, true);

    const calcAudit = auditAlgorithm("raster_calculator");
    assert.ok(calcAudit);
    assert.equal(calcAudit.pattern, "pixel-independent");
    assert.equal(calcAudit.supportsThreading, true);
    assert.equal(calcAudit.supportsSimd, true);
  });

  it("correctly audits hydrology algorithms as sequential DAGs or priority queues", () => {
    const d8Audit = auditAlgorithm("d8_flow_accumulation");
    assert.ok(d8Audit);
    assert.equal(d8Audit.pattern, "topological-dag");
    assert.equal(d8Audit.supportsThreading, false);
    assert.ok(d8Audit.notes.includes("topological order"));

    const dinfAudit = auditAlgorithm("d_inf_flow_accumulation");
    assert.ok(dinfAudit);
    assert.equal(dinfAudit.pattern, "topological-dag");
    assert.equal(dinfAudit.supportsThreading, false);

    const fillAudit = auditAlgorithm("fill_depressions");
    assert.ok(fillAudit);
    assert.equal(fillAudit.pattern, "priority-queue");
    assert.equal(fillAudit.supportsThreading, false);
  });

  it("handles algorithm audit helper functions", () => {
    assert.equal(isAlgorithmParallelizable("hillshade"), true);
    assert.equal(isAlgorithmParallelizable("d8_flow_accumulation"), false);
    assert.equal(isAlgorithmSimdEligible("slope"), true);
    assert.equal(isAlgorithmSimdEligible("viewshed"), true);
    assert.equal(isAlgorithmSimdEligible("buffer_vector"), false);
  });
});

describe("Multi-Worker Concurrent Pool Architecture", () => {
  const originalWorker = globalThis.Worker;

  beforeEach(() => {
    MockWorker.instances = [];
    MockWorker.postMessageFail = null;
    (globalThis as { Worker?: unknown }).Worker = MockWorker;
    resetWasmRuntimeConfig();
  });

  afterEach(() => {
    terminateAllWasmToolWorkers();
    setMockWasmCapabilities(null);
    if (originalWorker === undefined) {
      delete (globalThis as { Worker?: typeof Worker }).Worker;
    } else {
      globalThis.Worker = originalWorker;
    }
    resetWasmRuntimeConfig();
  });

  /** Bound the pool to a single worker so later runs queue behind the first. */
  function useSingleSlotPool(): void {
    setMockWasmCapabilities({
      hasSimd: true,
      hasSharedArrayBuffer: true,
      hasSharedMemory: true,
      isCrossOriginIsolated: true,
    });
    setWasmRuntimeConfig({ executionMode: "threaded-simd", maxThreads: 1 });
  }

  it("runs concurrent requests on separate workers outside threaded-simd", () => {
    setWasmRuntimeConfig({ executionMode: "portable-single-thread" });
    void runWasmToolInBackground({ tool: "long", args: [], input: {} }).catch(() => {});
    void runWasmToolInBackground({ tool: "short", args: [], input: {} }).catch(() => {});
    assert.equal(MockWorker.instances.length, 2, "the second run must not queue");
    assert.equal(getWasmToolWorkerPoolStats().queuedRequests, 0);
  });

  it("does not bound the pool in auto mode even when threaded-simd is available", () => {
    setMockWasmCapabilities({
      hasSimd: true,
      hasSharedArrayBuffer: true,
      hasSharedMemory: true,
      isCrossOriginIsolated: true,
    });
    setWasmRuntimeConfig({ executionMode: "auto", maxThreads: 1 });
    assert.equal(getWasmDiagnostics().activeMode, "threaded-simd");
    void runWasmToolInBackground({ tool: "long", args: [], input: {} }).catch(() => {});
    void runWasmToolInBackground({ tool: "short", args: [], input: {} }).catch(() => {});
    assert.equal(MockWorker.instances.length, 2, "the short run must not queue");
  });

  it("scales pool capacity when threaded-simd mode is active", () => {
    setWasmRuntimeConfig({
      executionMode: "portable-single-thread",
    });
    // Outside threaded-simd every concurrent run gets its own worker.
    assert.equal(getWasmToolPoolCapacity(), Number.POSITIVE_INFINITY);

    // Set custom config with maxThreads = 4
    setWasmRuntimeConfig({
      executionMode: "threaded-simd",
      maxThreads: 4,
    });
    // If environment supports threaded-simd (or mocked), capacity reflects activeThreads
    const stats = getWasmToolWorkerPoolStats();
    assert.ok(stats.poolCapacity >= 1);
  });

  it("executes sequential requests by reusing warm parked workers", async () => {
    const promise1 = runWasmToolInBackground({
      tool: "slope",
      args: ["--input=/work/dem.tif", "--output=/work/slope.tif"],
      input: { "dem.tif": new Uint8Array([1, 2, 3]) },
    });

    assert.equal(MockWorker.instances.length, 1);
    const worker1 = MockWorker.instances[0];

    // Worker 1 returns success
    worker1.emit("message", {
      data: {
        ok: true,
        result: {
          exitCode: 0,
          stdout: ["done"],
          files: { "slope.tif": new Uint8Array([4, 5, 6]) },
        },
      },
    });

    const res1 = await promise1;
    assert.equal(res1.exitCode, 0);
    assert.equal(worker1.terminated, false, "Worker should be parked in idle pool");

    // Second sequential request
    const promise2 = runWasmToolInBackground({
      tool: "aspect",
      args: ["--input=/work/dem.tif", "--output=/work/aspect.tif"],
      input: { "dem.tif": new Uint8Array([1, 2, 3]) },
    });

    // Should NOT spawn a second worker; should reuse worker1
    assert.equal(MockWorker.instances.length, 1, "Should reuse parked worker");
    worker1.emit("message", {
      data: {
        ok: true,
        result: {
          exitCode: 0,
          stdout: ["done aspect"],
          files: { "aspect.tif": new Uint8Array([7, 8]) },
        },
      },
    });

    const res2 = await promise2;
    assert.equal(res2.exitCode, 0);
  });

  it("executes concurrent requests across multiple workers when running parallel tools", async () => {
    setMockWasmCapabilities({
      hasSimd: true,
      hasSharedArrayBuffer: true,
      hasSharedMemory: true,
      isCrossOriginIsolated: true,
      hardwareConcurrency: 4,
      recommendedThreads: 4,
    });

    try {
      // Force a 4-thread configuration for testing concurrent dispatch
      setWasmRuntimeConfig({
        executionMode: "auto",
        maxThreads: 4,
      });

      const requests: WasmToolRequest[] = [
        { tool: "slope", args: ["--tile=1"], input: {} },
        { tool: "aspect", args: ["--tile=2"], input: {} },
      ];

      const batchPromise = runParallelWasmTools(requests);

      // In threaded-simd with capacity >= 2, both workers are spawned concurrently
      assert.equal(MockWorker.instances.length, 2, "Both workers spawned in parallel");

      // Emit responses for both workers
      MockWorker.instances[0].emit("message", {
        data: {
          ok: true,
          result: { exitCode: 0, stdout: ["done 0"], files: {} },
        },
      });
      MockWorker.instances[1].emit("message", {
        data: {
          ok: true,
          result: { exitCode: 0, stdout: ["done 1"], files: {} },
        },
      });

      const results = await batchPromise;
      assert.equal(results.length, 2);
      assert.equal(results[0].exitCode, 0);
      assert.equal(results[1].exitCode, 0);
    } finally {
      setMockWasmCapabilities(null);
    }
  });

  it("handles cancellation via AbortSignal gracefully and terminates worker", async () => {
    const controller = new AbortController();
    const run = runWasmToolInBackground(
      { tool: "heavy_filter", args: [], input: {} },
      { signal: controller.signal },
    );

    assert.equal(MockWorker.instances.length, 1);
    const worker = MockWorker.instances[0];

    // Trigger abort
    controller.abort();

    await assert.rejects(run, (err: Error) => err.name === "AbortError");
    assert.equal(worker.terminated, true, "Cancelled worker must be terminated");
  });

  it("cleans up all idle and active workers on terminateAllWasmToolWorkers", async () => {
    useSingleSlotPool();
    const run = runWasmToolInBackground({ tool: "task", args: [], input: {} });
    const queued = runWasmToolInBackground({ tool: "queued", args: [], input: {} });

    assert.equal(MockWorker.instances.length, 1);
    const worker = MockWorker.instances[0];

    terminateAllWasmToolWorkers("pool closed");
    assert.equal(worker.terminated, true);
    // terminate() fires no worker event, so the pool must settle both runs itself.
    await assert.rejects(run, /pool closed/);
    await assert.rejects(queued, /pool closed/);

    const stats = getWasmToolWorkerPoolStats();
    assert.equal(stats.activeWorkers, 0);
    assert.equal(stats.idleWorkers, 0);
    assert.equal(stats.queuedRequests, 0);
  });

  it("leaves in-flight runs alone in releaseIdleWasmToolWorkers", async () => {
    const run = runWasmToolInBackground({ tool: "task", args: [], input: {} });
    const worker = MockWorker.instances[0];

    releaseIdleWasmToolWorkers();
    assert.equal(worker.terminated, false, "a busy worker is not idle");

    worker.emit("message", { data: { ok: true, result: { exitCode: 0, stdout: [], files: {} } } });
    assert.equal((await run).exitCode, 0);
  });

  it("dispatches the next queued job when postMessage throws", async () => {
    useSingleSlotPool();
    const first = runWasmToolInBackground({ tool: "first", args: [], input: {} });
    const second = runWasmToolInBackground({ tool: "second", args: [], input: {} });
    const third = runWasmToolInBackground({ tool: "third", args: [], input: {} });
    const worker = MockWorker.instances[0];

    // `first` finishes and hands its worker to `second`, whose post fails.
    worker.postMessage = () => {
      throw new Error("DataCloneError");
    };
    worker.emit("message", { data: { ok: true, result: { exitCode: 0, stdout: [], files: {} } } });

    assert.equal((await first).exitCode, 0);
    await assert.rejects(second, /DataCloneError/);
    // `third` must not be stranded in the queue: a fresh worker picks it up.
    assert.equal(MockWorker.instances.length, 2);
    MockWorker.instances[1].emit("message", {
      data: { ok: true, result: { exitCode: 0, stdout: ["third"], files: {} } },
    });
    assert.deepEqual((await third).stdout, ["third"]);
  });

  it("rejects a queued job as soon as its signal aborts", async () => {
    useSingleSlotPool();
    const running = runWasmToolInBackground({ tool: "running", args: [], input: {} });
    const controller = new AbortController();
    const queued = runWasmToolInBackground(
      { tool: "queued", args: [], input: {} },
      { signal: controller.signal },
    );
    assert.equal(getWasmToolWorkerPoolStats().queuedRequests, 1);

    controller.abort();
    await assert.rejects(queued, (err: Error) => err.name === "AbortError");
    assert.equal(getWasmToolWorkerPoolStats().queuedRequests, 0);

    MockWorker.instances[0].emit("message", {
      data: { ok: true, result: { exitCode: 0, stdout: [], files: {} } },
    });
    assert.equal((await running).exitCode, 0);
  });

  it("keeps dispatching past a queued job that settles without a worker", async () => {
    useSingleSlotPool();
    const shared = new AbortController();
    const running = runWasmToolInBackground(
      { tool: "running", args: [], input: {} },
      { signal: shared.signal },
    );
    // Queued behind `running` on the same signal, then an unrelated job.
    const sibling = runWasmToolInBackground(
      { tool: "sibling", args: [], input: {} },
      { signal: shared.signal },
    );
    const other = runWasmToolInBackground({ tool: "other", args: [], input: {} });
    assert.equal(getWasmToolWorkerPoolStats().queuedRequests, 2);

    shared.abort();
    await assert.rejects(running, (err: Error) => err.name === "AbortError");
    await assert.rejects(sibling, (err: Error) => err.name === "AbortError");
    // `other` must take the freed slot rather than wait for a run that never comes.
    assert.equal(getWasmToolWorkerPoolStats().queuedRequests, 0);
    assert.equal(MockWorker.instances.length, 2);
    MockWorker.instances[1].emit("message", {
      data: { ok: true, result: { exitCode: 0, stdout: [], files: {} } },
    });
    assert.equal((await other).exitCode, 0);
  });

  it("cancels the rest of a parallel batch when one run fails", async () => {
    setMockWasmCapabilities({
      hasSimd: true,
      hasSharedArrayBuffer: true,
      hasSharedMemory: true,
      isCrossOriginIsolated: true,
      recommendedThreads: 2,
    });
    try {
      setWasmRuntimeConfig({ executionMode: "auto", maxThreads: 2 });
      const batch = runParallelWasmTools([
        { tool: "a", args: [], input: {} },
        { tool: "b", args: [], input: {} },
      ]);
      assert.equal(MockWorker.instances.length, 2);
      MockWorker.instances[0].emit("message", { data: { ok: false, error: "a broke" } });
      await assert.rejects(batch, /a broke/);
      assert.equal(MockWorker.instances[1].terminated, true, "sibling run is cancelled");
    } finally {
      setMockWasmCapabilities(null);
    }
  });
});
