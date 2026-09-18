import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProcessingModelGraph } from "../packages/core/src/types";
import {
  graphToLinearSteps,
  portKindsCompatible,
  runModelGraph,
  topologicalOrder,
  validateModelGraph,
  type ModelToolDescriptor,
  type ModelValue,
} from "../packages/processing/src/model-graph";

const BUFFER: ModelToolDescriptor = {
  key: "vector:buffer",
  provider: "vector",
  toolId: "buffer",
  name: "Buffer",
  group: "Geometry",
  inputs: [{ id: "layer", label: "Input", kind: "vector", required: true }],
  outputs: [{ id: "out", label: "Output", kind: "vector" }],
  parameters: [{ id: "distance", label: "Distance", type: "number" }],
};

const CLIP: ModelToolDescriptor = {
  key: "vector:clip",
  provider: "vector",
  toolId: "clip",
  name: "Clip",
  group: "Overlay",
  inputs: [
    { id: "layer", label: "Input", kind: "vector", required: true },
    { id: "overlay", label: "Clip layer", kind: "vector", required: true },
  ],
  outputs: [{ id: "out", label: "Output", kind: "vector" }],
  parameters: [],
};

const SLOPE: ModelToolDescriptor = {
  key: "whitebox:slope",
  provider: "whitebox",
  toolId: "slope",
  name: "Slope",
  group: "Terrain",
  inputs: [{ id: "dem", label: "DEM", kind: "raster", required: true }],
  outputs: [{ id: "output", label: "Slope", kind: "raster" }],
  parameters: [],
};

const TOOLS = [BUFFER, CLIP, SLOPE];
const resolve = (provider: string | undefined, toolId: string | undefined) =>
  TOOLS.find((tool) => tool.provider === provider && tool.toolId === toolId);

function featureCollection(name: string): ModelValue {
  return {
    kind: "vector",
    geojson: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { name },
          geometry: { type: "Point", coordinates: [0, 0] },
        },
      ],
    },
  };
}

/** input(roads) -> buffer -> output */
function chainGraph(): ProcessingModelGraph {
  return {
    nodes: [
      { id: "in1", kind: "input", x: 0, y: 0, layerId: "roads" },
      {
        id: "t1",
        kind: "tool",
        x: 100,
        y: 0,
        provider: "vector",
        toolId: "buffer",
        parameters: { distance: 50 },
      },
      { id: "out1", kind: "output", x: 200, y: 0, name: "Buffered" },
    ],
    edges: [
      { id: "e1", from: "in1", fromPort: "out", to: "t1", toPort: "layer" },
      { id: "e2", from: "t1", fromPort: "out", to: "out1", toPort: "in" },
    ],
  };
}

describe("model graph ordering", () => {
  it("orders nodes so each follows the ones feeding it", () => {
    const order = topologicalOrder(chainGraph());
    assert.deepEqual(
      order?.map((node) => node.id),
      ["in1", "t1", "out1"],
    );
  });

  it("returns null for a cycle instead of a partial order", () => {
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
    assert.equal(topologicalOrder(graph), null);
  });

  it("orders a diamond so a merge node follows both of its branches", () => {
    const graph: ProcessingModelGraph = {
      nodes: [
        { id: "in1", kind: "input", x: 0, y: 0, layerId: "a" },
        { id: "b1", kind: "tool", x: 0, y: 0, provider: "vector", toolId: "buffer" },
        { id: "b2", kind: "tool", x: 0, y: 0, provider: "vector", toolId: "buffer" },
        { id: "clip", kind: "tool", x: 0, y: 0, provider: "vector", toolId: "clip" },
      ],
      edges: [
        { id: "e1", from: "in1", fromPort: "out", to: "b1", toPort: "layer" },
        { id: "e2", from: "in1", fromPort: "out", to: "b2", toPort: "layer" },
        { id: "e3", from: "b1", fromPort: "out", to: "clip", toPort: "layer" },
        { id: "e4", from: "b2", fromPort: "out", to: "clip", toPort: "overlay" },
      ],
    };
    const order = topologicalOrder(graph)?.map((node) => node.id) ?? [];
    assert.ok(order.indexOf("clip") > order.indexOf("b1"));
    assert.ok(order.indexOf("clip") > order.indexOf("b2"));
  });
});

describe("model graph validation", () => {
  it("accepts a wired chain", () => {
    assert.deepEqual(validateModelGraph(chainGraph(), resolve), []);
  });

  it("reports an input node with no layer chosen", () => {
    const graph = chainGraph();
    delete graph.nodes[0].layerId;
    const codes = validateModelGraph(graph, resolve).map((issue) => issue.code);
    assert.ok(codes.includes("missing-layer"));
  });

  it("reports an unknown tool once, without also blaming its edges", () => {
    const graph = chainGraph();
    graph.nodes[1].toolId = "nope";
    const issues = validateModelGraph(graph, resolve);
    assert.equal(issues.filter((issue) => issue.code === "unknown-tool").length, 1);
    assert.equal(issues.filter((issue) => issue.code === "unknown-port").length, 0);
  });

  it("rejects wiring a vector output into a raster input", () => {
    const graph: ProcessingModelGraph = {
      nodes: [
        { id: "in1", kind: "input", x: 0, y: 0, layerId: "roads" },
        { id: "b", kind: "tool", x: 0, y: 0, provider: "vector", toolId: "buffer" },
        { id: "s", kind: "tool", x: 0, y: 0, provider: "whitebox", toolId: "slope" },
        { id: "o", kind: "output", x: 0, y: 0, name: "Out" },
      ],
      edges: [
        { id: "e1", from: "in1", fromPort: "out", to: "b", toPort: "layer" },
        { id: "e2", from: "b", fromPort: "out", to: "s", toPort: "dem" },
        { id: "e3", from: "s", fromPort: "output", to: "o", toPort: "in" },
      ],
    };
    const codes = validateModelGraph(graph, resolve).map((issue) => issue.code);
    assert.ok(codes.includes("type-mismatch"));
  });

  it("reports a required input with neither an edge nor a typed value", () => {
    const graph: ProcessingModelGraph = {
      nodes: [
        { id: "c", kind: "tool", x: 0, y: 0, provider: "vector", toolId: "clip" },
        { id: "o", kind: "output", x: 0, y: 0, name: "Out" },
      ],
      edges: [{ id: "e1", from: "c", fromPort: "out", to: "o", toPort: "in" }],
    };
    const missing = validateModelGraph(graph, resolve).filter(
      (issue) => issue.code === "missing-input",
    );
    // Both of Clip's required inputs are unwired.
    assert.equal(missing.length, 2);
  });

  it("treats a typed layer value as satisfying a required input", () => {
    const graph: ProcessingModelGraph = {
      nodes: [
        {
          id: "c",
          kind: "tool",
          x: 0,
          y: 0,
          provider: "vector",
          toolId: "clip",
          parameters: { layer: "roads", overlay: "aoi" },
        },
        { id: "o", kind: "output", x: 0, y: 0, name: "Out" },
      ],
      edges: [{ id: "e1", from: "c", fromPort: "out", to: "o", toPort: "in" }],
    };
    assert.deepEqual(validateModelGraph(graph, resolve), []);
  });

  it("rejects two edges feeding one input port", () => {
    const graph = chainGraph();
    graph.nodes.push({ id: "in2", kind: "input", x: 0, y: 0, layerId: "other" });
    graph.edges.push({ id: "e3", from: "in2", fromPort: "out", to: "t1", toPort: "layer" });
    const codes = validateModelGraph(graph, resolve).map((issue) => issue.code);
    assert.ok(codes.includes("duplicate-input"));
  });

  it("reports two nodes sharing an id, which lookups would silently collapse", () => {
    const graph = chainGraph();
    graph.nodes.push({ ...graph.nodes[1], x: 50 });
    const dup = validateModelGraph(graph, resolve).filter(
      (issue) => issue.code === "duplicate-node",
    );
    assert.equal(dup.length, 1);
    assert.equal(dup[0].nodeId, "t1");
  });

  it("reports an edge pointing at a node that no longer exists", () => {
    const graph = chainGraph();
    graph.edges.push({ id: "e9", from: "ghost", fromPort: "out", to: "t1", toPort: "layer" });
    const codes = validateModelGraph(graph, resolve).map((issue) => issue.code);
    assert.ok(codes.includes("dangling-edge"));
  });

  it("carries the offending port or tool id as `detail` for interpolation", () => {
    // The UI translates by `code` and interpolates `detail`; without it the port
    // name would have to be parsed back out of the English message.
    const graph: ProcessingModelGraph = {
      nodes: [
        { id: "c", kind: "tool", x: 0, y: 0, provider: "vector", toolId: "clip" },
        { id: "o", kind: "output", x: 0, y: 0, name: "Out" },
      ],
      edges: [{ id: "e1", from: "c", fromPort: "out", to: "o", toPort: "in" }],
    };
    const details = validateModelGraph(graph, resolve)
      .filter((issue) => issue.code === "missing-input")
      .map((issue) => issue.detail);
    assert.deepEqual(details.sort(), ["Clip layer", "Input"]);

    const unknown = chainGraph();
    unknown.nodes[1].toolId = "nope";
    assert.equal(
      validateModelGraph(unknown, resolve).find((i) => i.code === "unknown-tool")?.detail,
      "nope",
    );
  });

  it("requires an output node so a run keeps something", () => {
    const graph = chainGraph();
    graph.nodes = graph.nodes.filter((node) => node.kind !== "output");
    graph.edges = graph.edges.filter((edge) => edge.to !== "out1");
    const codes = validateModelGraph(graph, resolve).map((issue) => issue.code);
    assert.ok(codes.includes("no-output"));
  });
});

describe("port compatibility", () => {
  it("lets `any` bridge both concrete kinds but keeps those two apart", () => {
    assert.equal(portKindsCompatible("vector", "vector"), true);
    assert.equal(portKindsCompatible("any", "raster"), true);
    assert.equal(portKindsCompatible("raster", "any"), true);
    assert.equal(portKindsCompatible("vector", "raster"), false);
  });
});

describe("running a model graph", () => {
  const baseOptions = () => {
    const log: string[] = [];
    const emitted: { name: string; value: ModelValue }[] = [];
    return {
      log,
      emitted,
      options: {
        resolveDescriptor: resolve,
        resolveInput: (layerId: string) => featureCollection(layerId),
        emitOutput: (name: string, value: ModelValue) => emitted.push({ name, value }),
        log: (message: string) => log.push(message),
      },
    };
  };

  it("feeds an input layer through a tool into an output", async () => {
    const { options, emitted } = baseOptions();
    const seen: Record<string, ModelValue>[] = [];
    const result = await runModelGraph(chainGraph(), {
      ...options,
      executeTool: async ({ inputs }) => {
        seen.push(inputs);
        return { out: featureCollection("buffered") };
      },
    });
    assert.equal(result.error, undefined);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].name, "Buffered");
    // The tool saw the input node's layer on its `layer` port.
    assert.equal(seen[0].layer.kind, "vector");
  });

  it("delivers both branches of a merge to the right ports", async () => {
    const graph: ProcessingModelGraph = {
      nodes: [
        { id: "in1", kind: "input", x: 0, y: 0, layerId: "roads" },
        { id: "in2", kind: "input", x: 0, y: 0, layerId: "aoi" },
        { id: "c", kind: "tool", x: 0, y: 0, provider: "vector", toolId: "clip" },
        { id: "o", kind: "output", x: 0, y: 0, name: "Clipped" },
      ],
      edges: [
        { id: "e1", from: "in1", fromPort: "out", to: "c", toPort: "layer" },
        { id: "e2", from: "in2", fromPort: "out", to: "c", toPort: "overlay" },
        { id: "e3", from: "c", fromPort: "out", to: "o", toPort: "in" },
      ],
    };
    const { options } = baseOptions();
    let ports: Record<string, ModelValue> = {};
    const result = await runModelGraph(graph, {
      ...options,
      executeTool: async ({ inputs }) => {
        ports = inputs;
        return { out: featureCollection("clipped") };
      },
    });
    assert.equal(result.error, undefined);
    assert.deepEqual(Object.keys(ports).sort(), ["layer", "overlay"]);
    assert.equal(
      (ports.layer as { geojson: { features: { properties: { name: string } }[] } }).geojson
        .features[0].properties.name,
      "roads",
    );
    assert.equal(
      (ports.overlay as { geojson: { features: { properties: { name: string } }[] } }).geojson
        .features[0].properties.name,
      "aoi",
    );
  });

  it("stops at the failing node and names it", async () => {
    const { options, emitted } = baseOptions();
    const result = await runModelGraph(chainGraph(), {
      ...options,
      executeTool: async () => {
        throw new Error("tool exploded");
      },
    });
    assert.equal(result.error?.nodeId, "t1");
    assert.match(result.error?.message ?? "", /tool exploded/);
    assert.equal(emitted.length, 0);
  });

  it("reports the node when an input layer has no usable data", async () => {
    const { options } = baseOptions();
    const result = await runModelGraph(chainGraph(), {
      ...options,
      resolveInput: () => null,
      executeTool: async () => ({ out: featureCollection("x") }),
    });
    assert.equal(result.error?.nodeId, "in1");
  });

  it("carries raster bytes between two raster nodes", async () => {
    const graph: ProcessingModelGraph = {
      nodes: [
        { id: "in1", kind: "input", x: 0, y: 0, layerId: "dem" },
        { id: "s", kind: "tool", x: 0, y: 0, provider: "whitebox", toolId: "slope" },
        { id: "o", kind: "output", x: 0, y: 0, name: "Slope" },
      ],
      edges: [
        { id: "e1", from: "in1", fromPort: "out", to: "s", toPort: "dem" },
        { id: "e2", from: "s", fromPort: "output", to: "o", toPort: "in" },
      ],
    };
    const { options, emitted } = baseOptions();
    const result = await runModelGraph(graph, {
      ...options,
      resolveInput: () => ({ kind: "raster", bytes: new Uint8Array([1, 2, 3]), name: "dem" }),
      executeTool: async ({ inputs }) => {
        assert.equal(inputs.dem.kind, "raster");
        return { output: { kind: "raster", bytes: new Uint8Array([9]), name: "slope" } };
      },
    });
    assert.equal(result.error, undefined);
    assert.equal(emitted[0].value.kind, "raster");
  });

  it("awaits an async input resolver, since raster bytes have to be fetched", async () => {
    const { options, emitted } = baseOptions();
    const result = await runModelGraph(chainGraph(), {
      ...options,
      resolveInput: async (layerId: string) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { kind: "raster", bytes: new Uint8Array([1, 2]), name: layerId };
      },
      executeTool: async ({ inputs }) => {
        // A resolver that was not awaited would deliver a Promise here.
        assert.equal(inputs.layer.kind, "raster");
        return { out: { kind: "raster", bytes: new Uint8Array([3]), name: "o" } };
      },
    });
    assert.equal(result.error, undefined);
    assert.equal(emitted[0].value.kind, "raster");
  });

  it("resolves an unwired input port from a layer id typed into the node", async () => {
    const graph: ProcessingModelGraph = {
      nodes: [
        {
          id: "t",
          kind: "tool",
          x: 0,
          y: 0,
          provider: "vector",
          toolId: "buffer",
          parameters: { layer: "roads", distance: 10 },
        },
        { id: "o", kind: "output", x: 0, y: 0, name: "Out" },
      ],
      edges: [{ id: "e1", from: "t", fromPort: "out", to: "o", toPort: "in" }],
    };
    const { options } = baseOptions();
    let saw: Record<string, ModelValue> = {};
    const result = await runModelGraph(graph, {
      ...options,
      executeTool: async ({ inputs }) => {
        saw = inputs;
        return { out: featureCollection("b") };
      },
    });
    assert.equal(result.error, undefined);
    assert.equal(saw.layer?.kind, "vector");
  });

  it("reports a non-Error rejection instead of throwing inside its own handler", async () => {
    const { options } = baseOptions();
    const result = await runModelGraph(chainGraph(), {
      ...options,
      executeTool: async () => {
        // A WASM/sidecar call can reject with something that is not an Error.
        throw "plain string failure";
      },
    });
    assert.equal(result.error?.nodeId, "t1");
    assert.match(result.error?.message ?? "", /plain string failure/);
  });

  it("does not start a node once the signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { options } = baseOptions();
    let ran = false;
    const result = await runModelGraph(chainGraph(), {
      ...options,
      signal: controller.signal,
      executeTool: async () => {
        ran = true;
        return { out: featureCollection("x") };
      },
    });
    assert.equal(ran, false);
    assert.match(result.error?.message ?? "", /cancelled/i);
  });
});

describe("legacy linear projection", () => {
  it("projects a single chain so older builds can still run it", () => {
    const steps = graphToLinearSteps(chainGraph());
    assert.deepEqual(
      steps.map((step) => step.toolId),
      ["buffer"],
    );
    // The source layer lives on the input node, and runModel only overrides a
    // step's input parameter from step 1 onwards — so step 0 has to carry it or
    // the fallback chain fails on its very first tool.
    assert.deepEqual(steps[0].parameters, { distance: 50, layer: "roads" });
  });

  it("carries the source layer into a non-default input parameter too", () => {
    const graph = chainGraph();
    graph.edges[0].toPort = "input";
    const steps = graphToLinearSteps(graph);
    assert.equal(steps[0].inputParam, "input");
    assert.deepEqual(steps[0].parameters, { distance: 50, input: "roads" });
  });

  it("refuses to project a branch that shares one input node", () => {
    // Every tool node still has in-degree 1 and out-degree 1 here, so only the
    // input node's own fan-out reveals that this is not a linear chain. Left
    // unchecked it would project as [a, b] and runModel would feed b from a's
    // output instead of from the shared input.
    const graph: ProcessingModelGraph = {
      nodes: [
        { id: "in1", kind: "input", x: 0, y: 0, layerId: "roads" },
        { id: "a", kind: "tool", x: 0, y: 0, provider: "vector", toolId: "buffer" },
        { id: "b", kind: "tool", x: 0, y: 0, provider: "vector", toolId: "centroids" },
        { id: "o", kind: "output", x: 0, y: 0, name: "Out" },
      ],
      edges: [
        { id: "e1", from: "in1", fromPort: "out", to: "a", toPort: "layer" },
        { id: "e2", from: "in1", fromPort: "out", to: "b", toPort: "layer" },
        { id: "e3", from: "a", fromPort: "out", to: "o", toPort: "in" },
        { id: "e4", from: "b", fromPort: "out", to: "o", toPort: "in" },
      ],
    };
    assert.deepEqual(graphToLinearSteps(graph), []);
  });

  it("refuses to project a multi-input tool rather than truncating it", () => {
    const graph: ProcessingModelGraph = {
      nodes: [
        { id: "in1", kind: "input", x: 0, y: 0, layerId: "roads" },
        { id: "in2", kind: "input", x: 0, y: 0, layerId: "aoi" },
        { id: "c", kind: "tool", x: 0, y: 0, provider: "vector", toolId: "clip" },
        { id: "o", kind: "output", x: 0, y: 0, name: "Out" },
      ],
      edges: [
        { id: "e1", from: "in1", fromPort: "out", to: "c", toPort: "layer" },
        { id: "e2", from: "in2", fromPort: "out", to: "c", toPort: "overlay" },
        { id: "e3", from: "c", fromPort: "out", to: "o", toPort: "in" },
      ],
    };
    assert.deepEqual(graphToLinearSteps(graph), []);
  });

  it("refuses to project a graph containing a Whitebox node", () => {
    const graph: ProcessingModelGraph = {
      nodes: [
        { id: "in1", kind: "input", x: 0, y: 0, layerId: "dem" },
        { id: "s", kind: "tool", x: 0, y: 0, provider: "whitebox", toolId: "slope" },
        { id: "o", kind: "output", x: 0, y: 0, name: "Out" },
      ],
      edges: [
        { id: "e1", from: "in1", fromPort: "out", to: "s", toPort: "dem" },
        { id: "e2", from: "s", fromPort: "output", to: "o", toPort: "in" },
      ],
    };
    assert.deepEqual(graphToLinearSteps(graph), []);
  });

  it("ignores a dangling edge when counting a node's predecessors", () => {
    // Without this the stray edge makes `t1` look like it has two predecessors
    // and the projection bails, or worse counts it as the one real predecessor.
    const graph = chainGraph();
    graph.edges.push({ id: "e9", from: "ghost", fromPort: "out", to: "t1", toPort: "layer" });
    const steps = graphToLinearSteps(graph);
    assert.deepEqual(
      steps.map((step) => step.toolId),
      ["buffer"],
    );
  });

  it("records a non-default input port so the chain rewires correctly", () => {
    const graph = chainGraph();
    graph.nodes[1].provider = "vector";
    graph.edges[0].toPort = "input";
    // Buffer's descriptor names its port `layer`; an edge onto `input` is what a
    // tool with a differently-named primary input would produce.
    const steps = graphToLinearSteps(graph);
    assert.equal(steps[0].inputParam, "input");
  });
});
