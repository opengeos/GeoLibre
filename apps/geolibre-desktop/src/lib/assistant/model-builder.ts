import type { GeoLibreLayer, ProcessingModel, ProcessingModelGraph } from "@geolibre/core";
import {
  INPUT_NODE_PORT,
  OUTPUT_NODE_PORT,
  validateModelGraph,
  graphToLinearSteps,
  type ModelToolDescriptor,
} from "@geolibre/processing";

export interface AssistantModelInput {
  key: string;
  layer: string;
}

export interface AssistantModelStep {
  key: string;
  algorithm: string;
  parameters?: Record<string, unknown>;
  inputs: Record<string, string>;
}

export interface AssistantModelOutput {
  source: string;
  name: string;
}

export interface AssistantModelDefinition {
  name: string;
  inputs: AssistantModelInput[];
  steps: AssistantModelStep[];
  outputs: AssistantModelOutput[];
}

/** Build and validate the graph requested by the assistant before it reaches the store. */
export function buildAssistantModel(
  definition: AssistantModelDefinition,
  layers: GeoLibreLayer[],
  descriptors: ModelToolDescriptor[],
  createId: () => string = () => crypto.randomUUID(),
): ProcessingModel {
  const descriptorById = new Map(descriptors.map((descriptor) => [descriptor.toolId, descriptor]));
  const nodesByKey = new Map<string, { id: string; outputPort: string; kind: "input" | "tool" }>();
  const nodes: ProcessingModelGraph["nodes"] = [];
  const edges: ProcessingModelGraph["edges"] = [];

  const claimKey = (key: string): void => {
    if (!key.trim()) throw new Error("Every input and step needs a non-empty key.");
    if (nodesByKey.has(key)) throw new Error(`Duplicate model key "${key}".`);
  };
  const resolveLayer = (reference: string): GeoLibreLayer | undefined => {
    const exactId = layers.find((layer) => layer.id === reference);
    if (exactId) return exactId;
    const target = reference.trim().toLowerCase();
    return layers.find((layer) => layer.name.toLowerCase() === target);
  };

  definition.inputs.forEach((input, index) => {
    claimKey(input.key);
    const layer = resolveLayer(input.layer);
    if (!layer) throw new Error(`No layer matching model input "${input.layer}".`);
    const id = createId();
    nodes.push({ id, kind: "input", layerId: layer.id, x: 0, y: index * 112 });
    nodesByKey.set(input.key, { id, outputPort: INPUT_NODE_PORT, kind: "input" });
  });

  definition.steps.forEach((step, index) => {
    claimKey(step.key);
    const descriptor = descriptorById.get(step.algorithm);
    if (!descriptor) throw new Error(`"${step.algorithm}" is not a Model Builder algorithm.`);
    const inputPorts = new Map(descriptor.inputs.map((port) => [port.id, port]));
    const parameters = { ...(step.parameters ?? {}) };
    const id = createId();
    for (const [portId, sourceKey] of Object.entries(step.inputs)) {
      if (!inputPorts.has(portId)) {
        throw new Error(`Algorithm "${step.algorithm}" has no input port "${portId}".`);
      }
      const source = nodesByKey.get(sourceKey);
      if (!source)
        throw new Error(`Model source "${sourceKey}" must be defined before "${step.key}".`);
      delete parameters[portId];
      edges.push({
        id: createId(),
        from: source.id,
        fromPort: source.outputPort,
        to: id,
        toPort: portId,
      });
    }
    nodes.push({
      id,
      kind: "tool",
      provider: descriptor.provider,
      toolId: descriptor.toolId,
      parameters,
      x: 260 + index * 260,
      y: index * 32,
    });
    nodesByKey.set(step.key, {
      id,
      outputPort: descriptor.outputs[0]?.id ?? "out",
      kind: "tool",
    });
  });

  definition.outputs.forEach((output, index) => {
    const source = nodesByKey.get(output.source);
    if (!source) throw new Error(`Unknown model output source "${output.source}".`);
    if (source.kind !== "tool") throw new Error("A model output must come from an algorithm step.");
    const id = createId();
    nodes.push({
      id,
      kind: "output",
      name: output.name.trim() || "Model output",
      x: 260 + definition.steps.length * 260,
      y: index * 112,
    });
    edges.push({
      id: createId(),
      from: source.id,
      fromPort: source.outputPort,
      to: id,
      toPort: OUTPUT_NODE_PORT,
    });
  });

  if (!definition.steps.length) throw new Error("A model needs at least one algorithm step.");
  if (!definition.outputs.length) throw new Error("A model needs at least one output.");
  const graph = { nodes, edges };
  const descriptorByKey = new Map(
    descriptors.map((item) => [`${item.provider}:${item.toolId}`, item]),
  );
  const issues = validateModelGraph(graph, (provider, toolId) =>
    provider && toolId ? descriptorByKey.get(`${provider}:${toolId}`) : undefined,
  );
  if (issues.length) {
    throw new Error(`Invalid model: ${issues.map((issue) => issue.code).join(", ")}.`);
  }
  return {
    id: createId(),
    name: definition.name.trim() || "AI-created model",
    graph,
    steps: graphToLinearSteps(graph),
  };
}
