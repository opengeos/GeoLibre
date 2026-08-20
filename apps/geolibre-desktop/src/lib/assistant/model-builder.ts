import type { GeoLibreLayer, ProcessingModel, ProcessingModelGraph } from "@geolibre/core";
import {
  INPUT_NODE_PORT,
  OUTPUT_NODE_PORT,
  validateModelGraph,
  graphToLinearSteps,
  type AlgorithmParameter,
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

/** Whether a parameter applies, given the other values the assistant supplied. */
function isParameterVisible(param: AlgorithmParameter, values: Record<string, unknown>): boolean {
  const vw = param.visibleWhen;
  if (!vw) return true;
  const current = values[vw.param] as string | undefined;
  if ("in" in vw) return current != null && vw.in.includes(current);
  return current == null || !vw.notIn.includes(current);
}

/** Whether a value is usable for a parameter of this declared type. */
function parameterTypeMatches(param: AlgorithmParameter, value: unknown): boolean {
  switch (param.type) {
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "select":
      return (
        typeof value === "string" &&
        (!param.options?.length || param.options.some((option) => option.value === value))
      );
    default:
      // layer / string / field / path all arrive as text.
      return typeof value === "string";
  }
}

/**
 * Check a step's parameter block against the tool's own declaration.
 *
 * `validateModelGraph` only inspects input *ports*, so without this an invented
 * parameter id, a missing required setting, or a string where a number belongs
 * would be saved verbatim and only surface when the user presses Run.
 *
 * @param step The step as the assistant described it, used for error text.
 * @param descriptor The tool the step resolved to.
 * @param values The parameters left after edge-supplied ports were removed.
 * @param wired Ids of the input ports an edge already feeds.
 */
function checkStepParameters(
  step: AssistantModelStep,
  descriptor: ModelToolDescriptor,
  values: Record<string, unknown>,
  wired: Set<string>,
): void {
  const declared = new Map(descriptor.parameters.map((param) => [param.id, param]));
  // A layer parameter doubles as an input port, so a port id stays a legal key
  // even when the registry did not also list it among the parameters.
  const portIds = new Set(descriptor.inputs.map((port) => port.id));
  for (const [id, value] of Object.entries(values)) {
    const param = declared.get(id);
    if (!param) {
      if (portIds.has(id)) continue;
      throw new Error(`Algorithm "${step.algorithm}" has no parameter "${id}".`);
    }
    if (value === undefined || value === null) continue;
    if (!parameterTypeMatches(param, value)) {
      throw new Error(`Parameter "${id}" of "${step.algorithm}" expects a ${param.type} value.`);
    }
  }
  for (const param of descriptor.parameters) {
    // A wired port carries its value along the edge, and a parameter the tool
    // defaults needs no explicit value.
    if (!param.required || wired.has(param.id) || param.default !== undefined) continue;
    if (!isParameterVisible(param, values)) continue;
    const value = values[param.id];
    if (value === undefined || value === null || value === "") {
      throw new Error(`Parameter "${param.id}" of "${step.algorithm}" is required.`);
    }
  }
}

/** Build and validate the graph requested by the assistant before it reaches the store. */
export function buildAssistantModel(
  definition: AssistantModelDefinition,
  layers: GeoLibreLayer[],
  descriptors: ModelToolDescriptor[],
  createId: () => string = () => crypto.randomUUID(),
): ProcessingModel {
  const descriptorByKey = new Map(
    descriptors.map((descriptor) => [`${descriptor.provider}:${descriptor.toolId}`, descriptor]),
  );
  /**
   * A bare tool id only identifies a tool while exactly one provider claims it
   * — Whitebox and the client vector registry both define e.g. `buffer`, which
   * is why `modelToolKey` makes the provider part of a tool's identity. Mark a
   * colliding id so it is reported rather than silently resolved to whichever
   * descriptor happened to come last.
   */
  const descriptorByToolId = new Map<string, ModelToolDescriptor | null>();
  for (const descriptor of descriptors) {
    descriptorByToolId.set(
      descriptor.toolId,
      descriptorByToolId.has(descriptor.toolId) ? null : descriptor,
    );
  }
  const resolveDescriptor = (algorithm: string): ModelToolDescriptor => {
    const qualified = descriptorByKey.get(algorithm);
    if (qualified) return qualified;
    const bare = descriptorByToolId.get(algorithm);
    if (bare === null) {
      throw new Error(
        `"${algorithm}" is defined by more than one provider; name it as "<provider>:${algorithm}".`,
      );
    }
    if (!bare) throw new Error(`"${algorithm}" is not a Model Builder algorithm.`);
    return bare;
  };
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
    const descriptor = resolveDescriptor(step.algorithm);
    const inputPorts = new Map(descriptor.inputs.map((port) => [port.id, port]));
    const parameters = { ...(step.parameters ?? {}) };
    const wired = new Set<string>();
    const id = createId();
    for (const [portId, sourceKey] of Object.entries(step.inputs)) {
      if (!inputPorts.has(portId)) {
        throw new Error(`Algorithm "${step.algorithm}" has no input port "${portId}".`);
      }
      const source = nodesByKey.get(sourceKey);
      if (!source)
        throw new Error(`Model source "${sourceKey}" must be defined before "${step.key}".`);
      delete parameters[portId];
      wired.add(portId);
      edges.push({
        id: createId(),
        from: source.id,
        fromPort: source.outputPort,
        to: id,
        toPort: portId,
      });
    }
    checkStepParameters(step, descriptor, parameters, wired);
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
