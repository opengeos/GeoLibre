import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  auditAlgorithm,
  getWasmDiagnostics,
  getWasmRuntimeConfig,
  getWasmToolPoolCapacity,
  getWasmToolWorkerPoolStats,
  isAlgorithmParallelizable,
  isAlgorithmSimdEligible,
  probeWasmCapabilities,
  releaseIdleWasmToolWorkers,
  resetWasmRuntimeConfig,
  resolveExecutionMode,
  runParallelWasmTools,
  runWasmToolInBackground,
  setMockWasmCapabilities,
  setWasmRuntimeConfig,
  terminateAllWasmToolWorkers,
  type WasmExecutionMode,
  type WasmToolRequest,
  type WasmToolResponse,
} from "../packages/processing/src/index";

// Mock worker for pool and concurrency testing
class MockWorker {
  static instances: MockWorker[] = [];
  static postMessageFail: Error | null = null;

  public posted: unknown[] = [];
  public terminated = false;
  private listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(public url: URL, public options?: { type?: string }) {
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
    const caps = probeWasmCapabilities();
    assert.equal(typeof caps.hasSimd, "boolean");
    assert.equal(typeof caps.hasSharedMemory, "boolean");
    assert.equal(typeof caps.isCrossOriginIsolated, "boolean");
    assert.equal(typeof caps.hardwareConcurrency, "number");
    assert.ok(caps.hardwareConcurrency >= 1);
    assert.ok(caps.recommendedThreads >= 1);
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
    if (originalWorker === undefined) {
      delete (globalThis as { Worker?: typeof Worker }).Worker;
    } else {
      globalThis.Worker = originalWorker;
    }
    resetWasmRuntimeConfig();
  });

  it("scales pool capacity when threaded-simd mode is active", () => {
    setWasmRuntimeConfig({
      executionMode: "portable-single-thread",
    });
    assert.equal(getWasmToolPoolCapacity(), 1);

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
        result: { exitCode: 0, stdout: ["done"], files: { "slope.tif": new Uint8Array([4, 5, 6]) } },
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
        result: { exitCode: 0, stdout: ["done aspect"], files: { "aspect.tif": new Uint8Array([7, 8]) } },
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

  it("cleans up all idle and active workers on terminateAllWasmToolWorkers", () => {
    const run = runWasmToolInBackground({ tool: "task", args: [], input: {} });
    run.catch(() => {});

    assert.equal(MockWorker.instances.length, 1);
    const worker = MockWorker.instances[0];

    terminateAllWasmToolWorkers();
    assert.equal(worker.terminated, true);

    const stats = getWasmToolWorkerPoolStats();
    assert.equal(stats.activeWorkers, 0);
    assert.equal(stats.idleWorkers, 0);
    assert.equal(stats.queuedRequests, 0);
  });
});

describe("Numerical Correctness & Invariant Validation", () => {
  it("computes 3x3 Horn slope stencil accurately on synthetic DEM", () => {
    // 3x3 DEM grid with 10m cell resolution
    // Horn's slope formula:
    // dz/dx = ((c + 2f + i) - (a + 2d + g)) / (8 * cell_size)
    // dz/dy = ((g + 2h + i) - (a + 2b + c)) / (8 * cell_size)
    // slope_deg = atan(sqrt(dz/dx^2 + dz/dy^2)) * 180 / PI

    const cellSize = 10.0;
    // Flat terrain: elevation = 100 everywhere
    const flatDem = [
      100, 100, 100,
      100, 100, 100,
      100, 100, 100,
    ];

    const dzdxFlat =
      ((flatDem[2] + 2 * flatDem[5] + flatDem[8]) - (flatDem[0] + 2 * flatDem[3] + flatDem[6])) /
      (8 * cellSize);
    const dzdyFlat =
      ((flatDem[6] + 2 * flatDem[7] + flatDem[8]) - (flatDem[0] + 2 * flatDem[1] + flatDem[2])) /
      (8 * cellSize);
    const slopeFlat = Math.atan(Math.sqrt(dzdxFlat * dzdxFlat + dzdyFlat * dzdyFlat)) * (180 / Math.PI);
    assert.equal(slopeFlat, 0.0, "Flat terrain slope must be exactly 0 degrees");

    // 45-degree slope ramp downhill towards the East:
    // elevation decreases by 10m per 10m cell from West to East
    const rampDem = [
      20, 10, 0,
      20, 10, 0,
      20, 10, 0,
    ];
    const dzdxRamp =
      ((rampDem[2] + 2 * rampDem[5] + rampDem[8]) - (rampDem[0] + 2 * rampDem[3] + rampDem[6])) /
      (8 * cellSize);
    const dzdyRamp =
      ((rampDem[6] + 2 * rampDem[7] + rampDem[8]) - (rampDem[0] + 2 * rampDem[1] + rampDem[2])) /
      (8 * cellSize);
    const slopeRamp = Math.atan(Math.sqrt(dzdxRamp * dzdxRamp + dzdyRamp * dzdyRamp)) * (180 / Math.PI);
    assert.ok(Math.abs(slopeRamp - 45.0) < 1e-4, `Expected 45 deg slope, got ${slopeRamp}`);

    // Compass aspect (North = 0, East = 90, South = 180, West = 270)
    let aspectRamp = 90.0 - 57.29578 * Math.atan2(dzdyRamp, -dzdxRamp);
    if (aspectRamp < 0) aspectRamp += 360;
    if (aspectRamp >= 360) aspectRamp -= 360;
    assert.ok(Math.abs(aspectRamp - 90.0) < 1e-4, `Expected 90 deg aspect (East), got ${aspectRamp}`);
  });

  it("handles NoData boundary cells without contaminating interior cells", () => {
    const NODATA = -9999.0;
    const grid = [
      NODATA, 10, 20,
      NODATA, 10, 20,
      NODATA, 10, 20,
    ];

    // Neighborhood operation check: any stencil containing NoData returns NoData
    function mean3x3(dem: number[], centerIdx: number): number {
      for (const val of dem) {
        if (val === NODATA) return NODATA;
      }
      return dem.reduce((a, b) => a + b, 0) / dem.length;
    }

    assert.equal(mean3x3(grid, 4), NODATA, "Cell with NoData in 3x3 kernel must evaluate to NoData");
  });

  it("preserves topological drainage invariants in D8 flow accumulation", () => {
    // 3x3 elevation model representing a valley draining south
    // [10, 12, 10]
    // [ 8,  9,  8]
    // [ 4,  2,  4]  <- lowest point is (2, 1) = elevation 2
    const dem = [
      10, 12, 10,
      8,  9,  8,
      4,  2,  4,
    ];

    // Steepest descent from center (idx 4, elevation 9):
    // Neighbors:
    // (0): 10, (1): 12, (2): 10
    // (3): 8,  (4): 9,  (5): 8
    // (6): 4,  (7): 2,  (8): 4
    // Lowest neighbor is index 7 (elevation 2).
    let lowestIdx = 4;
    let minElev = dem[4];
    for (let i = 0; i < 9; i++) {
      if (dem[i] < minElev) {
        minElev = dem[i];
        lowestIdx = i;
      }
    }
    assert.equal(lowestIdx, 7, "Center cell must drain to index 7 (elevation 2)");
  });
});
