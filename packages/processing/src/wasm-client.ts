// Run WhiteboxTools entirely in the browser via WebAssembly - a drop-in
// alternative to the Python sidecar for the OSS tool set. `whitebox-wasm/tools`
// executes the same `wbtools_oss` engine (compiled to a WASI binary) through an
// in-memory WASI filesystem, so no server, no Python, and no native install is
// required. Same algorithms and outputs as the sidecar; bounded by WASM's ~4 GiB
// memory and single-threaded execution (use the sidecar for very large data).
import type { FeatureCollection } from "geojson";
import type { RunWhiteboxToolRequest, WhiteboxJob, WhiteboxToolParameter } from "./sidecar-client";

interface ToolRunResult {
  exitCode: number;
  stdout: string[];
  files: Record<string, Uint8Array>;
}

interface ToolsModule {
  initTools: (source?: unknown) => Promise<unknown>;
  listTools: () => Promise<string[]>;
  runTool: (
    tool: string,
    opts: { args?: string[]; input?: Record<string, Uint8Array> },
  ) => Promise<ToolRunResult>;
}

let toolsModulePromise: Promise<ToolsModule> | null = null;

function loadToolsModule(): Promise<ToolsModule> {
  // Lazy import: the ~5 MB (gzipped) WASI runtime only downloads on first use.
  toolsModulePromise ??= import("whitebox-wasm/tools") as unknown as Promise<ToolsModule>;
  return toolsModulePromise;
}

/** Whether the in-browser WASM tool runner can be loaded in this build. */
export async function whiteboxWasmAvailable(): Promise<boolean> {
  try {
    await loadToolsModule();
    return true;
  } catch {
    return false;
  }
}

/** List every tool id available in the WASM runner (733 of them). */
export async function listWhiteboxWasmTools(): Promise<string[]> {
  const { listTools } = await loadToolsModule();
  return listTools();
}

function paramKind(p: WhiteboxToolParameter): string {
  return String(p.kind ?? p.data_kind ?? p.io_role ?? p.type ?? "").toLowerCase();
}

function isFeatureCollection(value: unknown): value is FeatureCollection {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { type?: unknown }).type === "FeatureCollection",
  );
}

/** TIFF magic: "II*\0" (little-endian) or "MM\0*" (big-endian). */
function isTiff(b: Uint8Array): boolean {
  return (
    b.length >= 4 &&
    ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) ||
      (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a))
  );
}

function describeBytes(b: Uint8Array): string {
  const head = String.fromCharCode(...b.slice(0, 14));
  if (/^\s*<(!doctype|html|\?xml)/i.test(head)) return "an HTML/XML page";
  return `bytes starting with [${Array.from(b.slice(0, 4))
    .map((n) => n.toString(16).padStart(2, "0"))
    .join(" ")}]`;
}

async function fetchBytes(source: unknown): Promise<Uint8Array | null> {
  if (typeof source !== "string" || source.length === 0) return null;
  try {
    const res = await fetch(source);
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  }
}

function job(
  toolId: string,
  status: WhiteboxJob["status"],
  messages: string[],
  outputs: Record<string, unknown>,
  error: string | null,
): WhiteboxJob {
  const ts = new Date().toISOString();
  return {
    id: `wasm-${Date.now().toString(36)}`,
    status,
    tool_id: toolId,
    created_at: ts,
    updated_at: ts,
    messages,
    outputs,
    result: null,
    error,
  };
}

/**
 * Run a Whitebox tool in the browser via WASM. Mirrors `runWhiteboxTool` but
 * executes locally and returns an already-completed {@link WhiteboxJob}. Output
 * values are inline: a `FeatureCollection` for `vector_out`, or a `Uint8Array`
 * (Cloud Optimized GeoTIFF) for `raster_out` - never a server path.
 */
export async function runWhiteboxToolWasm(
  request: RunWhiteboxToolRequest,
): Promise<WhiteboxJob> {
  const { runTool } = await loadToolsModule();
  const encoder = new TextEncoder();
  const input: Record<string, Uint8Array> = {};
  const args: string[] = [];
  const outputs: { name: string; file: string; raster: boolean }[] = [];

  for (const param of request.tool?.params ?? []) {
    const kind = paramKind(param);
    const name = param.name;

    if (kind === "vector_in") {
      const geojson = request.layer_inputs?.[name]?.geojson;
      if (!geojson) throw new Error(`Missing vector input for "${name}"`);
      const file = `${name}.geojson`;
      input[file] = encoder.encode(JSON.stringify(geojson));
      args.push(`--${name}=/work/${file}`);
    } else if (kind === "raster_in" || kind === "lidar_in") {
      // Prefer bytes the caller resolved (the dialog fetches the layer's data);
      // otherwise try to fetch the parameter as a URL.
      const bytes =
        request.layer_inputs?.[name]?.bytes ??
        (await fetchBytes(request.parameters[name]));
      if (!bytes) {
        throw new Error(
          `Could not read raster/LiDAR input "${name}" in the browser. Its data is not fetchable here (only available via the sidecar); turn off "Run locally (WASM)" to use the sidecar.`,
        );
      }
      if (kind === "raster_in" && !isTiff(bytes)) {
        throw new Error(
          `Input "${name}" is not a readable GeoTIFF in the browser (received ${describeBytes(bytes)}). Load the raster as a COG/GeoTIFF, or use the sidecar.`,
        );
      }
      const ext = kind === "lidar_in" ? "las" : "tif";
      const file = `${name}.${ext}`;
      input[file] = bytes;
      args.push(`--${name}=/work/${file}`);
    } else if (kind === "vector_out") {
      const file = `${name}.geojson`;
      outputs.push({ name, file, raster: false });
      args.push(`--${name}=/work/${file}`);
    } else if (kind === "raster_out") {
      const file = `${name}.tif`;
      outputs.push({ name, file, raster: true });
      args.push(`--${name}=/work/${file}`);
    } else {
      const value = request.parameters[name];
      if (value !== undefined && value !== null && value !== "") {
        args.push(`--${name}=${value}`);
      }
    }
  }

  const { exitCode, stdout, files } = await runTool(request.tool_id, { args, input });
  if (exitCode !== 0) {
    return job(
      request.tool_id,
      "failed",
      stdout,
      {},
      stdout.join("\n") || `Tool exited with code ${exitCode}`,
    );
  }

  const out: Record<string, unknown> = {};
  for (const entry of outputs) {
    const bytes = files[entry.file];
    if (!bytes) continue;
    out[entry.name] = entry.raster
      ? bytes
      : (JSON.parse(new TextDecoder().decode(bytes)) as FeatureCollection);
  }
  return job(request.tool_id, "succeeded", stdout, out, null);
}

export { isFeatureCollection as isWhiteboxFeatureCollection };

// Dev-only hook so end-to-end tests can drive the WASM runner directly in a real
// browser without clicking through the UI. Tree-shaken out of production builds.
if (
  typeof window !== "undefined" &&
  typeof import.meta !== "undefined" &&
  (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV
) {
  (window as unknown as Record<string, unknown>).__geolibreWhiteboxWasm = {
    runWhiteboxToolWasm,
    listWhiteboxWasmTools,
    whiteboxWasmAvailable,
  };
}
