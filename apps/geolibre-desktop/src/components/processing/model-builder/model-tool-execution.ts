// Running a Model Builder tool step: graph conversion from steps, layer inputs and tool execution.

import {
  DEFAULT_LAYER_STYLE,
  type GeoLibreLayer,
  type ModelGraphNode,
  type ProcessingModel,
  type ProcessingModelGraph,
} from "@geolibre/core";
import {
  getVectorTool,
  runAlgorithmCapture,
  runWhiteboxToolWasm,
  type ModelToolDescriptor,
  type ModelValue,
  type WhiteboxLayerInput,
  type WhiteboxTool,
} from "@geolibre/processing";
import type { TFunction } from "i18next";
import { createDuckDbCapability } from "../../../lib/duckdb-processing";
import { fetchLayerBytes } from "../../../lib/whitebox-layer-inputs";
import { descriptorName, portLabel } from "./model-builder-labels";

/** Rebuild a graph from a legacy linear model, so old saves open on the canvas. */
export function stepsToGraph(model: ProcessingModel): ProcessingModelGraph {
  const nodes: ModelGraphNode[] = [];
  const edges: ProcessingModelGraph["edges"] = [];
  let previousId: string | null = null;
  model.steps.forEach((step, index) => {
    nodes.push({
      id: step.id,
      kind: "tool",
      x: 40 + index * 240,
      y: 40,
      provider: "vector",
      toolId: step.toolId,
      parameters: { ...step.parameters },
    });
    if (previousId) {
      edges.push({
        id: `${previousId}-${step.id}`,
        from: previousId,
        fromPort: "out",
        to: step.id,
        toPort: step.inputParam ?? "layer",
      });
    }
    previousId = step.id;
  });
  if (previousId) {
    const outputId = `${previousId}-output`;
    nodes.push({
      id: outputId,
      kind: "output",
      x: 40 + model.steps.length * 240,
      y: 40,
      name: model.name,
    });
    edges.push({
      id: `${previousId}-to-output`,
      from: previousId,
      fromPort: "out",
      to: outputId,
      toPort: "in",
    });
  }
  return { nodes, edges };
}

/**
 * Wrap a project layer as a model value the graph runner can carry.
 *
 * A vector layer hands over its in-memory GeoJSON directly. A raster layer has
 * to have its bytes fetched — the same path the Whitebox toolbox uses for a
 * `raster_in`, so a locally loaded GeoTIFF resolves through its blob URL rather
 * than a file path the browser cannot read.
 *
 * @param layers The project layers.
 * @param layerId The layer an input node points at.
 * @returns The value, or `null` when the layer holds nothing runnable.
 */
export async function layerToModelValue(
  layers: GeoLibreLayer[],
  layerId: string,
): Promise<ModelValue | null> {
  const layer = layers.find((entry) => entry.id === layerId);
  if (!layer) return null;
  if (layer.geojson) return { kind: "vector", geojson: layer.geojson };
  if (["raster", "cog", "wms", "wmts", "xyz", "zarr"].includes(layer.type)) {
    const bytes = await fetchLayerBytes(layer);
    if (bytes) return { kind: "raster", bytes, name: layer.name };
  }
  return null;
}

/**
 * Run one tool node, dispatching to whichever engine owns it.
 *
 * Client vector tools take a synthetic in-memory layer per wired input, exactly
 * as the linear runner does. Whitebox tools take their inputs as
 * `layer_inputs` — GeoJSON for a `vector_in`, raw GeoTIFF bytes for a
 * `raster_in` — and their job outputs are mapped back onto the descriptor's
 * output ports so the next node receives the right payload.
 *
 * Takes `t` because everything it throws is surfaced verbatim in the run log,
 * appended to an already-translated prefix; an English literal here would
 * leave that line half-localized in all 19 locales.
 */
export async function executeModelTool({
  node,
  descriptor,
  inputs,
  signal,
  layers,
  duckdb,
  log: callerLog,
  t,
}: {
  node: ModelGraphNode;
  descriptor: ModelToolDescriptor;
  inputs: Record<string, ModelValue>;
  signal?: AbortSignal;
  layers: GeoLibreLayer[];
  duckdb: ReturnType<typeof createDuckDbCapability>;
  log: (message: string) => void;
  t: TFunction;
}): Promise<Record<string, ModelValue>> {
  // A run abandoned mid-step (cancelled, or another model loaded) must not
  // write to the log of the session that replaced it: a Whitebox job or a
  // vector tool can finish after the abort and still report its messages.
  const log = (message: string) => {
    if (!signal?.aborted) callerLog(message);
  };
  if (descriptor.provider === "vector") {
    const tool = getVectorTool(descriptor.toolId);
    if (!tool)
      throw new Error(
        t("processing.modelBuilder.issueUnknownTool", {
          tool: descriptor.toolId,
        }),
      );
    // Each wired input becomes a synthetic layer the tool resolves by id, the
    // same trick the linear runner uses to chain a step's output forward.
    const synthetic: GeoLibreLayer[] = [];
    const parameters = { ...(node.parameters ?? {}) };
    for (const [portId, value] of Object.entries(inputs)) {
      if (value.kind !== "vector") {
        throw new Error(
          t("processing.modelBuilder.portNeedsVector", {
            port: portLabel(t, portId),
          }),
        );
      }
      const syntheticId = `__geolibre_model_${node.id}_${portId}`;
      synthetic.push(syntheticLayer(syntheticId, portId, value.geojson));
      parameters[portId] = syntheticId;
    }
    const output = await runAlgorithmCapture(tool, parameters, {
      layers: [...layers, ...synthetic],
      log,
      duckdb,
      signal,
    });
    if (!output)
      throw new Error(
        t("processing.modelBuilder.toolNoOutput", {
          tool: descriptorName(t, descriptor),
        }),
      );
    return { out: { kind: "vector", geojson: output } };
  }

  const layerInputs: Record<string, WhiteboxLayerInput> = {};
  for (const [portId, value] of Object.entries(inputs)) {
    if (value.kind === "vector") {
      layerInputs[portId] = {
        name: portId,
        kind: "vector_in",
        geojson: value.geojson,
      };
    } else if (value.kind === "raster") {
      layerInputs[portId] = {
        name: portId,
        kind: "raster_in",
        bytes: value.bytes,
      };
    } else {
      // A raster collection, number or string has no Whitebox input form;
      // say so here rather than fail later as a missing input.
      throw new Error(
        t("processing.modelBuilder.portCannotTake", {
          port: portLabel(t, portId),
          kind: value.kind,
        }),
      );
    }
  }
  const job = await runWhiteboxToolWasm({
    tool_id: descriptor.toolId,
    parameters: { ...(node.parameters ?? {}) },
    // The WASM runner builds its CLI arguments by walking `tool.params`; without
    // the manifest it passes none and the binary rejects the run as missing a
    // required parameter.
    tool: descriptor.native as WhiteboxTool | undefined,
    layer_inputs: layerInputs,
    include_pro: false,
    tier: "open",
  });
  if (job.error) throw new Error(job.error);
  for (const message of job.messages ?? []) log(message);

  const results: Record<string, ModelValue> = {};
  for (const port of descriptor.outputs) {
    const value = job.outputs?.[port.id];
    if (value instanceof Uint8Array) {
      results[port.id] = { kind: "raster", bytes: value, name: port.id };
    } else if (
      value &&
      typeof value === "object" &&
      (value as { type?: string }).type === "FeatureCollection"
    ) {
      results[port.id] = {
        kind: "vector",
        geojson: value as ModelValue extends {
          kind: "vector";
          geojson: infer G;
        }
          ? G
          : never,
      };
    }
  }
  if (Object.keys(results).length === 0) {
    throw new Error(
      t("processing.modelBuilder.toolNoUsableOutput", {
        tool: descriptorName(t, descriptor),
      }),
    );
  }
  return results;
}

/** A throwaway in-memory layer wrapping one wired input for a client tool. */
function syntheticLayer(
  id: string,
  name: string,
  geojson: NonNullable<GeoLibreLayer["geojson"]>,
): GeoLibreLayer {
  return {
    id,
    name,
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
    geojson,
  };
}
