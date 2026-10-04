// Runs the client-side (Turf.js) vector tools on a Web Worker (#2858).
//
// A Turf tool is one synchronous pass over its input: buffering, overlaying or
// dissolving a large layer held the main thread — no paint, no input — for as
// long as the geometry took, which is bounded by the data rather than the
// clock. This is the wasm-tool-runner.ts idea applied to those tools: post the
// run to a worker, replay its callbacks (`log`, `addResultLayer`, `fitBounds`)
// on the main thread in the order the tool made them, and fall back to running
// inline where there is no Worker (node, tests) or the run cannot be posted.
//
// The main thread still pays the structured clone of the input layers on the
// way out and of each result on the way back. Both cross in feature chunks (see
// vector-tool-protocol.ts) with a yield between the outgoing ones, so that copy
// is spread over many short tasks instead of one proportional to the layer.
import type { Feature, FeatureCollection } from "geojson";
import { getActiveEllipsoid } from "@geolibre/core/worker-safe";
import type { ProcessingAlgorithm, ProcessingContext, ResultLayerOptions } from "./types";
import {
  chunkFeatureCollection,
  type VectorToolRunRequest,
  type VectorToolWorkerLayer,
  type VectorToolWorkerMessage,
  type VectorToolWorkerRequest,
} from "./vector-tool-protocol";
import { getVectorTool } from "./vector-tool-registry";
import { WORKER_VECTOR_TOOL_IDS } from "./vector-tool-worker-tools";

export { WORKER_VECTOR_TOOL_IDS };

/**
 * Whether `tool` would run on a worker here: Workers exist, and the tool is the
 * registry's own instance of a worker-safe id. The identity check matters
 * because the worker resolves the tool by id from its own registry copy; a
 * caller's custom algorithm that happens to reuse an id must still run as
 * itself.
 *
 * @param tool The algorithm about to run.
 * @returns True when {@link runAlgorithmInBackground} would post it to a worker.
 */
export function canRunVectorToolOnWorker(tool: ProcessingAlgorithm): boolean {
  return (
    typeof Worker !== "undefined" &&
    WORKER_VECTOR_TOOL_IDS.has(tool.id) &&
    getVectorTool(tool.id) === tool
  );
}

/**
 * The layers a run's parameters name, cut down to the fields the tools read.
 * A layer is included when its id is a parameter value, or an element of an
 * array-valued parameter (the `layers` multi-select).
 */
function referencedLayers(ctx: ProcessingContext): VectorToolWorkerLayer[] {
  const ids = new Set<string>();
  for (const value of Object.values(ctx.parameters)) {
    if (typeof value === "string") ids.add(value);
    else if (Array.isArray(value)) {
      for (const item of value) if (typeof item === "string") ids.add(item);
    }
  }
  return ctx.layers
    .filter((layer) => ids.has(layer.id))
    .map(({ id, name, type, geojson }) => ({ id, name, type, geojson }));
}

function spawnWorker(): Worker {
  return new Worker(new URL("./vector-tool.worker.ts", import.meta.url), { type: "module" });
}

/**
 * How long a finished run's worker stays parked for the next run before it is
 * terminated. Chained runs (Model Builder, Batch, a user trying a few buffer
 * distances) then skip the worker spawn and module load, while an idle app does
 * not hold a worker indefinitely.
 */
export const VECTOR_TOOL_WORKER_IDLE_MS = 30_000;

/**
 * The one warm worker, parked between runs. Only a worker whose last run ended
 * cleanly (`done` or a tool `error`) is parked: an aborted, crashed or
 * half-fed worker is terminated, so the next run spawns fresh.
 */
let parked: { worker: Worker; timer: ReturnType<typeof setTimeout> } | null = null;

/** Take the parked worker for a run, if there is one. */
function takeParkedWorker(): Worker | null {
  if (!parked) return null;
  clearTimeout(parked.timer);
  const { worker } = parked;
  parked = null;
  return worker;
}

/**
 * Park a worker whose run finished cleanly, replacing its idle timer. When a
 * worker is already parked (two runs overlapped), the extra one is terminated:
 * one warm worker is enough for sequential runs.
 */
function parkWorker(worker: Worker): void {
  if (parked) {
    worker.terminate();
    return;
  }
  const timer = setTimeout(() => {
    if (parked?.worker !== worker) return;
    parked = null;
    worker.terminate();
  }, VECTOR_TOOL_WORKER_IDLE_MS);
  // Node's timers keep the process alive; a parked worker must not (tests).
  (timer as { unref?: () => void }).unref?.();
  parked = { worker, timer };
}

/**
 * Terminate the parked worker now instead of on its idle timeout. The next run
 * spawns a fresh one.
 */
export function disposeVectorToolWorker(): void {
  takeParkedWorker()?.terminate();
}

/** Thrown when the run was aborted through `ctx.signal`. */
function abortError(): Error {
  const error = new Error("The vector tool run was cancelled.");
  error.name = "AbortError";
  return error;
}

/**
 * Resolve on a later task. `scheduler.yield` where it exists; otherwise a
 * MessageChannel round trip, which unlike `setTimeout(0)` is not clamped to
 * 4 ms once nested, so yielding after each of a hundred chunks stays cheap.
 *
 * The app's duckdb-feature-batches.ts has a simpler twin that falls back to
 * `setTimeout` directly: it yields only when a batch overruns its budget, so
 * the clamp never compounds there the way it would after every chunk here.
 */
function yieldToEventLoop(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof scheduler?.yield === "function") return scheduler.yield();
  if (typeof MessageChannel === "function") {
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        resolve();
      };
      channel.port2.postMessage(null);
    });
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The layer messages for one input layer: a feature-less header, then chunks. */
function layerMessages(layer: VectorToolWorkerLayer): VectorToolWorkerRequest[] {
  if (!layer.geojson) return [{ type: "layer", layer }];
  const { header, chunks } = chunkFeatureCollection(layer.geojson);
  return [
    { type: "layer", layer: { ...layer, geojson: header } },
    ...chunks.map((features) => ({ type: "layer-features" as const, layerId: layer.id, features })),
  ];
}

/**
 * Post one run to a worker (the parked one, or a fresh one) and replay its
 * messages onto `ctx`.
 *
 * The callbacks are replayed once the worker reports the run finished, in the
 * order the tool made them, rather than as they arrive. A run aborted part-way
 * therefore leaves no trace on the host: no result layer, no fitted view, no
 * log line. Turf tools are synchronous, so their callbacks arrive back to back
 * after the work anyway.
 *
 * Resolves `"post-failed"` without the tool having run when the worker cannot
 * start (construction throws, or its module fails to load before it reports
 * `ready`) or a message cannot be posted (a parameter or layer that will not
 * structured-clone), so the caller can fall back to running inline. Nothing is
 * posted until the worker is ready, so an error before then cannot mean the
 * tool had started.
 */
async function runOnWorker(
  layers: VectorToolWorkerLayer[],
  run: VectorToolRunRequest,
  ctx: ProcessingContext,
  toolName: string,
): Promise<"done" | "post-failed"> {
  let worker = takeParkedWorker();
  // A parked worker already reported `ready` for an earlier run.
  let workerReady = worker !== null;
  if (!worker) {
    try {
      worker = spawnWorker();
    } catch {
      return "post-failed";
    }
  }
  const activeWorker = worker;
  let settled = false;
  let resolveReady: (ready: boolean) => void = () => {};
  const ready = workerReady
    ? Promise.resolve(true)
    : new Promise<boolean>((resolve) => {
        resolveReady = resolve;
      });
  let settle: (outcome: {
    value?: "done" | "post-failed";
    error?: unknown;
    /** The worker finished its run cleanly and can serve the next one. */
    reusable?: boolean;
  }) => void = () => {};
  const outcome = new Promise<"done" | "post-failed">((resolve, reject) => {
    settle = ({ value, error, reusable }) => {
      if (settled) return;
      settled = true;
      activeWorker.removeEventListener("message", onMessage);
      activeWorker.removeEventListener("error", onError);
      activeWorker.removeEventListener("messageerror", onMessageError);
      ctx.signal?.removeEventListener("abort", onAbort);
      if (reusable) parkWorker(activeWorker);
      else activeWorker.terminate();
      resolveReady(false);
      if (error !== undefined) reject(error);
      else resolve(value ?? "done");
    };
  });
  // An abort or worker failure can settle the run while chunks are still being
  // posted, before `outcome` is returned to anyone; mark it handled so that is
  // not reported as an unhandled rejection. The caller still sees it.
  outcome.catch(() => undefined);

  // The host callbacks the tool made, replayed in order once the run finishes.
  const replay: Array<() => void> = [];
  // A result being reassembled from its chunks.
  let pending: {
    name: string;
    collection: FeatureCollection;
    features: Feature[];
    options?: ResultLayerOptions;
  } | null = null;

  // Replay the buffered callbacks, then settle. A throwing host callback ends
  // the run the way it would inline, where the throw would have propagated out
  // of `tool.run` before anything after it. Either way the worker finished its
  // run, so it can be parked.
  const finish = (toolError?: Error) => {
    try {
      for (const call of replay) call();
    } catch (callbackError) {
      settle({ error: callbackError, reusable: true });
      return;
    }
    if (toolError) settle({ error: toolError, reusable: true });
    else settle({ value: "done", reusable: true });
  };

  const onMessage = (event: MessageEvent<VectorToolWorkerMessage>) => {
    const message = event.data;
    switch (message.type) {
      case "ready":
        workerReady = true;
        resolveReady(true);
        return;
      case "log": {
        const line = message.message;
        replay.push(() => ctx.log(line));
        return;
      }
      case "result-start":
        pending = {
          name: message.name,
          collection: message.collection,
          features: [],
          ...(message.options === undefined ? {} : { options: message.options }),
        };
        return;
      case "result-features":
        if (pending) for (const feature of message.features) pending.features.push(feature);
        return;
      case "result-end": {
        if (!pending) return;
        const { name, collection, features, options } = pending;
        pending = null;
        const geojson: FeatureCollection = { ...collection, features };
        replay.push(() => {
          if (options === undefined) ctx.addResultLayer?.(name, geojson);
          else ctx.addResultLayer?.(name, geojson, options);
        });
        return;
      }
      case "fit-bounds": {
        const { bounds } = message;
        replay.push(() => ctx.fitBounds?.(bounds));
        return;
      }
      case "done":
        finish();
        return;
      case "error":
        finish(new Error(message.message));
        return;
    }
  };
  const onError = (event: ErrorEvent) => {
    // Before `ready` the worker never received the run: its module failed to
    // load (a missing chunk, a CSP refusal), so run inline instead.
    if (!workerReady) settle({ value: "post-failed" });
    else settle({ error: new Error(event.message || `The ${toolName} worker failed.`) });
  };
  // `error` does not fire for a message that cannot be deserialized, which
  // would otherwise leave the run pending forever.
  const onMessageError = () => {
    settle({ error: new Error(`The ${toolName} worker posted an undeserializable message.`) });
  };
  const onAbort = () => settle({ error: abortError() });

  activeWorker.addEventListener("message", onMessage);
  activeWorker.addEventListener("error", onError);
  activeWorker.addEventListener("messageerror", onMessageError);
  ctx.signal?.addEventListener("abort", onAbort, { once: true });

  if (!(await ready)) return outcome;
  try {
    for (const layer of layers) {
      for (const message of layerMessages(layer)) {
        if (settled) return outcome;
        activeWorker.postMessage(message);
        // Each post serializes its chunk on this thread; yield so the copy is
        // many short tasks rather than one long one.
        await yieldToEventLoop();
      }
    }
    if (!settled) {
      activeWorker.postMessage({ type: "run", ...run } satisfies VectorToolWorkerRequest);
    }
  } catch {
    // DataCloneError: the tool has not run (`run` was never posted), so the
    // caller runs it inline instead. The worker may hold some of this run's
    // layers, so it is terminated rather than parked.
    settle({ value: "post-failed" });
  }
  return outcome;
}

/**
 * Run a processing algorithm, on a Web Worker when it is a worker-safe vector
 * tool and Workers exist, otherwise inline via `tool.run(ctx)`.
 *
 * Same contract as calling `tool.run(ctx)` directly: the context's `log`,
 * `addResultLayer` and `fitBounds` are called with the same arguments in the
 * same order, and a tool that throws rejects with its error message. A worker
 * run additionally honours `ctx.signal`: aborting terminates the worker and
 * rejects with an `AbortError` before any of the run's callbacks reach `ctx`.
 * Consecutive worker runs share one warm worker (see
 * {@link VECTOR_TOOL_WORKER_IDLE_MS}).
 *
 * @param tool The algorithm to run.
 * @param ctx The run context, as it would be passed to `tool.run`.
 */
export async function runAlgorithmInBackground(
  tool: ProcessingAlgorithm,
  ctx: ProcessingContext,
): Promise<void> {
  if (!canRunVectorToolOnWorker(tool)) {
    await tool.run(ctx);
    return;
  }
  if (ctx.signal?.aborted) throw abortError();
  const run: VectorToolRunRequest = {
    toolId: tool.id,
    parameters: ctx.parameters,
    viewportBounds: ctx.viewportBounds?.() ?? null,
    ellipsoidId: getActiveEllipsoid().id,
  };
  const outcome = await runOnWorker(referencedLayers(ctx), run, ctx, tool.name);
  if (outcome === "post-failed") await tool.run(ctx);
}
