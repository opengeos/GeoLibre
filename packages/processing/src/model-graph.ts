import type { FeatureCollection } from "geojson";
import type {
  ModelGraphNode,
  ModelPortKind,
  ModelToolProvider,
  ProcessingModelGraph,
} from "@geolibre/core";
import type { AlgorithmParameter } from "./types";

/**
 * A value flowing along a model edge. Vector nodes exchange FeatureCollections,
 * raster nodes exchange GeoTIFF bytes; carrying the kind with the payload is
 * what lets one graph mix Whitebox raster tools with client vector tools and
 * still fail fast when an edge would connect two incompatible ports.
 */
export type ModelValue =
  | { kind: "vector"; geojson: FeatureCollection }
  | { kind: "raster"; bytes: Uint8Array; name?: string };

/**
 * One connection point on a {@link ModelToolDescriptor}.
 *
 * `label` is a stable identifier, not display text: this package has no i18n
 * access, so a hardcoded English word here would reach the rendered port title
 * untranslated in every locale. The UI layer resolves it for display.
 */
export interface ModelToolPort {
  /**
   * For an input port this is the underlying tool parameter id, so wiring an
   * edge and typing a value into the properties panel target the same slot.
   */
  id: string;
  label: string;
  kind: ModelPortKind;
  required?: boolean;
}

/**
 * A tool as the Model Builder sees it, independent of which registry produced
 * it: ports it can be wired through, plus the parameters the user still has to
 * fill in by hand. Adapters build these from the vector algorithm registry and
 * from the Whitebox WASM manifests.
 */
export interface ModelToolDescriptor {
  /** Globally unique palette key, `"<provider>:<toolId>"`. */
  key: string;
  provider: ModelToolProvider;
  toolId: string;
  name: string;
  /** Palette grouping label. */
  group: string;
  description?: string;
  inputs: ModelToolPort[];
  outputs: ModelToolPort[];
  /** Everything not supplied by an edge, rendered in the properties panel. */
  parameters: AlgorithmParameter[];
  /**
   * The provider's own tool record, carried through verbatim so the executor
   * can hand it back to that provider's runner. The Whitebox WASM runner builds
   * its CLI arguments by walking this manifest's params, so a node that loses it
   * runs with no arguments at all and the binary rejects it as missing a
   * required parameter. Opaque here to keep the graph engine provider-agnostic.
   */
  native?: unknown;
}

/** The single output port every `input` node exposes. */
export const INPUT_NODE_PORT = "out";
/** The single input port every `output` node exposes. */
export const OUTPUT_NODE_PORT = "in";

/** Resolve a tool node to its descriptor, or `undefined` when unknown. */
export type DescriptorResolver = (
  provider: ModelToolProvider | undefined,
  toolId: string | undefined,
) => ModelToolDescriptor | undefined;

/** A problem found in a graph, anchored to the node or edge that carries it. */
export interface ModelGraphIssue {
  /** Machine-readable reason, so the UI can translate rather than show `message`. */
  code:
    | "unknown-tool"
    | "missing-layer"
    | "missing-input"
    | "unknown-port"
    | "duplicate-input"
    | "type-mismatch"
    | "cycle"
    | "no-output"
    | "duplicate-node"
    | "dangling-edge";
  nodeId?: string;
  edgeId?: string;
  /**
   * The one piece of data the message names — a port label or a tool id — so
   * the UI can interpolate it into a translated string instead of parsing it
   * back out of {@link message}.
   */
  detail?: string;
  /** English fallback, for a caller with no translation for {@link code}. */
  message: string;
}

/** True when a value of `from` can be fed into a port declaring `to`. */
export function portKindsCompatible(from: ModelPortKind, to: ModelPortKind): boolean {
  return from === "any" || to === "any" || from === to;
}

/**
 * Order nodes so every node follows the ones feeding it (Kahn's algorithm).
 *
 * @param graph The graph to order.
 * @returns Nodes in a runnable order, or `null` when the graph contains a
 *   cycle — in which case some nodes could never have their inputs ready.
 */
export function topologicalOrder(graph: ProcessingModelGraph): ModelGraphNode[] | null {
  const indegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const node of graph.nodes) {
    indegree.set(node.id, 0);
    outgoing.set(node.id, []);
  }
  for (const edge of graph.edges) {
    if (!indegree.has(edge.from) || !indegree.has(edge.to)) continue;
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    outgoing.get(edge.from)?.push(edge.to);
  }
  const queue = graph.nodes.filter((node) => (indegree.get(node.id) ?? 0) === 0);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const ordered: ModelGraphNode[] = [];
  // Index cursor rather than shift(): shift() is O(remaining) per call, which
  // makes a wide fan-out quadratic, and this runs on every graph edit.
  for (let head = 0; head < queue.length; head++) {
    const node = queue[head];
    ordered.push(node);
    for (const nextId of outgoing.get(node.id) ?? []) {
      const remaining = (indegree.get(nextId) ?? 0) - 1;
      indegree.set(nextId, remaining);
      if (remaining === 0) {
        const next = byId.get(nextId);
        if (next) queue.push(next);
      }
    }
  }
  return ordered.length === graph.nodes.length ? ordered : null;
}

/** The ports a node exposes, given its descriptor (tool nodes only). */
function portsFor(
  node: ModelGraphNode,
  descriptor: ModelToolDescriptor | undefined,
): { inputs: ModelToolPort[]; outputs: ModelToolPort[] } {
  if (node.kind === "input") {
    return { inputs: [], outputs: [{ id: INPUT_NODE_PORT, label: INPUT_NODE_PORT, kind: "any" }] };
  }
  if (node.kind === "output") {
    return {
      inputs: [{ id: OUTPUT_NODE_PORT, label: OUTPUT_NODE_PORT, kind: "any", required: true }],
      outputs: [],
    };
  }
  return { inputs: descriptor?.inputs ?? [], outputs: descriptor?.outputs ?? [] };
}

/**
 * Check a graph for everything that would make a run fail, so the canvas can
 * mark the offending node before the user presses Run.
 *
 * Covers unknown tools, `input` nodes with no layer chosen, required input
 * ports with neither an edge nor a typed parameter value, edges naming a port
 * the node does not have, two edges into one port, vector wired into raster (or
 * the reverse), cycles, and a graph with no `output` node.
 *
 * @param graph The graph to check.
 * @param resolve Descriptor lookup for tool nodes.
 * @returns One issue per problem found; empty when the graph is runnable.
 */
export function validateModelGraph(
  graph: ProcessingModelGraph,
  resolve: DescriptorResolver,
): ModelGraphIssue[] {
  const issues: ModelGraphIssue[] = [];
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  // Every lookup here keys on node id, so a duplicate silently collapses to
  // "last write wins" while both entries stay in `nodes` — the run would then
  // execute only one of them, with no error anywhere.
  const idCounts = new Map<string, number>();
  for (const node of graph.nodes) idCounts.set(node.id, (idCounts.get(node.id) ?? 0) + 1);
  for (const [id, count] of idCounts) {
    if (count > 1) {
      issues.push({
        code: "duplicate-node",
        nodeId: id,
        message: `Two or more nodes share the id "${id}".`,
      });
    }
  }
  const descriptors = new Map<string, ModelToolDescriptor | undefined>();
  for (const node of graph.nodes) {
    if (node.kind === "tool") descriptors.set(node.id, resolve(node.provider, node.toolId));
  }

  for (const node of graph.nodes) {
    if (node.kind === "input" && !node.layerId) {
      issues.push({ code: "missing-layer", nodeId: node.id, message: "Choose an input layer." });
    }
    if (node.kind === "tool" && !descriptors.get(node.id)) {
      issues.push({
        code: "unknown-tool",
        nodeId: node.id,
        detail: node.toolId ?? "",
        message: `Unknown tool "${node.toolId ?? ""}"`,
      });
    }
  }

  // Edges: both endpoints must name a real port, kinds must line up, and no
  // input port may take two values.
  const filled = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) {
      // Skipping these silently makes a stray edge's wiring simply vanish, and
      // graphToLinearSteps still counts them when deciding whether a node has
      // exactly one predecessor.
      issues.push({
        code: "dangling-edge",
        edgeId: edge.id,
        message: "A connection points at a node that no longer exists.",
      });
      continue;
    }
    const fromPort = portsFor(from, descriptors.get(from.id)).outputs.find(
      (port) => port.id === edge.fromPort,
    );
    const toPort = portsFor(to, descriptors.get(to.id)).inputs.find(
      (port) => port.id === edge.toPort,
    );
    if (!fromPort || !toPort) {
      // An unknown tool already reports itself; do not also blame its edges.
      if (
        (from.kind !== "tool" || descriptors.get(from.id)) &&
        (to.kind !== "tool" || descriptors.get(to.id))
      ) {
        issues.push({
          code: "unknown-port",
          edgeId: edge.id,
          message: "Connection refers to a port that no longer exists.",
        });
      }
      continue;
    }
    if (!portKindsCompatible(fromPort.kind, toPort.kind)) {
      issues.push({
        code: "type-mismatch",
        edgeId: edge.id,
        message: `Cannot connect ${fromPort.kind} output to ${toPort.kind} input.`,
      });
    }
    const seen = filled.get(to.id) ?? new Set<string>();
    if (seen.has(toPort.id)) {
      issues.push({
        code: "duplicate-input",
        edgeId: edge.id,
        detail: toPort.label,
        message: `"${toPort.label}" already has an incoming connection.`,
      });
    }
    seen.add(toPort.id);
    filled.set(to.id, seen);
  }

  // Required inputs must be satisfied by an edge or a typed parameter value.
  for (const node of graph.nodes) {
    const descriptor = descriptors.get(node.id);
    if (node.kind === "tool" && !descriptor) continue;
    for (const port of portsFor(node, descriptor).inputs) {
      if (!port.required) continue;
      if (filled.get(node.id)?.has(port.id)) continue;
      const typed = node.parameters?.[port.id];
      if (typed !== undefined && typed !== null && typed !== "") continue;
      issues.push({
        code: "missing-input",
        nodeId: node.id,
        detail: port.label,
        message: `"${port.label}" needs a connection or a value.`,
      });
    }
  }

  if (!topologicalOrder(graph)) {
    issues.push({ code: "cycle", message: "The model contains a loop." });
  }
  if (!graph.nodes.some((node) => node.kind === "output")) {
    issues.push({ code: "no-output", message: "Add an output node to keep a result." });
  }
  return issues;
}

/** Run one tool node: given its resolved inputs, produce a value per output port. */
export type ModelToolExecutor = (args: {
  node: ModelGraphNode;
  descriptor: ModelToolDescriptor;
  /** Values arriving on the node's input ports, keyed by port id. */
  inputs: Record<string, ModelValue>;
  signal?: AbortSignal;
}) => Promise<Record<string, ModelValue>>;

export interface RunModelGraphOptions {
  /** Resolve a tool node's descriptor. */
  resolveDescriptor: DescriptorResolver;
  /** Run one tool node. */
  executeTool: ModelToolExecutor;
  /**
   * Resolve an `input` node's layer to a value, or `null` when unusable.
   * Async because a raster layer's bytes have to be fetched.
   */
  resolveInput: (layerId: string) => Promise<ModelValue | null> | ModelValue | null;
  /** Deliver a finished `output` node's value (adds it to the map). */
  emitOutput: (name: string, value: ModelValue, node: ModelGraphNode) => void;
  log: (message: string) => void;
  signal?: AbortSignal;
  /** Called as each node starts and finishes, for canvas progress marking. */
  onNodeStatus?: (nodeId: string, status: "running" | "done" | "error") => void;
}

/** Outcome of a {@link runModelGraph} call. */
export interface ModelGraphRunResult {
  /** Output-node values produced, keyed by node id. */
  outputs: Record<string, ModelValue>;
  /** Set when the run stopped early; names the failing node when there is one. */
  error?: { nodeId?: string; message: string };
}

/**
 * Execute a validated graph in dependency order.
 *
 * Each node's inputs are gathered from its incoming edges (falling back, for a
 * tool node's unwired input port, to a layer id typed into its parameters and
 * resolved through {@link RunModelGraphOptions.resolveInput}). Stops at the
 * first node that fails and reports which one, leaving already-produced outputs
 * in place so a partial run is still inspectable.
 *
 * Validate first: this assumes the graph is acyclic and its ports line up.
 *
 * @param graph The graph to run.
 * @param options Resolution, execution and reporting hooks.
 * @returns The produced outputs plus the first error, if any.
 */
export async function runModelGraph(
  graph: ProcessingModelGraph,
  options: RunModelGraphOptions,
): Promise<ModelGraphRunResult> {
  const ordered = topologicalOrder(graph);
  const outputs: Record<string, ModelValue> = {};
  if (!ordered) {
    return { outputs, error: { message: "The model contains a loop." } };
  }

  // Values produced per node, keyed by output port id.
  const produced = new Map<string, Record<string, ModelValue>>();
  const incoming = new Map<string, typeof graph.edges>();
  for (const edge of graph.edges) {
    const list = incoming.get(edge.to) ?? [];
    list.push(edge);
    incoming.set(edge.to, list);
  }

  for (const node of ordered) {
    if (options.signal?.aborted) {
      return { outputs, error: { nodeId: node.id, message: "Run cancelled." } };
    }

    // Gather whatever the upstream nodes put on this node's input ports.
    const inputs: Record<string, ModelValue> = {};
    for (const edge of incoming.get(node.id) ?? []) {
      const value = produced.get(edge.from)?.[edge.fromPort];
      if (value) inputs[edge.toPort] = value;
    }

    try {
      if (node.kind === "input") {
        options.onNodeStatus?.(node.id, "running");
        const value = node.layerId ? await options.resolveInput(node.layerId) : null;
        if (!value) {
          const message = `Input layer "${node.layerId ?? ""}" has no usable data.`;
          options.log(`Error: ${message}`);
          options.onNodeStatus?.(node.id, "error");
          return { outputs, error: { nodeId: node.id, message } };
        }
        produced.set(node.id, { [INPUT_NODE_PORT]: value });
        options.onNodeStatus?.(node.id, "done");
        continue;
      }

      if (node.kind === "output") {
        options.onNodeStatus?.(node.id, "running");
        const value = inputs[OUTPUT_NODE_PORT];
        if (!value) {
          const message = "Output node has nothing connected to it.";
          options.log(`Error: ${message}`);
          options.onNodeStatus?.(node.id, "error");
          return { outputs, error: { nodeId: node.id, message } };
        }
        const name = node.name?.trim() || "Model output";
        options.emitOutput(name, value, node);
        outputs[node.id] = value;
        options.onNodeStatus?.(node.id, "done");
        continue;
      }

      const descriptor = options.resolveDescriptor(node.provider, node.toolId);
      if (!descriptor) {
        const message = `Unknown tool "${node.toolId ?? ""}"`;
        options.log(`Error: ${message}`);
        options.onNodeStatus?.(node.id, "error");
        return { outputs, error: { nodeId: node.id, message } };
      }

      // An unwired input port may still name a project layer typed into the
      // properties panel, which is how a single-node model gets its data.
      for (const port of descriptor.inputs) {
        if (inputs[port.id]) continue;
        const typed = node.parameters?.[port.id];
        if (typeof typed !== "string" || !typed) continue;
        const value = await options.resolveInput(typed);
        if (value) inputs[port.id] = value;
      }

      options.onNodeStatus?.(node.id, "running");
      options.log(`Running ${descriptor.name}...`);
      const result = await options.executeTool({
        node,
        descriptor,
        inputs,
        signal: options.signal,
      });
      produced.set(node.id, result);
      options.onNodeStatus?.(node.id, "done");
    } catch (err) {
      // executeTool wraps arbitrary WASM/sidecar calls, which can reject with a
      // non-Error; reading `.message` off that would throw inside this handler
      // and escape as an unhandled rejection instead of the documented result.
      const message = err instanceof Error ? err.message : String(err);
      options.log(`Error: ${message}`);
      options.onNodeStatus?.(node.id, "error");
      return { outputs, error: { nodeId: node.id, message } };
    }
  }

  return { outputs };
}

/**
 * Project a graph onto the legacy linear {@link ProcessingModelStep} chain, so a
 * model authored on the canvas still runs in builds that only understand
 * `steps`.
 *
 * Only an unambiguous chain projects: one input node feeding exactly one edge,
 * one output node fed by exactly one edge, and every tool node with exactly one
 * incoming and one outgoing edge. Anything with a branch or a multi-input tool
 * returns `[]`, which is the honest answer — such a model has no linear
 * equivalent and older builds must not run a silently truncated version of it.
 *
 * @param graph The authored graph.
 * @returns The equivalent step chain, or `[]` when there is not one.
 */
export function graphToLinearSteps(
  graph: ProcessingModelGraph,
): { id: string; toolId: string; parameters: Record<string, unknown>; inputParam?: string }[] {
  const ordered = topologicalOrder(graph);
  if (!ordered) return [];
  const inputs = graph.nodes.filter((node) => node.kind === "input");
  const outs = graph.nodes.filter((node) => node.kind === "output");
  if (inputs.length !== 1 || outs.length !== 1) return [];

  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, number>();
  for (const edge of graph.edges) {
    // Count only edges between nodes that exist: a dangling edge would
    // otherwise make a node look like it has the one predecessor this
    // projection requires, defeating the "refuse rather than truncate" rule.
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) continue;
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    outgoing.set(edge.from, (outgoing.get(edge.from) ?? 0) + 1);
  }
  // A branch through the shared input or output node keeps every tool node at
  // in-degree 1 / out-degree 1, so the per-tool counts above would wave it
  // through and `runModel` would then run the branches as a strict chain — the
  // silent truncation this function exists to refuse.
  if ((outgoing.get(inputs[0].id) ?? 0) !== 1) return [];
  if ((incoming.get(outs[0].id) ?? 0) !== 1) return [];

  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const steps: {
    id: string;
    toolId: string;
    parameters: Record<string, unknown>;
    inputParam?: string;
  }[] = [];
  for (const node of ordered) {
    if (node.kind !== "tool") continue;
    if ((incoming.get(node.id) ?? 0) !== 1) return [];
    if ((outgoing.get(node.id) ?? 0) !== 1) return [];
    // Only client vector tools have a `steps` runner to fall back to.
    if (node.provider !== "vector" || !node.toolId) return [];
    const inputEdge = graph.edges.find((edge) => edge.to === node.id && nodeIds.has(edge.from));
    const parameters = { ...(node.parameters ?? {}) };
    // The source layer lives on the `input` node, not in any tool's parameters,
    // but `runModel` overrides the input parameter only from step 1 onwards —
    // step 0 reads its layer straight out of `parameters`. Without this the
    // fallback chain fails at its very first step.
    const source = inputEdge ? byId.get(inputEdge.from) : undefined;
    if (source?.kind === "input" && source.layerId) {
      parameters[inputEdge?.toPort ?? "layer"] = source.layerId;
    }
    steps.push({
      id: node.id,
      toolId: node.toolId,
      parameters,
      ...(inputEdge && inputEdge.toPort !== "layer" ? { inputParam: inputEdge.toPort } : {}),
    });
  }
  return steps;
}
