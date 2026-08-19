/// <reference lib="webworker" />
import { runTool } from "geolibre-wasm/tools";
import type { ToolResult } from "geolibre-wasm/tools";

// Runs one `geolibre-wasm/tools` WASI tool off the main thread. The runner has
// no yield points once a tool starts, so on the main thread a long job freezes
// the whole UI for its duration — tiling a country-scale vector layer to zoom 14
// is minutes of that, which is why wasm-convert.ts routes it here.
//
// One tool per worker: the caller terminates this worker as soon as the terminal
// message arrives, so nothing here has to be reusable across runs.
const worker = self as unknown as DedicatedWorkerGlobalScope;

/** A tool to run: its id, CLI args, and the files to place under /work. */
export interface WasmToolRequest {
  tool: string;
  args: string[];
  input: Record<string, Uint8Array>;
}

/** The single message this worker posts back. */
export type WasmToolResponse = { ok: true; result: ToolResult } | { ok: false; error: string };

worker.addEventListener("message", async (event: MessageEvent<WasmToolRequest>) => {
  const { tool, args, input } = event.data;
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
