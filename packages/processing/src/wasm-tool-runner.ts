// Shared plumbing for running a `geolibre-wasm/tools` WASI tool off the main
// thread.
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

export type { WasmToolRequest, WasmToolResponse };

// Idle workers, kept alive to be reused. A worker compiles the ~23 MB
// `geolibre-cli.wasm` in its *own* module scope, and the main thread's
// already-compiled copy is not shared with it, so a worker discarded after
// every run makes each run pay that fetch and compile again. That is invisible
// next to a minutes-long tiling job — the only thing that used this path
// before — but not next to the many Whitebox tools that finish in well under a
// second, where it would dominate the run.
//
// Reuse rather than a single shared worker: a WASI run is synchronous inside
// its worker, so one worker would serialize concurrent runs that used to
// overlap. Taking an idle worker when there is one and spawning otherwise keeps
// that parallelism and still pays the compile once per worker.
const idleWorkers: Worker[] = [];

// How many idle workers to keep warm. Each holds its compiled module (tens of
// MB) for the rest of the session, and real usage is one tool at a time, so
// one warm worker captures nearly all of the benefit; extras are terminated
// rather than parked.
const MAX_IDLE_WORKERS = 1;

/**
 * Terminate every parked worker and forget them, freeing the compiled module
 * each one holds. Runs in flight are unaffected — they own their worker until
 * it answers. Call it to reclaim that memory, and in tests, so a worker parked
 * by one case is not handed to the next.
 */
export function releaseIdleWasmToolWorkers(): void {
  for (const worker of idleWorkers.splice(0)) worker.terminate();
}

function acquireWorker(): Worker {
  return (
    idleWorkers.pop() ??
    new Worker(new URL("./wasm-tool.worker.ts", import.meta.url), { type: "module" })
  );
}

/** Park a still-healthy worker for reuse, or terminate it if enough are warm. */
function releaseWorker(worker: Worker): void {
  if (idleWorkers.length < MAX_IDLE_WORKERS) idleWorkers.push(worker);
  else worker.terminate();
}

/**
 * Run a tool on a Web Worker and resolve with its result.
 *
 * No timeout: how long a tool runs is bounded by the data, not the clock (a
 * country-scale tile pyramid is minutes), and cutting off work that would have
 * finished is worse than waiting. `error`/`messageerror` still reject, so the
 * promise settles on every failure the worker can report.
 *
 * A worker that answers is parked for reuse; one that fails at the worker level
 * is terminated, since its state after that is not something to hand the next
 * caller. Listeners are removed on the way out so a reused worker does not
 * accumulate them.
 */
function runToolOnWorker(request: WasmToolRequest): Promise<ToolResult> {
  return new Promise((resolve, reject) => {
    const worker = acquireWorker();
    const onMessage = (event: MessageEvent<WasmToolResponse>) => {
      cleanup();
      releaseWorker(worker);
      if (event.data.ok) resolve(event.data.result);
      else reject(new Error(event.data.error || `${request.tool} failed.`));
    };
    const onError = (event: ErrorEvent) => {
      cleanup();
      worker.terminate();
      reject(new Error(event.message || `The ${request.tool} worker failed.`));
    };
    // `error` does not fire when a posted message cannot be deserialized, which
    // would otherwise leave this promise pending forever.
    const onMessageError = () => {
      cleanup();
      worker.terminate();
      reject(new Error(`The ${request.tool} worker posted an undeserializable message.`));
    };
    const cleanup = () => {
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      worker.removeEventListener("messageerror", onMessageError);
    };
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    worker.addEventListener("messageerror", onMessageError);
    // The input files are structured-cloned rather than transferred: these
    // wrappers do not otherwise take ownership of the caller's bytes, and a
    // neutered input array would be a trap the callers don't set.
    try {
      worker.postMessage(request);
    } catch (error) {
      // A throw here (e.g. DataCloneError) rejects the promise on its own, but
      // the worker is already spawned and would leak without this.
      cleanup();
      worker.terminate();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/**
 * Run a tool off the main thread where Workers exist, inline where they do not
 * (node, tests). The inline path is why the callers still expose an explicit
 * wasm-source init (`initConvertTools`): a worker resolves its own bundled copy
 * instead, in its own module scope.
 *
 * @param request - The tool id, CLI args, and files to place under `/work`.
 * @returns The tool's exit code, captured output, and the files it wrote.
 */
export async function runWasmToolInBackground(request: WasmToolRequest): Promise<ToolResult> {
  if (typeof Worker === "undefined") {
    const { runTool } = await import("geolibre-wasm/tools");
    return runTool(request.tool, { args: request.args, input: request.input });
  }
  return runToolOnWorker(request);
}
