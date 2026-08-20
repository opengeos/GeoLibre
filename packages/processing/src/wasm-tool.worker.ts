/// <reference lib="webworker" />
import { runTool } from "geolibre-wasm/tools";
import type { ToolResult } from "geolibre-wasm/tools";

// Runs `geolibre-wasm/tools` WASI tools off the main thread. The runner has no
// yield points once a tool starts, so on the main thread a long job freezes the
// whole UI for its duration — tiling a country-scale vector layer to zoom 14 is
// minutes of that, and dissolving 290 polygons by an attribute is ~60s, which is
// why wasm-convert.ts and wasm-client.ts both route through wasm-tool-runner.ts.
//
// One run at a time, but reusable across runs: the caller parks this worker for
// its next call instead of terminating it, so the ~23 MB `geolibre-cli.wasm`
// compile in this worker's module scope is paid once rather than per run. Each
// run still gets a fresh WASI instance and a fresh /work from `runTool`, so
// nothing carries over between them.
const worker = self as unknown as DedicatedWorkerGlobalScope;

/** A tool to run: its id, CLI args, and the files to place under /work. */
export interface WasmToolRequest {
  tool: string;
  args: string[];
  input: Record<string, Uint8Array>;
}

/**
 * What this worker posts back: an immediate `ack` on receipt, then one terminal
 * message when the tool finishes.
 *
 * The ack is what lets the caller tell a live parked worker from one that died
 * while idle. Nothing here can report that: a worker killed out of band fires
 * no `error` event, and posting to it silently does nothing, so without an ack
 * a reused-but-dead worker would leave the run pending forever.
 */
export type WasmToolResponse =
  | { ok: "ack" }
  | { ok: true; result: ToolResult }
  | { ok: false; error: string };

worker.addEventListener("message", async (event: MessageEvent<WasmToolRequest>) => {
  const { tool, args, input } = event.data;
  // Before the run, so it lands even though the WASI call that follows blocks
  // this worker's thread until the tool is done.
  worker.postMessage({ ok: "ack" } satisfies WasmToolResponse);
  try {
    // runTool compiles the bundled geolibre-cli.wasm on first use, in this
    // worker's own module scope — a copy already compiled on the main thread
    // is not shared with it.
    const result = await runTool(tool, { args, input });
    worker.postMessage({ ok: true, result } satisfies WasmToolResponse);
  } catch (error) {
    // A tool that merely exits non-zero resolves normally and is reported by
    // the caller; reaching here means the runner itself threw.
    worker.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    } satisfies WasmToolResponse);
  }
});
