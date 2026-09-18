import type {
  ModelGraphEdge,
  ModelGraphNode,
  ModelGraphNodeKind,
  ModelToolProvider,
  ProcessingModelGraph,
} from "@geolibre/core";
import { OUTPUT_NODE_PORT, type ModelToolDescriptor } from "@geolibre/processing";

/** An empty canvas. */
export function emptyModelGraph(): ProcessingModelGraph {
  return { nodes: [], edges: [] };
}

/** Card footprint used for collision checks, matching the canvas renderer. */
export const NODE_WIDTH = 168;
export const NODE_HEIGHT = 64;
const NODE_GAP = 16;

/**
 * Nudge a preferred position down until the card would not overlap an existing
 * one.
 *
 * Overlapping cards do not just look untidy: the one painted on top swallows
 * the hit-test for the other's connector dots, so a port underneath cannot be
 * wired at all. Placement therefore has to guarantee a clear footprint rather
 * than merely stagger by a few pixels.
 *
 * @param graph The current graph.
 * @param preferred Where the caller would like the node to go.
 * @returns The first free position at or below `preferred`.
 */
export function findFreePosition(
  graph: ProcessingModelGraph,
  preferred: { x: number; y: number },
): { x: number; y: number } {
  const overlaps = (x: number, y: number): boolean =>
    graph.nodes.some(
      (node) =>
        x < node.x + NODE_WIDTH + NODE_GAP &&
        x + NODE_WIDTH + NODE_GAP > node.x &&
        y < node.y + NODE_HEIGHT + NODE_GAP &&
        y + NODE_HEIGHT + NODE_GAP > node.y,
    );
  let { x, y } = preferred;
  // Bounded so a pathological graph cannot spin here; past that the user can
  // drag the node somewhere sensible themselves.
  for (let attempt = 0; attempt < 200 && overlaps(x, y); attempt++) {
    y += NODE_HEIGHT + NODE_GAP;
  }
  return { x, y };
}

/**
 * Add an `input` or `output` node at a canvas position.
 *
 * @param graph The current graph.
 * @param kind Which of the two non-tool node kinds to add.
 * @param position Canvas coordinates for the new node.
 * @param createId Id factory.
 * @returns The updated graph and the new node's id.
 */
export function addDataNode(
  graph: ProcessingModelGraph,
  kind: Extract<ModelGraphNodeKind, "input" | "output">,
  position: { x: number; y: number },
  createId: () => string,
): { graph: ProcessingModelGraph; nodeId: string } {
  const nodeId = createId();
  const free = findFreePosition(graph, position);
  const node: ModelGraphNode = {
    id: nodeId,
    kind,
    x: free.x,
    y: free.y,
    ...(kind === "output" ? { name: "" } : {}),
  };
  return { graph: { ...graph, nodes: [...graph.nodes, node] }, nodeId };
}

/**
 * Add a tool node, seeded with the descriptor's documented parameter defaults so
 * a freshly dropped node is runnable without opening every field first.
 *
 * @param graph The current graph.
 * @param descriptor The palette entry being dropped.
 * @param position Canvas coordinates for the new node.
 * @param createId Id factory.
 * @returns The updated graph and the new node's id.
 */
export function addToolNode(
  graph: ProcessingModelGraph,
  descriptor: ModelToolDescriptor,
  position: { x: number; y: number },
  createId: () => string,
): { graph: ProcessingModelGraph; nodeId: string } {
  const parameters: Record<string, unknown> = {};
  for (const param of descriptor.parameters) {
    if (param.default !== undefined) parameters[param.id] = param.default;
  }
  const nodeId = createId();
  const free = findFreePosition(graph, position);
  const node: ModelGraphNode = {
    id: nodeId,
    kind: "tool",
    x: free.x,
    y: free.y,
    provider: descriptor.provider as ModelToolProvider,
    toolId: descriptor.toolId,
    parameters,
  };
  return { graph: { ...graph, nodes: [...graph.nodes, node] }, nodeId };
}

/** Move a node to a new canvas position, following the pointer exactly. */
export function moveNode(
  graph: ProcessingModelGraph,
  nodeId: string,
  position: { x: number; y: number },
): ProcessingModelGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) =>
      node.id === nodeId ? { ...node, x: position.x, y: position.y } : node,
    ),
  };
}

/**
 * Settle a just-dragged node so it does not sit on top of another card.
 *
 * Cards are painted in array order with no z-index, so a node dropped over
 * another swallows the hit-test for whichever ports end up underneath — and the
 * only way out would be to drag the invisible card blind. Dropping therefore
 * nudges the node to the nearest clear footprint (never moving the others) and
 * re-appends it so it paints last and its own ports stay reachable.
 *
 * @param graph The graph after the drag.
 * @param nodeId The node that was dragged.
 * @returns The graph with that node settled and moved to the end of the paint order.
 */
export function settleNode(graph: ProcessingModelGraph, nodeId: string): ProcessingModelGraph {
  const dragged = graph.nodes.find((node) => node.id === nodeId);
  if (!dragged) return graph;
  const others = graph.nodes.filter((node) => node.id !== nodeId);
  const free = findFreePosition({ ...graph, nodes: others }, { x: dragged.x, y: dragged.y });
  return {
    ...graph,
    nodes: [...others, { ...dragged, x: free.x, y: free.y }],
  };
}

/** Remove a node together with every edge touching it, so no edge is orphaned. */
export function removeNode(graph: ProcessingModelGraph, nodeId: string): ProcessingModelGraph {
  return {
    nodes: graph.nodes.filter((node) => node.id !== nodeId),
    edges: graph.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId),
  };
}

/** Remove a single connection. */
export function removeEdge(graph: ProcessingModelGraph, edgeId: string): ProcessingModelGraph {
  return { ...graph, edges: graph.edges.filter((edge) => edge.id !== edgeId) };
}

/** Merge new values into a node's stored parameters. */
export function setNodeParameter(
  graph: ProcessingModelGraph,
  nodeId: string,
  paramId: string,
  value: unknown,
): ProcessingModelGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) =>
      node.id === nodeId
        ? { ...node, parameters: { ...(node.parameters ?? {}), [paramId]: value } }
        : node,
    ),
  };
}

/** Set an `input` node's source layer, or an `output` node's result name. */
export function setNodeField(
  graph: ProcessingModelGraph,
  nodeId: string,
  field: "layerId" | "name",
  value: string,
): ProcessingModelGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => (node.id === nodeId ? { ...node, [field]: value } : node)),
  };
}

/** Why {@link connectNodes} refused a connection. */
export type ConnectRejection = "same-node" | "cycle";

/**
 * Connect an output port to an input port.
 *
 * An input port holds one value, so an existing edge into the same port is
 * replaced rather than added alongside — dragging a new connection onto a filled
 * port is how a user rewires it. A connection that would close a loop is
 * refused, since the graph could never be ordered.
 *
 * @param graph The current graph.
 * @param from Source node id and output port id.
 * @param to Target node id and input port id.
 * @param createId Id factory.
 * @returns The updated graph, or a rejection reason when the edge is illegal.
 */
export function connectNodes(
  graph: ProcessingModelGraph,
  from: { nodeId: string; portId: string },
  to: { nodeId: string; portId: string },
  createId: () => string,
): { graph: ProcessingModelGraph } | { rejected: ConnectRejection } {
  if (from.nodeId === to.nodeId) return { rejected: "same-node" };
  if (createsCycle(graph, from.nodeId, to.nodeId)) return { rejected: "cycle" };
  const edge: ModelGraphEdge = {
    id: createId(),
    from: from.nodeId,
    fromPort: from.portId,
    to: to.nodeId,
    toPort: to.portId,
  };
  const edges = graph.edges.filter(
    (existing) => !(existing.to === to.nodeId && existing.toPort === to.portId),
  );
  return { graph: { ...graph, edges: [...edges, edge] } };
}

/**
 * Whether adding `from → to` would close a loop, i.e. whether `from` is already
 * reachable from `to`.
 *
 * @param graph The current graph.
 * @param from Proposed source node id.
 * @param to Proposed target node id.
 * @returns True when the edge must be refused.
 */
export function createsCycle(graph: ProcessingModelGraph, from: string, to: string): boolean {
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = outgoing.get(edge.from) ?? [];
    list.push(edge.to);
    outgoing.set(edge.from, list);
  }
  const stack = [to];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (current === from) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    stack.push(...(outgoing.get(current) ?? []));
  }
  return false;
}

/**
 * Lay a freshly imported graph out on a grid when its nodes carry no usable
 * positions — a hand-written or older pipeline file would otherwise stack every
 * node at the origin.
 *
 * Only fills positions in when there are none to preserve; use
 * {@link layoutGraph} for the user-invoked "arrange" command, which is an
 * explicit request to overwrite the hand-placed positions.
 *
 * @param graph The imported graph.
 * @returns The graph, with positions filled in only if they were all at 0,0.
 */
export function autoLayout(
  graph: ProcessingModelGraph,
  options: LayoutOptions = {},
): ProcessingModelGraph {
  const placed = graph.nodes.some((node) => node.x !== 0 || node.y !== 0);
  if (placed) return graph;
  return layoutGraph(graph, options);
}

/** How much room the layout has to work with. */
export interface LayoutOptions {
  /**
   * Visible canvas width in pixels. The flow wraps to a new band once a depth
   * would not fit, so a long chain stays reachable instead of running off the
   * right edge. Omitted (or non-finite) means unlimited width: one band, the
   * old single-row behaviour.
   */
  width?: number;
}

/** Horizontal pitch between two consecutive depths. */
const LAYOUT_COLUMN = 240;
/** Vertical pitch between two nodes sharing a depth. */
const LAYOUT_ROW = 120;
/** Padding between the canvas origin and the first node. */
const LAYOUT_MARGIN = 40;

/**
 * Arrange every node by its depth from the sources, discarding the positions
 * it already had.
 *
 * The flow reads left to right, and wraps: when `options.width` cannot fit
 * another depth, the next one starts a fresh band below the deepest node of
 * the current one. Without that a chain of more than a few tools ran straight
 * off the right edge of the canvas, so Arrange pushed work out of view rather
 * than tidying it into view.
 *
 * @param graph The graph to lay out.
 * @param options Room available; see {@link LayoutOptions}.
 * @returns The graph with every node repositioned.
 */
export function layoutGraph(
  graph: ProcessingModelGraph,
  options: LayoutOptions = {},
): ProcessingModelGraph {
  if (graph.nodes.length === 0) return graph;
  const COLUMN = LAYOUT_COLUMN;
  const ROW = LAYOUT_ROW;
  // Depth from the sources, so the layout reads left-to-right along the flow.
  const depth = new Map<string, number>();
  const incoming = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = incoming.get(edge.to) ?? [];
    list.push(edge.from);
    incoming.set(edge.to, list);
  }
  // Iterative rather than recursive: this runs on an imported file before any
  // size or cycle check, so a very long ancestor chain would otherwise exhaust
  // the call stack instead of failing gracefully.
  const resolveDepth = (start: string): number => {
    const stack: string[] = [start];
    const onStack = new Set<string>([start]);
    while (stack.length > 0) {
      const nodeId = stack[stack.length - 1];
      if (depth.has(nodeId)) {
        stack.pop();
        onStack.delete(nodeId);
        continue;
      }
      const parents = incoming.get(nodeId) ?? [];
      // A parent still on the stack is a cycle; treat it as contributing no
      // depth rather than looping forever.
      const pending = parents.filter((parent) => !depth.has(parent) && !onStack.has(parent));
      if (pending.length > 0) {
        for (const parent of pending) {
          stack.push(parent);
          onStack.add(parent);
        }
        continue;
      }
      const value = parents.length
        ? Math.max(0, ...parents.map((parent) => (depth.get(parent) ?? 0) + 1))
        : 0;
      depth.set(nodeId, value);
      stack.pop();
      onStack.delete(nodeId);
    }
    return depth.get(start) ?? 0;
  };
  for (const node of graph.nodes) resolveDepth(node.id);

  // How many depths fit side by side. The last one has to fit whole, not just
  // start inside the viewport, or the rightmost card is still clipped.
  const usable = options.width;
  const perBand =
    usable && Number.isFinite(usable)
      ? Math.max(1, Math.floor((usable - LAYOUT_MARGIN - NODE_WIDTH) / COLUMN) + 1)
      : Number.POSITIVE_INFINITY;

  // Each band is as tall as its most crowded depth, so bands never overlap.
  const perDepth = new Map<number, number>();
  for (const node of graph.nodes) {
    const value = depth.get(node.id) ?? 0;
    perDepth.set(value, (perDepth.get(value) ?? 0) + 1);
  }
  const bandRows = new Map<number, number>();
  for (const [value, count] of perDepth) {
    const band = Number.isFinite(perBand) ? Math.floor(value / perBand) : 0;
    bandRows.set(band, Math.max(bandRows.get(band) ?? 0, count));
  }
  const bandTop = new Map<number, number>();
  let top = LAYOUT_MARGIN;
  for (const band of [...bandRows.keys()].sort((a, b) => a - b)) {
    bandTop.set(band, top);
    top += (bandRows.get(band) ?? 1) * ROW;
  }

  const perColumn = new Map<number, number>();
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      const value = depth.get(node.id) ?? 0;
      const band = Number.isFinite(perBand) ? Math.floor(value / perBand) : 0;
      const column = Number.isFinite(perBand) ? value % perBand : value;
      const row = perColumn.get(value) ?? 0;
      perColumn.set(value, row + 1);
      return {
        ...node,
        x: LAYOUT_MARGIN + column * COLUMN,
        y: (bandTop.get(band) ?? LAYOUT_MARGIN) + row * ROW,
      };
    }),
  };
}

/**
 * Serialize a value with object keys in a stable order, so two structurally
 * equal values always produce the same string.
 *
 * `JSON.stringify` preserves insertion order, and a node's `parameters` are
 * built up by different code paths (typed in the inspector, restored from a
 * project file, copied from a descriptor default), so the same model can
 * stringify two ways. Comparing those raw would report an edit that is not
 * there.
 */
function stableKey(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableKey).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    // An absent key and a key set to undefined mean the same thing here, and
    // JSON.stringify drops the latter — so drop it on both sides.
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableKey(entry)}`).join(",")}}`;
}

/**
 * Compare two graphs by content, ignoring key order and the order nodes and
 * edges happen to sit in their arrays.
 *
 * Backs the Model Builder's unsaved-work check. Array order is deliberately
 * ignored: {@link settleNode} re-appends a dragged node so it paints last, which
 * reorders `nodes` without changing the model. Positions, on the other hand,
 * *are* compared — moving a card is an edit the user would not expect a New or
 * Load to throw away without asking.
 *
 * @param a One graph.
 * @param b The other.
 * @returns True when the two describe the same model.
 */
export function graphsEqual(a: ProcessingModelGraph, b: ProcessingModelGraph): boolean {
  if (a === b) return true;
  if (a.nodes.length !== b.nodes.length || a.edges.length !== b.edges.length) return false;
  const canonical = (graph: ProcessingModelGraph): string =>
    `${graph.nodes.map(stableKey).sort().join("|")}#${graph.edges.map(stableKey).sort().join("|")}`;
  return canonical(a) === canonical(b);
}

/**
 * Attach a fresh `output` node to one of a tool's output ports.
 *
 * A model keeps only what an `output` node is wired to, so without this the
 * only reachable result is the end of the chain — every intermediate step is
 * computed and thrown away. An output port may feed the next tool *and* an
 * output node at the same time, so keeping a step costs nothing downstream.
 *
 * @param graph The current graph.
 * @param nodeId The tool whose result should be kept.
 * @param portId The output port to tap.
 * @param createId Fresh id source.
 * @param name Suggested result name, normally the tool's display name. Made
 *   unique against the outputs already in the graph, since an unnamed output
 *   falls back to a single shared "Model output" label and a model that keeps
 *   several steps would put indistinguishable layers on the map.
 * @returns The updated graph and the new node's id, or `null` when the tool is
 *   not in the graph.
 */
export function addOutputForPort(
  graph: ProcessingModelGraph,
  nodeId: string,
  portId: string,
  createId: () => string,
  name?: string,
): { graph: ProcessingModelGraph; nodeId: string } | null {
  const source = graph.nodes.find((node) => node.id === nodeId);
  if (!source) return null;
  // One column to the right of the tool, where the flow already reads; the
  // placement helper pushes it down until it has a clear footprint.
  const added = addDataNode(
    graph,
    "output",
    { x: source.x + NODE_WIDTH + 72, y: source.y },
    createId,
  );
  const resultName = name?.trim() ? uniqueOutputName(graph, name.trim()) : "";
  const named: ProcessingModelGraph = resultName
    ? {
        ...added.graph,
        nodes: added.graph.nodes.map((node) =>
          node.id === added.nodeId ? { ...node, name: resultName } : node,
        ),
      }
    : added.graph;
  const connected = connectNodes(
    named,
    { nodeId, portId },
    { nodeId: added.nodeId, portId: OUTPUT_NODE_PORT },
    createId,
  );
  // A brand-new output node cannot close a loop or target itself, so a
  // rejection here is not reachable; fall back to the unwired node rather than
  // dropping the user's click on the floor.
  if ("rejected" in connected) return { graph: named, nodeId: added.nodeId };
  return { graph: connected.graph, nodeId: added.nodeId };
}

/**
 * A result name not already taken by another `output` node, by appending a
 * counter. Two Buffer steps both named "Buffer" would otherwise land on the
 * map as two layers the user cannot tell apart.
 *
 * @param graph The current graph.
 * @param base The preferred name.
 * @returns `base`, or `base` with the lowest free counter appended.
 */
export function uniqueOutputName(graph: ProcessingModelGraph, base: string): string {
  const taken = new Set(
    graph.nodes
      .filter((node) => node.kind === "output")
      .map((node) => node.name?.trim())
      .filter((name): name is string => Boolean(name)),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** True when this output port already feeds an `output` node. */
export function portFeedsOutput(
  graph: ProcessingModelGraph,
  nodeId: string,
  portId: string,
): boolean {
  const outputs = new Set(
    graph.nodes.filter((node) => node.kind === "output").map((node) => node.id),
  );
  return graph.edges.some(
    (edge) => edge.from === nodeId && edge.fromPort === portId && outputs.has(edge.to),
  );
}
