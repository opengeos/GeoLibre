// Shared plumbing for running a `geolibre-wasm/tools` WASI tool off the main
// thread, supporting multi-worker concurrent execution, SIMD128, and portable fallbacks.
//
// The runner has no yield points once a tool starts: `wasi.start()` is one
// synchronous call that returns only when the tool is done. On the main thread
// that freezes the whole UI — no repaint, no input — for the tool's entire
// duration, which is bounded by the data rather than the clock. Dissolving the
// 290-polygon layer from GeoLibre#1977 blocks it for ~60s.
//
// wasm-convert.ts routed its tiling calls through a worker for exactly this
// reason. This module is that machinery, lifted out so the Whitebox toolbox
// (wasm-client.ts) shares one implementation with it instead of growing a
// second copy that could drift.

import type { ToolResult } from "geolibre-wasm/tools";
import type { WasmToolRequest, WasmToolResponse } from "./wasm-tool.worker";
import { getWasmDiagnostics, getWasmRuntimeConfig } from "./wasm-config";
import type { WasmExecutionMode } from "./wasm-capabilities";

export type { WasmToolRequest, WasmToolResponse };

interface QueuedJob {
  request: WasmToolRequest;
  signal?: AbortSignal;
  resolve: (result: ToolResult) => void;
  reject: (error: Error) => void;
  startTime: number;
}

// Workers currently parked and warm, ready to take work immediately.
const idleWorkers: Worker[] = [];

// Workers currently executing a job.
const busyWorkers = new Set<Worker>();

// Pending job queue waiting for an available worker slot.
const pendingQueue: QueuedJob[] = [];

// How long a *reused* worker has to acknowledge a request before it is treated
// as dead. A parked worker is idle by construction — it is only parked once it
// has answered — so an ack is a message hop away and this window is enormous by
// comparison. It exists because a worker killed out of band (an OOM kill, a
// discarded tab) fires no `error` event and silently swallows `postMessage`, and
// this module deliberately puts no timeout on the run itself, so without the ack
// a dead worker would leave the run pending forever. A false positive costs a
// respawn, never a failed run.
const REUSED_WORKER_ACK_MS = 10_000;

/**
 * Determine the maximum active worker pool size based on current execution mode.
 */
export function getWasmToolPoolCapacity(): number {
  const diag = getWasmDiagnostics();
  if (diag.activeMode === "threaded-simd") {
    return Math.max(1, Math.min(16, diag.activeThreads));
  }
  return 1;
}

/**
 * Return current pool metrics and diagnostics.
 */
export function getWasmToolWorkerPoolStats(): {
  activeWorkers: number;
  idleWorkers: number;
  queuedRequests: number;
  poolCapacity: number;
  mode: WasmExecutionMode;
} {
  const diag = getWasmDiagnostics();
  return {
    activeWorkers: busyWorkers.size,
    idleWorkers: idleWorkers.length,
    queuedRequests: pendingQueue.length,
    poolCapacity: getWasmToolPoolCapacity(),
    mode: diag.activeMode,
  };
}

/**
 * Terminate every parked worker and forget them, freeing the compiled module
 * each one holds. Runs in flight are unaffected — they own their worker until
 * it answers. Call it to reclaim that memory, and in tests, so a worker parked
 * by one case is not handed to the next.
 */
export function releaseIdleWasmToolWorkers(): void {
  for (const worker of idleWorkers.splice(0)) worker.terminate();
  for (const worker of busyWorkers) worker.terminate();
  busyWorkers.clear();
  pendingQueue.length = 0;
}

/**
 * Terminate all workers (busy and idle) and reject any queued jobs.
 */
export function terminateAllWasmToolWorkers(reason = "Worker pool terminated."): void {
  for (const job of pendingQueue.splice(0)) {
    job.reject(new Error(reason));
  }
  for (const worker of idleWorkers.splice(0)) {
    worker.terminate();
  }
  for (const worker of busyWorkers) {
    worker.terminate();
  }
  busyWorkers.clear();
}

function spawnWorker(): Worker {
  return new Worker(new URL("./wasm-tool.worker.ts", import.meta.url), { type: "module" });
}

/** The rejection a cancelled run settles with. */
function abortError(tool: string): DOMException {
  return new DOMException(`${tool} was cancelled.`, "AbortError");
}

/**
 * Execute a job on a specific worker instance.
 */
function executeOnWorker(
  worker: Worker,
  isReused: boolean,
  request: WasmToolRequest,
  signal: AbortSignal | undefined,
  resolve: (res: ToolResult) => void,
  reject: (err: Error) => void,
  startTime: number,
): void {
  busyWorkers.add(worker);
  let currentWorker = worker;
  let isCurrentReused = isReused;
  let ackTimer: ReturnType<typeof setTimeout> | undefined;

  const config = getWasmRuntimeConfig();

  const disarmAck = () => {
    if (ackTimer !== undefined) clearTimeout(ackTimer);
    ackTimer = undefined;
  };

  const armAck = () => {
    if (!isCurrentReused) return;
    ackTimer = setTimeout(() => {
      // Never acknowledged, so it died while parked. Replace it and re-post;
      // the request has not started, so nothing is lost by retrying once.
      cleanup();
      busyWorkers.delete(currentWorker);
      currentWorker.terminate();
      currentWorker = spawnWorker();
      isCurrentReused = false;
      busyWorkers.add(currentWorker);
      attach();
      post();
    }, REUSED_WORKER_ACK_MS);
  };

  const onDone = () => {
    disarmAck();
    cleanup();
    busyWorkers.delete(currentWorker);

    // If there is another job in the queue, hand this warm worker off directly.
    const nextJob = pendingQueue.shift();
    if (nextJob) {
      if (nextJob.signal?.aborted) {
        nextJob.reject(abortError(nextJob.request.tool));
        onDone();
      } else {
        executeOnWorker(
          currentWorker,
          true,
          nextJob.request,
          nextJob.signal,
          nextJob.resolve,
          nextJob.reject,
          nextJob.startTime,
        );
      }
      return;
    }

    // Otherwise, park it if we have capacity; else terminate.
    const capacity = getWasmToolPoolCapacity();
    if (idleWorkers.length < capacity) {
      idleWorkers.push(currentWorker);
    } else {
      currentWorker.terminate();
    }
  };

  const onMessage = (event: MessageEvent<WasmToolResponse>) => {
    if (event.data.ok === "ack") {
      disarmAck();
      return;
    }
    const elapsed = Date.now() - startTime;
    if (config.debugPerformance) {
      console.debug(`[WASM Geoprocessing] ${request.tool} completed in ${elapsed}ms`);
    }
    onDone();
    if (event.data.ok) resolve(event.data.result);
    else reject(new Error(event.data.error || `${request.tool} failed.`));
  };

  const onError = (event: ErrorEvent) => {
    disarmAck();
    cleanup();
    busyWorkers.delete(currentWorker);
    currentWorker.terminate();
    // Dispatch next queued item if any
    const nextJob = pendingQueue.shift();
    if (nextJob) {
      acquireAndExecute(nextJob);
    }
    reject(new Error(event.message || `The ${request.tool} worker failed.`));
  };

  const onMessageError = () => {
    disarmAck();
    cleanup();
    busyWorkers.delete(currentWorker);
    currentWorker.terminate();
    const nextJob = pendingQueue.shift();
    if (nextJob) {
      acquireAndExecute(nextJob);
    }
    reject(new Error(`The ${request.tool} worker posted an undeserializable message.`));
  };

  const onAbort = () => {
    disarmAck();
    cleanup();
    busyWorkers.delete(currentWorker);
    currentWorker.terminate();
    const nextJob = pendingQueue.shift();
    if (nextJob) {
      acquireAndExecute(nextJob);
    }
    reject(abortError(request.tool));
  };

  const cleanup = () => {
    currentWorker.removeEventListener("message", onMessage);
    currentWorker.removeEventListener("error", onError);
    currentWorker.removeEventListener("messageerror", onMessageError);
    signal?.removeEventListener("abort", onAbort);
  };

  const attach = () => {
    currentWorker.addEventListener("message", onMessage);
    currentWorker.addEventListener("error", onError);
    currentWorker.addEventListener("messageerror", onMessageError);
    signal?.addEventListener("abort", onAbort, { once: true });
  };

  const post = () => {
    try {
      currentWorker.postMessage(request);
      armAck();
    } catch (error) {
      disarmAck();
      cleanup();
      busyWorkers.delete(currentWorker);
      currentWorker.terminate();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  };

  attach();
  post();
}

function acquireAndExecute(job: QueuedJob): void {
  if (job.signal?.aborted) {
    job.reject(abortError(job.request.tool));
    return;
  }

  // 1. Try to take an already-parked warm worker
  const parked = idleWorkers.pop();
  if (parked) {
    executeOnWorker(parked, true, job.request, job.signal, job.resolve, job.reject, job.startTime);
    return;
  }

  // 2. Check if we can spawn a new worker within pool capacity
  const capacity = getWasmToolPoolCapacity();
  if (busyWorkers.size < capacity) {
    const spawned = spawnWorker();
    executeOnWorker(
      spawned,
      false,
      job.request,
      job.signal,
      job.resolve,
      job.reject,
      job.startTime,
    );
    return;
  }

  // 3. Pool is saturated; queue the job for next available slot
  pendingQueue.push(job);
}

/**
 * Run a tool on a Web Worker pool and resolve with its result.
 *
 * Automatically scales across available workers when in threaded-simd mode.
 * Preserves cancellation, dead-worker acknowledgement retry, and structured errors.
 */
function runToolOnWorker(request: WasmToolRequest, signal?: AbortSignal): Promise<ToolResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(request.tool));
      return;
    }
    acquireAndExecute({
      request,
      signal,
      resolve,
      reject,
      startTime: Date.now(),
    });
  });
}

/**
 * Run a tool off the main thread where Workers exist, inline where they do not
 * (node, tests). The inline path is why the callers still expose an explicit
 * wasm-source init (`initConvertTools`): a worker resolves its own bundled copy
 * instead, in its own module scope.
 *
 * @param request - The tool id, CLI args, and files to place under `/work`.
 * @param options - `signal` cancels the run: the worker running it is
 *   terminated and the promise rejects with an `AbortError` DOMException. The
 *   inline (no-Worker) path can only honour a signal between runs.
 * @returns The tool's exit code, captured output, and the files it wrote.
 */
export async function runWasmToolInBackground(
  request: WasmToolRequest,
  options: { signal?: AbortSignal } = {},
): Promise<ToolResult> {
  if (options.signal?.aborted) throw abortError(request.tool);
  if (typeof Worker === "undefined") {
    const { runTool } = await import("geolibre-wasm/tools");
    const result = await runTool(request.tool, { args: request.args, input: request.input });
    if (options.signal?.aborted) throw abortError(request.tool);
    return result;
  }
  return runToolOnWorker(request, options.signal);
}

/**
 * Execute multiple tool requests in parallel across the worker pool,
 * preserving input-to-output array indexing.
 */
export async function runParallelWasmTools(
  requests: WasmToolRequest[],
  options: { signal?: AbortSignal } = {},
): Promise<ToolResult[]> {
  if (options.signal?.aborted) {
    throw abortError(requests[0]?.tool ?? "batch");
  }
  return Promise.all(requests.map((req) => runWasmToolInBackground(req, options)));
}
