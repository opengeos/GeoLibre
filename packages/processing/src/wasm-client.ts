// Run the OSS geospatial tools entirely in the browser via WebAssembly - a
// drop-in alternative to the Python sidecar. `geolibre-wasm/tools` is a superset
// of `whitebox-wasm/tools`: the same `wbtools_oss` engine (compiled to a WASI
// binary) plus GeoLibre-authored tools, run through an in-memory WASI
// filesystem, so no server, no Python, and no native install is required. Same
// algorithms and outputs as the sidecar; bounded by WASM's ~4 GiB memory and
// single-threaded execution (use the sidecar for very large data).
import type { FeatureCollection } from "geojson";
import { normalizeVectorOutputFormat } from "./sidecar-client";
import type {
  RunWhiteboxToolRequest,
  VectorOutputFormat,
  WhiteboxJob,
  WhiteboxTool,
  WhiteboxToolParameter,
} from "./sidecar-client";

/**
 * File extension the WASM tool writes for each CRS-preserving vector output
 * format. Selecting one of these (instead of the default GeoJSON) keeps the
 * tool's target-CRS coordinates, which the GeoJSON writer would otherwise
 * reproject back to WGS84 for RFC 7946 compliance.
 */
const VECTOR_OUTPUT_EXTENSION: Record<Exclude<VectorOutputFormat, "geojson">, string> = {
  geoparquet: "parquet",
  flatgeobuf: "fgb",
  shapefile: "shp",
};

/**
 * Bundle a Shapefile the WASM tool wrote (`.shp` plus its `.shx`/`.dbf`/`.prj`/
 * `.cpg` sidecars) into a single zip, since a Shapefile is inherently multi-file.
 * Returns `null` when any of the core members (`.shp`/`.shx`/`.dbf`) is missing:
 * most GIS clients reject a Shapefile that lacks them, so an incomplete bundle
 * is treated like a failed/partial write rather than shipped as a valid output.
 *
 * @param shpFile - The `.shp` filename in the WASM output map.
 * @param files - Every file the tool wrote, keyed by name.
 * @returns The zip bytes, or `null` if the core `.shp`/`.shx`/`.dbf` are incomplete.
 */
async function zipShapefileSidecars(
  shpFile: string,
  files: Record<string, Uint8Array>,
): Promise<Uint8Array | null> {
  const base = shpFile.replace(/\.shp$/i, "");
  const required = ["shp", "shx", "dbf"] as const;
  const members: Record<string, Uint8Array> = {};
  for (const ext of [...required, "prj", "cpg"]) {
    const member = files[`${base}.${ext}`];
    if (member) members[`${base}.${ext}`] = member;
  }
  if (required.some((ext) => !members[`${base}.${ext}`])) return null;
  const { zipSync } = await import("fflate");
  return zipSync(members);
}

interface ToolRunResult {
  exitCode: number;
  stdout: string[];
  files: Record<string, Uint8Array>;
}

/** One tool's manifest as emitted by `geolibre manifests` (geolibre-wasm). */
interface ToolManifest {
  id: string;
  display_name?: string;
  summary?: string;
  category?: string;
  license_tier?: string;
  /** "geolibre" for GeoLibre-authored tools, "whitebox" otherwise. */
  source?: string;
  params?: Array<{
    name: string;
    description?: string;
    required?: boolean;
    io_role?: string;
    data_kind?: string;
    schema?: {
      kind?: string;
      options?: Array<{ value?: unknown }>;
      [key: string]: unknown;
    };
  }>;
}

interface ToolsModule {
  listTools: () => Promise<string[]>;
  listManifests: () => Promise<ToolManifest[]>;
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
  toolsModulePromise ??= (import("geolibre-wasm/tools") as unknown as Promise<ToolsModule>).catch(
    (error) => {
      toolsModulePromise = null;
      throw error;
    },
  );
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

/**
 * Map one WASM tool manifest to the {@link WhiteboxTool} shape the Processing
 * toolbox renders. Each manifest param already carries `io_role`/`data_kind`/
 * `schema`, which the dialog's `parameterKind` reads directly; we additionally
 * flatten an enum schema's choices to `options` so the param renders as a
 * dropdown. `source` is preserved only for GeoLibre-authored tools, matching how
 * the Whitebox catalog snapshot leaves Whitebox tools' `source` unset.
 */
function manifestToWhiteboxTool(manifest: ToolManifest): WhiteboxTool {
  return {
    id: manifest.id,
    display_name: manifest.display_name,
    summary: manifest.summary,
    category: manifest.category,
    license_tier: manifest.license_tier,
    source: manifest.source?.toLowerCase() === "geolibre" ? "geolibre" : undefined,
    params: (manifest.params ?? []).map((param) => {
      const mapped: WhiteboxToolParameter = {
        name: param.name,
        description: param.description,
        required: param.required,
        io_role: param.io_role,
        data_kind: param.data_kind,
        schema: param.schema,
      };
      if (param.schema?.kind === "enum" && Array.isArray(param.schema.options)) {
        // Coerce to strings (not filter to strings): an enum with numeric or
        // boolean values would otherwise drop to an empty list and render as a
        // plain text input instead of a dropdown.
        mapped.options = param.schema.options
          .map((option) => option?.value)
          .filter((value) => value != null)
          .map(String);
      }
      return mapped;
    }),
  };
}

/**
 * Every WASM tool manifest mapped to {@link WhiteboxTool}. In local (WASM) mode
 * the binary is the source of truth for parameter names and shapes, which can
 * diverge from the Python sidecar's catalog for the same tool id (e.g.
 * `reproject_vector` takes `epsg`, not the catalog's `dst_epsg`). Use
 * {@link mergeWasmToolManifests} to reconcile these against the catalog.
 */
export async function listWasmToolManifests(): Promise<WhiteboxTool[]> {
  const { listManifests } = await loadToolsModule();
  const manifests = await listManifests();
  return manifests.map(manifestToWhiteboxTool);
}

/**
 * Reconcile the Whitebox catalog snapshot with the WASM binary's own manifests
 * for local (WASM) mode. The catalog supplies the tool list, display names, and
 * categories; the WASM manifest is authoritative for each tool's parameters,
 * because the binary can expose a different parameter set than the Python
 * sidecar (e.g. `reproject_vector` validates `epsg`, whereas the catalog names
 * the parameter `dst_epsg`, causing a "parameter 'epsg' is required" failure).
 *
 * Every catalog tool that the WASM binary also implements keeps its catalog
 * metadata but takes the manifest's parameters; the GeoLibre-authored tools that
 * never appear in the catalog are appended.
 *
 * @param catalogTools - Tools from the Whitebox catalog snapshot.
 * @param wasmTools - Every WASM tool manifest ({@link listWasmToolManifests}).
 * @returns Catalog tools with WASM parameters, plus WASM-only GeoLibre tools.
 */
/** Scalar catalog kinds trusted to correct a mislabeled WASM manifest param. */
const CATALOG_SCALAR_KINDS = new Set(["string", "int", "double"]);

/**
 * Whether the catalog's kind should override the WASM manifest's for a param
 * they both declare (matched by name). The WASM binary's manifest occasionally
 * mislabels a free-form scalar parameter: `extract_by_attribute`'s `statement`
 * expression is typed `bool` (rendering a checkbox) and `field_calculator`'s
 * `expression` is typed as a vector input (rendering a second layer picker),
 * so neither exposes a text field to type the expression (GeoLibre#1073). When
 * the Python sidecar's catalog types the same-named param as a plain scalar
 * (string/int/double) but the WASM manifest makes it a `bool` (any name) or a
 * dataset **input** whose *name* marks it as a free-text expression, we trust
 * the catalog so the dialog renders (and the runner serializes) a text input.
 *
 * The scope is deliberately tight:
 * - A `bool` mislabel is always safe to correct (no dataset is involved), which
 *   covers `extract_by_attribute.statement`.
 * - A dataset **input** is only downgraded when its name is `expression`/
 *   `statement` (mirroring the upstream wbcore `looks_like_expression` fix),
 *   which covers `field_calculator.expression` without downgrading a genuine
 *   raster/vector/lidar input that the catalog merely mistyped as a scalar.
 * - Outputs are never touched: diverting a real dataset output into the
 *   plain-arg path would break its run.
 *
 * Enums/dropdowns and already-matching kinds are left untouched.
 *
 * @param param - The WASM manifest param (its name gates the input case).
 * @param wasmKind - The kind derived from the WASM manifest param.
 * @param catalogKind - The kind the catalog declares for the same-named param.
 * @returns `true` when the catalog kind should replace the WASM kind.
 */
function shouldPreferCatalogKind(
  param: WhiteboxToolParameter,
  wasmKind: string,
  catalogKind: string | undefined,
): boolean {
  if (!catalogKind || catalogKind === wasmKind) return false;
  if (!CATALOG_SCALAR_KINDS.has(catalogKind)) return false;
  if (wasmKind === "bool") return true;
  return wasmKind.endsWith("_in") && /\b(expression|statement)\b/i.test(param.name);
}

/**
 * Reconcile one tool's WASM manifest params against the catalog's. The WASM
 * params win (names and set), but a same-named catalog param corrects a WASM
 * kind that mislabels a scalar as a dataset/bool (see {@link shouldPreferCatalogKind}).
 */
function reconcileToolParams(
  catalogParams: WhiteboxToolParameter[] | undefined,
  wasmParams: WhiteboxToolParameter[] | undefined,
): WhiteboxToolParameter[] {
  const catalogByName = new Map((catalogParams ?? []).map((param) => [param.name, param] as const));
  return (wasmParams ?? []).map((param) => {
    const catalogParam = catalogByName.get(param.name);
    if (!catalogParam) return param;
    const catalogKind = paramKind(catalogParam);
    if (shouldPreferCatalogKind(param, paramKind(param), catalogKind)) {
      return { ...param, kind: catalogKind as WhiteboxToolParameter["kind"] };
    }
    return param;
  });
}

export function mergeWasmToolManifests(
  catalogTools: WhiteboxTool[],
  wasmTools: WhiteboxTool[],
): WhiteboxTool[] {
  const wasmById = new Map(wasmTools.map((tool) => [tool.id, tool] as const));
  const merged = catalogTools.map((tool) => {
    const wasm = wasmById.get(tool.id);
    if (!wasm) return tool;
    // Consume the match so a WASM-only-appended tool (below) can never duplicate
    // a catalog tool's id.
    wasmById.delete(tool.id);
    // The WASM binary is authoritative for the parameters (even an empty set)
    // and for the tool's provenance; keep only the catalog's display metadata
    // (name, category, …). Preserving `source` matters so a GeoLibre-authored
    // tool that also has a catalog stub keeps its "geolibre" marker for the
    // source filter. A same-named catalog param still corrects a WASM kind that
    // mislabels a scalar expression as a dataset/bool (GeoLibre#1073).
    return {
      ...tool,
      params: reconcileToolParams(tool.params, wasm.params),
      source: wasm.source ?? tool.source,
    };
  });
  const geolibreOnly = [...wasmById.values()].filter((tool) => tool.source === "geolibre");
  return [...merged, ...geolibreOnly];
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
    p.schema && typeof p.schema === "object" ? (p.schema as Record<string, unknown>) : {};
  const dataset =
    schema.dataset && typeof schema.dataset === "object"
      ? (schema.dataset as Record<string, unknown>)
      : {};
  const dataKind = String(
    p.data_kind ?? schema.data_kind ?? dataset.kind ?? p.type ?? "",
  ).toLowerCase();
  const role = String(p.io_role ?? schema.kind ?? "").toLowerCase();
  if (role === "input") return datasetParameterKind(dataKind, "in");
  if (role === "output") return datasetParameterKind(dataKind, "out");
  return dataKind;
}

/**
 * Extension (without the dot) the WASM runner should give a `file_out` file so
 * the tool's own format check passes. Whitebox tools infer a table/report
 * format from the output path's extension, so we honor the extension of the
 * user-chosen output path; when none is present we sniff the intended text
 * format from the parameter's name/description (e.g. an "Output JSON report
 * path."), default a `table` output to CSV, and fall back to an opaque `.dat`.
 *
 * @param param - The output parameter (carries `data_kind`/`schema`).
 * @param requested - The user-chosen output path, if any.
 * @returns A lowercase extension without a leading dot (e.g. `csv`, `json`, `dat`).
 */
export function fileOutputTargetExtension(
  param: WhiteboxToolParameter,
  requested: unknown,
): string {
  if (typeof requested === "string") {
    const match = requested.match(/\.([A-Za-z0-9]+)$/);
    if (match) return match[1].toLowerCase();
  }
  return outputTextFormatHint(param) ?? "dat";
}

/**
 * The text/tabular output format a `file_out` parameter declares through its
 * name, description, or `table` data kind, as a bare extension (`csv`/`html`/
 * `json`), or `null` when nothing recognizable is found. Shared by the WASM
 * runner's {@link fileOutputTargetExtension} and the dialog's default-name and
 * download-naming code so the two hint lists cannot drift apart.
 *
 * @param param - The output parameter.
 * @returns `"csv" | "html" | "json"`, or `null` if no text format is implied.
 */
export function outputTextFormatHint(param: WhiteboxToolParameter): string | null {
  const hint = `${param.name ?? ""} ${param.description ?? ""} ${param.type ?? ""}`;
  if (/\bcsv\b/i.test(hint)) return "csv";
  if (/\bhtml\b/i.test(hint)) return "html";
  if (/\bjson\b/i.test(hint)) return "json";
  const schema =
    param.schema && typeof param.schema === "object"
      ? (param.schema as Record<string, unknown>)
      : {};
  const dataset =
    schema.dataset && typeof schema.dataset === "object"
      ? (schema.dataset as Record<string, unknown>)
      : {};
  const dataKind = String(param.data_kind ?? dataset.kind ?? param.type ?? "").toLowerCase();
  return dataKind === "table" ? "csv" : null;
}

function isFeatureCollection(value: unknown): value is FeatureCollection {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === "FeatureCollection",
  );
}

/**
 * Whether bytes start with the TIFF signature: "II" (little-endian) or "MM"
 * (big-endian) followed by the version number in the byte order's own
 * endianness -- 42 (0x2a) for classic TIFF or 43 (0x2b) for BigTIFF (rasters
 * larger than 4 GiB). A cheap header-only sniff used to reject non-GeoTIFF
 * content (e.g. an HTML error or login page served with a 200) before handing
 * the bytes to the wasm reader.
 *
 * @param b - The candidate file bytes (only the first four are inspected).
 * @returns `true` if the bytes look like a TIFF/BigTIFF.
 */
export function isTiff(b: Uint8Array): boolean {
  if (b.length < 4) return false;
  const le = b[0] === 0x49 && b[1] === 0x49;
  const be = b[0] === 0x4d && b[1] === 0x4d;
  if (!le && !be) return false;
  const magic = le ? b[2] : b[3];
  return magic === 0x2a || magic === 0x2b;
}

// LAS/LAZ magic: every LAS and LAZ file begins with the signature "LASF".
function isLas(b: Uint8Array): boolean {
  return b.length >= 4 && b[0] === 0x4c && b[1] === 0x41 && b[2] === 0x53 && b[3] === 0x46;
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
 * Descriptive base name for an output file, e.g. `fill_depressions_output`
 * instead of a generic `output`. Keeps each tool's outputs distinct in the
 * in-memory `/work` filesystem (and in the path the tool echoes to stdout) so
 * running several tools does not reuse `/work/output.tif`.
 *
 * Combines the tool id with the output parameter name so the filename humanizes
 * to the same words as the imported layer (e.g. `<tool>_output` ->
 * "<Tool> Output"), keeping the panel path and the layer name consistent.
 *
 * @param toolId - The tool being run (already filesystem-safe snake_case).
 * @param paramName - The output parameter name.
 * @returns A sanitized base name without extension.
 */
export function outputBaseName(toolId: string, paramName: string): string {
  const safe = (text: string) => text.replace(/[^A-Za-z0-9_-]+/g, "_");
  return `${safe(toolId)}_${safe(paramName)}`;
}

/**
 * GeoLibre-authored subset extractors whose single result COG is written to a
 * plain-string `output` path (no typed `raster_out` param). Their produced file
 * is surfaced explicitly after the run; see the fallback in
 * {@link runWhiteboxToolWasm}.
 */
const SUBSET_OUTPUT_TOOL_IDS = new Set([
  "extract_cog_subset",
  "extract_wms_subset",
  "extract_xyz_tile_subset",
]);

/**
 * Run a Whitebox tool in the browser via WASM. Mirrors `runWhiteboxTool` but
 * executes locally and returns an already-completed {@link WhiteboxJob}. Output
 * values are inline: a `FeatureCollection` for `vector_out`, or a `Uint8Array`
 * (Cloud Optimized GeoTIFF) for `raster_out` - never a server path.
 */
export async function runWhiteboxToolWasm(request: RunWhiteboxToolRequest): Promise<WhiteboxJob> {
  const { runTool } = await loadToolsModule();
  const encoder = new TextEncoder();
  const input: Record<string, Uint8Array> = {};
  const args: string[] = [];
  // How each output file is turned into a job output: "geojson" is parsed into a
  // FeatureCollection (a map layer); "bytes" is returned raw (a raster COG, a
  // file_out blob, or a CRS-preserving vector file to download); "shapefile" is
  // zipped with its sidecars first.
  const outputs: {
    name: string;
    file: string;
    kind: "geojson" | "bytes" | "shapefile";
  }[] = [];
  // Defensive: validate the requested format so a bad value (e.g. a stale
  // output path from switching sidecar/WASM modes) degrades to GeoJSON instead
  // of indexing VECTOR_OUTPUT_EXTENSION to `undefined` and writing a
  // `..._output.undefined` file the tool can't format. One format applies to
  // every `vector_out` param; no current tool exposes more than one.
  const vectorFormat: VectorOutputFormat = normalizeVectorOutputFormat(
    request.vector_output_format,
  );

  for (const param of request.tool?.params ?? []) {
    const kind = paramKind(param);
    const name = param.name;

    if (kind === "vector_in") {
      const geojson = request.layer_inputs?.[name]?.geojson;
      if (!geojson) throw new Error(`Missing vector input for "${name}"`);
      const file = `${name}.geojson`;
      input[file] = encoder.encode(JSON.stringify(geojson));
      args.push(`--${name}=/work/${file}`);
    } else if (kind === "raster_in" || kind === "lidar_in" || kind === "file_in") {
      // Prefer bytes the caller resolved (the dialog fetches the layer's data);
      // otherwise try to fetch the parameter as a URL.
      const provided = request.parameters[name];
      const hasValue = typeof provided === "string" ? provided.length > 0 : provided != null;
      const bytes =
        request.layer_inputs?.[name]?.bytes ?? (hasValue ? await fetchBytes(provided) : null);
      if (!bytes) {
        // An optional data input the user left blank is simply omitted rather
        // than force-fetched: e.g. extract_cog_subset's `input` when a `url` is
        // supplied instead (the tool reads the COG by byte-range from that url).
        // Only a required input, or one with a value that could not be fetched,
        // is a hard error.
        if (!param.required && !hasValue) continue;
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
      const ext = kind === "lidar_in" ? "las" : kind === "file_in" ? "dat" : "tif";
      const file = `${name}.${ext}`;
      input[file] = bytes;
      args.push(`--${name}=/work/${file}`);
    } else if (kind === "vector_out") {
      const base = outputBaseName(request.tool_id, name);
      // GeoJSON is reprojected to WGS84 on write (a map layer); the other formats
      // keep the tool's target CRS and are returned as bytes to download.
      if (vectorFormat === "geojson") {
        const file = `${base}.geojson`;
        outputs.push({ name, file, kind: "geojson" });
        args.push(`--${name}=/work/${file}`);
      } else {
        const file = `${base}.${VECTOR_OUTPUT_EXTENSION[vectorFormat]}`;
        outputs.push({
          name,
          file,
          kind: vectorFormat === "shapefile" ? "shapefile" : "bytes",
        });
        args.push(`--${name}=/work/${file}`);
      }
    } else if (kind === "raster_out" || kind === "file_out") {
      // raster_out is always a GeoTIFF. file_out is an opaque output whose
      // format the tool infers from the output *extension* (e.g.
      // vector_summary_statistics rejects any output path that isn't ".csv").
      // Honor the extension of the user-chosen output path; fall back to CSV for
      // a tabular output, else an opaque ".dat". Hardcoding ".dat" here made
      // every such tool fail its own ".csv path" validation regardless of what
      // the user typed (see GeoLibre#1074).
      const ext =
        kind === "file_out" ? fileOutputTargetExtension(param, request.parameters[name]) : "tif";
      const file = `${outputBaseName(request.tool_id, name)}.${ext}`;
      outputs.push({ name, file, kind: "bytes" });
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
    if (entry.kind === "shapefile") {
      const zipped = await zipShapefileSidecars(entry.file, files);
      if (zipped) {
        out[entry.name] = zipped;
      } else {
        // The tool reported success but the Shapefile is incomplete (a core
        // .shp/.shx/.dbf member is missing). Note it in the job messages so the
        // user isn't left with a silently empty output.
        stdout.push(
          `Warning: "${entry.name}" produced an incomplete Shapefile (missing .shp/.shx/.dbf); no output written.`,
        );
      }
      continue;
    }
    const bytes = files[entry.file];
    if (!bytes) continue;
    if (entry.kind === "bytes") {
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
  // The GeoLibre COG/WMS/XYZ subset extractors type their `output` as a plain
  // string path (not a `raster_out`), so the loop above maps nothing. Surface
  // their single produced result COG as raw bytes so it still reaches the map
  // instead of being silently dropped. Scoped to those tool ids (not "any tool
  // with no typed output") so an unrelated tool's scratch/sidecar/log file is
  // never mistaken for a result and pushed through the raster loader.
  if (outputs.length === 0 && SUBSET_OUTPUT_TOOL_IDS.has(request.tool_id)) {
    for (const [file, bytes] of Object.entries(files)) {
      // Skip files we supplied as inputs (e.g. a local `input` raster written to
      // /work before the run) so an unchanged input isn't re-added as a spurious
      // second layer alongside the real result.
      if (file in input) continue;
      out[file.replace(/\.[^.]+$/, "")] = bytes;
    }
  }
  return job(request.tool_id, "succeeded", stdout, out, null);
}
