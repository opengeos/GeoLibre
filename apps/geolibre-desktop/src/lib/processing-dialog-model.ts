import { fileOutputTargetExtension } from "@geolibre/processing/output-format";
import type { GeoLibreLayer } from "@geolibre/core";
import {
  normalizeVectorOutputFormat,
  type VectorOutputFormat,
  type WhiteboxJob,
  type WhiteboxLayerInput,
  type WhiteboxTool,
  type WhiteboxToolParameter,
} from "@geolibre/processing/parameters";
import type { FeatureCollection } from "geojson";
import type { TFunction } from "i18next";
import { DOWNLOAD_GLOBAL_DEM_TOOL_ID } from "./global-dem-id";
import {
  LAYER_TOKEN_PREFIX,
  createDefaultValues,
  fileOutputExtension,
  isDataInputParameter,
  isFeatureCollection,
  isFieldParameter,
  isJsonOutputPath,
  isOutputParameter,
  outputPath,
  toolLabel,
  type ParameterValues,
} from "./processing-params";
import { translateWhiteboxCategory } from "./processing-tool-i18n";
import {
  degreesToUnit,
  formatDistanceValue,
  parseDistanceInput,
  unitToDegrees,
  type DistanceUnit,
} from "./whitebox-distance-params";
import { fieldSourceInputName } from "./whitebox-field-params";
import { layerPath } from "./whitebox-layer-inputs";
import { isMultipleDatasetParameter, parameterKind } from "./whitebox-param-kind";

/**
 * Controller and view-model logic for the Whitebox Processing dialog
 * (`components/processing/ProcessingDialog.tsx`): picking and filtering tools,
 * deriving form options from the loaded layers, validating the form and
 * resolving it into a run request, and mapping load/run outcomes to messages.
 * Pure apart from the injected callbacks, with no React, store, i18n runtime or
 * Tauri dependency, so it is unit-tested directly in
 * `tests/processing-dialog-model.test.ts`. The lower-level parameter helpers
 * live in `processing-params.ts`.
 */

/** Job statuses that mean a sidecar job is still in flight and must be polled. */
export const RUNNING_JOB_STATUSES: ReadonlySet<string> = new Set(["pending", "running"]);

/** A layer's `[west, south, east, north]` extent, or null when it has none. */
export type LayerBounds = [number, number, number, number] | null;

/** A file the user browsed from disk in the web build, keyed by parameter. */
export interface BrowsedInput {
  name: string;
  bytes: Uint8Array;
  /** Set when the file parsed as a GeoJSON FeatureCollection. */
  geojson?: FeatureCollection;
}

/** Tool counts per provenance, for the source filter ("All", "geolibre", "whitebox"). */
export interface ToolSourceCounts {
  all: number;
  geolibre: number;
  whitebox: number;
}

/** One entry of the category filter's option list. */
export interface CategoryOption {
  value: string;
  label: string;
}

/**
 * Whether a job is still pending or running.
 *
 * @param job - The current job, or null.
 * @returns True while the job needs polling.
 */
export function isJobRunning(job: WhiteboxJob | null): boolean {
  return Boolean(job && RUNNING_JOB_STATUSES.has(job.status));
}

/**
 * The tool to show for a selected id, falling back to the first tool, with any
 * Python varargs (`*args`/`**kwargs`) parameters dropped. Some upstream tools
 * expose those as unusable inputs; the bundled catalog strips them, but the
 * live sidecar catalog may not.
 *
 * @param tools - The loaded catalog.
 * @param selectedToolId - The id the user picked (may be stale or empty).
 * @returns The selected tool, or null for an empty catalog.
 */
export function resolveSelectedTool(
  tools: WhiteboxTool[],
  selectedToolId: string,
): WhiteboxTool | null {
  const tool = tools.find((item) => item.id === selectedToolId) ?? tools[0] ?? null;
  if (!tool?.params?.some((param) => param.name?.startsWith("*"))) return tool;
  return {
    ...tool,
    params: tool.params.filter((param) => !param.name?.startsWith("*")),
  };
}

/**
 * Keep the current selection when the new catalog still has it, else select the
 * catalog's first tool (or nothing).
 *
 * @param tools - The newly loaded catalog.
 * @param current - The currently selected tool id.
 * @returns The tool id to select.
 */
export function keepOrFirstToolId(tools: WhiteboxTool[], current: string): string {
  return tools.some((tool) => tool.id === current) ? current : (tools[0]?.id ?? "");
}

/**
 * Attribute-field names per GeoJSON layer. GeoJSON is schemaless, so only the
 * first `sample` features are scanned rather than a whole large layer.
 *
 * @param layers - The project's layers.
 * @param sample - How many features to scan per layer.
 * @returns Field names keyed by layer id; layers with no fields are omitted.
 */
export function collectLayerFieldNames(
  layers: readonly GeoLibreLayer[],
  sample = 1000,
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const layer of layers) {
    if (!layer.geojson) continue;
    const keys = new Set<string>();
    for (const feature of layer.geojson.features.slice(0, sample)) {
      for (const key of Object.keys(feature.properties ?? {})) keys.add(key);
    }
    if (keys.size) map.set(layer.id, [...keys]);
  }
  return map;
}

/**
 * The latitude a distance parameter's metric entry converts at: the middle of
 * the combined extent of the layers the tool reads. A layer with no in-memory
 * GeoJSON makes the units unknowable (null); an extentless layer (an attribute
 * table) is skipped.
 *
 * @param layerIds - Ids of the layers wired to the tool's vector inputs.
 * @param layers - The project's layers.
 * @param boundsOf - Measures (or returns a cached) extent for a layer.
 * @returns The midpoint latitude, or null when there is none.
 */
export function combinedMidLatitude(
  layerIds: readonly string[],
  layers: readonly GeoLibreLayer[],
  boundsOf: (layer: GeoLibreLayer & { geojson: FeatureCollection }) => LayerBounds,
): number | null {
  let south = Number.POSITIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  for (const id of layerIds) {
    const layer = layers.find((item) => item.id === id);
    if (!layer?.geojson) return null;
    const bounds = boundsOf(layer as GeoLibreLayer & { geojson: FeatureCollection });
    if (!bounds) continue;
    south = Math.min(south, bounds[1]);
    north = Math.max(north, bounds[3]);
  }
  return Number.isFinite(south) ? (south + north) / 2 : null;
}

/**
 * Column names to offer for a `*_field` parameter (GeoLibre#1459): those of the
 * layer picked for the vector input the parameter names. With one vector input
 * that is unambiguous; with several, an unmatched name falls back to the union
 * of every selected input's columns. Empty when the input is a path rather than
 * a loaded layer.
 *
 * @param param - The parameter being rendered.
 * @param vectorInputParams - The tool's `vector_in` parameters.
 * @param values - The current form values.
 * @param fieldsByLayer - Field names keyed by layer id.
 * @returns The column names to offer.
 */
export function fieldOptionsForParameter(
  param: WhiteboxToolParameter,
  vectorInputParams: readonly WhiteboxToolParameter[],
  values: ParameterValues,
  fieldsByLayer: ReadonlyMap<string, string[]>,
): string[] {
  if (!vectorInputParams.length || !isFieldParameter(param)) return [];
  const columnsOf = (input: WhiteboxToolParameter): string[] => {
    const value = values[input.name];
    if (typeof value !== "string" || !value.startsWith(LAYER_TOKEN_PREFIX)) return [];
    return fieldsByLayer.get(value.slice(LAYER_TOKEN_PREFIX.length)) ?? [];
  };
  const sourceName =
    vectorInputParams.length === 1
      ? vectorInputParams[0].name
      : fieldSourceInputName(
          param.name,
          vectorInputParams.map((input) => input.name),
        );
  const source = vectorInputParams.find((input) => input.name === sourceName);
  if (source) return columnsOf(source);
  return [...new Set(vectorInputParams.flatMap(columnsOf))];
}

/**
 * The parameters a share link carries: those changed from the tool's defaults,
 * minus local file paths (`*_in`/`*_out`), which are machine-specific.
 *
 * @param tool - The selected tool.
 * @param values - The current form values.
 * @returns Changed, non-blank parameter values as strings.
 */
export function shareLinkParameters(
  tool: WhiteboxTool,
  values: ParameterValues,
): Record<string, string> {
  const defaults = createDefaultValues(tool);
  const asString = (value: unknown) =>
    typeof value === "string" ? value : value == null ? "" : String(value);
  const parameters: Record<string, string> = {};
  for (const param of tool.params ?? []) {
    const name = param.name;
    if (!name) continue;
    const kind = parameterKind(param);
    if (kind.endsWith("_in") || kind.endsWith("_out")) continue;
    const value = asString(values[name]);
    if (!value.trim() || value === asString(defaults[name])) continue;
    parameters[name] = value;
  }
  return parameters;
}

/**
 * Whether a tool passes the source filter. The filter is ignored when no
 * GeoLibre tools are present, so a stale "geolibre" choice cannot empty the list.
 *
 * @param tool - The tool to test.
 * @param source - "All", "geolibre" or "whitebox".
 * @param hasGeolibreTools - Whether the catalog has any GeoLibre-authored tool.
 * @returns True when the tool should be listed.
 */
export function matchesToolSource(
  tool: WhiteboxTool,
  source: string,
  hasGeolibreTools: boolean,
): boolean {
  if (source === "All" || !hasGeolibreTools) return true;
  return (tool.source === "geolibre" ? "geolibre" : "whitebox") === source;
}

/**
 * Total tool count per source, for the source-filter labels.
 *
 * @param tools - The loaded catalog.
 * @returns Counts for all, GeoLibre and Whitebox tools.
 */
export function countToolSources(tools: readonly WhiteboxTool[]): ToolSourceCounts {
  const geolibre = tools.filter((tool) => tool.source === "geolibre").length;
  return { all: tools.length, geolibre, whitebox: tools.length - geolibre };
}

/**
 * Category filter options, each labelled with its tool count within the active
 * source filter (e.g. "Conversion (37)"), sorted by translated name.
 *
 * @param tools - The loaded catalog.
 * @param matchesSource - The active source filter.
 * @param t - The i18n translate function.
 * @param language - The UI language, for locale-aware sorting.
 * @returns The "All" option followed by one option per category.
 */
export function buildCategoryOptions(
  tools: readonly WhiteboxTool[],
  matchesSource: (tool: WhiteboxTool) => boolean,
  t: TFunction,
  language: string,
): CategoryOption[] {
  const counts = new Map<string, number>();
  let total = 0;
  for (const tool of tools) {
    if (!matchesSource(tool)) continue;
    total += 1;
    const value = tool.category ?? "";
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) =>
    translateWhiteboxCategory(t, a[0] || undefined).localeCompare(
      translateWhiteboxCategory(t, b[0] || undefined),
      language,
    ),
  );
  return [
    { value: "All", label: t("processing.whitebox.categoryAll", { total }) },
    ...sorted.map(([name, count]) => ({
      value: name,
      label: `${translateWhiteboxCategory(t, name || undefined)} (${count})`,
    })),
  ];
}

/**
 * Tools allowed by the category and source filters, before the search text.
 *
 * @param tools - The loaded catalog.
 * @param category - The chosen category, or "All".
 * @param matchesSource - The active source filter.
 * @returns The tools in scope.
 */
export function scopeTools(
  tools: readonly WhiteboxTool[],
  category: string,
  matchesSource: (tool: WhiteboxTool) => boolean,
): WhiteboxTool[] {
  return tools.filter(
    (tool) => (category === "All" || (tool.category ?? "") === category) && matchesSource(tool),
  );
}

/**
 * The text a tool is searched by. `identifiers` holds only the tool's own names,
 * which exact/prefix ranking measures; categories stay out of it because they
 * are shared by dozens of tools.
 *
 * @param t - The i18n translate function.
 * @param tool - The tool to index.
 * @returns The searchable name, identifiers and summary.
 */
export function toolSearchFields(
  t: TFunction,
  tool: WhiteboxTool,
): { name: string; identifiers: string[]; summary: string } {
  return {
    name: [
      tool.id,
      toolLabel(t, tool),
      tool.category ?? "",
      translateWhiteboxCategory(t, tool.category),
    ].join(" "),
    identifiers: [tool.id, toolLabel(t, tool)],
    summary: tool.summary || "",
  };
}

/**
 * Resolve semantic-search hits against the scoped tools, in ranked order.
 *
 * @param scopedTools - The tools in scope.
 * @param matches - The semantic hits, or null/undefined when there are none.
 * @returns The matched tools; unknown ids are dropped.
 */
export function semanticMatchTools(
  scopedTools: readonly WhiteboxTool[],
  matches: readonly { id: string }[] | null | undefined,
): WhiteboxTool[] {
  if (!matches?.length) return [];
  const byId = new Map(scopedTools.map((tool) => [tool.id, tool]));
  return matches
    .map((match) => byId.get(match.id))
    .filter((tool): tool is WhiteboxTool => tool !== undefined);
}

/**
 * The substring hits the ranked semantic group does not already show, so no
 * tool is listed twice under two headings.
 *
 * @param filteredTools - The substring-search hits.
 * @param semanticTools - The ranked semantic hits.
 * @returns The remaining keyword hits.
 */
export function keywordOnlyTools(
  filteredTools: WhiteboxTool[],
  semanticTools: readonly WhiteboxTool[],
): WhiteboxTool[] {
  if (semanticTools.length === 0) return filteredTools;
  const ranked = new Set(semanticTools.map((tool) => tool.id));
  return filteredTools.filter((tool) => !ranked.has(tool.id));
}

/**
 * The error to show after a local (WASM) catalog load. A WASM manifest failure
 * wins (without it every tool keeps the catalog's parameter names and fails on
 * run), then a catalog fetch failure, then an empty catalog.
 *
 * @param outcome - What the two concurrent loads produced.
 * @param t - The i18n translate function.
 * @returns The message to show, or null when the load is clean.
 */
export function localCatalogLoadError(
  outcome: {
    wasmError: unknown;
    catalogError: unknown;
    catalogEmpty: boolean;
    toolCount: number;
  },
  t: TFunction,
): string | null {
  if (outcome.wasmError) return t("processing.whitebox.localRunnerError");
  if (outcome.catalogError) {
    return outcome.catalogError instanceof Error
      ? outcome.catalogError.message
      : t("processing.whitebox.catalogSnapshotError");
  }
  if (outcome.catalogEmpty || outcome.toolCount === 0) {
    return t("processing.whitebox.catalogSnapshotError");
  }
  return null;
}

/**
 * The status line under the toolbox title.
 *
 * @param t - The i18n translate function.
 * @param runtimeAvailable - Sidecar availability, or null while still checking.
 * @param runtimeMessage - The runtime's own message, if any.
 * @param toolCount - How many tools are loaded.
 * @returns The text to show.
 */
export function runtimeStatusText(
  t: TFunction,
  runtimeAvailable: boolean | null,
  runtimeMessage: string,
  toolCount: number,
): string {
  if (runtimeAvailable === null) return t("processing.whitebox.checkingRuntime");
  if (runtimeAvailable) {
    return runtimeMessage || t("processing.whitebox.toolsAvailable", { count: toolCount });
  }
  return runtimeMessage || t("processing.whitebox.runtimeUnavailable");
}

/**
 * Whether the Run button is disabled. The global DEM download runs in the
 * browser regardless of mode; other tools need either local mode or a live
 * sidecar.
 *
 * @param state - The selected tool and runtime state.
 * @returns True when a run cannot start.
 */
export function isRunDisabled(state: {
  tool: WhiteboxTool | null;
  running: boolean;
  runLocal: boolean;
  runtimeAvailable: boolean | null;
}): boolean {
  const { tool, running, runLocal, runtimeAvailable } = state;
  return (
    !tool ||
    Boolean(tool.locked) ||
    running ||
    (tool.id !== DOWNLOAD_GLOBAL_DEM_TOOL_ID && !runLocal && runtimeAvailable !== true)
  );
}

/**
 * Companion fields a subset-URL populate resets to their defaults first, so a
 * previous layer's optional values cannot linger.
 *
 * @param kind - The subset tool kind ("wms", "xyz", "cog", or null).
 * @param defaults - The tool's default values.
 * @returns The companion fields to reset.
 */
export function subsetCompanionReset(
  kind: string | null,
  defaults: ParameterValues,
): ParameterValues {
  return kind === "wms"
    ? { styles: defaults.styles }
    : kind === "xyz"
      ? { tile_size: defaults.tile_size, subdomains: defaults.subdomains }
      : {};
}

/**
 * Reset any `vector_out` parameter that holds an output-format string (a WASM
 * mode value) to its default, for when WASM mode is turned off and the field
 * becomes a free-text sidecar output path.
 *
 * @param tool - The selected tool.
 * @param values - The current form values.
 * @returns A new values object.
 */
export function resetVectorOutputFormats(
  tool: WhiteboxTool,
  values: ParameterValues,
): ParameterValues {
  const defaults = createDefaultValues(tool);
  const next = { ...values };
  for (const param of tool.params ?? []) {
    const current = values[param.name];
    if (
      parameterKind(param) === "vector_out" &&
      typeof current === "string" &&
      normalizeVectorOutputFormat(current) === current
    ) {
      next[param.name] = defaults[param.name];
    }
  }
  return next;
}

/**
 * Wrap a browsed file, parsing a `.geojson`/`.json` file up front so vector
 * tools receive a FeatureCollection. Anything else stays raw bytes.
 *
 * @param fileName - The picked file's name.
 * @param bytes - Its contents.
 * @returns The browsed input.
 */
export function parseBrowsedInput(fileName: string, bytes: Uint8Array): BrowsedInput {
  let geojson: FeatureCollection | undefined;
  if (/\.(geojson|json)$/i.test(fileName)) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(bytes));
      if (isFeatureCollection(parsed)) geojson = parsed;
    } catch {
      // Not valid JSON; fall back to raw bytes.
    }
  }
  return { name: fileName, bytes, geojson };
}

/**
 * Whether a required input parameter is empty. Output parameters are exempt:
 * an empty one gets an automatic name.
 *
 * @param param - The parameter.
 * @param value - Its form value.
 * @returns True when the run must stop for a missing value.
 */
export function isMissingRequiredValue(param: WhiteboxToolParameter, value: unknown): boolean {
  return Boolean(
    param.required &&
    !isOutputParameter(param) &&
    (value === undefined ||
      value === null ||
      value === "" ||
      (Array.isArray(value) && value.length === 0)),
  );
}

/** The resolved request inputs, or the message explaining why a run cannot start. */
export type RunInputsResult =
  | {
      ok: true;
      parameters: Record<string, unknown>;
      layerInputs: Record<string, WhiteboxLayerInput | WhiteboxLayerInput[]>;
    }
  | { ok: false; error: string };

/** Everything `resolveRunInputs` reads. */
export interface ResolveRunInputsOptions {
  tool: WhiteboxTool;
  values: ParameterValues;
  layers: readonly GeoLibreLayer[];
  browsedInputs: ReadonlyMap<string, BrowsedInput[]>;
  runLocal: boolean;
  t: TFunction;
  /** The translated label of a parameter, for error messages. */
  parameterLabel: (param: WhiteboxToolParameter) => string;
  /** Fetches a layer's bytes in the browser, or null when not fetchable. */
  fetchLayerBytes: (layer: GeoLibreLayer) => Promise<Uint8Array | null>;
}

/**
 * Validate the form and resolve it into a run request's `parameters` and
 * `layer_inputs`. Browsed files become byte/GeoJSON inputs; `layer:` tokens
 * become GeoJSON, fetched bytes (local raster/LiDAR), or layer paths; anything
 * else passes through as typed.
 *
 * @param options - The tool, form state, layers and injected helpers.
 * @returns The resolved inputs, or the first validation error.
 */
export async function resolveRunInputs(options: ResolveRunInputsOptions): Promise<RunInputsResult> {
  const { tool, values, layers, browsedInputs, runLocal, t, parameterLabel, fetchLayerBytes } =
    options;
  const parameters: Record<string, unknown> = {};
  const layerInputs: Record<string, WhiteboxLayerInput | WhiteboxLayerInput[]> = {};

  for (const param of tool.params ?? []) {
    const parameterLabelText = parameterLabel(param);
    const value = values[param.name];
    if (isMissingRequiredValue(param, value)) {
      return {
        ok: false,
        error: t("processing.whitebox.missingRequiredParameter", {
          label: parameterLabelText,
        }),
      };
    }

    // A file browsed from disk in the web build: feed its bytes (or parsed
    // GeoJSON) straight to the WASM runner instead of an unresolvable path.
    const browsed = browsedInputs.get(param.name);
    if (browsed?.length && isDataInputParameter(param)) {
      const kind = parameterKind(param);
      if (!runLocal && browsed.some((input) => !input.geojson)) {
        return {
          ok: false,
          error: t("processing.whitebox.sidecarCannotReadBrowserFiles", {
            label: parameterLabelText,
          }),
        };
      }
      const inputs = browsed.map((input) =>
        input.geojson
          ? { name: input.name, kind, geojson: input.geojson }
          : { name: input.name, kind, bytes: input.bytes },
      );
      layerInputs[param.name] = inputs.length === 1 ? inputs[0] : inputs;
      continue;
    }

    if (isMultipleDatasetParameter(param) && Array.isArray(value)) {
      const selectedLayers = value
        .filter(
          (item): item is string => typeof item === "string" && item.startsWith(LAYER_TOKEN_PREFIX),
        )
        .map((item) => layers.find((layer) => layer.id === item.slice(LAYER_TOKEN_PREFIX.length)))
        .filter((layer): layer is GeoLibreLayer => Boolean(layer));
      if (selectedLayers.length !== value.length) {
        return {
          ok: false,
          error: t("processing.whitebox.selectedLayersMissing", {
            label: parameterLabelText,
          }),
        };
      }
      const kind = parameterKind(param);
      if (runLocal && kind === "vector_in") {
        const missing = selectedLayers.find((layer) => !layer.geojson);
        if (missing) {
          return {
            ok: false,
            error: t("processing.whitebox.layerMissingGeoJson", {
              layer: missing.name,
              label: parameterLabelText,
            }),
          };
        }
        layerInputs[param.name] = selectedLayers.map((layer) => ({
          name: layer.name,
          kind,
          geojson: layer.geojson,
        }));
      } else if (runLocal) {
        const inputs: WhiteboxLayerInput[] = [];
        for (const layer of selectedLayers) {
          const bytes = await fetchLayerBytes(layer);
          if (!bytes) {
            return {
              ok: false,
              error: t("processing.whitebox.layerNotFetchable", {
                layer: layer.name,
                label: parameterLabelText,
              }),
            };
          }
          inputs.push({ name: layer.name, kind, bytes });
        }
        layerInputs[param.name] = inputs;
      } else if (kind === "vector_in" && selectedLayers.every((layer) => layer.geojson)) {
        layerInputs[param.name] = selectedLayers.map((layer) => ({
          name: layer.name,
          kind,
          geojson: layer.geojson,
        }));
      } else {
        // Whitebox list arguments use comma-delimited paths. The browser
        // runner builds the same form after staging each selected dataset.
        const paths = selectedLayers.map(layerPath);
        const missingIndex = paths.findIndex((path) => !path);
        if (missingIndex >= 0) {
          return {
            ok: false,
            error: t("processing.whitebox.layerMissingPath", {
              layer: selectedLayers[missingIndex].name,
              label: parameterLabelText,
            }),
          };
        }
        parameters[param.name] = paths.join(",");
      }
    } else if (typeof value === "string" && value.startsWith(LAYER_TOKEN_PREFIX)) {
      const layerId = value.slice(LAYER_TOKEN_PREFIX.length);
      const layer = layers.find((item) => item.id === layerId);
      if (!layer) continue;
      const kind = parameterKind(param);
      if (layer.geojson && kind === "vector_in") {
        layerInputs[param.name] = {
          name: layer.name,
          kind,
          geojson: layer.geojson,
        };
      } else if (runLocal && (kind === "raster_in" || kind === "lidar_in")) {
        // WASM runs in-browser: pass the layer's actual bytes, not a path. When
        // they are not fetchable (e.g. a desktop file path), fall back to the
        // path, which the WASM runner reports clearly if it cannot fetch it.
        const bytes = await fetchLayerBytes(layer);
        if (bytes) {
          layerInputs[param.name] = { name: layer.name, kind, bytes };
        } else {
          parameters[param.name] = layerPath(layer);
        }
      } else {
        parameters[param.name] = layerPath(layer);
      }
    } else {
      parameters[param.name] = value;
    }
  }
  return { ok: true, parameters, layerInputs };
}

/**
 * The vector output format a local (WASM) run requests, read from the tool's
 * `vector_out` parameter and normalized so a stale sidecar-mode path cannot be
 * cast to a bogus format.
 *
 * @param tool - The selected tool.
 * @param values - The current form values.
 * @param runLocal - Whether the run is local.
 * @returns The normalized format.
 */
export function runVectorOutputFormat(
  tool: WhiteboxTool,
  values: ParameterValues,
  runLocal: boolean,
): VectorOutputFormat {
  const vectorOut = runLocal
    ? (tool.params ?? []).find((item) => parameterKind(item) === "vector_out")
    : undefined;
  return normalizeVectorOutputFormat(vectorOut ? values[vectorOut.name] : undefined);
}

/**
 * Evict the oldest entries (Map insertion order) until the map is within `max`.
 *
 * @param map - The tracked-job map, mutated in place.
 * @param max - The maximum number of entries to keep.
 * @param onEvict - Called with each evicted key.
 */
export function evictOldestEntries<K, V>(
  map: Map<K, V>,
  max: number,
  onEvict?: (key: K) => void,
): void {
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
    onEvict?.(oldest);
  }
}

/**
 * The job outputs to import as GeoJSON layers: inline FeatureCollections and
 * paths to JSON files.
 *
 * @param outputs - A finished job's outputs.
 * @returns The `[name, value]` entries to import.
 */
export function geoJsonOutputEntries(outputs: Record<string, unknown>): [string, unknown][] {
  return Object.entries(outputs).filter(([, value]) => {
    if (isFeatureCollection(value)) return true;
    const path = outputPath(value);
    return Boolean(path && isJsonOutputPath(path));
  });
}

/**
 * The extension for a downloaded binary output: sniffed from its bytes, or, for
 * an unrecognized `file_out`, taken from the output path the user typed.
 *
 * @param bytes - The output bytes.
 * @param outKind - The output parameter's kind ("" when unknown).
 * @param param - The output parameter, if known.
 * @param runValue - The value the run passed for that parameter.
 * @returns The extension, without a dot.
 */
export function binaryOutputExtension(
  bytes: Uint8Array,
  outKind: string,
  param: WhiteboxToolParameter | undefined,
  runValue: unknown,
): string {
  const sniffed = fileOutputExtension(bytes);
  return sniffed !== "bin" || outKind !== "file_out" || !param
    ? sniffed
    : fileOutputTargetExtension(param, runValue);
}

/**
 * The kind badge for a grouped extent control: every distinct kind of the four
 * boundary parameters, sorted.
 *
 * @param params - The boundary parameters.
 * @returns A comma-separated kind list.
 */
export function extentKindLabel(params: readonly WhiteboxToolParameter[]): string {
  return [...new Set(params.map((param) => parameterKind(param)))].sort().join(", ");
}

/**
 * The value a number stepper moves to: one step (1, or 0.1 for decimals) from
 * the current value, treating unparsable text as 0.
 *
 * @param value - The current text.
 * @param integer - Whether the field is an integer.
 * @param direction - 1 to increase, -1 to decrease.
 * @returns The next value as text.
 */
export function stepNumberValue(value: string, integer: boolean, direction: 1 | -1): string {
  const step = integer ? 1 : 0.1;
  const parsed = Number.parseFloat(value);
  const base = Number.isFinite(parsed) ? parsed : 0;
  const next = base + direction * step;
  return integer ? String(Math.trunc(next)) : Number(next.toFixed(6)).toString();
}

/**
 * The stored degrees for text typed into a distance field in `unit`. Text that
 * is not a complete number is stored verbatim (blank stays blank), so it fails
 * at the tool instead of being reinterpreted as a different distance.
 *
 * @param text - What the user typed.
 * @param unit - The unit it is in.
 * @param latitude - The latitude the conversion is anchored at.
 * @returns The value to store.
 */
export function distanceDraftToStored(text: string, unit: DistanceUnit, latitude: number): string {
  const parsed = parseDistanceInput(text);
  return parsed === null
    ? text.trim() === ""
      ? ""
      : text
    : formatDistanceValue(unitToDegrees(parsed, unit, latitude), 8);
}

/**
 * The draft a distance field shows after switching to `unit`, carrying the
 * stored distance over. A stored value that is not a number moves across as-is.
 *
 * @param value - The stored value (degrees).
 * @param unit - The newly chosen unit (not degrees).
 * @param latitude - The latitude the conversion is anchored at.
 * @returns The draft text.
 */
export function distanceDraftForUnit(value: string, unit: DistanceUnit, latitude: number): string {
  const degrees = parseDistanceInput(value);
  return degrees === null ? value : formatDistanceValue(degreesToUnit(degrees, unit, latitude), 8);
}

/**
 * The i18n key and rounded value naming a conversion latitude. A value that
 * rounds to 0.0 reads as the equator rather than "0.0°N".
 *
 * @param latitude - The latitude in degrees.
 * @returns The key and the absolute latitude rounded to one decimal.
 */
export function latitudeLabelKey(latitude: number): {
  key: "processing.distance.equator" | "processing.distance.north" | "processing.distance.south";
  latitude: string;
} {
  const rounded = Math.abs(latitude).toFixed(1);
  return {
    key:
      rounded === "0.0"
        ? "processing.distance.equator"
        : latitude > 0
          ? "processing.distance.north"
          : "processing.distance.south",
    latitude: rounded,
  };
}
