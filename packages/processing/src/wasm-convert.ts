// In-browser format conversion backed by the `geolibre-wasm/tools` WASI runner
// (the same ~18 MB binary wasm-client.ts and raster-subset.ts use, loaded
// lazily and shared once downloaded). These wrap three GeoLibre-authored tools:
//
//   - `vector_convert`    — any vector format -> any vector format (driver picked
//                           from the output extension). Used for the formats the
//                           pure-JS writers in vector-exporter.ts cannot produce,
//                           notably FlatGeobuf.
//   - `write_pmtiles`     — render a *raster* into a Web Mercator PNG tile
//                           pyramid packed as a single PMTiles archive.
//   - `vector_to_pmtiles` — pack a *vector* layer into a single PMTiles archive
//                           of Mapbox Vector Tiles (geolibre-wasm 0.8.0+).
//
// All three run entirely client-side, so the web build needs no Python sidecar
// for them.
import type { RunToolOptions, ToolResult } from "geolibre-wasm/tools";
import type { WasmToolRequest, WasmToolResponse } from "./wasm-convert.worker";

/** The subset of `geolibre-wasm/tools` these converters use. */
interface ConvertToolsModule {
  initTools: (source?: URL | Response | BufferSource | string) => Promise<WebAssembly.Module>;
  runTool: (tool: string, opts?: RunToolOptions) => Promise<ToolResult>;
}

let toolsModulePromise: Promise<ConvertToolsModule> | null = null;

/**
 * Lazily import the WASI tool runner once. Mirrors {@link loadSubsetModule} in
 * raster-subset.ts: the memoized promise is reset on failure so a transient
 * error (e.g. a network blip during the chunk download) retries on the next
 * call instead of staying permanently rejected for the session.
 */
function loadToolsModule(): Promise<ConvertToolsModule> {
  toolsModulePromise ??= (
    import("geolibre-wasm/tools") as unknown as Promise<ConvertToolsModule>
  ).catch((error) => {
    toolsModulePromise = null;
    throw error;
  });
  return toolsModulePromise;
}

/**
 * Compile the WASI runner ahead of the first conversion. Optional in the browser
 * and in bundlers, where the runner resolves its own bundled `.wasm` asset on
 * demand; hosts without that resolution (node, tests) pass the wasm bytes.
 *
 * The source must be handed to *this* module rather than to a separately
 * imported copy of `geolibre-wasm/tools`: the compiled module is cached in the
 * tool runner's own module scope, and a second instance of it would not see it.
 * Mirrors {@link initCogWasm} in cog-convert.ts.
 *
 * @param source - Optional wasm bytes / URL / Response for non-browser hosts.
 */
export async function initConvertTools(
  source?: URL | Response | BufferSource | string,
): Promise<void> {
  const { initTools } = await loadToolsModule();
  await initTools(source);
}

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
    const worker = new Worker(new URL("./wasm-convert.worker.ts", import.meta.url), {
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
    // neutered input array would be a trap the sibling converters don't set.
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
 * (node, tests). The inline path is why {@link initConvertTools} still takes an
 * explicit wasm source: a worker resolves its own bundled copy instead.
 */
async function runToolInBackground(request: WasmToolRequest): Promise<ToolResult> {
  if (typeof Worker === "undefined") {
    const { runTool } = await loadToolsModule();
    return runTool(request.tool, { args: request.args, input: request.input });
  }
  return runToolOnWorker(request);
}

/** An input file for a WASM conversion: its name (the extension drives format
 * detection) and its raw bytes. */
export interface WasmConvertFile {
  name: string;
  data: Uint8Array;
}

/** A finished WASM conversion: the output bytes plus the tool's log lines, which
 * the Conversion dialog renders in the same log pane as sidecar jobs. */
export interface WasmConvertResult {
  data: Uint8Array;
  messages: string[];
}

/**
 * The tools report failures as an exit code plus a human-readable trailing
 * stdout line (e.g. `validation error: unsupported output path: ...`) rather
 * than by throwing, so surface that line instead of a bare "exit 1".
 */
function assertToolSucceeded(tool: string, result: ToolResult): void {
  if (result.exitCode === 0) return;
  const detail = [...result.stdout]
    .reverse()
    .find((line) => /error|unsupported|unknown|invalid/i.test(line));
  throw new Error(detail?.trim() || `${tool} failed with exit code ${result.exitCode}.`);
}

/**
 * Append a `--name=value` argument for every flag that is set. An `undefined`
 * value is left off entirely, which is what lets callers say "leave it to the
 * tool" rather than having this module restate the tool's own defaults.
 */
function appendFlags(args: string[], flags: Array<[string, number | string | undefined]>): void {
  for (const [name, value] of flags) {
    if (value !== undefined) args.push(`--${name}=${value}`);
  }
}

/** Pull the single expected output out of a tool's virtual /work filesystem. */
function requireOutput(tool: string, result: ToolResult, outputName: string): Uint8Array {
  const data = result.files[outputName];
  if (!data) {
    throw new Error(`${tool} produced no ${outputName} output.`);
  }
  return data;
}

/**
 * Convert a vector dataset to another vector format entirely in the browser.
 * The output driver is chosen by `outputName`'s extension (`.fgb`, `.gpkg`,
 * `.shp`, `.geojson`, `.parquet`, ...).
 *
 * Multi-file datasets (a Shapefile's `.dbf`/`.shx`/`.prj`) are supported by
 * passing the companions as `siblings`; they are placed alongside the main file
 * in the tool's virtual filesystem so the driver can find them.
 *
 * @param input - The main input file (name + bytes).
 * @param outputName - Output file name; its extension selects the driver.
 * @param siblings - Companion files for multi-file formats.
 * @returns The converted bytes and the tool's log lines.
 */
export async function convertVectorWithWasm(
  input: WasmConvertFile,
  outputName: string,
  siblings: WasmConvertFile[] = [],
): Promise<WasmConvertResult> {
  const { runTool } = await loadToolsModule();
  const files: Record<string, Uint8Array> = { [input.name]: input.data };
  for (const sibling of siblings) files[sibling.name] = sibling.data;
  const result = await runTool("vector_convert", {
    args: [`--input=/work/${input.name}`, `--output=/work/${outputName}`],
    input: files,
  });
  assertToolSucceeded("vector_convert", result);
  return {
    data: requireOutput("vector_convert", result, outputName),
    messages: result.stdout,
  };
}

/** Colormaps `write_pmtiles` can render a single band with. */
export const PMTILES_COLORMAPS = ["viridis", "magma", "turbo", "terrain", "grayscale"] as const;

export type PmtilesColormap = (typeof PMTILES_COLORMAPS)[number];

/** Resampling methods `write_pmtiles` can build the pyramid with. */
export const PMTILES_RESAMPLING_METHODS = ["bilinear", "nearest", "cubic"] as const;

export type PmtilesResamplingMethod = (typeof PMTILES_RESAMPLING_METHODS)[number];

export interface RasterToPmtilesOptions {
  /** Minimum zoom. Defaults to a single native zoom matching the resolution. */
  minZoom?: number;
  /** Maximum zoom. Defaults to `minZoom`. */
  maxZoom?: number;
  /** 1-based band to render. Defaults to 1. */
  band?: number;
  /** Colormap for the rendered tiles. Defaults to `"viridis"`. */
  colormap?: PmtilesColormap;
  /** Resampling method. Defaults to `"bilinear"`. */
  method?: PmtilesResamplingMethod;
  /** Value mapped to the low end of the colormap. Defaults to the band minimum. */
  min?: number;
  /** Value mapped to the high end of the colormap. Defaults to the band maximum. */
  max?: number;
}

/**
 * Render a raster into a single PMTiles archive (a Web Mercator PNG tile
 * pyramid) in the browser. The input must carry a source CRS; the tool
 * reprojects to EPSG:3857 itself.
 *
 * Every option is optional — omitted flags let the tool pick its own defaults
 * (native zoom, band 1, viridis, bilinear, band min/max stretch) rather than
 * having this wrapper hard-code a second set.
 *
 * @param input - The input raster file (name + bytes).
 * @param outputName - Output archive name, e.g. `dem.pmtiles`.
 * @param options - Zoom range, band, colormap, resampling, and value stretch.
 * @returns The PMTiles bytes and the tool's log lines.
 */
export async function renderRasterToPmtiles(
  input: WasmConvertFile,
  outputName: string,
  options: RasterToPmtilesOptions = {},
): Promise<WasmConvertResult> {
  const { runTool } = await loadToolsModule();
  const args = [`--input=/work/${input.name}`, `--output=/work/${outputName}`];
  appendFlags(args, [
    ["min_zoom", options.minZoom],
    ["max_zoom", options.maxZoom],
    ["band", options.band],
    ["colormap", options.colormap],
    ["method", options.method],
    ["min", options.min],
    ["max", options.max],
  ]);
  const result = await runTool("write_pmtiles", {
    args,
    input: { [input.name]: input.data },
  });
  assertToolSucceeded("write_pmtiles", result);
  return {
    data: requireOutput("write_pmtiles", result, outputName),
    messages: result.stdout,
  };
}

/**
 * The deepest zoom `vector_to_pmtiles` accepts; past it the tool exits with
 * `validation error: max_zoom must be <= 18`.
 *
 * This is *lower* than the 24 the sidecar's freestiler allows, so the two
 * engines behind Vector to PMTiles do not share a cap and callers have to
 * validate against whichever one they are about to run.
 */
export const MAX_VECTOR_PMTILES_ZOOM = 18;

// `vector_to_pmtiles` also takes --simplify and --drop_rate. They are left out
// until something asks for them: the tool ignores an unrecognized flag or value
// silently (--simplify=0 and --simplify=banana both produce the byte-identical
// default output), so an option here can only be trusted once a caller and a
// test pin its effect down.
export interface VectorToPmtilesOptions {
  /** Minimum zoom. Defaults to 0. */
  minZoom?: number;
  /** Maximum zoom. Defaults to 14; {@link MAX_VECTOR_PMTILES_ZOOM} is the ceiling. */
  maxZoom?: number;
  /** Layer name inside the tiles, used when styling. Defaults to the input layer's name. */
  layerName?: string;
}

/**
 * Pack a vector dataset into a single PMTiles archive of Mapbox Vector Tiles in
 * the browser — the client-side counterpart to the sidecar's freestiler.
 *
 * Reads whatever `vector_convert` reads (GeoJSON, Shapefile, GeoPackage,
 * FlatGeobuf, GeoParquet, ...), so multi-file datasets pass their companions as
 * `siblings`, exactly as in {@link convertVectorWithWasm}.
 *
 * Unlike its siblings here this runs on a Web Worker (see
 * {@link runToolInBackground}). Tiling is by far the heaviest of these tools —
 * a US-wide layer to the default zoom 14 is millions of tiles and minutes of
 * uninterrupted WASM — so running it on the main thread would freeze the UI for
 * the whole conversion. The others finish quickly enough not to warrant the
 * worker's separate ~18 MB wasm compile, but they can adopt this if that
 * changes.
 *
 * @param input - The main input file (name + bytes).
 * @param outputName - Output archive name, e.g. `roads.pmtiles`.
 * @param options - Zoom range and layer name.
 * @param siblings - Companion files for multi-file formats.
 * @returns The PMTiles bytes and the tool's log lines.
 */
export async function tileVectorToPmtiles(
  input: WasmConvertFile,
  outputName: string,
  options: VectorToPmtilesOptions = {},
  siblings: WasmConvertFile[] = [],
): Promise<WasmConvertResult> {
  const args = [`--input=/work/${input.name}`, `--output=/work/${outputName}`];
  appendFlags(args, [
    ["min_zoom", options.minZoom],
    ["max_zoom", options.maxZoom],
    ["layer_name", options.layerName],
  ]);
  const files: Record<string, Uint8Array> = { [input.name]: input.data };
  for (const sibling of siblings) files[sibling.name] = sibling.data;
  const result = await runToolInBackground({
    tool: "vector_to_pmtiles",
    args,
    input: files,
  });
  assertToolSucceeded("vector_to_pmtiles", result);
  return {
    data: requireOutput("vector_to_pmtiles", result, outputName),
    messages: result.stdout,
  };
}
