// In-browser format conversion backed by the `geolibre-wasm/tools` WASI runner
// (the same ~18 MB binary wasm-client.ts and raster-subset.ts use, loaded
// lazily and shared once downloaded). These wrap two GeoLibre-authored tools:
//
//   - `vector_convert`  — any vector format -> any vector format (driver picked
//                         from the output extension). Used for the formats the
//                         pure-JS writers in vector-exporter.ts cannot produce,
//                         notably FlatGeobuf.
//   - `write_pmtiles`   — render a *raster* into a Web Mercator PNG tile pyramid
//                         packed as a single PMTiles archive.
//
// Both run entirely client-side, so the web build no longer needs the Python
// sidecar for them. Note `write_pmtiles` is raster-only: there is no vector
// tiler in geolibre-wasm, so Vector to PMTiles remains sidecar-backed
// (freestiler) and desktop-only.
import type { RunToolOptions, ToolResult } from "geolibre-wasm/tools";

/** The subset of `geolibre-wasm/tools` these converters use. */
interface ConvertToolsModule {
  initTools: (
    source?: URL | Response | BufferSource | string,
  ) => Promise<WebAssembly.Module>;
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
  throw new Error(
    detail?.trim() || `${tool} failed with exit code ${result.exitCode}.`,
  );
}

/** Pull the single expected output out of a tool's virtual /work filesystem. */
function requireOutput(
  tool: string,
  result: ToolResult,
  outputName: string,
): Uint8Array {
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
export const PMTILES_COLORMAPS = [
  "viridis",
  "magma",
  "turbo",
  "terrain",
  "grayscale",
] as const;

export type PmtilesColormap = (typeof PMTILES_COLORMAPS)[number];

/** Resampling methods `write_pmtiles` can build the pyramid with. */
export const PMTILES_RESAMPLING_METHODS = [
  "bilinear",
  "nearest",
  "cubic",
] as const;

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
  const flags: Array<[string, number | string | undefined]> = [
    ["min_zoom", options.minZoom],
    ["max_zoom", options.maxZoom],
    ["band", options.band],
    ["colormap", options.colormap],
    ["method", options.method],
    ["min", options.min],
    ["max", options.max],
  ];
  for (const [name, value] of flags) {
    if (value !== undefined) args.push(`--${name}=${value}`);
  }
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
