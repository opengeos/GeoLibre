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
  | { kind: "vector"; geojson: FeatureCollection; metadata?: Record<string, unknown> }
  | { kind: "raster"; bytes: Uint8Array; name?: string; metadata?: Record<string, unknown> }
  | {
      kind: "raster-collection";
      items: Array<{ bytes: Uint8Array; name?: string; metadata?: Record<string, unknown> }>;
      metadata?: Record<string, unknown>;
    }
  | { kind: "boolean"; value: boolean }
  | { kind: "number"; value: number }
  | { kind: "string"; value: string }
  | { kind: "any"; value: unknown };

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

/** Iterate Features port ids */
export const ITERATE_FEATURES_INPUT_PORT = "collection";
export const ITERATE_FEATURES_OUTPUT_FEATURE = "feature";
export const ITERATE_FEATURES_OUTPUT_INDEX = "index";
export const ITERATE_FEATURES_OUTPUT_COUNT = "count";

/** Iterate Rasters port ids */
export const ITERATE_RASTERS_INPUT_PORT = "collection";
export const ITERATE_RASTERS_OUTPUT_RASTER = "raster";
export const ITERATE_RASTERS_OUTPUT_NAME = "name";
export const ITERATE_RASTERS_OUTPUT_INDEX = "index";
export const ITERATE_RASTERS_OUTPUT_COUNT = "count";

/** Collect Results port ids */
export const COLLECT_RESULTS_INPUT_PORT = "item";
export const COLLECT_RESULTS_OUTPUT_PORT = "collection";
export const COLLECT_RESULTS_OUTPUT_COUNT = "count";

/** Conditional Switch port ids */
export const SWITCH_INPUT_PORT = "input";
export const SWITCH_CONDITION_PORT = "condition";
export const SWITCH_TRUE_PORT = "true";
export const SWITCH_FALSE_PORT = "false";

/** Conditional Merge port ids */
export const MERGE_TRUE_PORT = "true";
export const MERGE_FALSE_PORT = "false";
export const MERGE_OUTPUT_PORT = "out";

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
    | "dangling-edge"
    | "invalid-condition"
    | "invalid-iterator"
    | "invalid-body";
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
export function portsFor(
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
  if (node.kind === "iterate-features") {
    return {
      inputs: [
        {
          id: ITERATE_FEATURES_INPUT_PORT,
          label: "Feature Collection",
          kind: "vector",
          required: true,
        },
      ],
      outputs: [
        { id: ITERATE_FEATURES_OUTPUT_FEATURE, label: "Current Feature", kind: "vector" },
        { id: ITERATE_FEATURES_OUTPUT_INDEX, label: "Index", kind: "any" },
        { id: ITERATE_FEATURES_OUTPUT_COUNT, label: "Total Count", kind: "any" },
      ],
    };
  }
  if (node.kind === "iterate-rasters") {
    return {
      inputs: [
        {
          id: ITERATE_RASTERS_INPUT_PORT,
          label: "Raster Collection",
          kind: "any",
          required: false,
        },
      ],
      outputs: [
        { id: ITERATE_RASTERS_OUTPUT_RASTER, label: "Current Raster", kind: "any" },
        { id: ITERATE_RASTERS_OUTPUT_NAME, label: "Raster Name", kind: "any" },
        { id: ITERATE_RASTERS_OUTPUT_INDEX, label: "Index", kind: "any" },
        { id: ITERATE_RASTERS_OUTPUT_COUNT, label: "Total Count", kind: "any" },
      ],
    };
  }
  if (node.kind === "collect-results") {
    return {
      inputs: [
        { id: COLLECT_RESULTS_INPUT_PORT, label: "Item to Collect", kind: "any", required: true },
      ],
      outputs: [
        { id: COLLECT_RESULTS_OUTPUT_PORT, label: "Collected Results", kind: "any" },
        { id: COLLECT_RESULTS_OUTPUT_COUNT, label: "Count", kind: "any" },
      ],
    };
  }
  if (node.kind === "conditional-switch") {
    return {
      inputs: [
        { id: SWITCH_INPUT_PORT, label: "Input", kind: "any", required: true },
        { id: SWITCH_CONDITION_PORT, label: "Condition Value", kind: "any", required: false },
      ],
      outputs: [
        { id: SWITCH_TRUE_PORT, label: "True Branch", kind: "any" },
        { id: SWITCH_FALSE_PORT, label: "False Branch", kind: "any" },
      ],
    };
  }
  if (node.kind === "conditional-merge") {
    return {
      inputs: [
        { id: MERGE_TRUE_PORT, label: "True Result", kind: "any", required: false },
        { id: MERGE_FALSE_PORT, label: "False Result", kind: "any", required: false },
      ],
      outputs: [{ id: MERGE_OUTPUT_PORT, label: "Active Output", kind: "any" }],
    };
  }
  return { inputs: descriptor?.inputs ?? [], outputs: descriptor?.outputs ?? [] };
}

export interface ConditionEvaluationOptions {
  inputValue?: ModelValue;
  conditionValue?: ModelValue;
  parameters?: Record<string, unknown>;
}

/**
 * Safely evaluate a conditional switch's condition without arbitrary code execution.
 *
 * Supports boolean evaluation, numeric/string comparisons, property/metadata lookups,
 * and null/empty checks.
 */
export function evaluateCondition(options: ConditionEvaluationOptions): boolean {
  const params = options.parameters ?? {};
  const condType = String(params.conditionType || "compare").toLowerCase();
  const operator = String(params.operator || "==").toLowerCase();
  const targetVal = params.value;
  const propPath = typeof params.property === "string" ? params.property : undefined;

  // Resolve left-hand operand
  let left: unknown;
  if (options.conditionValue !== undefined) {
    if ("value" in options.conditionValue) {
      left = options.conditionValue.value;
    } else if (options.conditionValue.kind === "vector") {
      left = options.conditionValue.geojson.features.length;
    } else if (options.conditionValue.kind === "raster") {
      left = options.conditionValue.name;
    }
  }

  if (left === undefined && options.inputValue) {
    if (propPath) {
      if (options.inputValue.kind === "vector") {
        const feat = options.inputValue.geojson.features[0];
        const cleanPath = propPath.startsWith("properties.") ? propPath.slice(11) : propPath;
        left = feat?.properties?.[cleanPath] ?? feat?.properties?.[propPath];
        if (left === undefined && propPath === "feature_count") {
          left = options.inputValue.geojson.features.length;
        }
      } else if (options.inputValue.kind === "raster") {
        const meta = options.inputValue.metadata as Record<string, unknown> | undefined;
        const cleanPath = propPath.startsWith("metadata.") ? propPath.slice(9) : propPath;
        left =
          meta?.[cleanPath] ??
          meta?.[propPath] ??
          (propPath === "name" ? options.inputValue.name : undefined);
      } else if ("value" in options.inputValue) {
        left = options.inputValue.value;
      }
    } else if ("value" in options.inputValue) {
      left = options.inputValue.value;
    } else if (options.inputValue.kind === "vector") {
      left = options.inputValue.geojson.features.length;
    } else if (options.inputValue.kind === "raster") {
      left = options.inputValue.name;
    }
  }

  if (left === undefined && params.left !== undefined) {
    left = params.left;
  }

  if (condType === "boolean") {
    // The inspector stores the target value as text, so "true"/"false" (and a
    // "false" property value) must read as booleans, not as non-empty strings.
    const leftBool = booleanLike(left);
    if (leftBool !== undefined) return leftBool;
    const targetBool = booleanLike(targetVal);
    if (targetBool !== undefined) return targetBool;
    return Boolean(left);
  }

  if (
    condType === "null_check" ||
    operator === "is_null" ||
    operator === "not_null" ||
    operator === "is_empty" ||
    operator === "not_empty"
  ) {
    switch (operator) {
      case "is_null":
        return left === null || left === undefined;
      case "not_null":
        return left !== null && left !== undefined;
      case "is_empty":
        if (left === null || left === undefined) return true;
        if (typeof left === "string") return left.trim().length === 0;
        if (Array.isArray(left)) return left.length === 0;
        if (typeof left === "number") return false;
        if (typeof left === "object") return Object.keys(left).length === 0;
        return false;
      case "not_empty":
        if (left === null || left === undefined) return false;
        if (typeof left === "string") return left.trim().length > 0;
        if (Array.isArray(left)) return left.length > 0;
        if (typeof left === "number") return true;
        if (typeof left === "object") return Object.keys(left).length > 0;
        return true;
    }
    // A null check left on a comparison operator (the node's default is "==")
    // means "is null"; never fall through to an equality test.
    return left === null || left === undefined;
  }

  switch (operator) {
    case "==":
    case "eq":
      if (typeof left === "number" || typeof targetVal === "number") {
        return Number(left) === Number(targetVal);
      }
      return String(left ?? "") === String(targetVal ?? "");
    case "!=":
    case "neq":
      if (typeof left === "number" || typeof targetVal === "number") {
        return Number(left) !== Number(targetVal);
      }
      return String(left ?? "") !== String(targetVal ?? "");
    case "<":
    case "lt":
      return Number(left) < Number(targetVal);
    case "<=":
    case "lte":
      return Number(left) <= Number(targetVal);
    case ">":
    case "gt":
      return Number(left) > Number(targetVal);
    case ">=":
    case "gte":
      return Number(left) >= Number(targetVal);
    case "contains":
      if (Array.isArray(left)) return left.includes(targetVal);
      return String(left ?? "").includes(String(targetVal ?? ""));
    case "starts_with":
      return String(left ?? "").startsWith(String(targetVal ?? ""));
    case "ends_with":
      return String(left ?? "").endsWith(String(targetVal ?? ""));
    default:
      return Boolean(left);
  }
}

export function findDownstreamCollector(
  graph: ProcessingModelGraph,
  startNodeId: string,
): ModelGraphNode | undefined {
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = outgoing.get(edge.from) ?? [];
    list.push(edge.to);
    outgoing.set(edge.from, list);
  }
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const queue = [startNodeId];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const curr = queue.shift()!;
    if (seen.has(curr)) continue;
    seen.add(curr);
    for (const next of outgoing.get(curr) ?? []) {
      const node = byId.get(next);
      if (node?.kind === "collect-results") return node;
      queue.push(next);
    }
  }
  return undefined;
}

export function findNodesBetween(
  graph: ProcessingModelGraph,
  startId: string,
  endId: string,
): ModelGraphNode[] {
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = outgoing.get(edge.from) ?? [];
    list.push(edge.to);
    outgoing.set(edge.from, list);
  }
  const fromStart = new Set<string>();
  const q1 = [startId];
  while (q1.length > 0) {
    const c = q1.shift()!;
    for (const n of outgoing.get(c) ?? []) {
      if (!fromStart.has(n)) {
        fromStart.add(n);
        q1.push(n);
      }
    }
  }

  const incoming = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = incoming.get(edge.to) ?? [];
    list.push(edge.from);
    incoming.set(edge.to, list);
  }
  const canReachEnd = new Set<string>();
  const q2 = [endId];
  while (q2.length > 0) {
    const c = q2.shift()!;
    for (const p of incoming.get(c) ?? []) {
      if (!canReachEnd.has(p)) {
        canReachEnd.add(p);
        q2.push(p);
      }
    }
  }

  const betweenIds = new Set<string>();
  for (const id of fromStart) {
    if (canReachEnd.has(id) && id !== startId && id !== endId) {
      betweenIds.add(id);
    }
  }
  const fullOrder = topologicalOrder(graph) ?? graph.nodes;
  return fullOrder.filter((n) => betweenIds.has(n.id));
}

function findExternalAncestors(
  graph: ProcessingModelGraph,
  bodyNodeIds: Set<string>,
  iteratorNodeId: string,
  producedNodeIds: Set<string>,
): ModelGraphNode[] {
  const incoming = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = incoming.get(edge.to) ?? [];
    list.push(edge.from);
    incoming.set(edge.to, list);
  }
  const ancestors = new Set<string>();
  const queue = Array.from(bodyNodeIds);
  const seen = new Set<string>(queue);

  while (queue.length > 0) {
    const curr = queue.shift()!;
    for (const parentId of incoming.get(curr) ?? []) {
      if (parentId === iteratorNodeId || bodyNodeIds.has(parentId)) continue;
      if (!ancestors.has(parentId)) {
        ancestors.add(parentId);
        if (!seen.has(parentId)) {
          seen.add(parentId);
          queue.push(parentId);
        }
      }
    }
  }

  const needed = Array.from(ancestors).filter((id) => !producedNodeIds.has(id));
  const fullOrder = topologicalOrder(graph) ?? graph.nodes;
  const neededSet = new Set(needed);
  return fullOrder.filter((n) => neededSet.has(n.id));
}

/**
 * The order {@link runModelGraph} visits nodes in: the topological order, with
 * every node a collector-driven loop body reads from outside the loop placed
 * before that loop's iterator. Without this, a ready node that appears earlier
 * in `graph.nodes` (say a second loop fed by the first loop's collector) can be
 * visited first and its body would run against inputs nobody produced yet.
 *
 * @param graph The graph to order.
 * @returns Nodes in run order, or `null` when the graph contains a cycle.
 */
function executionOrder(graph: ProcessingModelGraph): ModelGraphNode[] | null {
  const base = topologicalOrder(graph);
  if (!base) return null;
  const extra: ProcessingModelGraph["edges"] = [];
  for (const node of graph.nodes) {
    if (node.kind !== "iterate-features" && node.kind !== "iterate-rasters") continue;
    if (node.body) continue;
    const collector = findDownstreamCollector(graph, node.id);
    if (!collector) continue;
    const bodyIds = new Set(findNodesBetween(graph, node.id, collector.id).map((n) => n.id));
    for (const anc of findExternalAncestors(graph, bodyIds, node.id, new Set())) {
      extra.push({
        id: `order:${anc.id}:${node.id}`,
        from: anc.id,
        fromPort: "",
        to: node.id,
        toPort: "",
      });
    }
  }
  if (extra.length === 0) return base;
  return topologicalOrder({ ...graph, edges: [...graph.edges, ...extra] }) ?? base;
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
      // Only control nodes read a layer named in their settings; a tool's
      // unwired port must still be connected or typed.
      if (
        node.kind !== "tool" &&
        sourceLayerId(node) &&
        (port.id === "collection" || port.id === "input" || port.id === "layer")
      )
        continue;
      issues.push({
        code: "missing-input",
        nodeId: node.id,
        detail: port.label,
        message: `"${port.label}" needs a connection or a value.`,
      });
    }

    if (node.kind === "iterate-features") {
      const hasCollectionEdge = filled.get(node.id)?.has(ITERATE_FEATURES_INPUT_PORT);
      const hasLayer = !!node.layerId || !!node.parameters?.layer;
      if (!hasCollectionEdge && !hasLayer) {
        issues.push({
          code: "missing-input",
          nodeId: node.id,
          detail: "collection",
          message: "Iterate Features requires an input collection connection or layer.",
        });
      }
      const collector = findDownstreamCollector(graph, node.id);
      const hasBody = !!node.body && node.body.nodes.length > 0;
      if (!collector && !hasBody) {
        issues.push({
          code: "invalid-iterator",
          nodeId: node.id,
          message: "Iterator node requires an iteration body or a downstream Collect Results node.",
        });
      } else if (collector) {
        const bodyNodes = findNodesBetween(graph, node.id, collector.id);
        const bodyIds = new Set(bodyNodes.map((bn) => bn.id));
        for (const bn of bodyNodes) {
          if (bn.kind === "iterate-features" || bn.kind === "iterate-rasters") {
            issues.push({
              code: "invalid-iterator",
              nodeId: bn.id,
              message:
                "A loop inside a Collect Results loop body is not supported; use an iteration body.",
            });
          }
        }
        for (const edge of graph.edges) {
          if (bodyIds.has(edge.from) && edge.to !== collector.id && !bodyIds.has(edge.to)) {
            issues.push({
              code: "invalid-iterator",
              nodeId: edge.from,
              edgeId: edge.id,
              message:
                "Nodes inside an iteration body can only feed other body nodes or the collector.",
            });
          }
        }
      }
      if (node.body) {
        const bodyIssues = validateModelGraph(node.body, resolve);
        for (const bi of bodyIssues) {
          issues.push({ ...bi, nodeId: node.id, message: `Iteration body: ${bi.message}` });
        }
      }
    }
    if (node.kind === "iterate-rasters") {
      const hasCollectionEdge = filled.get(node.id)?.has(ITERATE_RASTERS_INPUT_PORT);
      const hasLayers =
        (Array.isArray(node.parameters?.layers) &&
          (node.parameters.layers as unknown[]).length > 0) ||
        (typeof node.parameters?.layers === "string" &&
          (node.parameters.layers as string).trim().length > 0) ||
        !!node.layerId;
      if (!hasCollectionEdge && !hasLayers) {
        issues.push({
          code: "missing-input",
          nodeId: node.id,
          detail: "collection",
          message:
            "Iterate Rasters requires an input collection connection or configured raster layers.",
        });
      }
      const collector = findDownstreamCollector(graph, node.id);
      const hasBody = !!node.body && node.body.nodes.length > 0;
      if (!collector && !hasBody) {
        issues.push({
          code: "invalid-iterator",
          nodeId: node.id,
          message: "Iterator node requires an iteration body or a downstream Collect Results node.",
        });
      } else if (collector) {
        const bodyNodes = findNodesBetween(graph, node.id, collector.id);
        const bodyIds = new Set(bodyNodes.map((bn) => bn.id));
        for (const bn of bodyNodes) {
          if (bn.kind === "iterate-features" || bn.kind === "iterate-rasters") {
            issues.push({
              code: "invalid-iterator",
              nodeId: bn.id,
              message:
                "A loop inside a Collect Results loop body is not supported; use an iteration body.",
            });
          }
        }
        for (const edge of graph.edges) {
          if (bodyIds.has(edge.from) && edge.to !== collector.id && !bodyIds.has(edge.to)) {
            issues.push({
              code: "invalid-iterator",
              nodeId: edge.from,
              edgeId: edge.id,
              message:
                "Nodes inside an iteration body can only feed other body nodes or the collector.",
            });
          }
        }
      }
      if (node.body) {
        const bodyIssues = validateModelGraph(node.body, resolve);
        for (const bi of bodyIssues) {
          issues.push({ ...bi, nodeId: node.id, message: `Iteration body: ${bi.message}` });
        }
      }
    }
    if (node.kind === "collect-results") {
      if (!filled.get(node.id)?.has(COLLECT_RESULTS_INPUT_PORT)) {
        issues.push({
          code: "missing-input",
          nodeId: node.id,
          detail: "item",
          message: "Collect Results requires an incoming connection to collect.",
        });
      }
    }
    if (node.kind === "conditional-switch") {
      if (
        !filled.get(node.id)?.has(SWITCH_INPUT_PORT) &&
        !node.parameters?.input &&
        !node.layerId
      ) {
        issues.push({
          code: "missing-input",
          nodeId: node.id,
          detail: "input",
          message: "Conditional Switch requires an incoming data connection to route.",
        });
      }
    }
    if (node.kind === "conditional-merge") {
      const hasTrue = filled.get(node.id)?.has(MERGE_TRUE_PORT);
      const hasFalse = filled.get(node.id)?.has(MERGE_FALSE_PORT);
      if (!hasTrue && !hasFalse) {
        issues.push({
          code: "missing-input",
          nodeId: node.id,
          message: "Conditional Merge requires at least one branch input connection.",
        });
      }
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
  onNodeStatus?: (nodeId: string, status: "running" | "done" | "error" | "skipped") => void;
  /** Optional callback for iteration progress. */
  onIterationProgress?: (nodeId: string, current: number, total: number) => void;
}

/** Outcome of a {@link runModelGraph} call. */
export interface ModelGraphRunResult {
  /** Output-node values produced, keyed by node id. */
  outputs: Record<string, ModelValue>;
  /** Set when the run stopped early; names the failing node when there is one. */
  error?: { nodeId?: string; message: string };
}

/**
 * The layer a control node reads when nothing is wired in: its `layerId`, or a
 * layer id in `parameters.layer` (which the AI Assistant writes).
 *
 * @param node The node.
 * @returns The layer id, or `undefined` when neither is set.
 */
function sourceLayerId(node: ModelGraphNode): string | undefined {
  if (node.layerId) return node.layerId;
  const layer = node.parameters?.layer;
  return typeof layer === "string" && layer ? layer : undefined;
}

/**
 * The layer id a Conditional Switch routes when no data edge is wired in: its
 * `layerId`, or a layer id in `parameters.input` (validation accepts both).
 *
 * @param node The switch node.
 * @returns The layer id, or `undefined` when neither is set.
 */
export function switchSourceLayerId(node: ModelGraphNode): string | undefined {
  if (node.layerId) return node.layerId;
  const input = node.parameters?.input;
  return typeof input === "string" && input ? input : undefined;
}

/** Resolve a Conditional Switch's unwired data input from its layer, if it names one. */
async function resolveSwitchLayer(
  node: ModelGraphNode,
  options: RunModelGraphOptions,
): Promise<ModelValue | undefined> {
  const layerId = switchSourceLayerId(node);
  return layerId ? ((await options.resolveInput(layerId)) ?? undefined) : undefined;
}

/**
 * Read a value as a boolean when it plainly is one: a boolean, or the text
 * "true"/"false"/"1"/"0" (any case). Anything else returns `undefined`.
 *
 * @param value The value to read.
 * @returns The boolean, or `undefined` when the value is not boolean-like.
 */
function booleanLike(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const text = value.trim().toLowerCase();
  if (text === "true" || text === "1") return true;
  if (text === "false" || text === "0") return false;
  return undefined;
}

/**
 * An iterator's iteration cap: a positive whole `maxIterations`, else 1000.
 * Matches the inspector, which stores only positive whole numbers, so a zero or
 * negative value in a hand-edited project never silently runs nothing.
 *
 * @param node The iterator node.
 * @returns The maximum number of iterations to run.
 */
function iterationLimit(node: ModelGraphNode): number {
  const value = Number(node.parameters?.maxIterations);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 1000;
}

const SKIPPED = Symbol("SKIPPED");
type ValueOrSkipped = ModelValue | typeof SKIPPED;

async function executeSingleNode(
  node: ModelGraphNode,
  graph: ProcessingModelGraph,
  produced: Map<string, Record<string, ValueOrSkipped>>,
  options: RunModelGraphOptions,
  descriptors: Map<string, ModelToolDescriptor | undefined>,
): Promise<{ error?: string }> {
  const incoming = graph.edges.filter((e) => e.to === node.id);
  const inputs: Record<string, ModelValue> = {};
  let anyInputReal = false;
  let anyInputSkipped = false;
  let allIncomingSkipped = incoming.length > 0;
  for (const edge of incoming) {
    const val = produced.get(edge.from)?.[edge.fromPort];
    if (val === SKIPPED) {
      anyInputSkipped = true;
    } else if (val !== undefined) {
      inputs[edge.toPort] = val;
      anyInputReal = true;
      allIncomingSkipped = false;
    } else {
      allIncomingSkipped = false;
    }
  }

  // A node fed by an unselected branch sits on that branch, even when another
  // input is live; only a merge exists to take one live branch out of two.
  if (node.kind === "conditional-merge") {
    if (anyInputReal) allIncomingSkipped = false;
  } else if (anyInputSkipped) {
    allIncomingSkipped = true;
  }

  if (allIncomingSkipped) {
    options.onNodeStatus?.(node.id, "skipped");
    const skipOutputs: Record<string, typeof SKIPPED> = {};
    for (const port of portsFor(node, descriptors.get(node.id)).outputs) {
      skipOutputs[port.id] = SKIPPED;
    }
    produced.set(node.id, skipOutputs);
    return {};
  }

  if (node.kind === "conditional-switch") {
    options.onNodeStatus?.(node.id, "running");
    const inputVal = inputs[SWITCH_INPUT_PORT] ?? (await resolveSwitchLayer(node, options));
    if (!inputVal) return { error: `Conditional Switch "${node.id}" has no incoming data input.` };
    const condVal = inputs[SWITCH_CONDITION_PORT];
    const cond = evaluateCondition({
      inputValue: inputVal,
      conditionValue: condVal,
      parameters: node.parameters,
    });
    if (cond) {
      produced.set(node.id, { [SWITCH_TRUE_PORT]: inputVal, [SWITCH_FALSE_PORT]: SKIPPED });
    } else {
      produced.set(node.id, { [SWITCH_TRUE_PORT]: SKIPPED, [SWITCH_FALSE_PORT]: inputVal });
    }
    options.onNodeStatus?.(node.id, "done");
    return {};
  }

  if (node.kind === "conditional-merge") {
    options.onNodeStatus?.(node.id, "running");
    const activeVal = inputs[MERGE_TRUE_PORT] ?? inputs[MERGE_FALSE_PORT];
    if (!activeVal)
      return { error: `Conditional Merge "${node.id}" received no active branch result.` };
    produced.set(node.id, { [MERGE_OUTPUT_PORT]: activeVal });
    options.onNodeStatus?.(node.id, "done");
    return {};
  }

  if (node.kind === "tool") {
    const descriptor = descriptors.get(node.id);
    if (!descriptor) return { error: `Unknown tool "${node.toolId ?? ""}"` };
    for (const port of descriptor.inputs) {
      if (inputs[port.id]) continue;
      const typed = node.parameters?.[port.id];
      if (typeof typed !== "string" || !typed) continue;
      const val = await options.resolveInput(typed);
      if (val) inputs[port.id] = val;
    }
    options.onNodeStatus?.(node.id, "running");
    options.log(`Running ${descriptor.name}...`);
    try {
      const result = await options.executeTool({
        node,
        descriptor,
        inputs,
        signal: options.signal,
      });
      produced.set(node.id, result);
      options.onNodeStatus?.(node.id, "done");
      return {};
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: message };
    }
  }

  // Inputs and outputs never sit inside a loop body, and a nested loop or an
  // extra collector would otherwise be a silent no-op that leaves the real
  // collector empty.
  return { error: `A "${node.kind}" node cannot run inside a loop body.` };
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
 * Supports conditional branching (evaluating switches, routing active branches,
 * skipping unselected branches), iteration loops (features and rasters), and result
 * collection.
 *
 * @param graph The graph to run.
 * @param options Resolution, execution and reporting hooks.
 * @returns The produced outputs plus the first error, if any.
 */
export async function runModelGraph(
  graph: ProcessingModelGraph,
  options: RunModelGraphOptions,
): Promise<ModelGraphRunResult> {
  const ordered = executionOrder(graph);
  const outputs: Record<string, ModelValue> = {};
  if (!ordered) {
    return { outputs, error: { message: "The model contains a loop." } };
  }

  const descriptors = new Map<string, ModelToolDescriptor | undefined>();
  for (const node of graph.nodes) {
    if (node.kind === "tool")
      descriptors.set(node.id, options.resolveDescriptor(node.provider, node.toolId));
  }

  const produced = new Map<string, Record<string, ValueOrSkipped>>();
  const incoming = new Map<string, typeof graph.edges>();
  for (const edge of graph.edges) {
    const list = incoming.get(edge.to) ?? [];
    list.push(edge);
    incoming.set(edge.to, list);
  }

  const handledNodes = new Set<string>();

  for (const node of ordered) {
    if (handledNodes.has(node.id)) continue;
    if (options.signal?.aborted) {
      return { outputs, error: { nodeId: node.id, message: "Run cancelled." } };
    }

    // Gather upstream values
    const incomingEdges = incoming.get(node.id) ?? [];
    const inputs: Record<string, ModelValue> = {};
    let anyInputReal = false;
    let anyInputSkipped = false;
    let allIncomingSkipped = incomingEdges.length > 0;
    for (const edge of incomingEdges) {
      const value = produced.get(edge.from)?.[edge.fromPort];
      if (value === SKIPPED) {
        anyInputSkipped = true;
      } else if (value !== undefined) {
        inputs[edge.toPort] = value;
        anyInputReal = true;
        allIncomingSkipped = false;
      } else {
        allIncomingSkipped = false;
      }
    }

    // A node fed by an unselected branch sits on that branch, even when another
    // input is live; only a merge exists to take one live branch out of two.
    if (node.kind === "conditional-merge") {
      if (anyInputReal) allIncomingSkipped = false;
    } else if (anyInputSkipped) {
      allIncomingSkipped = true;
    }

    if (allIncomingSkipped) {
      options.onNodeStatus?.(node.id, "skipped");
      options.log(`Skipping "${node.id}" (${node.kind}) - branch not selected`);
      const skipOutputs: Record<string, typeof SKIPPED> = {};
      for (const port of portsFor(node, descriptors.get(node.id)).outputs) {
        skipOutputs[port.id] = SKIPPED;
      }
      produced.set(node.id, skipOutputs);
      continue;
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
        if (value.kind === "raster-collection") {
          value.items.forEach((item, idx) => {
            const subName = item.name ? `${name} - ${item.name}` : `${name} ${idx + 1}`;
            options.emitOutput(
              subName,
              { kind: "raster", bytes: item.bytes, name: item.name, metadata: item.metadata },
              node,
            );
          });
        } else {
          options.emitOutput(name, value, node);
        }
        outputs[node.id] = value;
        options.onNodeStatus?.(node.id, "done");
        continue;
      }

      if (node.kind === "conditional-switch") {
        options.onNodeStatus?.(node.id, "running");
        const inputVal = inputs[SWITCH_INPUT_PORT] ?? (await resolveSwitchLayer(node, options));
        if (!inputVal) {
          const message = `Conditional Switch "${node.id}" has no incoming data input.`;
          options.log(`Error: ${message}`);
          options.onNodeStatus?.(node.id, "error");
          return { outputs, error: { nodeId: node.id, message } };
        }
        const condVal = inputs[SWITCH_CONDITION_PORT];
        const cond = evaluateCondition({
          inputValue: inputVal,
          conditionValue: condVal,
          parameters: node.parameters,
        });
        if (cond) {
          options.log(`Switch "${node.id}": condition TRUE -> True branch`);
          produced.set(node.id, {
            [SWITCH_TRUE_PORT]: inputVal,
            [SWITCH_FALSE_PORT]: SKIPPED,
          });
        } else {
          options.log(`Switch "${node.id}": condition FALSE -> False branch`);
          produced.set(node.id, {
            [SWITCH_TRUE_PORT]: SKIPPED,
            [SWITCH_FALSE_PORT]: inputVal,
          });
        }
        options.onNodeStatus?.(node.id, "done");
        continue;
      }

      if (node.kind === "conditional-merge") {
        options.onNodeStatus?.(node.id, "running");
        const activeVal = inputs[MERGE_TRUE_PORT] ?? inputs[MERGE_FALSE_PORT];
        if (!activeVal) {
          const message = `Conditional Merge "${node.id}" received no active branch result.`;
          options.log(`Error: ${message}`);
          options.onNodeStatus?.(node.id, "error");
          return { outputs, error: { nodeId: node.id, message } };
        }
        produced.set(node.id, { [MERGE_OUTPUT_PORT]: activeVal });
        options.onNodeStatus?.(node.id, "done");
        continue;
      }

      if (node.kind === "iterate-features") {
        options.onNodeStatus?.(node.id, "running");
        let collectionVal = inputs[ITERATE_FEATURES_INPUT_PORT];
        const layerSource = sourceLayerId(node);
        if (!collectionVal && layerSource) {
          const resolved = await options.resolveInput(layerSource);
          if (resolved) collectionVal = resolved;
        }
        if (!collectionVal || collectionVal.kind !== "vector") {
          const message = `Iterate Features "${node.id}" requires a vector FeatureCollection.`;
          options.log(`Error: ${message}`);
          options.onNodeStatus?.(node.id, "error");
          return { outputs, error: { nodeId: node.id, message } };
        }
        const features = collectionVal.geojson.features;
        const maxIterations = iterationLimit(node);
        const stopOnError = node.parameters?.stopOnError !== false;
        const count = Math.min(features.length, maxIterations);
        options.log(
          `Iterate Features "${node.id}": running iteration over ${count} features (total: ${features.length}).`,
        );

        if (node.body) {
          const collected: FeatureCollection["features"] = [];
          for (let i = 0; i < count; i++) {
            if (options.signal?.aborted)
              return { outputs, error: { nodeId: node.id, message: "Run cancelled." } };
            const feature = features[i];
            options.onIterationProgress?.(node.id, i + 1, count);
            const singleFC: FeatureCollection = { type: "FeatureCollection", features: [feature] };
            const subResult = await runModelGraph(node.body, {
              ...options,
              resolveInput: (layerId) => {
                if (
                  layerId === "current" ||
                  layerId === "item" ||
                  layerId === "feature" ||
                  !layerId
                ) {
                  return { kind: "vector", geojson: singleFC };
                }
                return options.resolveInput(layerId);
              },
              emitOutput: () => {},
            });
            if (subResult.error) {
              const message = `Iteration ${i + 1}/${count} failed: ${subResult.error.message}`;
              if (stopOnError) {
                options.log(`Error: ${message}`);
                options.onNodeStatus?.(node.id, "error");
                return { outputs, error: { nodeId: node.id, message } };
              } else {
                options.log(`Warning: ${message}; continuing.`);
              }
            } else {
              for (const outVal of Object.values(subResult.outputs)) {
                if (outVal.kind === "vector") collected.push(...outVal.geojson.features);
              }
            }
          }
          const resVal: ModelValue = {
            kind: "vector",
            geojson: { type: "FeatureCollection", features: collected },
          };
          produced.set(node.id, {
            [ITERATE_FEATURES_OUTPUT_FEATURE]: resVal,
            [ITERATE_FEATURES_OUTPUT_INDEX]: { kind: "number", value: count - 1 },
            [ITERATE_FEATURES_OUTPUT_COUNT]: { kind: "number", value: features.length },
          });
          options.onNodeStatus?.(node.id, "done");
          continue;
        }

        const collector = findDownstreamCollector(graph, node.id);
        if (collector) {
          const bodyNodes = findNodesBetween(graph, node.id, collector.id);
          const extAncestors = findExternalAncestors(
            graph,
            new Set(bodyNodes.map((n) => n.id)),
            node.id,
            new Set([...produced.keys(), ...handledNodes]),
          );
          for (const anc of extAncestors) {
            const ancRes = await executeSingleNode(anc, graph, produced, options, descriptors);
            if (ancRes.error) {
              options.onNodeStatus?.(anc.id, "error");
              return { outputs, error: { nodeId: anc.id, message: ancRes.error } };
            }
            handledNodes.add(anc.id);
          }

          const collectedFeatures: FeatureCollection["features"] = [];
          const collectedRasters: Array<{
            bytes: Uint8Array;
            name?: string;
            metadata?: Record<string, unknown>;
          }> = [];
          let hasVector = false;
          let hasRaster = false;

          for (let i = 0; i < count; i++) {
            if (options.signal?.aborted)
              return { outputs, error: { nodeId: node.id, message: "Run cancelled." } };
            const feature = features[i];
            options.onIterationProgress?.(node.id, i + 1, count);
            const singleFC: FeatureCollection = { type: "FeatureCollection", features: [feature] };
            const iterProduced = new Map(produced);
            iterProduced.set(node.id, {
              [ITERATE_FEATURES_OUTPUT_FEATURE]: { kind: "vector", geojson: singleFC },
              [ITERATE_FEATURES_OUTPUT_INDEX]: { kind: "number", value: i },
              [ITERATE_FEATURES_OUTPUT_COUNT]: { kind: "number", value: features.length },
            });
            let iterFailed = false;
            for (const bn of bodyNodes) {
              const stepRes = await executeSingleNode(
                bn,
                graph,
                iterProduced,
                options,
                descriptors,
              );
              if (stepRes.error) {
                iterFailed = true;
                const message = `Iteration ${i + 1}/${count} failed at "${bn.id}": ${stepRes.error}`;
                if (stopOnError) {
                  options.log(`Error: ${message}`);
                  options.onNodeStatus?.(bn.id, "error");
                  return { outputs, error: { nodeId: bn.id, message } };
                } else {
                  options.log(`Warning: ${message}; continuing.`);
                }
                break;
              }
            }
            if (!iterFailed) {
              for (const edge of incoming.get(collector.id) ?? []) {
                const val = iterProduced.get(edge.from)?.[edge.fromPort];
                if (val && val !== SKIPPED) {
                  if (val.kind === "vector") {
                    hasVector = true;
                    collectedFeatures.push(...val.geojson.features);
                  } else if (val.kind === "raster") {
                    hasRaster = true;
                    collectedRasters.push({
                      bytes: val.bytes,
                      name: val.name,
                      metadata: val.metadata,
                    });
                  } else if (val.kind === "raster-collection") {
                    hasRaster = true;
                    collectedRasters.push(...val.items);
                  }
                }
              }
            }
          }

          if (hasVector && hasRaster) {
            const message = "Collector received mixed vector and raster results across iterations.";
            options.log(`Error: ${message}`);
            options.onNodeStatus?.(collector.id, "error");
            return { outputs, error: { nodeId: collector.id, message } };
          }

          for (const bn of bodyNodes) {
            handledNodes.add(bn.id);
            options.onNodeStatus?.(bn.id, "done");
          }
          handledNodes.add(collector.id);
          options.onNodeStatus?.(collector.id, "done");

          let resVal: ModelValue;
          if (hasRaster) {
            resVal = {
              kind: "raster-collection",
              items: collectedRasters,
            };
            produced.set(collector.id, {
              [COLLECT_RESULTS_OUTPUT_PORT]: resVal,
              [COLLECT_RESULTS_OUTPUT_COUNT]: { kind: "number", value: collectedRasters.length },
            });
          } else {
            resVal = {
              kind: "vector",
              geojson: { type: "FeatureCollection", features: collectedFeatures },
            };
            produced.set(collector.id, {
              [COLLECT_RESULTS_OUTPUT_PORT]: resVal,
              [COLLECT_RESULTS_OUTPUT_COUNT]: { kind: "number", value: collectedFeatures.length },
            });
          }

          produced.set(node.id, {
            [ITERATE_FEATURES_OUTPUT_FEATURE]: resVal,
            [ITERATE_FEATURES_OUTPUT_INDEX]: { kind: "number", value: count - 1 },
            [ITERATE_FEATURES_OUTPUT_COUNT]: { kind: "number", value: features.length },
          });
          options.onNodeStatus?.(node.id, "done");
          continue;
        }

        const message =
          "Iterate Features requires an iteration body or a downstream Collect Results node.";
        options.log(`Error: ${message}`);
        options.onNodeStatus?.(node.id, "error");
        return { outputs, error: { nodeId: node.id, message } };
      }

      if (node.kind === "iterate-rasters") {
        options.onNodeStatus?.(node.id, "running");
        let rasterItems: Array<{
          bytes: Uint8Array;
          name?: string;
          metadata?: Record<string, unknown>;
        }> = [];
        const incomingColl = inputs[ITERATE_RASTERS_INPUT_PORT];
        if (incomingColl) {
          if (incomingColl.kind === "raster-collection") {
            rasterItems = incomingColl.items;
          } else if (incomingColl.kind === "raster") {
            rasterItems = [
              {
                bytes: incomingColl.bytes,
                name: incomingColl.name,
                metadata: incomingColl.metadata,
              },
            ];
          } else {
            // Otherwise the loop would run zero times and "succeed" empty.
            const message = `Iterate Rasters "${node.id}" requires rasters, but received ${incomingColl.kind} data.`;
            options.log(`Error: ${message}`);
            options.onNodeStatus?.(node.id, "error");
            return { outputs, error: { nodeId: node.id, message } };
          }
        } else if (node.parameters?.layers) {
          const layerList = Array.isArray(node.parameters.layers)
            ? (node.parameters.layers as string[])
            : String(node.parameters.layers)
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
          for (const lid of layerList) {
            const res = await options.resolveInput(lid);
            if (res && res.kind === "raster") {
              rasterItems.push({ bytes: res.bytes, name: res.name ?? lid, metadata: res.metadata });
            }
          }
        } else if (node.layerId) {
          const res = await options.resolveInput(node.layerId);
          if (res && res.kind === "raster") {
            rasterItems.push({
              bytes: res.bytes,
              name: res.name ?? node.layerId,
              metadata: res.metadata,
            });
          }
        }

        const maxIterations = iterationLimit(node);
        const stopOnError = node.parameters?.stopOnError !== false;
        const count = Math.min(rasterItems.length, maxIterations);
        options.log(
          `Iterate Rasters "${node.id}": running iteration over ${count} rasters (total: ${rasterItems.length}).`,
        );

        if (node.body) {
          const collectedRasters: Array<{
            bytes: Uint8Array;
            name?: string;
            metadata?: Record<string, unknown>;
          }> = [];
          for (let i = 0; i < count; i++) {
            if (options.signal?.aborted)
              return { outputs, error: { nodeId: node.id, message: "Run cancelled." } };
            const rItem = rasterItems[i];
            options.onIterationProgress?.(node.id, i + 1, count);
            const singleRasterVal: ModelValue = {
              kind: "raster",
              bytes: rItem.bytes,
              name: rItem.name,
              metadata: rItem.metadata,
            };
            const subResult = await runModelGraph(node.body, {
              ...options,
              resolveInput: (layerId) => {
                if (
                  layerId === "current" ||
                  layerId === "item" ||
                  layerId === "raster" ||
                  !layerId
                ) {
                  return singleRasterVal;
                }
                return options.resolveInput(layerId);
              },
              emitOutput: () => {},
            });
            if (subResult.error) {
              const message = `Iteration ${i + 1}/${count} failed: ${subResult.error.message}`;
              if (stopOnError) {
                options.log(`Error: ${message}`);
                options.onNodeStatus?.(node.id, "error");
                return { outputs, error: { nodeId: node.id, message } };
              } else {
                options.log(`Warning: ${message}; continuing.`);
              }
            } else {
              for (const outVal of Object.values(subResult.outputs)) {
                if (outVal.kind === "raster") {
                  collectedRasters.push({
                    bytes: outVal.bytes,
                    name: outVal.name ?? rItem.name,
                    metadata: outVal.metadata,
                  });
                } else if (outVal.kind === "raster-collection") {
                  collectedRasters.push(...outVal.items);
                }
              }
            }
          }
          const resVal: ModelValue = {
            kind: "raster-collection",
            items: collectedRasters,
          };
          produced.set(node.id, {
            [ITERATE_RASTERS_OUTPUT_RASTER]: resVal,
            [ITERATE_RASTERS_OUTPUT_NAME]: {
              kind: "string",
              value: collectedRasters[0]?.name ?? "",
            },
            [ITERATE_RASTERS_OUTPUT_INDEX]: { kind: "number", value: count - 1 },
            [ITERATE_RASTERS_OUTPUT_COUNT]: { kind: "number", value: rasterItems.length },
          });
          options.onNodeStatus?.(node.id, "done");
          continue;
        }

        const collector = findDownstreamCollector(graph, node.id);
        if (collector) {
          const bodyNodes = findNodesBetween(graph, node.id, collector.id);
          const extAncestors = findExternalAncestors(
            graph,
            new Set(bodyNodes.map((n) => n.id)),
            node.id,
            new Set([...produced.keys(), ...handledNodes]),
          );
          for (const anc of extAncestors) {
            const ancRes = await executeSingleNode(anc, graph, produced, options, descriptors);
            if (ancRes.error) {
              options.onNodeStatus?.(anc.id, "error");
              return { outputs, error: { nodeId: anc.id, message: ancRes.error } };
            }
            handledNodes.add(anc.id);
          }

          const collectedFeatures: GeoJSON.Feature[] = [];
          const collectedRasters: Array<{
            bytes: Uint8Array;
            name?: string;
            metadata?: Record<string, unknown>;
          }> = [];
          let hasVector = false;
          let hasRaster = false;

          for (let i = 0; i < count; i++) {
            if (options.signal?.aborted)
              return { outputs, error: { nodeId: node.id, message: "Run cancelled." } };
            const rItem = rasterItems[i];
            options.onIterationProgress?.(node.id, i + 1, count);
            const singleRasterVal: ModelValue = {
              kind: "raster",
              bytes: rItem.bytes,
              name: rItem.name,
              metadata: rItem.metadata,
            };
            const iterProduced = new Map(produced);
            iterProduced.set(node.id, {
              [ITERATE_RASTERS_OUTPUT_RASTER]: singleRasterVal,
              [ITERATE_RASTERS_OUTPUT_NAME]: { kind: "string", value: rItem.name ?? "" },
              [ITERATE_RASTERS_OUTPUT_INDEX]: { kind: "number", value: i },
              [ITERATE_RASTERS_OUTPUT_COUNT]: { kind: "number", value: rasterItems.length },
            });
            let iterFailed = false;
            for (const bn of bodyNodes) {
              const stepRes = await executeSingleNode(
                bn,
                graph,
                iterProduced,
                options,
                descriptors,
              );
              if (stepRes.error) {
                iterFailed = true;
                const message = `Iteration ${i + 1}/${count} failed at "${bn.id}": ${stepRes.error}`;
                if (stopOnError) {
                  options.log(`Error: ${message}`);
                  options.onNodeStatus?.(bn.id, "error");
                  return { outputs, error: { nodeId: bn.id, message } };
                } else {
                  options.log(`Warning: ${message}; continuing.`);
                }
                break;
              }
            }
            if (!iterFailed) {
              for (const edge of incoming.get(collector.id) ?? []) {
                const val = iterProduced.get(edge.from)?.[edge.fromPort];
                if (val && val !== SKIPPED) {
                  if (val.kind === "vector") {
                    hasVector = true;
                    collectedFeatures.push(...val.geojson.features);
                  } else if (val.kind === "raster") {
                    hasRaster = true;
                    collectedRasters.push({
                      bytes: val.bytes,
                      name: val.name ?? rItem.name,
                      metadata: val.metadata,
                    });
                  } else if (val.kind === "raster-collection") {
                    hasRaster = true;
                    collectedRasters.push(...val.items);
                  }
                }
              }
            }
          }

          if (hasVector && hasRaster) {
            const message = "Collector received mixed vector and raster results across iterations.";
            options.log(`Error: ${message}`);
            options.onNodeStatus?.(collector.id, "error");
            return { outputs, error: { nodeId: collector.id, message } };
          }

          for (const bn of bodyNodes) {
            handledNodes.add(bn.id);
            options.onNodeStatus?.(bn.id, "done");
          }
          handledNodes.add(collector.id);
          options.onNodeStatus?.(collector.id, "done");

          let resVal: ModelValue;
          if (hasVector) {
            resVal = {
              kind: "vector",
              geojson: { type: "FeatureCollection", features: collectedFeatures },
            };
            produced.set(collector.id, {
              [COLLECT_RESULTS_OUTPUT_PORT]: resVal,
              [COLLECT_RESULTS_OUTPUT_COUNT]: { kind: "number", value: collectedFeatures.length },
            });
          } else {
            resVal = {
              kind: "raster-collection",
              items: collectedRasters,
            };
            produced.set(collector.id, {
              [COLLECT_RESULTS_OUTPUT_PORT]: resVal,
              [COLLECT_RESULTS_OUTPUT_COUNT]: { kind: "number", value: collectedRasters.length },
            });
          }

          produced.set(node.id, {
            [ITERATE_RASTERS_OUTPUT_RASTER]: resVal,
            [ITERATE_RASTERS_OUTPUT_NAME]: {
              kind: "string",
              value: collectedRasters[0]?.name ?? "",
            },
            [ITERATE_RASTERS_OUTPUT_INDEX]: { kind: "number", value: count - 1 },
            [ITERATE_RASTERS_OUTPUT_COUNT]: { kind: "number", value: rasterItems.length },
          });
          options.onNodeStatus?.(node.id, "done");
          continue;
        }

        const message =
          "Iterate Rasters requires an iteration body or a downstream Collect Results node.";
        options.log(`Error: ${message}`);
        options.onNodeStatus?.(node.id, "error");
        return { outputs, error: { nodeId: node.id, message } };
      }

      if (node.kind === "collect-results") {
        options.onNodeStatus?.(node.id, "running");
        const itemVal = inputs[COLLECT_RESULTS_INPUT_PORT];
        if (itemVal) {
          produced.set(node.id, {
            [COLLECT_RESULTS_OUTPUT_PORT]: itemVal,
            [COLLECT_RESULTS_OUTPUT_COUNT]: { kind: "number", value: 1 },
          });
        }
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
