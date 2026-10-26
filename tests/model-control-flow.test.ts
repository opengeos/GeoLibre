import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FeatureCollection, Feature } from "geojson";
import {
  normalizeModelGraph,
  type GeoLibreLayer,
  type ModelGraphNode,
  type ProcessingModelGraph,
} from "../packages/core/src/index";
import {
  evaluateCondition,
  portsFor,
  portKindsCompatible,
  runModelGraph,
  topologicalOrder,
  validateModelGraph,
  type ModelToolDescriptor,
  type ModelValue,
  ITERATE_FEATURES_INPUT_PORT,
  ITERATE_FEATURES_OUTPUT_FEATURE,
  ITERATE_RASTERS_INPUT_PORT,
  ITERATE_RASTERS_OUTPUT_RASTER,
  COLLECT_RESULTS_INPUT_PORT,
  COLLECT_RESULTS_OUTPUT_PORT,
  SWITCH_INPUT_PORT,
  SWITCH_TRUE_PORT,
  SWITCH_FALSE_PORT,
  MERGE_TRUE_PORT,
  MERGE_FALSE_PORT,
  MERGE_OUTPUT_PORT,
  OUTPUT_NODE_PORT,
  INPUT_NODE_PORT,
} from "../packages/processing/src/model-graph";
import { modelGraphToPython } from "../apps/geolibre-desktop/src/lib/model-python-script";
import { buildAssistantModel } from "../apps/geolibre-desktop/src/lib/assistant/model-builder";

const BUFFER_TOOL: ModelToolDescriptor = {
  key: "vector:buffer",
  provider: "vector",
  toolId: "buffer",
  name: "Buffer",
  group: "Geometry",
  inputs: [{ id: "layer", label: "Input", kind: "vector", required: true }],
  outputs: [{ id: "out", label: "Output", kind: "vector" }],
  parameters: [{ id: "distance", label: "Distance", type: "number" }],
};

const CENTROID_TOOL: ModelToolDescriptor = {
  key: "vector:centroid",
  provider: "vector",
  toolId: "centroid",
  name: "Centroid",
  group: "Geometry",
  inputs: [{ id: "layer", label: "Input", kind: "vector", required: true }],
  outputs: [{ id: "out", label: "Output", kind: "vector" }],
  parameters: [],
};

const THRESHOLD_TOOL: ModelToolDescriptor = {
  key: "whitebox:threshold",
  provider: "whitebox",
  toolId: "threshold",
  name: "Threshold",
  group: "Math",
  inputs: [{ id: "input", label: "Input", kind: "raster", required: true }],
  outputs: [{ id: "output", label: "Output", kind: "raster" }],
  parameters: [{ id: "threshold", label: "Threshold", type: "number" }],
};

const TOOLS = [BUFFER_TOOL, CENTROID_TOOL, THRESHOLD_TOOL];
const resolve = (provider?: string, id?: string) =>
  TOOLS.find((t) => t.provider === provider && t.toolId === id);

function makeVectorValue(features: Feature[]): ModelValue {
  return {
    kind: "vector",
    geojson: {
      type: "FeatureCollection",
      features,
    },
  };
}

function makeRasterValue(name: string, byteVal = 1): ModelValue {
  return {
    kind: "raster",
    name,
    bytes: new Uint8Array([byteVal, byteVal + 1, byteVal + 2]),
    metadata: { name, bands: 1 },
  };
}

describe("Model Builder Control Flow - Graph Model & Ports", () => {
  it("exposes correct ports for iterate-features", () => {
    const node: ModelGraphNode = { id: "iter1", kind: "iterate-features", x: 0, y: 0 };
    const ports = portsFor(node, undefined);
    assert.equal(ports.inputs.length, 1);
    assert.equal(ports.inputs[0].id, ITERATE_FEATURES_INPUT_PORT);
    assert.equal(ports.inputs[0].kind, "vector");
    assert.equal(ports.inputs[0].required, true);

    assert.equal(ports.outputs.length, 3);
    assert.equal(ports.outputs[0].id, ITERATE_FEATURES_OUTPUT_FEATURE);
    assert.equal(ports.outputs[0].kind, "vector");
  });

  it("exposes correct ports for iterate-rasters", () => {
    const node: ModelGraphNode = { id: "iterR", kind: "iterate-rasters", x: 0, y: 0 };
    const ports = portsFor(node, undefined);
    assert.equal(ports.inputs.length, 1);
    assert.equal(ports.inputs[0].id, ITERATE_RASTERS_INPUT_PORT);
    assert.equal(ports.outputs.length, 4);
    assert.equal(ports.outputs[0].id, ITERATE_RASTERS_OUTPUT_RASTER);
    assert.equal(ports.outputs[0].kind, "raster");
  });

  it("exposes correct ports for conditional-switch", () => {
    const node: ModelGraphNode = { id: "sw1", kind: "conditional-switch", x: 0, y: 0 };
    const ports = portsFor(node, undefined);
    assert.equal(ports.inputs.length, 2);
    assert.equal(ports.inputs[0].id, SWITCH_INPUT_PORT);
    assert.equal(ports.inputs[0].required, true);
    assert.equal(ports.outputs.length, 2);
    assert.equal(ports.outputs[0].id, SWITCH_TRUE_PORT);
    assert.equal(ports.outputs[1].id, SWITCH_FALSE_PORT);
  });

  it("exposes correct ports for conditional-merge", () => {
    const node: ModelGraphNode = { id: "m1", kind: "conditional-merge", x: 0, y: 0 };
    const ports = portsFor(node, undefined);
    assert.equal(ports.inputs.length, 2);
    assert.equal(ports.inputs[0].id, MERGE_TRUE_PORT);
    assert.equal(ports.inputs[1].id, MERGE_FALSE_PORT);
    assert.equal(ports.outputs.length, 1);
    assert.equal(ports.outputs[0].id, MERGE_OUTPUT_PORT);
  });

  it("exposes correct ports for collect-results", () => {
    const node: ModelGraphNode = { id: "c1", kind: "collect-results", x: 0, y: 0 };
    const ports = portsFor(node, undefined);
    assert.equal(ports.inputs.length, 1);
    assert.equal(ports.inputs[0].id, COLLECT_RESULTS_INPUT_PORT);
    assert.equal(ports.inputs[0].required, true);
    assert.equal(ports.outputs.length, 2);
    assert.equal(ports.outputs[0].id, COLLECT_RESULTS_OUTPUT_PORT);
  });

  it("preserves serialization and normalization of control flow nodes and nested body", () => {
    const graph: ProcessingModelGraph = {
      nodes: [
        {
          id: "iter",
          kind: "iterate-features",
          x: 10,
          y: 20,
          parameters: { maxIterations: 50 },
          body: {
            nodes: [
              { id: "bin", kind: "input", x: 0, y: 0, layerId: "current" },
              { id: "bout", kind: "output", x: 100, y: 0 },
            ],
            edges: [{ id: "be1", from: "bin", fromPort: "out", to: "bout", toPort: "in" }],
          },
        },
        {
          id: "sw",
          kind: "conditional-switch",
          x: 200,
          y: 20,
          parameters: { conditionType: "compare", operator: ">", value: 10 },
        },
        { id: "out", kind: "output", x: 400, y: 20, name: "Result" },
      ],
      edges: [{ id: "e1", from: "iter", fromPort: "feature", to: "out", toPort: "in" }],
    };

    const normalized = normalizeModelGraph(graph);
    assert.ok(normalized);
    assert.equal(normalized.nodes.length, 3);
    assert.equal(normalized.nodes[0].kind, "iterate-features");
    assert.equal(normalized.nodes[0].parameters?.maxIterations, 50);
    assert.ok(normalized.nodes[0].body);
    assert.equal(normalized.nodes[0].body.nodes.length, 2);
    assert.equal(normalized.nodes[1].kind, "conditional-switch");
  });
});

describe("Model Builder Control Flow - Condition Evaluation", () => {
  it("evaluates boolean conditions correctly", () => {
    assert.equal(
      evaluateCondition({
        parameters: { conditionType: "boolean" },
        inputValue: { kind: "boolean", value: true },
      }),
      true,
    );
    assert.equal(
      evaluateCondition({
        parameters: { conditionType: "boolean" },
        inputValue: { kind: "boolean", value: false },
      }),
      false,
    );
    assert.equal(
      evaluateCondition({
        parameters: { conditionType: "boolean", value: true },
      }),
      true,
    );
  });

  it("evaluates numeric comparisons correctly", () => {
    assert.equal(
      evaluateCondition({
        parameters: { conditionType: "compare", operator: ">", value: 50 },
        inputValue: { kind: "number", value: 100 },
      }),
      true,
    );
    assert.equal(
      evaluateCondition({
        parameters: { conditionType: "compare", operator: "<=", value: 50 },
        inputValue: { kind: "number", value: 100 },
      }),
      false,
    );
    assert.equal(
      evaluateCondition({
        parameters: { conditionType: "compare", operator: "==", value: 42 },
        inputValue: { kind: "number", value: 42 },
      }),
      true,
    );
  });

  it("evaluates string comparisons and string operators", () => {
    assert.equal(
      evaluateCondition({
        parameters: { conditionType: "compare", operator: "==", value: "high" },
        inputValue: { kind: "string", value: "high" },
      }),
      true,
    );
    assert.equal(
      evaluateCondition({
        parameters: { conditionType: "compare", operator: "contains", value: "risk" },
        inputValue: { kind: "string", value: "high-risk-area" },
      }),
      true,
    );
    assert.equal(
      evaluateCondition({
        parameters: { conditionType: "compare", operator: "starts_with", value: "geo" },
        inputValue: { kind: "string", value: "geolibre" },
      }),
      true,
    );
  });

  it("evaluates feature properties and metadata correctly", () => {
    const feat: Feature = {
      type: "Feature",
      geometry: { type: "Point", coordinates: [0, 0] },
      properties: { category: "urban", population: 25000 },
    };
    const val = makeVectorValue([feat]);

    assert.equal(
      evaluateCondition({
        parameters: { property: "category", operator: "==", value: "urban" },
        inputValue: val,
      }),
      true,
    );
    assert.equal(
      evaluateCondition({
        parameters: { property: "population", operator: ">=", value: 20000 },
        inputValue: val,
      }),
      true,
    );
    assert.equal(
      evaluateCondition({
        parameters: { property: "population", operator: "<", value: 1000 },
        inputValue: val,
      }),
      false,
    );
  });

  it("evaluates null and empty checks correctly", () => {
    assert.equal(
      evaluateCondition({
        parameters: { operator: "is_null" },
        conditionValue: undefined,
      }),
      true,
    );
    assert.equal(
      evaluateCondition({
        parameters: { operator: "not_null" },
        inputValue: { kind: "number", value: 10 },
      }),
      true,
    );
    assert.equal(
      evaluateCondition({
        parameters: { operator: "is_empty" },
        inputValue: { kind: "string", value: "" },
      }),
      true,
    );
    assert.equal(
      evaluateCondition({
        parameters: { operator: "not_empty" },
        inputValue: { kind: "string", value: "hello" },
      }),
      true,
    );
  });
});

describe("Model Builder Control Flow - Conditional Branch Execution", () => {
  it("executes ONLY the true branch when condition is true", async () => {
    const executedTools: string[] = [];
    const graph: ProcessingModelGraph = {
      nodes: [
        { id: "in", kind: "input", x: 0, y: 0, layerId: "test-layer" },
        {
          id: "switch",
          kind: "conditional-switch",
          x: 100,
          y: 0,
          parameters: { conditionType: "compare", operator: ">", value: 0 },
        },
        { id: "t_true", kind: "tool", x: 200, y: -50, provider: "vector", toolId: "buffer" },
        { id: "t_false", kind: "tool", x: 200, y: 50, provider: "vector", toolId: "centroid" },
        { id: "merge", kind: "conditional-merge", x: 300, y: 0 },
        { id: "out", kind: "output", x: 400, y: 0, name: "Branch Result" },
      ],
      edges: [
        { id: "e1", from: "in", fromPort: "out", to: "switch", toPort: "input" },
        { id: "e2", from: "switch", fromPort: "true", to: "t_true", toPort: "layer" },
        { id: "e3", from: "switch", fromPort: "false", to: "t_false", toPort: "layer" },
        { id: "e4", from: "t_true", fromPort: "out", to: "merge", toPort: "true" },
        { id: "e5", from: "t_false", fromPort: "out", to: "merge", toPort: "false" },
        { id: "e6", from: "merge", fromPort: "out", to: "out", toPort: "in" },
      ],
    };

    const nodeStatuses: Record<string, string> = {};
    const feat: Feature = {
      type: "Feature",
      geometry: { type: "Point", coordinates: [1, 1] },
      properties: { score: 100 },
    };
    const inputVec = makeVectorValue([feat]);

    const result = await runModelGraph(graph, {
      resolveDescriptor: resolve,
      resolveInput: () => inputVec,
      executeTool: async ({ node, inputs }) => {
        executedTools.push(node.id);
        return { out: inputs.layer };
      },
      emitOutput: () => {},
      log: () => {},
      onNodeStatus: (nodeId, status) => {
        nodeStatuses[nodeId] = status;
      },
    });

    assert.equal(result.error, undefined);
    assert.deepEqual(executedTools, ["t_true"], "Only True branch tool should execute");
    assert.equal(nodeStatuses["t_true"], "done");
    assert.equal(nodeStatuses["t_false"], "skipped", "False branch tool must be marked skipped");
    assert.ok(result.outputs["out"], "Output must receive result from true branch");
  });

  it("executes ONLY the false branch when condition is false", async () => {
    const executedTools: string[] = [];
    const graph: ProcessingModelGraph = {
      nodes: [
        { id: "in", kind: "input", x: 0, y: 0, layerId: "test-layer" },
        {
          id: "switch",
          kind: "conditional-switch",
          x: 100,
          y: 0,
          parameters: { conditionType: "compare", operator: "==", value: "non_existent" },
        },
        { id: "t_true", kind: "tool", x: 200, y: -50, provider: "vector", toolId: "buffer" },
        { id: "t_false", kind: "tool", x: 200, y: 50, provider: "vector", toolId: "centroid" },
        { id: "merge", kind: "conditional-merge", x: 300, y: 0 },
        { id: "out", kind: "output", x: 400, y: 0, name: "Branch Result" },
      ],
      edges: [
        { id: "e1", from: "in", fromPort: "out", to: "switch", toPort: "input" },
        { id: "e2", from: "switch", fromPort: "true", to: "t_true", toPort: "layer" },
        { id: "e3", from: "switch", fromPort: "false", to: "t_false", toPort: "layer" },
        { id: "e4", from: "t_true", fromPort: "out", to: "merge", toPort: "true" },
        { id: "e5", from: "t_false", fromPort: "out", to: "merge", toPort: "false" },
        { id: "e6", from: "merge", fromPort: "out", to: "out", toPort: "in" },
      ],
    };

    const nodeStatuses: Record<string, string> = {};
    const inputVec = makeVectorValue([
      { type: "Feature", geometry: { type: "Point", coordinates: [0, 0] }, properties: {} },
    ]);

    const result = await runModelGraph(graph, {
      resolveDescriptor: resolve,
      resolveInput: () => inputVec,
      executeTool: async ({ node, inputs }) => {
        executedTools.push(node.id);
        return { out: inputs.layer };
      },
      emitOutput: () => {},
      log: () => {},
      onNodeStatus: (nodeId, status) => {
        nodeStatuses[nodeId] = status;
      },
    });

    assert.equal(result.error, undefined);
    assert.deepEqual(executedTools, ["t_false"], "Only False branch tool should execute");
    assert.equal(nodeStatuses["t_true"], "skipped", "True branch tool must be marked skipped");
    assert.equal(nodeStatuses["t_false"], "done");
    assert.ok(result.outputs["out"], "Output must receive result from false branch");
  });

  it("skips downstream output nodes that belong to an unselected branch", async () => {
    const graph: ProcessingModelGraph = {
      nodes: [
        { id: "in", kind: "input", x: 0, y: 0, layerId: "test-layer" },
        {
          id: "switch",
          kind: "conditional-switch",
          x: 100,
          y: 0,
          parameters: { conditionType: "boolean", value: true },
        },
        { id: "out_true", kind: "output", x: 200, y: -50, name: "True Output" },
        { id: "out_false", kind: "output", x: 200, y: 50, name: "False Output" },
      ],
      edges: [
        { id: "e1", from: "in", fromPort: "out", to: "switch", toPort: "input" },
        { id: "e2", from: "switch", fromPort: "true", to: "out_true", toPort: "in" },
        { id: "e3", from: "switch", fromPort: "false", to: "out_false", toPort: "in" },
      ],
    };

    const emittedOutputs: string[] = [];
    const inputVec = makeVectorValue([
      { type: "Feature", geometry: { type: "Point", coordinates: [0, 0] }, properties: {} },
    ]);

    const result = await runModelGraph(graph, {
      resolveDescriptor: resolve,
      resolveInput: () => inputVec,
      executeTool: async () => ({}),
      emitOutput: (name) => emittedOutputs.push(name),
      log: () => {},
    });

    assert.equal(result.error, undefined);
    assert.deepEqual(emittedOutputs, ["True Output"]);
    assert.ok(result.outputs["out_true"]);
    assert.equal(result.outputs["out_false"], undefined);
  });
});

describe("Model Builder Control Flow - Feature Iterator Execution", () => {
  it("iterates over features one by one with isolated context and collects results", async () => {
    const features: Feature[] = [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [10, 20] },
        properties: { id: 1 },
      },
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [30, 40] },
        properties: { id: 2 },
      },
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [50, 60] },
        properties: { id: 3 },
      },
    ];
    const inputVec = makeVectorValue(features);

    const processedBatches: number[] = [];
    const graph: ProcessingModelGraph = {
      nodes: [
        { id: "in", kind: "input", x: 0, y: 0, layerId: "regions" },
        { id: "iter", kind: "iterate-features", x: 100, y: 0 },
        { id: "buf", kind: "tool", x: 200, y: 0, provider: "vector", toolId: "buffer" },
        { id: "collect", kind: "collect-results", x: 300, y: 0 },
        { id: "out", kind: "output", x: 400, y: 0, name: "Buffered Regions" },
      ],
      edges: [
        { id: "e1", from: "in", fromPort: "out", to: "iter", toPort: "collection" },
        { id: "e2", from: "iter", fromPort: "feature", to: "buf", toPort: "layer" },
        { id: "e3", from: "buf", fromPort: "out", to: "collect", toPort: "item" },
        { id: "e4", from: "collect", fromPort: "collection", to: "out", toPort: "in" },
      ],
    };

    const result = await runModelGraph(graph, {
      resolveDescriptor: resolve,
      resolveInput: () => inputVec,
      executeTool: async ({ inputs }) => {
        const fc = (inputs.layer as { geojson: FeatureCollection }).geojson;
        processedBatches.push(fc.features.length);
        const bufferedFeatures = fc.features.map((f) => ({
          ...f,
          properties: { ...f.properties, processed: true },
        }));
        return {
          out: {
            kind: "vector",
            geojson: { type: "FeatureCollection", features: bufferedFeatures },
          },
        };
      },
      emitOutput: () => {},
      log: () => {},
    });

    assert.equal(result.error, undefined);
    assert.deepEqual(processedBatches, [1, 1, 1], "Each iteration must process exactly 1 feature");
    const outVal = result.outputs["out"];
    assert.ok(outVal && outVal.kind === "vector");
    assert.equal(outVal.geojson.features.length, 3, "Collected output must contain all 3 features");
    assert.equal(outVal.geojson.features[0].properties?.processed, true);
    assert.equal(outVal.geojson.features[2].properties?.id, 3);
  });

  it("handles empty feature collection gracefully", async () => {
    const emptyVec = makeVectorValue([]);
    const graph: ProcessingModelGraph = {
      nodes: [
        { id: "in", kind: "input", x: 0, y: 0, layerId: "empty" },
        { id: "iter", kind: "iterate-features", x: 100, y: 0 },
        { id: "collect", kind: "collect-results", x: 200, y: 0 },
        { id: "out", kind: "output", x: 300, y: 0, name: "Empty Output" },
      ],
      edges: [
        { id: "e1", from: "in", fromPort: "out", to: "iter", toPort: "collection" },
        { id: "e2", from: "iter", fromPort: "feature", to: "collect", toPort: "item" },
        { id: "e3", from: "collect", fromPort: "collection", to: "out", toPort: "in" },
      ],
    };

    const result = await runModelGraph(graph, {
      resolveDescriptor: resolve,
      resolveInput: () => emptyVec,
      executeTool: async () => ({}),
      emitOutput: () => {},
      log: () => {},
    });

    assert.equal(result.error, undefined);
    const outVal = result.outputs["out"];
    assert.ok(outVal && outVal.kind === "vector");
    assert.equal(outVal.geojson.features.length, 0);
  });

  it("respects maxIterations limit on feature iteration", async () => {
    const features: Feature[] = Array.from({ length: 10 }, (_, i) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [i, i] },
      properties: { index: i },
    }));
    const inputVec = makeVectorValue(features);
    let runCount = 0;

    const graph: ProcessingModelGraph = {
      nodes: [
        { id: "in", kind: "input", x: 0, y: 0, layerId: "many" },
        { id: "iter", kind: "iterate-features", x: 100, y: 0, parameters: { maxIterations: 3 } },
        { id: "buf", kind: "tool", x: 200, y: 0, provider: "vector", toolId: "buffer" },
        { id: "collect", kind: "collect-results", x: 300, y: 0 },
        { id: "out", kind: "output", x: 400, y: 0 },
      ],
      edges: [
        { id: "e1", from: "in", fromPort: "out", to: "iter", toPort: "collection" },
        { id: "e2", from: "iter", fromPort: "feature", to: "buf", toPort: "layer" },
        { id: "e3", from: "buf", fromPort: "out", to: "collect", toPort: "item" },
        { id: "e4", from: "collect", fromPort: "collection", to: "out", toPort: "in" },
      ],
    };

    const result = await runModelGraph(graph, {
      resolveDescriptor: resolve,
      resolveInput: () => inputVec,
      executeTool: async ({ inputs }) => {
        runCount++;
        return { out: inputs.layer };
      },
      emitOutput: () => {},
      log: () => {},
    });

    assert.equal(result.error, undefined);
    assert.equal(runCount, 3, "Must not execute more than maxIterations");
    const outVal = result.outputs["out"];
    assert.ok(outVal && outVal.kind === "vector");
    assert.equal(outVal.geojson.features.length, 3);
  });

  it("handles iteration failure with stopOnError: true", async () => {
    const features: Feature[] = [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [0, 0] },
        properties: { fail: false },
      },
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [1, 1] },
        properties: { fail: true },
      },
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [2, 2] },
        properties: { fail: false },
      },
    ];
    const inputVec = makeVectorValue(features);

    const graph: ProcessingModelGraph = {
      nodes: [
        { id: "in", kind: "input", x: 0, y: 0, layerId: "test" },
        { id: "iter", kind: "iterate-features", x: 100, y: 0, parameters: { stopOnError: true } },
        { id: "buf", kind: "tool", x: 200, y: 0, provider: "vector", toolId: "buffer" },
        { id: "collect", kind: "collect-results", x: 300, y: 0 },
        { id: "out", kind: "output", x: 400, y: 0 },
      ],
      edges: [
        { id: "e1", from: "in", fromPort: "out", to: "iter", toPort: "collection" },
        { id: "e2", from: "iter", fromPort: "feature", to: "buf", toPort: "layer" },
        { id: "e3", from: "buf", fromPort: "out", to: "collect", toPort: "item" },
        { id: "e4", from: "collect", fromPort: "collection", to: "out", toPort: "in" },
      ],
    };

    const result = await runModelGraph(graph, {
      resolveDescriptor: resolve,
      resolveInput: () => inputVec,
      executeTool: async ({ inputs }) => {
        const feat = (inputs.layer as { geojson: FeatureCollection }).geojson.features[0];
        if (feat.properties?.fail) throw new Error("Feature buffer computation failed");
        return { out: inputs.layer };
      },
      emitOutput: () => {},
      log: () => {},
    });

    assert.ok(result.error);
    assert.match(result.error.message, /Iteration 2\/3 failed/);
  });

  it("supports cancellation mid-iteration", async () => {
    const features: Feature[] = [
      { type: "Feature", geometry: { type: "Point", coordinates: [0, 0] }, properties: {} },
      { type: "Feature", geometry: { type: "Point", coordinates: [1, 1] }, properties: {} },
    ];
    const controller = new AbortController();

    const graph: ProcessingModelGraph = {
      nodes: [
        { id: "in", kind: "input", x: 0, y: 0, layerId: "test" },
        { id: "iter", kind: "iterate-features", x: 100, y: 0 },
        { id: "buf", kind: "tool", x: 200, y: 0, provider: "vector", toolId: "buffer" },
        { id: "collect", kind: "collect-results", x: 300, y: 0 },
        { id: "out", kind: "output", x: 400, y: 0 },
      ],
      edges: [
        { id: "e1", from: "in", fromPort: "out", to: "iter", toPort: "collection" },
        { id: "e2", from: "iter", fromPort: "feature", to: "buf", toPort: "layer" },
        { id: "e3", from: "buf", fromPort: "out", to: "collect", toPort: "item" },
        { id: "e4", from: "collect", fromPort: "collection", to: "out", toPort: "in" },
      ],
    };

    let iterations = 0;
    const result = await runModelGraph(graph, {
      resolveDescriptor: resolve,
      resolveInput: () => makeVectorValue(features),
      executeTool: async ({ inputs }) => {
        iterations++;
        controller.abort();
        return { out: inputs.layer };
      },
      emitOutput: () => {},
      log: () => {},
      signal: controller.signal,
    });

    assert.ok(result.error);
    assert.equal(result.error.message, "Run cancelled.");
    assert.equal(iterations, 1);
  });
});

describe("Model Builder Control Flow - Raster Iterator Execution", () => {
  it("iterates over multiple rasters and collects results", async () => {
    const rasters: ModelValue = {
      kind: "raster-collection",
      items: [
        { bytes: new Uint8Array([10, 20]), name: "dem_north" },
        { bytes: new Uint8Array([30, 40]), name: "dem_south" },
      ],
    };

    const processedRasters: string[] = [];
    const graph: ProcessingModelGraph = {
      nodes: [
        { id: "in", kind: "input", x: 0, y: 0, layerId: "dems" },
        { id: "iter", kind: "iterate-rasters", x: 100, y: 0 },
        { id: "thresh", kind: "tool", x: 200, y: 0, provider: "whitebox", toolId: "threshold" },
        { id: "collect", kind: "collect-results", x: 300, y: 0 },
        { id: "out", kind: "output", x: 400, y: 0, name: "Thresholded DEMs" },
      ],
      edges: [
        { id: "e1", from: "in", fromPort: "out", to: "iter", toPort: "collection" },
        { id: "e2", from: "iter", fromPort: "raster", to: "thresh", toPort: "input" },
        { id: "e3", from: "thresh", fromPort: "output", to: "collect", toPort: "item" },
        { id: "e4", from: "collect", fromPort: "collection", to: "out", toPort: "in" },
      ],
    };

    const emittedLayers: string[] = [];
    const result = await runModelGraph(graph, {
      resolveDescriptor: resolve,
      resolveInput: () => rasters,
      executeTool: async ({ inputs }) => {
        const r = inputs.input as { name?: string; bytes: Uint8Array };
        processedRasters.push(r.name ?? "unnamed");
        return {
          output: {
            kind: "raster",
            name: `${r.name}_thresh`,
            bytes: new Uint8Array(r.bytes.map((b) => (b > 15 ? 1 : 0))),
          },
        };
      },
      emitOutput: (name) => emittedLayers.push(name),
      log: () => {},
    });

    assert.equal(result.error, undefined);
    assert.deepEqual(processedRasters, ["dem_north", "dem_south"]);
    assert.equal(emittedLayers.length, 2);
    assert.match(emittedLayers[0], /Thresholded DEMs - dem_north_thresh/);
  });
});

describe("Model Builder Control Flow - Nested Control Flow", () => {
  it("executes a conditional switch inside an iteration body", async () => {
    const features: Feature[] = [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [0, 0] },
        properties: { type: "point" },
      },
      {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [1, 1],
          ],
        },
        properties: { type: "line" },
      },
    ];
    const inputVec = makeVectorValue(features);

    const toolCalls: string[] = [];
    const graph: ProcessingModelGraph = {
      nodes: [
        { id: "in", kind: "input", x: 0, y: 0, layerId: "mixed" },
        { id: "iter", kind: "iterate-features", x: 100, y: 0 },
        {
          id: "switch",
          kind: "conditional-switch",
          x: 200,
          y: 0,
          parameters: { property: "type", operator: "==", value: "point" },
        },
        { id: "buffer_pts", kind: "tool", x: 300, y: -50, provider: "vector", toolId: "buffer" },
        {
          id: "centroid_lines",
          kind: "tool",
          x: 300,
          y: 50,
          provider: "vector",
          toolId: "centroid",
        },
        { id: "merge", kind: "conditional-merge", x: 400, y: 0 },
        { id: "collect", kind: "collect-results", x: 500, y: 0 },
        { id: "out", kind: "output", x: 600, y: 0, name: "Harmonized" },
      ],
      edges: [
        { id: "e1", from: "in", fromPort: "out", to: "iter", toPort: "collection" },
        { id: "e2", from: "iter", fromPort: "feature", to: "switch", toPort: "input" },
        { id: "e3", from: "switch", fromPort: "true", to: "buffer_pts", toPort: "layer" },
        { id: "e4", from: "switch", fromPort: "false", to: "centroid_lines", toPort: "layer" },
        { id: "e5", from: "buffer_pts", fromPort: "out", to: "merge", toPort: "true" },
        { id: "e6", from: "centroid_lines", fromPort: "out", to: "merge", toPort: "false" },
        { id: "e7", from: "merge", fromPort: "out", to: "collect", toPort: "item" },
        { id: "e8", from: "collect", fromPort: "collection", to: "out", toPort: "in" },
      ],
    };

    const result = await runModelGraph(graph, {
      resolveDescriptor: resolve,
      resolveInput: () => inputVec,
      executeTool: async ({ node, inputs }) => {
        toolCalls.push(node.id);
        return { out: inputs.layer };
      },
      emitOutput: () => {},
      log: () => {},
    });

    assert.equal(result.error, undefined);
    assert.deepEqual(toolCalls, ["buffer_pts", "centroid_lines"]);
    const outVal = result.outputs["out"];
    assert.ok(outVal && outVal.kind === "vector");
    assert.equal(outVal.geojson.features.length, 2);
  });
});

describe("Model Builder Control Flow - Python Export & AI Assistant", () => {
  it("serializes iterator and conditional nodes to python runnable script", () => {
    const graph: ProcessingModelGraph = {
      nodes: [
        { id: "in", kind: "input", x: 0, y: 0, layerId: "roads" },
        { id: "iter", kind: "iterate-features", x: 100, y: 0, parameters: { maxIterations: 500 } },
        { id: "buf", kind: "tool", x: 200, y: 0, provider: "vector", toolId: "buffer" },
        { id: "collect", kind: "collect-results", x: 300, y: 0 },
        { id: "out", kind: "output", x: 400, y: 0, name: "Result" },
      ],
      edges: [
        { id: "e1", from: "in", fromPort: "out", to: "iter", toPort: "collection" },
        { id: "e2", from: "iter", fromPort: "feature", to: "buf", toPort: "layer" },
        { id: "e3", from: "buf", fromPort: "out", to: "collect", toPort: "item" },
        { id: "e4", from: "collect", fromPort: "collection", to: "out", toPort: "in" },
      ],
    };

    const pythonScript = modelGraphToPython(graph, resolve);
    assert.match(pythonScript, /m\.run_model_builder/);
    assert.match(pythonScript, /"kind": "iterate-features"/);
    assert.match(pythonScript, /"kind": "collect-results"/);
    assert.match(pythonScript, /"maxIterations": 500/);
  });

  it("builds valid AI assistant models with control flow nodes", () => {
    const layers = [
      {
        id: "boundaries-layer",
        name: "Admin Boundaries",
        type: "geojson",
      },
    ] as GeoLibreLayer[];

    const model = buildAssistantModel(
      {
        name: "Feature Loop Workflow",
        inputs: [{ key: "boundaries", layer: "boundaries-layer" }],
        steps: [
          {
            key: "loop",
            algorithm: "iterate-features",
            inputs: { collection: "boundaries" },
            parameters: { maxIterations: 100 },
          },
          {
            key: "buffer_step",
            algorithm: "vector:buffer",
            inputs: { layer: "loop.feature" },
            parameters: { distance: 50 },
          },
          {
            key: "collect_step",
            algorithm: "collect-results",
            inputs: { item: "buffer_step.out" },
          },
        ],
        outputs: [{ source: "collect_step.collection", name: "Buffered Boundaries" }],
      },
      layers,
      TOOLS,
    );

    assert.ok(model.graph);
    assert.equal(model.graph.nodes.length, 5); // input, iter, buf, collect, output
    const iterNode = model.graph.nodes.find((n) => n.kind === "iterate-features");
    assert.ok(iterNode);
    assert.equal(iterNode.parameters?.maxIterations, 100);

    const issues = validateModelGraph(model.graph, resolve);
    assert.deepEqual(issues, []);
  });
});
