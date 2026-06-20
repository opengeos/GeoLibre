// Run the OSS geospatial tools entirely in the browser via WebAssembly - a
// drop-in alternative to the Python sidecar. `geolibre-wasm/tools` is a superset
// of `whitebox-wasm/tools`: the same `wbtools_oss` engine (compiled to a WASI
// binary) plus GeoLibre-authored tools, run through an in-memory WASI
// filesystem, so no server, no Python, and no native install is required. Same
// algorithms and outputs as the sidecar; bounded by WASM's ~4 GiB memory and
// single-threaded execution (use the sidecar for very large data).
import type { FeatureCollection } from "geojson";
import type { RunWhiteboxToolRequest, WhiteboxJob, WhiteboxToolParameter } from "./sidecar-client";

interface ToolRunResult {
  exitCode: number;
  stdout: string[];
  files: Record<string, Uint8Array>;
}

interface ToolsModule {
  listTools: () => Promise<string[]>;
  runTool: (
    tool: string,
    opts: { args?: string[]; input?: Record<string, Uint8Array> },
  ) => Promise<ToolRunResult>;
}

let toolsModulePromise: Promise<ToolsModule> | null = null;

function loadToolsModule(): Promise<ToolsModule> {
  // Lazy import: the ~5 MB (gzipped) WASI runtime only downloads on first use.
  // Reset the memoized promise on failure (e.g. a transient network error) so
  // the next call retries instead of being stuck with a permanently rejected
  // promise for the rest of the session.
  toolsModulePromise ??= (
    import("geolibre-wasm/tools") as unknown as Promise<ToolsModule>
  ).catch((error) => {
    toolsModulePromise = null;
    throw error;
  });
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

function datasetParameterKind(dataKind: string, suffix: "in" | "out"): string {
  return ["raster", "vector", "lidar", "file"].includes(dataKind)
    ? `${dataKind}_${suffix}`
    : `file_${suffix}`;
}

// Mirror ProcessingDialog's parameterKind: prefer an explicit `kind`, otherwise
// resolve it from the parameter schema (`schema.dataset.kind` + `io_role`).
// Without the schema branch, tools that express their kind only through the
// schema would have their raster/vector/lidar inputs misrouted as scalars.
function paramKind(p: WhiteboxToolParameter): string {
  if (p.kind) return String(p.kind).toLowerCase();
  const schema =
    p.schema && typeof p.schema === "object"
      ? (p.schema as Record<string, unknown>)
      : {};
  const dataset =
    schema.dataset && typeof schema.dataset === "object"
      ? (schema.dataset as Record<string, unknown>)
      : {};
  const dataKind = String(
    p.data_kind ?? dataset.kind ?? p.type ?? "",
  ).toLowerCase();
  const role = String(p.io_role ?? schema.kind ?? "").toLowerCase();
  if (role === "input") return datasetParameterKind(dataKind, "in");
  if (role === "output") return datasetParameterKind(dataKind, "out");
  return dataKind;
}

function isFeatureCollection(value: unknown): value is FeatureCollection {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { type?: unknown }).type === "FeatureCollection",
  );
}

// TIFF magic: "II" (little-endian) or "MM" (big-endian) followed by the version
// number in the byte-order's own endianness - 42 (0x2a) for classic TIFF or 43
// (0x2b) for BigTIFF (rasters larger than 4 GiB).
function isTiff(b: Uint8Array): boolean {
  if (b.length < 4) return false;
  const le = b[0] === 0x49 && b[1] === 0x49;
  const be = b[0] === 0x4d && b[1] === 0x4d;
  if (!le && !be) return false;
  const magic = le ? b[2] : b[3];
  return magic === 0x2a || magic === 0x2b;
}

// LAS/LAZ magic: every LAS and LAZ file begins with the signature "LASF".
function isLas(b: Uint8Array): boolean {
  return (
    b.length >= 4 &&
    b[0] === 0x4c &&
    b[1] === 0x41 &&
    b[2] === 0x53 &&
    b[3] === 0x46
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
    } else if (
      kind === "raster_in" ||
      kind === "lidar_in" ||
      kind === "file_in"
    ) {
      // Prefer bytes the caller resolved (the dialog fetches the layer's data);
      // otherwise try to fetch the parameter as a URL.
      const bytes =
        request.layer_inputs?.[name]?.bytes ??
        (await fetchBytes(request.parameters[name]));
      if (!bytes) {
        throw new Error(
          `Could not read input "${name}" in the browser. Its data is not fetchable here (only available via the sidecar); turn off "Run locally (WASM)" to use the sidecar.`,
        );
      }
      if (kind === "raster_in" && !isTiff(bytes)) {
        throw new Error(
          `Input "${name}" is not a readable GeoTIFF in the browser (received ${describeBytes(bytes)}). Load the raster as a COG/GeoTIFF, or use the sidecar.`,
        );
      }
      if (kind === "lidar_in" && !isLas(bytes)) {
        throw new Error(
          `Input "${name}" is not a readable LAS/LAZ file in the browser (received ${describeBytes(bytes)}). Load a LAS/LAZ file, or use the sidecar.`,
        );
      }
      const ext =
        kind === "lidar_in" ? "las" : kind === "file_in" ? "dat" : "tif";
      const file = `${name}.${ext}`;
      input[file] = bytes;
      args.push(`--${name}=/work/${file}`);
    } else if (kind === "vector_out") {
      const file = `${name}.geojson`;
      outputs.push({ name, file, raster: false });
      args.push(`--${name}=/work/${file}`);
    } else if (kind === "raster_out" || kind === "file_out") {
      // file_out is treated as an opaque binary output (no GeoJSON parsing),
      // mirroring how raster outputs are returned as raw bytes.
      const ext = kind === "file_out" ? "dat" : "tif";
      const file = `${name}.${ext}`;
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
    if (entry.raster) {
      out[entry.name] = bytes;
      continue;
    }
    // Skip a vector output that is not a valid FeatureCollection - malformed
    // JSON (e.g. a tool that crashed mid-write) or valid JSON of the wrong
    // shape - rather than letting one bad file reject the whole job and lose
    // every other output. Matches the sidecar path's tolerant handling.
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (isFeatureCollection(parsed)) out[entry.name] = parsed;
    } catch {
      // leave this output out
    }
  }
  return job(request.tool_id, "succeeded", stdout, out, null);
}
