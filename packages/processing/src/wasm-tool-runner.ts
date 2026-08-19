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

/**
 * Run a tool on a one-shot Web Worker and resolve with its result.
 *
 * No timeout: how long a tool runs is bounded by the data, not the clock (a
 * country-scale tile pyramid is minutes), and cutting off work that would have
 * finished is worse than waiting. `error`/`messageerror` still reject, so the
 * promise settles on every failure the worker can report.
 */
function runToolOnWorker(request: WasmToolRequest): Promise<ToolResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./wasm-tool.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.addEventListener("message", (event: MessageEvent<WasmToolResponse>) => {
      worker.terminate();
      if (event.data.ok) resolve(event.data.result);
      else reject(new Error(event.data.error || `${request.tool} failed.`));
    });
    worker.addEventListener("error", (event) => {
      worker.terminate();
      reject(new Error(event.message || `The ${request.tool} worker failed.`));
    });
    // `error` does not fire when a posted message cannot be deserialized, which
    // would otherwise leave this promise pending forever.
    worker.addEventListener("messageerror", () => {
      worker.terminate();
      reject(new Error(`The ${request.tool} worker posted an undeserializable message.`));
    });
    // The input files are structured-cloned rather than transferred: these
    // wrappers do not otherwise take ownership of the caller's bytes, and a
    // neutered input array would be a trap the callers don't set.
    try {
      worker.postMessage(request);
    } catch (error) {
      // A throw here (e.g. DataCloneError) rejects the promise on its own, but
      // the worker is already spawned and would leak without this.
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
