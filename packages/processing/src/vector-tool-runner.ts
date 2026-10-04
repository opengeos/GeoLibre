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
import { getActiveEllipsoid } from "@geolibre/core";
import type { ProcessingAlgorithm, ProcessingContext, ResultLayerOptions } from "./types";
import {
  chunkFeatureCollection,
  type VectorToolRunRequest,
  type VectorToolWorkerLayer,
  type VectorToolWorkerMessage,
  type VectorToolWorkerRequest,
} from "./vector-tool-protocol";
import { getVectorTool } from "./vector-tools";

/**
 * The vector tools that run on the worker: the pure FeatureCollection-in/out
 * Turf tools, whose only reach outside their parameters is the layers they
 * read and the viewport (snapshotted into the request).
 *
 * Kept as an explicit list so a new tool runs on the main thread until someone
 * checks it is worker-safe. Left out on purpose: the DGGS and topology tools,
 * which query the host's DuckDB capability (a main-thread object), and
 * `reproject`, whose client `run` only logs a pointer to the Python engines.
 */
export const WORKER_VECTOR_TOOL_IDS: ReadonlySet<string> = new Set([
  "buffer",
  "centroids",
  "convex-hull",
  "dissolve",
  "bounding-box",
  "simplify",
  "clip",
  "intersection",
  "difference",
  "union",
  "spatial-join",
  "attribute-join",
  "select-by-value",
  "select-by-location",
  "random-extract",
  "explode",
  "aggregate",
  "smooth",
  "extract-vertices",
  "points-along-geometry",
  "grid",
  "voronoi",
  "cell-sectors",
  "trajectory-speed",
  "detect-stops",
  "space-time-proximity",
  "merge-layers",
  "decode-polyline",
  "encode-polyline",
]);

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
 * Post one run to a fresh worker and replay its messages onto `ctx`.
 *
 * Resolves `"post-failed"` without the tool having run when a message cannot be
 * posted (a parameter or layer that will not structured-clone), so the caller
 * can fall back to running inline.
 */
async function runOnWorker(
  layers: VectorToolWorkerLayer[],
  run: VectorToolRunRequest,
  ctx: ProcessingContext,
  toolName: string,
): Promise<"done" | "post-failed"> {
  const worker = spawnWorker();
  let settled = false;
  let settle: (outcome: { value?: "done" | "post-failed"; error?: unknown }) => void = () => {};
  const outcome = new Promise<"done" | "post-failed">((resolve, reject) => {
    settle = ({ value, error }) => {
      if (settled) return;
      settled = true;
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      worker.removeEventListener("messageerror", onMessageError);
      ctx.signal?.removeEventListener("abort", onAbort);
      worker.terminate();
      if (error !== undefined) reject(error);
      else resolve(value ?? "done");
    };
  });
  // An abort or worker failure can settle the run while chunks are still being
  // posted, before `outcome` is returned to anyone; mark it handled so that is
  // not reported as an unhandled rejection. The caller still sees it.
  outcome.catch(() => undefined);

  // A result being reassembled from its chunks.
  let pending: {
    name: string;
    collection: FeatureCollection;
    features: Feature[];
    options?: ResultLayerOptions;
  } | null = null;

  const onMessage = (event: MessageEvent<VectorToolWorkerMessage>) => {
    const message = event.data;
    // A throwing host callback ends the run the way it would inline, where the
    // throw would have propagated out of `tool.run`.
    try {
      switch (message.type) {
        case "log":
          ctx.log(message.message);
          return;
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
          if (options === undefined) ctx.addResultLayer?.(name, geojson);
          else ctx.addResultLayer?.(name, geojson, options);
          return;
        }
        case "fit-bounds":
          ctx.fitBounds?.(message.bounds);
          return;
        case "done":
          settle({ value: "done" });
          return;
        case "error":
          settle({ error: new Error(message.message) });
          return;
      }
    } catch (error) {
      settle({ error });
    }
  };
  const onError = (event: ErrorEvent) => {
    settle({ error: new Error(event.message || `The ${toolName} worker failed.`) });
  };
  // `error` does not fire for a message that cannot be deserialized, which
  // would otherwise leave the run pending forever.
  const onMessageError = () => {
    settle({ error: new Error(`The ${toolName} worker posted an undeserializable message.`) });
  };
  const onAbort = () => settle({ error: abortError() });

  worker.addEventListener("message", onMessage);
  worker.addEventListener("error", onError);
  worker.addEventListener("messageerror", onMessageError);
  ctx.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    for (const layer of layers) {
      for (const message of layerMessages(layer)) {
        if (settled) return outcome;
        worker.postMessage(message);
        // Each post serializes its chunk on this thread; yield so the copy is
        // many short tasks rather than one long one.
        await yieldToEventLoop();
      }
    }
    if (!settled) worker.postMessage({ type: "run", ...run } satisfies VectorToolWorkerRequest);
  } catch {
    // DataCloneError: the tool has not run (`run` was never posted), so the
    // caller runs it inline instead.
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
 * rejects with an `AbortError`.
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
