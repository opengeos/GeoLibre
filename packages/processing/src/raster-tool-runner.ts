// Runs the browser raster tools on a Web Worker (issue #3701).
//
// Every client raster tool is a synchronous pass over typed arrays, and the
// Building shadows day modes scale with cells x sun positions x skyline, so a
// run on the main thread froze the tab (no paint, no input, no Cancel) for as
// long as it took. This follows the Felzenszwalb worker: one worker per run,
// terminated on the result or on Cancel, the input bands transferred rather
// than copied, and an inline fallback where there is no Worker (node, tests).
import {
  runRasterToolClientAsync,
  type ClientToolInputs,
  type ClientToolProgress,
  type ClientToolResult,
} from "./raster-client";
import {
  requestTransferables,
  type RasterToolWorkerMessage,
  type RasterToolWorkerRequest,
} from "./raster-tool-protocol";

/** Options for {@link runRasterToolInBackground}. */
export interface RasterToolBackgroundOptions {
  /** Aborting it terminates the worker and rejects the run with an `AbortError`. */
  signal?: AbortSignal;
  /** Called as a long run advances (the Building shadows day modes). */
  onProgress?: (progress: ClientToolProgress) => void;
}

const aborted = () => new DOMException("The raster tool run was cancelled.", "AbortError");

function spawnWorker(): Worker {
  return new Worker(new URL("./raster-tool.worker.ts", import.meta.url), { type: "module" });
}

/** Rebuild an error the worker reported, keeping its name. */
function workerError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

async function runInline(
  toolId: string,
  inputs: ClientToolInputs,
  parameters: Record<string, unknown>,
  options: RasterToolBackgroundOptions,
): Promise<ClientToolResult> {
  const result = await runRasterToolClientAsync(toolId, inputs, parameters, {
    onProgress: options.onProgress,
  });
  if (options.signal?.aborted) throw aborted();
  return result;
}

/**
 * Run a browser raster tool on a Web Worker, with progress and cancellation.
 * The result is the one {@link runRasterToolClientAsync} returns for the same
 * inputs.
 *
 * The input rasters' band buffers are transferred to the worker, so they are
 * detached (empty) on the caller's side once the run starts: pass rasters
 * decoded for this run. Where Workers are unavailable (node, tests), or the
 * request cannot be posted, the tool runs inline on the calling thread instead.
 * That compute is synchronous, so an abort cannot interrupt it: the signal is
 * checked before and after, and an aborted run still rejects with an
 * `AbortError` (its result discarded) once the compute returns.
 *
 * @param toolId - The raster tool id.
 * @param inputs - The decoded rasters and parsed GeoJSON inputs.
 * @param parameters - The tool parameters.
 * @param options - Cancellation and progress.
 * @returns The raster or vector result.
 */
export function runRasterToolInBackground(
  toolId: string,
  inputs: ClientToolInputs,
  parameters: Record<string, unknown>,
  options: RasterToolBackgroundOptions = {},
): Promise<ClientToolResult> {
  const { signal, onProgress } = options;
  if (signal?.aborted) return Promise.reject(aborted());
  if (typeof Worker === "undefined") return runInline(toolId, inputs, parameters, options);
  let worker: Worker;
  try {
    worker = spawnWorker();
  } catch {
    return runInline(toolId, inputs, parameters, options);
  }
  return new Promise<ClientToolResult>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      worker.terminate();
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => settle(() => reject(aborted()));
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.addEventListener("message", (event: MessageEvent<RasterToolWorkerMessage>) => {
      const data = event.data;
      if (data.type === "progress") {
        if (!settled) onProgress?.(data.progress);
        return;
      }
      if (data.type === "result") settle(() => resolve(data.result));
      else settle(() => reject(workerError(data.name, data.message)));
    });
    worker.addEventListener("error", (event) =>
      settle(() => reject(new Error(event.message || "The raster tool worker failed."))),
    );
    worker.addEventListener("messageerror", () =>
      settle(() => reject(new Error("The raster tool worker posted an unreadable message."))),
    );
    const request: RasterToolWorkerRequest = { toolId, inputs, parameters };
    try {
      worker.postMessage(request, requestTransferables(request));
    } catch {
      // Something in the inputs cannot be cloned; nothing was transferred, so
      // run on this thread instead.
      settle(() => {
        runInline(toolId, inputs, parameters, options).then(resolve, reject);
      });
    }
  });
}
