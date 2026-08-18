import type {
  ModelGraphEdge,
  ModelGraphNode,
  ModelGraphNodeKind,
  ModelToolProvider,
  ProcessingModelGraph,
} from "@geolibre/core";
import type { ModelToolDescriptor } from "@geolibre/processing";

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
 * @param graph The imported graph.
 * @returns The graph, with positions filled in only if they were all at 0,0.
 */
export function autoLayout(graph: ProcessingModelGraph): ProcessingModelGraph {
  const placed = graph.nodes.some((node) => node.x !== 0 || node.y !== 0);
  if (placed || graph.nodes.length === 0) return graph;
  const COLUMN = 240;
  const ROW = 120;
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
  const perColumn = new Map<number, number>();
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      const column = depth.get(node.id) ?? 0;
      const row = perColumn.get(column) ?? 0;
      perColumn.set(column, row + 1);
      return { ...node, x: 40 + column * COLUMN, y: 40 + row * ROW };
    }),
  };
}
