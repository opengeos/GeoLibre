import type { FeatureCollection } from "geojson";
import {
  DEFAULT_LAYER_STYLE,
  type GeoLibreLayer,
  type ProcessingModel,
  type ProcessingModelStep,
} from "@geolibre/core";
import type { DuckDbCapability, ProcessingAlgorithm, ProcessingContext } from "./types";
import { getVectorTool } from "./vector-tools";

/** Synthetic layer-id prefix for a pipeline step's chained input. */
const PIPELINE_INPUT_ID_PREFIX = "__geolibre_pipeline_step_";

/**
 * Host-level capabilities a run needs beyond a single step's parameters. The
 * same shape the dialogs already build for a one-off tool run, minus
 * `addResultLayer` (the runner supplies its own capturing sink) and the
 * per-result `fitBounds` (a batch/pipeline run decides what to fit afterwards).
 */
export interface RunnerHost {
  /** Project layers, resolved by any layer-id parameter the tools read. */
  layers: GeoLibreLayer[];
  /** Sink for tool log lines. */
  log: (message: string) => void;
  /** DuckDB-WASM capability for tools that need it (H3, DuckDB-backed ops). */
  duckdb?: DuckDbCapability;
  /** Current map viewport as [west, south, east, north], for tools that read it. */
  viewportBounds?: () => [number, number, number, number] | null;
  /** Abort signal; checked between steps and forwarded to each tool. */
  signal?: AbortSignal;
}

/**
 * Run a single processing algorithm and capture the FeatureCollection it
 * produces, instead of adding it to the map. When a tool emits several result
 * layers the last one wins, since sequential chaining only forwards one output.
 *
 * @param tool The algorithm to run.
 * @param parameters Parameter values keyed by the tool's parameter ids.
 * @param host Shared run capabilities (layers, logging, DuckDB, signal).
 * @returns The produced FeatureCollection, or `null` when the tool added no
 *   result (e.g. an empty selection, or a sidecar-only tool whose client `run`
 *   defers).
 */
export async function runAlgorithmCapture(
  tool: ProcessingAlgorithm,
  parameters: Record<string, unknown>,
  host: RunnerHost,
): Promise<FeatureCollection | null> {
  let captured: FeatureCollection | null = null;
  const ctx: ProcessingContext = {
    layers: host.layers,
    parameters,
    log: host.log,
    addResultLayer: (_name, geojson) => {
      captured = geojson;
    },
    duckdb: host.duckdb,
    viewportBounds: host.viewportBounds,
    signal: host.signal,
  };
  await tool.run(ctx);
  return captured;
}

/** Outcome of running one {@link ProcessingModelStep}. */
export interface ModelStepResult {
  step: ProcessingModelStep;
  /** Human-readable tool name (falls back to the tool id when unknown). */
  toolName: string;
  /** The step's output, or `null` when it produced nothing / failed. */
  output: FeatureCollection | null;
  /** Set when the step could not run (unknown tool, missing input, or threw). */
  error?: string;
}

export interface RunModelOptions {
  /**
   * Resolve a step's `toolId` to an algorithm. Defaults to the vector-tools
   * registry, the set of pure FeatureCollection-in/out client tools that chain
   * cleanly. Pass a custom resolver to support additional registries.
   */
  resolveTool?: (toolId: string) => ProcessingAlgorithm | undefined;
  /** Called after each step finishes (success or failure), in order. */
  onStepResult?: (result: ModelStepResult, index: number) => void;
}

/**
 * Run a {@link ProcessingModel} as a sequential pipeline: each step's output is
 * fed into the next step's input layer parameter (`step.inputParam`, default
 * `"layer"`). The first step reads the real project layer the user configured;
 * every later step's stored input parameter is overridden with the upstream
 * result. Stops at the first failing step (unknown tool, no upstream output, or
 * a tool that throws) and records the error on that step's result.
 *
 * @param model The pipeline to run.
 * @param host Shared run capabilities (project layers, logging, DuckDB, signal).
 * @param options Tool resolver and per-step callback.
 * @returns One {@link ModelStepResult} per step that ran, in order.
 */
export async function runModel(
  model: ProcessingModel,
  host: RunnerHost,
  options: RunModelOptions = {},
): Promise<ModelStepResult[]> {
  const resolveTool = options.resolveTool ?? getVectorTool;
  const results: ModelStepResult[] = [];
  let previousOutput: FeatureCollection | null = null;

  for (let index = 0; index < model.steps.length; index++) {
    if (host.signal?.aborted) break;
    const step = model.steps[index];

    const record = (result: ModelStepResult): void => {
      results.push(result);
      options.onStepResult?.(result, index);
    };

    const tool = resolveTool(step.toolId);
    if (!tool) {
      const error = `Unknown tool "${step.toolId}"`;
      host.log(`Error: ${error}`);
      record({ step, toolName: step.toolId, output: null, error });
      break;
    }

    const parameters = { ...step.parameters };
    let layers = host.layers;

    // Every step after the first chains: rewire its input layer parameter to the
    // previous step's output. The output is exposed as a synthetic in-memory
    // layer so the tool can resolve it by id exactly like a real project layer.
    if (index > 0) {
      if (!previousOutput) {
        const error = `Previous step produced no output to feed "${tool.name}"`;
        host.log(`Error: ${error}`);
        record({ step, toolName: tool.name, output: null, error });
        break;
      }
      const inputLayerId = `${PIPELINE_INPUT_ID_PREFIX}${index}`;
      const inputLayer: GeoLibreLayer = {
        id: inputLayerId,
        name: `Step ${index}`,
        type: "geojson",
        source: { type: "geojson" },
        visible: true,
        opacity: 1,
        style: { ...DEFAULT_LAYER_STYLE },
        metadata: {},
        geojson: previousOutput,
      };
      layers = [...host.layers, inputLayer];
      parameters[step.inputParam ?? "layer"] = inputLayerId;
    }

    host.log(`Running step ${index + 1}/${model.steps.length}: ${tool.name}...`);
    let output: FeatureCollection | null = null;
    try {
      output = await runAlgorithmCapture(tool, parameters, { ...host, layers });
    } catch (err) {
      const error = (err as Error).message;
      host.log(`Error in "${tool.name}": ${error}`);
      record({ step, toolName: tool.name, output: null, error });
      break;
    }

    record({ step, toolName: tool.name, output });
    previousOutput = output;
  }

  return results;
}
