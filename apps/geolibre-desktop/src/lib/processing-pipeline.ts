import type { ProcessingModel, ProcessingModelStep } from "@geolibre/core";

export const PIPELINE_SCHEMA = "https://geolibre.app/schemas/pipeline-v1.json";

export interface ProcessingPipelineNode {
  id: string;
  type: string;
  name: string;
  params: Record<string, unknown>;
  inputParam?: string;
}

export interface ProcessingPipelineEdge {
  from: string;
  to: string;
}

export interface ProcessingPipeline {
  $schema: typeof PIPELINE_SCHEMA;
  name: string;
  version: "1.0.0";
  nodes: ProcessingPipelineNode[];
  edges: ProcessingPipelineEdge[];
}

/** Convert the app's sequential model into the portable DAG interchange format. */
export function modelToPipeline(model: ProcessingModel): ProcessingPipeline {
  return {
    $schema: PIPELINE_SCHEMA,
    name: model.name,
    version: "1.0.0",
    nodes: model.steps.map((step) => ({
      id: step.id,
      type: `transform.vector.${step.toolId}`,
      name: step.toolId,
      params: { ...step.parameters },
      ...(step.inputParam ? { inputParam: step.inputParam } : {}),
    })),
    edges: model.steps.slice(1).map((step, index) => ({
      from: model.steps[index].id,
      to: step.id,
    })),
  };
}

/** Parse a pipeline and require the single, ordered chain supported by the current runner. */
export function pipelineToModel(value: unknown, createId: () => string): ProcessingModel {
  if (!value || typeof value !== "object") throw new Error("Pipeline must be a JSON object");
  const pipeline = value as Partial<ProcessingPipeline>;
  if (pipeline.$schema !== PIPELINE_SCHEMA || pipeline.version !== "1.0.0") {
    throw new Error("Unsupported pipeline schema or version");
  }
  if (!Array.isArray(pipeline.nodes) || !Array.isArray(pipeline.edges)) {
    throw new Error("Pipeline nodes and edges must be arrays");
  }
  const nodes = pipeline.nodes;
  const nodeById = new Map<string, ProcessingPipelineNode>();
  for (const node of nodes) {
    if (!node || typeof node.id !== "string" || nodeById.has(node.id)) {
      throw new Error("Every pipeline node must have a unique id");
    }
    if (
      typeof node.type !== "string" ||
      !node.type.startsWith("transform.vector.") ||
      !node.params ||
      typeof node.params !== "object" ||
      Array.isArray(node.params)
    ) {
      throw new Error(`Unsupported pipeline node "${node.id}"`);
    }
    nodeById.set(node.id, node);
  }

  const next = new Map<string, string>();
  const incoming = new Map<string, number>();
  for (const edge of pipeline.edges) {
    if (!nodeById.has(edge?.from) || !nodeById.has(edge?.to) || edge.from === edge.to) {
      throw new Error("Pipeline contains an invalid edge");
    }
    if (next.has(edge.from) || (incoming.get(edge.to) ?? 0) > 0) {
      throw new Error("Branching pipelines are not supported yet");
    }
    next.set(edge.from, edge.to);
    incoming.set(edge.to, 1);
  }
  if (nodes.length > 0 && pipeline.edges.length !== nodes.length - 1) {
    throw new Error("Pipeline must contain one connected chain");
  }
  const starts = nodes.filter((node) => !incoming.has(node.id));
  if (nodes.length > 0 && starts.length !== 1) throw new Error("Pipeline contains a cycle");

  const ordered: ProcessingPipelineNode[] = [];
  let current: ProcessingPipelineNode | undefined = starts[0];
  while (current) {
    ordered.push(current);
    const nextId = next.get(current.id);
    current = nextId ? nodeById.get(nextId) : undefined;
  }
  if (ordered.length !== nodes.length) throw new Error("Pipeline contains a cycle");

  const steps: ProcessingModelStep[] = ordered.map((node) => ({
    id: node.id || createId(),
    toolId: node.type.slice("transform.vector.".length),
    parameters: { ...node.params },
    ...(node.inputParam ? { inputParam: node.inputParam } : {}),
  }));
  return { id: createId(), name: String(pipeline.name || "Imported model"), steps };
}
