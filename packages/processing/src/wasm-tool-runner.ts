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
  /** Removes the abort listener attached while the job waits in the queue. */
  detachQueuedAbort?: () => void;
}

// Workers currently parked and warm, ready to take work immediately.
const idleWorkers: Worker[] = [];

// Idle-expiry timers for parked workers beyond the first. One warm worker is
// kept for the session, as before the pool existed; the extras a threaded
// batch leaves behind each hold their own compiled module and linear memory
// (which never shrinks), so they are terminated once they sit unused.
const idleTimers = new Map<Worker, ReturnType<typeof setTimeout>>();

/** How long a parked worker beyond the first stays warm before it is terminated. */
export const WASM_TOOL_WORKER_IDLE_MS = 30_000;

// Workers currently executing a job, each mapped to the function that fails
// that job: terminating a worker fires no event, so whoever tears the pool down
// has to settle the run itself.
const busyWorkers = new Map<Worker, (error: Error) => void>();

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
 * Determine how many workers may run at once.
 *
 * The pool is bounded only when the caller opts in by requesting
 * `executionMode: "threaded-simd"` and that mode is active. Otherwise, auto
 * mode included, each concurrent run gets its own worker, as before the pool
 * existed: a WASI run is synchronous inside its worker and the workers share
 * no memory, so a cap would only queue every short tool behind a minutes-long
 * tiling job.
 *
 * @returns The number of workers allowed to run at once (may be Infinity).
 */
export function getWasmToolPoolCapacity(): number {
  const diag = getWasmDiagnostics();
  if (diag.requestedMode === "threaded-simd" && diag.activeMode === "threaded-simd") {
    return Math.max(1, Math.min(16, diag.activeThreads));
  }
  return Number.POSITIVE_INFINITY;
}

// How many idle workers to keep warm outside `threaded-simd`. Each holds its
// compiled module (tens of MB), and real usage is one tool at a time, so one
// warm worker captures nearly all of the benefit.
const MAX_IDLE_WORKERS = 1;

/** How many idle workers the pool may keep parked in the current mode. */
function idleWorkerLimit(): number {
  const diag = getWasmDiagnostics();
  return diag.activeMode === "threaded-simd"
    ? Math.max(1, Math.min(16, diag.activeThreads))
    : MAX_IDLE_WORKERS;
}

/**
 * Return current pool metrics and diagnostics.
 *
 * @returns Busy, idle and queued counts plus the pool capacity and mode.
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

/** Take a worker out of the idle pool, cancelling its expiry timer. */
function unparkWorker(worker: Worker): void {
  const timer = idleTimers.get(worker);
  if (timer !== undefined) clearTimeout(timer);
  idleTimers.delete(worker);
}

/** Park a healthy worker for reuse, or terminate it if the pool is full. */
function parkWorker(worker: Worker): void {
  // The limit can shrink between runs (setWasmRuntimeConfig), so trim the pool
  // to leave room for this worker within it, dropping the oldest first.
  const limit = idleWorkerLimit();
  while (idleWorkers.length >= limit) {
    const extra = idleWorkers.shift()!;
    unparkWorker(extra);
    extra.terminate();
  }
  if (idleWorkers.length > 0) {
    const timer = setTimeout(() => {
      const index = idleWorkers.indexOf(worker);
      if (index === -1) return;
      idleWorkers.splice(index, 1);
      idleTimers.delete(worker);
      worker.terminate();
    }, WASM_TOOL_WORKER_IDLE_MS);
    // Node's timers keep the process alive; a parked worker must not (tests).
    (timer as { unref?: () => void }).unref?.();
    idleTimers.set(worker, timer);
  }
  idleWorkers.push(worker);
}

/**
 * Terminate every parked worker and forget them, freeing the compiled module
 * each one holds. Runs in flight are unaffected — they own their worker until
 * it answers. Call it to reclaim that memory, and in tests, so a worker parked
 * by one case is not handed to the next.
 */
export function releaseIdleWasmToolWorkers(): void {
  for (const worker of idleWorkers.splice(0)) {
    unparkWorker(worker);
    worker.terminate();
  }
}

/**
 * Terminate all workers (busy and idle), rejecting queued and in-flight runs.
 *
 * @param reason - The message the rejected runs settle with.
 */
export function terminateAllWasmToolWorkers(reason = "Worker pool terminated."): void {
  for (const job of pendingQueue.splice(0)) {
    job.detachQueuedAbort?.();
    job.reject(new Error(reason));
  }
  // Each fail() removes its own entry, so iterate over a snapshot.
  for (const fail of [...busyWorkers.values()]) fail(new Error(reason));
  releaseIdleWasmToolWorkers();
}

function spawnWorker(): Worker {
  return new Worker(new URL("./wasm-tool.worker.ts", import.meta.url), { type: "module" });
}

/** The rejection a cancelled run settles with. */
function abortError(tool: string): DOMException {
  return new DOMException(`${tool} was cancelled.`, "AbortError");
}

/**
 * Start queued jobs while a worker slot is free. A dequeued job can settle
 * without taking the slot (already aborted, or the spawn throws), so keep
 * going rather than leaving the jobs behind it stranded.
 */
function dispatchNext(): void {
  while (
    pendingQueue.length > 0 &&
    (idleWorkers.length > 0 || busyWorkers.size < getWasmToolPoolCapacity())
  ) {
    const nextJob = pendingQueue.shift()!;
    nextJob.detachQueuedAbort?.();
    acquireAndExecute(nextJob);
  }
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
  let currentWorker = worker;
  let isCurrentReused = isReused;
  let ackTimer: ReturnType<typeof setTimeout> | undefined;

  const config = getWasmRuntimeConfig();

  const disarmAck = () => {
    if (ackTimer !== undefined) clearTimeout(ackTimer);
    ackTimer = undefined;
  };

  // Settle the run as failed: the worker is no longer trustworthy, so it is
  // terminated rather than parked, and its slot goes to the next queued job.
  // The run is rejected before the next job is dispatched so that a throw
  // while starting that job cannot leave this one pending.
  const fail = (error: Error) => {
    disarmAck();
    cleanup();
    busyWorkers.delete(currentWorker);
    currentWorker.terminate();
    reject(error);
    dispatchNext();
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
      busyWorkers.set(currentWorker, fail);
      attach();
      post();
    }, REUSED_WORKER_ACK_MS);
  };

  const onDone = () => {
    disarmAck();
    cleanup();
    busyWorkers.delete(currentWorker);

    // If there is another job in the queue, hand this warm worker off directly.
    let nextJob = pendingQueue.shift();
    while (nextJob?.signal?.aborted) {
      nextJob.detachQueuedAbort?.();
      nextJob.reject(abortError(nextJob.request.tool));
      nextJob = pendingQueue.shift();
    }
    if (nextJob) {
      nextJob.detachQueuedAbort?.();
      executeOnWorker(
        currentWorker,
        true,
        nextJob.request,
        nextJob.signal,
        nextJob.resolve,
        nextJob.reject,
        nextJob.startTime,
      );
      return;
    }

    parkWorker(currentWorker);
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
    fail(new Error(event.message || `The ${request.tool} worker failed.`));
  };

  const onMessageError = () => {
    fail(new Error(`The ${request.tool} worker posted an undeserializable message.`));
  };

  const onAbort = () => {
    fail(abortError(request.tool));
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
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  };

  busyWorkers.set(currentWorker, fail);
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
    unparkWorker(parked);
    executeOnWorker(parked, true, job.request, job.signal, job.resolve, job.reject, job.startTime);
    return;
  }

  // 2. Check if we can spawn a new worker within pool capacity
  const capacity = getWasmToolPoolCapacity();
  if (busyWorkers.size < capacity) {
    let spawned: Worker;
    try {
      spawned = spawnWorker();
    } catch (error) {
      job.reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
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

  // 3. Pool is saturated; queue the job for next available slot. Aborting it
  // while it waits settles it now rather than when a slot frees, which with no
  // run timeout could be never.
  const { signal } = job;
  if (signal) {
    const onQueuedAbort = () => {
      const index = pendingQueue.indexOf(job);
      if (index !== -1) pendingQueue.splice(index, 1);
      job.reject(abortError(job.request.tool));
    };
    signal.addEventListener("abort", onQueuedAbort, { once: true });
    job.detachQueuedAbort = () => signal.removeEventListener("abort", onQueuedAbort);
  }
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
 *
 * @param requests - The tool runs to execute.
 * @param options - `signal` cancels every run in the batch.
 * @returns One result per request, in request order. Rejects with the first
 *   failure, after cancelling the batch's remaining runs.
 */
export async function runParallelWasmTools(
  requests: WasmToolRequest[],
  options: { signal?: AbortSignal } = {},
): Promise<ToolResult[]> {
  if (options.signal?.aborted) {
    throw abortError(requests[0]?.tool ?? "batch");
  }
  // One failure makes the batch's result unusable, so stop its siblings
  // instead of letting them keep workers and queue slots busy.
  const batch = new AbortController();
  const onOuterAbort = () => batch.abort();
  options.signal?.addEventListener("abort", onOuterAbort, { once: true });
  try {
    return await Promise.all(
      requests.map((req) =>
        runWasmToolInBackground(req, { signal: batch.signal }).catch((error: unknown) => {
          batch.abort();
          throw error;
        }),
      ),
    );
  } finally {
    options.signal?.removeEventListener("abort", onOuterAbort);
  }
}
