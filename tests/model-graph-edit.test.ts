import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProcessingModelGraph } from "../packages/core/src/types";
import type { ModelToolDescriptor } from "../packages/processing/src/model-graph";
import {
  addDataNode,
  addToolNode,
  autoLayout,
  connectNodes,
  createsCycle,
  emptyModelGraph,
  graphsEqual,
  layoutGraph,
  moveNode,
  removeEdge,
  removeNode,
  setNodeField,
  setNodeParameter,
  settleNode,
  NODE_HEIGHT,
  NODE_WIDTH,
} from "../apps/geolibre-desktop/src/lib/model-graph-edit";

const BUFFER: ModelToolDescriptor = {
  key: "vector:buffer",
  provider: "vector",
  toolId: "buffer",
  name: "Buffer",
  group: "Geometry",
  inputs: [{ id: "layer", label: "Input", kind: "vector", required: true }],
  outputs: [{ id: "out", label: "Output", kind: "vector" }],
  parameters: [
    { id: "distance", label: "Distance", type: "number", default: 25 },
    { id: "units", label: "Units", type: "string" },
  ],
};

let counter = 0;
const ids = () => `n${++counter}`;

describe("adding nodes", () => {
  it("seeds a tool node with the descriptor's documented defaults", () => {
    counter = 0;
    const { graph, nodeId } = addToolNode(emptyModelGraph(), BUFFER, { x: 10, y: 20 }, ids);
    const node = graph.nodes.find((entry) => entry.id === nodeId);
    // `units` has no default, so it stays unset rather than becoming undefined.
    assert.deepEqual(node?.parameters, { distance: 25 });
    assert.equal(node?.provider, "vector");
    assert.equal(node?.toolId, "buffer");
    assert.deepEqual([node?.x, node?.y], [10, 20]);
  });

  it("adds input and output nodes of the right kind", () => {
    counter = 0;
    const first = addDataNode(emptyModelGraph(), "input", { x: 0, y: 0 }, ids);
    const second = addDataNode(first.graph, "output", { x: 0, y: 0 }, ids);
    assert.deepEqual(
      second.graph.nodes.map((node) => node.kind),
      ["input", "output"],
    );
  });
});

describe("editing nodes", () => {
  const base = (): ProcessingModelGraph => ({
    nodes: [
      { id: "a", kind: "input", x: 0, y: 0, layerId: "roads" },
      { id: "b", kind: "tool", x: 0, y: 0, provider: "vector", toolId: "buffer", parameters: {} },
      { id: "c", kind: "output", x: 0, y: 0, name: "Out" },
    ],
    edges: [
      { id: "e1", from: "a", fromPort: "out", to: "b", toPort: "layer" },
      { id: "e2", from: "b", fromPort: "out", to: "c", toPort: "in" },
    ],
  });

  it("moves a node without touching the others", () => {
    const graph = moveNode(base(), "b", { x: 300, y: 120 });
    assert.deepEqual(
      graph.nodes.map((node) => [node.id, node.x, node.y]),
      [
        ["a", 0, 0],
        ["b", 300, 120],
        ["c", 0, 0],
      ],
    );
  });

  it("removes a node together with every edge touching it", () => {
    const graph = removeNode(base(), "b");
    assert.deepEqual(
      graph.nodes.map((node) => node.id),
      ["a", "c"],
    );
    assert.deepEqual(graph.edges, []);
  });

  it("removes one connection without disturbing the nodes", () => {
    const graph = removeEdge(base(), "e1");
    assert.deepEqual(
      graph.edges.map((edge) => edge.id),
      ["e2"],
    );
    assert.equal(graph.nodes.length, 3);
  });

  it("merges a parameter without dropping the others", () => {
    let graph = setNodeParameter(base(), "b", "distance", 50);
    graph = setNodeParameter(graph, "b", "units", "m");
    assert.deepEqual(graph.nodes.find((node) => node.id === "b")?.parameters, {
      distance: 50,
      units: "m",
    });
  });

  it("sets the input node's layer and the output node's name", () => {
    let graph = setNodeField(base(), "a", "layerId", "rivers");
    graph = setNodeField(graph, "c", "name", "Result");
    assert.equal(graph.nodes.find((node) => node.id === "a")?.layerId, "rivers");
    assert.equal(graph.nodes.find((node) => node.id === "c")?.name, "Result");
  });
});

describe("settling a dragged node", () => {
  const stacked = (): ProcessingModelGraph => ({
    nodes: [
      { id: "a", kind: "input", x: 0, y: 0, layerId: "roads" },
      { id: "b", kind: "tool", x: 400, y: 400, provider: "vector", toolId: "buffer" },
    ],
    edges: [],
  });

  it("moves a card off one it was dropped on top of", () => {
    // Dropped squarely onto `a`: leaving it there would make one card's ports
    // unclickable, with no way to separate them except blind dragging.
    let graph = moveNode(stacked(), "b", { x: 0, y: 0 });
    graph = settleNode(graph, "b");
    const a = graph.nodes.find((n) => n.id === "a")!;
    const b = graph.nodes.find((n) => n.id === "b")!;
    const overlaps = Math.abs(a.x - b.x) < NODE_WIDTH && Math.abs(a.y - b.y) < NODE_HEIGHT;
    assert.equal(overlaps, false);
  });

  it("leaves a card dropped in clear space exactly where the pointer left it", () => {
    let graph = moveNode(stacked(), "b", { x: 700, y: 500 });
    graph = settleNode(graph, "b");
    const b = graph.nodes.find((n) => n.id === "b")!;
    assert.deepEqual([b.x, b.y], [700, 500]);
  });

  it("repaints the dragged card last so its own ports stay on top", () => {
    const graph = settleNode(stacked(), "a");
    assert.equal(graph.nodes[graph.nodes.length - 1].id, "a");
  });

  it("never displaces the cards it was dropped near", () => {
    let graph = moveNode(stacked(), "b", { x: 0, y: 0 });
    graph = settleNode(graph, "b");
    const a = graph.nodes.find((n) => n.id === "a")!;
    assert.deepEqual([a.x, a.y], [0, 0]);
  });
});

describe("connecting nodes", () => {
  const twoNodes = (): ProcessingModelGraph => ({
    nodes: [
      { id: "a", kind: "input", x: 0, y: 0, layerId: "roads" },
      { id: "b", kind: "tool", x: 0, y: 0, provider: "vector", toolId: "buffer" },
      { id: "c", kind: "input", x: 0, y: 0, layerId: "rivers" },
    ],
    edges: [],
  });

  it("connects an output port to an input port", () => {
    counter = 0;
    const result = connectNodes(
      twoNodes(),
      { nodeId: "a", portId: "out" },
      { nodeId: "b", portId: "layer" },
      ids,
    );
    assert.ok("graph" in result);
    assert.deepEqual(
      result.graph.edges.map((edge) => [edge.from, edge.fromPort, edge.to, edge.toPort]),
      [["a", "out", "b", "layer"]],
    );
  });

  it("replaces an existing edge into the same port rather than doubling it", () => {
    counter = 0;
    const first = connectNodes(
      twoNodes(),
      { nodeId: "a", portId: "out" },
      { nodeId: "b", portId: "layer" },
      ids,
    );
    assert.ok("graph" in first);
    const second = connectNodes(
      first.graph,
      { nodeId: "c", portId: "out" },
      { nodeId: "b", portId: "layer" },
      ids,
    );
    assert.ok("graph" in second);
    // One value per input port: rewiring replaces, it does not accumulate.
    assert.equal(second.graph.edges.length, 1);
    assert.equal(second.graph.edges[0].from, "c");
  });

  it("refuses a self-connection", () => {
    const result = connectNodes(
      twoNodes(),
      { nodeId: "b", portId: "out" },
      { nodeId: "b", portId: "layer" },
      ids,
    );
    assert.deepEqual(result, { rejected: "same-node" });
  });

  it("refuses an edge that would close a loop", () => {
    const graph: ProcessingModelGraph = {
      nodes: [
        { id: "a", kind: "tool", x: 0, y: 0, provider: "vector", toolId: "buffer" },
        { id: "b", kind: "tool", x: 0, y: 0, provider: "vector", toolId: "buffer" },
      ],
      edges: [{ id: "e1", from: "a", fromPort: "out", to: "b", toPort: "layer" }],
    };
    const result = connectNodes(
      graph,
      { nodeId: "b", portId: "out" },
      { nodeId: "a", portId: "layer" },
      ids,
    );
    assert.deepEqual(result, { rejected: "cycle" });
  });

  it("detects a loop across a longer path, not just a direct back-edge", () => {
    const graph: ProcessingModelGraph = {
      nodes: ["a", "b", "c"].map((id) => ({
        id,
        kind: "tool" as const,
        x: 0,
        y: 0,
        provider: "vector" as const,
        toolId: "buffer",
      })),
      edges: [
        { id: "e1", from: "a", fromPort: "out", to: "b", toPort: "layer" },
        { id: "e2", from: "b", fromPort: "out", to: "c", toPort: "layer" },
      ],
    };
    // c -> a closes the a -> b -> c chain; a -> c is only a shortcut forward.
    assert.equal(createsCycle(graph, "c", "a"), true);
    assert.equal(createsCycle(graph, "a", "c"), false);
  });
});

describe("auto layout", () => {
  it("spreads an unpositioned graph left to right along the flow", () => {
    const graph: ProcessingModelGraph = {
      nodes: [
        { id: "a", kind: "input", x: 0, y: 0, layerId: "roads" },
        { id: "b", kind: "tool", x: 0, y: 0, provider: "vector", toolId: "buffer" },
        { id: "c", kind: "output", x: 0, y: 0, name: "Out" },
      ],
      edges: [
        { id: "e1", from: "a", fromPort: "out", to: "b", toPort: "layer" },
        { id: "e2", from: "b", fromPort: "out", to: "c", toPort: "in" },
      ],
    };
    const laid = autoLayout(graph);
    const x = Object.fromEntries(laid.nodes.map((node) => [node.id, node.x]));
    assert.ok(x.a < x.b && x.b < x.c);
  });

  it("leaves a graph that already carries positions alone", () => {
    const graph: ProcessingModelGraph = {
      nodes: [
        { id: "a", kind: "input", x: 500, y: 300, layerId: "roads" },
        { id: "b", kind: "output", x: 0, y: 0, name: "Out" },
      ],
      edges: [],
    };
    assert.deepEqual(autoLayout(graph), graph);
  });

  it("handles a long chain iteratively instead of exhausting the stack", () => {
    // An imported file is laid out before any size or cycle check, so depth
    // resolution has to survive a chain far longer than the call stack allows.
    const n = 20000;
    const nodes = Array.from({ length: n }, (_, i) => ({
      id: `n${i}`,
      kind: "tool" as const,
      x: 0,
      y: 0,
      provider: "vector" as const,
      toolId: "buffer",
    }));
    const edges = Array.from({ length: n - 1 }, (_, i) => ({
      id: `e${i}`,
      from: `n${i}`,
      fromPort: "out",
      to: `n${i + 1}`,
      toPort: "layer",
    }));
    const laid = autoLayout({ nodes, edges });
    assert.equal(laid.nodes.length, n);
    // Depth increases along the chain, so the last node sits far to the right.
    assert.ok(laid.nodes[n - 1].x > laid.nodes[0].x);
  });

  it("does not hang on a cycle with no root to start from", () => {
    const graph: ProcessingModelGraph = {
      nodes: [
        { id: "a", kind: "tool", x: 0, y: 0, provider: "vector", toolId: "buffer" },
        { id: "b", kind: "tool", x: 0, y: 0, provider: "vector", toolId: "buffer" },
      ],
      edges: [
        { id: "e1", from: "a", fromPort: "out", to: "b", toPort: "layer" },
        { id: "e2", from: "b", fromPort: "out", to: "a", toPort: "layer" },
      ],
    };
    assert.equal(autoLayout(graph).nodes.length, 2);
  });

  it("stacks siblings of the same depth into separate rows", () => {
    const graph: ProcessingModelGraph = {
      nodes: [
        { id: "a", kind: "input", x: 0, y: 0, layerId: "one" },
        { id: "b", kind: "input", x: 0, y: 0, layerId: "two" },
      ],
      edges: [],
    };
    const laid = autoLayout(graph);
    assert.equal(laid.nodes[0].x, laid.nodes[1].x);
    assert.notEqual(laid.nodes[0].y, laid.nodes[1].y);
  });

  it("re-lays hand-placed nodes when the user asks for it", () => {
    // autoLayout deliberately leaves a positioned graph alone; the Arrange
    // button is the explicit request to overwrite those positions, so it goes
    // through layoutGraph instead.
    const graph: ProcessingModelGraph = {
      nodes: [
        { id: "a", kind: "input", x: 900, y: 400, layerId: "roads" },
        { id: "b", kind: "tool", x: 30, y: 40, provider: "vector", toolId: "buffer" },
        { id: "c", kind: "output", x: 120, y: 500, name: "Out" },
      ],
      edges: [
        { id: "e1", from: "a", fromPort: "out", to: "b", toPort: "layer" },
        { id: "e2", from: "b", fromPort: "out", to: "c", toPort: "in" },
      ],
    };
    const laid = layoutGraph(graph);
    const x = Object.fromEntries(laid.nodes.map((node) => [node.id, node.x]));
    assert.ok(x.a < x.b && x.b < x.c);
  });

  it("leaves an empty graph untouched when arranging", () => {
    const graph: ProcessingModelGraph = { nodes: [], edges: [] };
    assert.deepEqual(layoutGraph(graph), graph);
  });
});

describe("graphsEqual", () => {
  const base = (): ProcessingModelGraph => ({
    nodes: [
      { id: "a", kind: "input", x: 10, y: 20, layerId: "roads" },
      {
        id: "b",
        kind: "tool",
        x: 30,
        y: 40,
        provider: "vector",
        toolId: "buffer",
        parameters: { distance: 5, units: "km" },
      },
    ],
    edges: [{ id: "e1", from: "a", fromPort: "out", to: "b", toPort: "layer" }],
  });

  it("treats a graph as equal to itself", () => {
    const graph = base();
    assert.equal(graphsEqual(graph, graph), true);
    assert.equal(graphsEqual(graph, base()), true);
  });

  it("ignores the order keys were written in", () => {
    // Parameters are built up by several code paths, so the same model can
    // stringify two ways; that must not read as an unsaved edit.
    const other = base();
    other.nodes[1].parameters = { units: "km", distance: 5 };
    assert.equal(graphsEqual(base(), other), true);
  });

  it("ignores the order nodes sit in the array", () => {
    // settleNode re-appends a dragged node so it paints last, which reorders
    // `nodes` without changing the model.
    const other = base();
    other.nodes.reverse();
    assert.equal(graphsEqual(base(), other), true);
  });

  it("treats an absent key and an undefined one as the same", () => {
    const other = base();
    other.nodes[0].name = undefined;
    assert.equal(graphsEqual(base(), other), true);
  });

  it("sees a moved node as a change", () => {
    const other = base();
    other.nodes[0].x = 999;
    assert.equal(graphsEqual(base(), other), false);
  });

  it("sees an edited parameter as a change", () => {
    const other = base();
    other.nodes[1].parameters = { distance: 6, units: "km" };
    assert.equal(graphsEqual(base(), other), false);
  });

  it("sees an added or removed edge as a change", () => {
    const other = base();
    other.edges = [];
    assert.equal(graphsEqual(base(), other), false);
  });

  it("sees a rewired edge as a change", () => {
    const other = base();
    other.edges[0].toPort = "overlay";
    assert.equal(graphsEqual(base(), other), false);
  });

  it("treats two empty graphs as equal", () => {
    assert.equal(graphsEqual(emptyModelGraph(), emptyModelGraph()), true);
  });
});
