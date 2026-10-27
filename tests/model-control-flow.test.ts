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
import { parseMaxIterations } from "../apps/geolibre-desktop/src/lib/model-graph-edit";
import { ModelBuilderPanel } from "../apps/geolibre-desktop/src/components/processing/model-builder/ModelBuilderPanel";

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
    assert.equal(ports.outputs[0].kind, "any");
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

  it("reads boolean text from the inspector as a boolean", () => {
    assert.equal(
      evaluateCondition({ parameters: { conditionType: "boolean", value: "false" } }),
      false,
    );
    assert.equal(
      evaluateCondition({ parameters: { conditionType: "boolean", value: "true" } }),
      true,
    );
    assert.equal(
      evaluateCondition({
        parameters: { conditionType: "boolean", property: "flag" },
        inputValue: makeVectorValue([
          {
            type: "Feature",
            properties: { flag: "false" },
            geometry: { type: "Point", coordinates: [0, 0] },
          },
        ]),
      }),
      false,
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

  it("treats a null check left on a comparison operator as is-null", () => {
    // addControlNode seeds operator "==", so switching only the condition type
    // must not fall through to an equality test against the target value.
    const params = { conditionType: "null_check", operator: "==", value: "" };
    assert.equal(evaluateCondition({ parameters: params }), true);
    assert.equal(
      evaluateCondition({ parameters: params, inputValue: { kind: "number", value: 0 } }),
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

  it("skips a tool fed by an unselected branch even when another input is live", async () => {
    const clipTool: ModelToolDescriptor = {
      key: "vector:clip",
      provider: "vector",
      toolId: "clip",
      name: "Clip",
      group: "Overlay",
      inputs: [
        { id: "layer", label: "Input", kind: "vector", required: true },
        { id: "overlay", label: "Overlay", kind: "vector", required: true },
      ],
      outputs: [{ id: "out", label: "Output", kind: "vector" }],
      parameters: [],
    };
    const graph: ProcessingModelGraph = {
      nodes: [
        { id: "in", kind: "input", x: 0, y: 0, layerId: "a" },
        { id: "mask", kind: "input", x: 0, y: 0, layerId: "b" },
        {
          id: "switch",
          kind: "conditional-switch",
          x: 0,
          y: 0,
          parameters: { conditionType: "boolean", value: false },
        },
        { id: "clip", kind: "tool", x: 0, y: 0, provider: "vector", toolId: "clip" },
        { id: "out", kind: "output", x: 0, y: 0, name: "Clipped" },
        { id: "out_false", kind: "output", x: 0, y: 0, name: "Unclipped" },
      ],
      edges: [
        { id: "e1", from: "in", fromPort: "out", to: "switch", toPort: "input" },
        { id: "e2", from: "switch", fromPort: "true", to: "clip", toPort: "layer" },
        { id: "e3", from: "mask", fromPort: "out", to: "clip", toPort: "overlay" },
        { id: "e4", from: "clip", fromPort: "out", to: "out", toPort: "in" },
        { id: "e5", from: "switch", fromPort: "false", to: "out_false", toPort: "in" },
      ],
    };
    const statuses: Record<string, string> = {};
    let ran = false;
    const result = await runModelGraph(graph, {
      resolveDescriptor: (prov, id) =>
        prov === "vector" && id === "clip" ? clipTool : resolve(prov, id),
      resolveInput: () => makeVectorValue([]),
      executeTool: async () => {
        ran = true;
        return {};
      },
      emitOutput: () => {},
      log: () => {},
      onNodeStatus: (nodeId, status) => {
        statuses[nodeId] = status;
      },
    });

    assert.equal(result.error, undefined);
    assert.equal(ran, false, "clip sits on the unselected True branch");
    assert.equal(statuses.clip, "skipped");
    assert.ok(result.outputs.out_false);
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

describe("Model Builder Panel & Component", () => {
  it("loads ModelBuilderPanel component", () => {
    assert.equal(typeof ModelBuilderPanel, "function");
  });
});

describe("Model Builder Review Comments Regression Tests", () => {
  // A. ModelBuilderPanel maxIterations parameter handling
  it("correctly handles maxIterations parameter values (empty, zero, numeric)", () => {
    assert.equal(parseMaxIterations(""), undefined);
    assert.equal(parseMaxIterations("abc"), undefined);
    assert.equal(parseMaxIterations("0"), undefined);
    assert.equal(parseMaxIterations("-3"), undefined);
    assert.equal(parseMaxIterations("2.7"), 2);
    assert.equal(parseMaxIterations(" 50 "), 50);
  });

  // B. Assistant model-builder control node layer resolution
  it("resolves layer names in control node parameters", () => {
    const layers = [
      { id: "layer-dem-north", name: "DEM North", type: "raster" },
      { id: "layer-dem-south", name: "DEM South", type: "raster" },
    ] as GeoLibreLayer[];

    const model = buildAssistantModel(
      {
        name: "Raster Loop Workflow",
        inputs: [],
        steps: [
          {
            key: "loop",
            algorithm: "iterate-rasters",
            inputs: {},
            parameters: { layers: ["DEM North", "DEM South"] },
          },
          {
            key: "collect",
            algorithm: "collect-results",
            inputs: { item: "loop.raster" },
          },
        ],
        outputs: [{ source: "collect.collection", name: "Result" }],
      },
      layers,
      TOOLS,
    );

    assert.ok(model.graph);
    const loopNode = model.graph.nodes.find((n) => n.kind === "iterate-rasters");
    assert.ok(loopNode);
    assert.deepEqual(loopNode.parameters?.layers, ["layer-dem-north", "layer-dem-south"]);
  });

  it("resolves a comma-separated layers string in control node parameters", () => {
    const layers = [
      { id: "layer-dem-north", name: "DEM North", type: "raster" },
      { id: "layer-dem-south", name: "DEM South", type: "raster" },
    ] as GeoLibreLayer[];

    const model = buildAssistantModel(
      {
        name: "Raster Loop Workflow",
        inputs: [],
        steps: [
          {
            key: "loop",
            algorithm: "iterate-rasters",
            inputs: {},
            parameters: { layers: "DEM North, DEM South" },
          },
          {
            key: "collect",
            algorithm: "collect-results",
            inputs: { item: "loop.raster" },
          },
        ],
        outputs: [{ source: "collect.collection", name: "Result" }],
      },
      layers,
      TOOLS,
    );

    const loopNode = model.graph?.nodes.find((n) => n.kind === "iterate-rasters");
    assert.ok(loopNode);
    assert.deepEqual(loopNode.parameters?.layers, ["layer-dem-north", "layer-dem-south"]);
  });

  it("throws clear error when a control node references an unresolved layer", () => {
    const layers = [
      { id: "layer-dem-north", name: "DEM North", type: "raster" },
    ] as GeoLibreLayer[];

    assert.throws(
      () =>
        buildAssistantModel(
          {
            name: "Bad Loop",
            inputs: [],
            steps: [
              {
                key: "loop",
                algorithm: "iterate-rasters",
                inputs: {},
                parameters: { layers: ["DEM North", "Missing DEM"] },
              },
            ],
            outputs: [{ source: "loop.raster", name: "Result" }],
          },
          layers,
          TOOLS,
        ),
      /No layer matching "Missing DEM"/,
    );
  });

  // F. Model graph: iterator body dependencies & external ancestors
  it("executes external ancestors of body nodes before the loop begins", async () => {
    const executionOrder: string[] = [];

    const overlayTool: ModelToolDescriptor = {
      key: "vector:overlay",
      provider: "vector",
      toolId: "overlay",
      name: "Overlay",
      group: "Geometry",
      inputs: [],
      outputs: [{ id: "out", label: "Output", kind: "vector" }],
      parameters: [],
    };
    const clipTool: ModelToolDescriptor = {
      key: "vector:clip",
      provider: "vector",
      toolId: "clip",
      name: "Clip",
      group: "Overlay",
      inputs: [
        { id: "layer", label: "Input", kind: "vector", required: true },
        { id: "overlay", label: "Overlay", kind: "vector", required: true },
      ],
      outputs: [{ id: "out", label: "Output", kind: "vector" }],
      parameters: [],
    };

    const localTools = [...TOOLS, overlayTool, clipTool];
    const localResolve = (prov?: string, id?: string) =>
      localTools.find((t) => t.provider === prov && t.toolId === id);

    const inputFeatures: Feature[] = [
      {
        type: "Feature",
        id: "f1",
        properties: { id: 1 },
        geometry: { type: "Point", coordinates: [0, 0] },
      },
      {
        type: "Feature",
        id: "f2",
        properties: { id: 2 },
        geometry: { type: "Point", coordinates: [1, 1] },
      },
    ];

    const graph: ProcessingModelGraph = {
      nodes: [
        { id: "in_pts", kind: "input", x: 0, y: 0, layerId: "pts" },
        { id: "ext_poly", kind: "tool", x: 0, y: 100, provider: "vector", toolId: "overlay" },
        { id: "iter", kind: "iterate-features", x: 100, y: 0 },
        { id: "body_clip", kind: "tool", x: 200, y: 0, provider: "vector", toolId: "clip" },
        { id: "collect", kind: "collect-results", x: 300, y: 0 },
        { id: "out", kind: "output", x: 400, y: 0, name: "Clipped" },
      ],
      edges: [
        { id: "e1", from: "in_pts", fromPort: "out", to: "iter", toPort: "collection" },
        { id: "e2", from: "iter", fromPort: "feature", to: "body_clip", toPort: "layer" },
        { id: "e3", from: "ext_poly", fromPort: "out", to: "body_clip", toPort: "overlay" },
        { id: "e4", from: "body_clip", fromPort: "out", to: "collect", toPort: "item" },
        { id: "e5", from: "collect", fromPort: "collection", to: "out", toPort: "in" },
      ],
    };

    const result = await runModelGraph(graph, {
      resolveDescriptor: localResolve,
      resolveInput: () => makeVectorValue(inputFeatures),
      executeTool: async ({ node, inputs }): Promise<Record<string, ModelValue>> => {
        executionOrder.push(node.id);
        if (node.id === "ext_poly") {
          return {
            out: makeVectorValue([
              { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [9, 9] } },
            ]),
          };
        }
        if (node.id === "body_clip") {
          assert.ok(inputs.overlay, "ext_poly output must be available as overlay input");
          return { out: inputs.layer };
        }
        return {};
      },
      emitOutput: () => {},
      log: () => {},
    });

    assert.equal(result.error, undefined);
    assert.equal(executionOrder[0], "ext_poly");
    assert.equal(executionOrder.filter((id) => id === "body_clip").length, 2);
  });

  it("finishes a loop before a later loop whose body reads its collector", async () => {
    const clipTool: ModelToolDescriptor = {
      key: "vector:clip",
      provider: "vector",
      toolId: "clip",
      name: "Clip",
      group: "Overlay",
      inputs: [
        { id: "layer", label: "Input", kind: "vector", required: true },
        { id: "overlay", label: "Overlay", kind: "vector", required: true },
      ],
      outputs: [{ id: "out", label: "Output", kind: "vector" }],
      parameters: [],
    };
    const localTools = [...TOOLS, clipTool];
    const localResolve = (prov?: string, id?: string) =>
      localTools.find((t) => t.provider === prov && t.toolId === id);
    const point = (id: string, x: number): Feature => ({
      type: "Feature",
      id,
      properties: {},
      geometry: { type: "Point", coordinates: [x, 0] },
    });

    // The second loop is listed first, so a plain topological order visits
    // iter2 before iter1 has filled collect1.
    const graph: ProcessingModelGraph = {
      nodes: [
        { id: "in_a", kind: "input", x: 0, y: 0, layerId: "a" },
        { id: "iter2", kind: "iterate-features", x: 0, y: 0 },
        { id: "clip2", kind: "tool", x: 0, y: 0, provider: "vector", toolId: "clip" },
        { id: "collect2", kind: "collect-results", x: 0, y: 0 },
        { id: "out", kind: "output", x: 0, y: 0, name: "Clipped" },
        { id: "in_b", kind: "input", x: 0, y: 0, layerId: "b" },
        { id: "iter1", kind: "iterate-features", x: 0, y: 0 },
        { id: "buf1", kind: "tool", x: 0, y: 0, provider: "vector", toolId: "buffer" },
        { id: "collect1", kind: "collect-results", x: 0, y: 0 },
      ],
      edges: [
        { id: "e1", from: "in_a", fromPort: "out", to: "iter2", toPort: "collection" },
        { id: "e2", from: "iter2", fromPort: "feature", to: "clip2", toPort: "layer" },
        { id: "e3", from: "collect1", fromPort: "collection", to: "clip2", toPort: "overlay" },
        { id: "e4", from: "clip2", fromPort: "out", to: "collect2", toPort: "item" },
        { id: "e5", from: "collect2", fromPort: "collection", to: "out", toPort: "in" },
        { id: "e6", from: "in_b", fromPort: "out", to: "iter1", toPort: "collection" },
        { id: "e7", from: "iter1", fromPort: "feature", to: "buf1", toPort: "layer" },
        { id: "e8", from: "buf1", fromPort: "out", to: "collect1", toPort: "item" },
      ],
    };
    assert.deepEqual(validateModelGraph(graph, localResolve), []);

    const overlaySizes: number[] = [];
    let bufRuns = 0;
    const result = await runModelGraph(graph, {
      resolveDescriptor: localResolve,
      resolveInput: (layerId) =>
        layerId === "a"
          ? makeVectorValue([point("a1", 0), point("a2", 1)])
          : makeVectorValue([point("b1", 5), point("b2", 6), point("b3", 7)]),
      executeTool: async ({ node, inputs }): Promise<Record<string, ModelValue>> => {
        if (node.id === "buf1") {
          bufRuns++;
          return { out: inputs.layer };
        }
        const overlay = inputs.overlay;
        assert.ok(overlay?.kind === "vector", "collect1 must be produced before clip2 runs");
        overlaySizes.push(overlay.geojson.features.length);
        return { out: inputs.layer };
      },
      emitOutput: () => {},
      log: () => {},
    });

    assert.equal(result.error, undefined);
    assert.equal(bufRuns, 3);
    assert.deepEqual(overlaySizes, [3, 3]);
    const out = result.outputs.out;
    assert.ok(out?.kind === "vector");
    assert.equal(out.geojson.features.length, 2);
  });

  it("reads an iterator's source from parameters.layer, as the assistant writes it", async () => {
    const graph: ProcessingModelGraph = {
      nodes: [
        { id: "iter", kind: "iterate-features", x: 0, y: 0, parameters: { layer: "pts" } },
        { id: "buf", kind: "tool", x: 0, y: 0, provider: "vector", toolId: "buffer" },
        { id: "collect", kind: "collect-results", x: 0, y: 0 },
        { id: "out", kind: "output", x: 0, y: 0 },
      ],
      edges: [
        { id: "e1", from: "iter", fromPort: "feature", to: "buf", toPort: "layer" },
        { id: "e2", from: "buf", fromPort: "out", to: "collect", toPort: "item" },
        { id: "e3", from: "collect", fromPort: "collection", to: "out", toPort: "in" },
      ],
    };
    assert.deepEqual(validateModelGraph(graph, resolve), []);
    const asked: string[] = [];
    const result = await runModelGraph(graph, {
      resolveDescriptor: resolve,
      resolveInput: (layerId) => {
        asked.push(layerId);
        return makeVectorValue([
          { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [0, 0] } },
        ]);
      },
      executeTool: async ({ inputs }) => ({ out: inputs.layer }),
      emitOutput: () => {},
      log: () => {},
    });
    assert.equal(result.error, undefined);
    assert.deepEqual(asked, ["pts"]);
  });

  it("routes the layer an unwired switch names", async () => {
    const graph: ProcessingModelGraph = {
      nodes: [
        {
          id: "switch",
          kind: "conditional-switch",
          x: 0,
          y: 0,
          layerId: "pts",
          parameters: { conditionType: "boolean", value: "true" },
        },
        { id: "out", kind: "output", x: 0, y: 0 },
      ],
      edges: [{ id: "e1", from: "switch", fromPort: "true", to: "out", toPort: "in" }],
    };
    assert.deepEqual(validateModelGraph(graph, resolve), []);
    const result = await runModelGraph(graph, {
      resolveDescriptor: resolve,
      resolveInput: () => makeVectorValue([]),
      executeTool: async () => ({}),
      emitOutput: () => {},
      log: () => {},
    });
    assert.equal(result.error, undefined);
    assert.ok(result.outputs.out);
  });

  it("still requires a tool's input when the tool has a layer parameter", () => {
    const graph: ProcessingModelGraph = {
      nodes: [
        {
          id: "buf",
          kind: "tool",
          x: 0,
          y: 0,
          provider: "vector",
          toolId: "buffer",
          parameters: { layer: "" },
        },
        {
          id: "clip",
          kind: "tool",
          x: 0,
          y: 0,
          provider: "whitebox",
          toolId: "threshold",
          parameters: { layer: "pts" },
        },
        { id: "out", kind: "output", x: 0, y: 0 },
      ],
      edges: [{ id: "e1", from: "clip", fromPort: "output", to: "out", toPort: "in" }],
    };
    const issues = validateModelGraph(graph, resolve);
    assert.ok(issues.some((i) => i.code === "missing-input" && i.nodeId === "clip"));
  });

  it("rejects a loop nested inside a collector-driven loop body", () => {
    const graph: ProcessingModelGraph = {
      nodes: [
        { id: "in", kind: "input", x: 0, y: 0, layerId: "pts" },
        { id: "outer", kind: "iterate-features", x: 0, y: 0 },
        { id: "inner", kind: "iterate-features", x: 0, y: 0 },
        { id: "buf", kind: "tool", x: 0, y: 0, provider: "vector", toolId: "buffer" },
        { id: "collect", kind: "collect-results", x: 0, y: 0 },
        { id: "out", kind: "output", x: 0, y: 0 },
      ],
      edges: [
        { id: "e1", from: "in", fromPort: "out", to: "outer", toPort: "collection" },
        { id: "e2", from: "outer", fromPort: "feature", to: "inner", toPort: "collection" },
        { id: "e3", from: "inner", fromPort: "feature", to: "buf", toPort: "layer" },
        { id: "e4", from: "buf", fromPort: "out", to: "collect", toPort: "item" },
        { id: "e5", from: "collect", fromPort: "collection", to: "out", toPort: "in" },
      ],
    };
    const issues = validateModelGraph(graph, resolve);
    assert.ok(issues.some((i) => i.code === "invalid-iterator" && i.nodeId === "inner"));
  });

  it("validates that body nodes cannot feed external non-collector nodes", () => {
    const graph: ProcessingModelGraph = {
      nodes: [
        { id: "in_pts", kind: "input", x: 0, y: 0, layerId: "pts" },
        { id: "iter", kind: "iterate-features", x: 100, y: 0 },
        { id: "buf", kind: "tool", x: 200, y: 0, provider: "vector", toolId: "buffer" },
        { id: "collect", kind: "collect-results", x: 300, y: 0 },
        {
          id: "external_centroid",
          kind: "tool",
          x: 300,
          y: 100,
          provider: "vector",
          toolId: "centroid",
        },
        { id: "out", kind: "output", x: 400, y: 0, name: "Out" },
      ],
      edges: [
        { id: "e1", from: "in_pts", fromPort: "out", to: "iter", toPort: "collection" },
        { id: "e2", from: "iter", fromPort: "feature", to: "buf", toPort: "layer" },
        { id: "e3", from: "buf", fromPort: "out", to: "collect", toPort: "item" },
        { id: "e4", from: "buf", fromPort: "out", to: "external_centroid", toPort: "layer" },
        { id: "e5", from: "collect", fromPort: "collection", to: "out", toPort: "in" },
      ],
    };

    const issues = validateModelGraph(graph, resolve);
    const bodyConsumerIssue = issues.find(
      (i) =>
        i.code === "invalid-iterator" &&
        i.message.includes("can only feed other body nodes or the collector"),
    );
    assert.ok(bodyConsumerIssue);
  });

  // G. Model graph: collector result types (vector-only, raster-only, mixed error)
  it("collects raster-only results into a raster-collection", async () => {
    const raster1 = makeRasterValue("dem_1", 10);
    const raster2 = makeRasterValue("dem_2", 20);

    const graph: ProcessingModelGraph = {
      nodes: [
        {
          id: "iter",
          kind: "iterate-rasters",
          x: 100,
          y: 0,
          parameters: { layers: ["dem_1", "dem_2"] },
        },
        { id: "thresh", kind: "tool", x: 200, y: 0, provider: "whitebox", toolId: "threshold" },
        { id: "collect", kind: "collect-results", x: 300, y: 0 },
        { id: "out", kind: "output", x: 400, y: 0, name: "Rasters" },
      ],
      edges: [
        { id: "e1", from: "iter", fromPort: "raster", to: "thresh", toPort: "input" },
        { id: "e2", from: "thresh", fromPort: "output", to: "collect", toPort: "item" },
        { id: "e3", from: "collect", fromPort: "collection", to: "out", toPort: "in" },
      ],
    };

    const result = await runModelGraph(graph, {
      resolveDescriptor: resolve,
      resolveInput: (id) => (id === "dem_1" ? raster1 : raster2),
      executeTool: async ({ inputs }) => ({ output: inputs.input }),
      emitOutput: () => {},
      log: () => {},
    });

    assert.equal(result.error, undefined);
    const outVal = result.outputs["out"];
    assert.ok(outVal && outVal.kind === "raster-collection");
    assert.equal(outVal.items.length, 2);
  });

  it("reports an explicit error when collector receives mixed vector and raster results", async () => {
    let callIndex = 0;
    const mixedTool: ModelToolDescriptor = {
      key: "vector:mixed",
      provider: "vector",
      toolId: "mixed",
      name: "Mixed Output Tool",
      group: "Test",
      inputs: [{ id: "input", label: "Input", kind: "vector", required: true }],
      outputs: [{ id: "out", label: "Output", kind: "any" }],
      parameters: [],
    };
    const localResolve = (prov?: string, id?: string) =>
      prov === "vector" && id === "mixed" ? mixedTool : resolve(prov, id);

    const graph: ProcessingModelGraph = {
      nodes: [
        { id: "in", kind: "input", x: 0, y: 0, layerId: "pts" },
        { id: "iter", kind: "iterate-features", x: 100, y: 0 },
        { id: "mixed", kind: "tool", x: 200, y: 0, provider: "vector", toolId: "mixed" },
        { id: "collect", kind: "collect-results", x: 300, y: 0 },
        { id: "out", kind: "output", x: 400, y: 0, name: "Out" },
      ],
      edges: [
        { id: "e1", from: "in", fromPort: "out", to: "iter", toPort: "collection" },
        { id: "e2", from: "iter", fromPort: "feature", to: "mixed", toPort: "input" },
        { id: "e3", from: "mixed", fromPort: "out", to: "collect", toPort: "item" },
        { id: "e4", from: "collect", fromPort: "collection", to: "out", toPort: "in" },
      ],
    };

    const result = await runModelGraph(graph, {
      resolveDescriptor: localResolve,
      resolveInput: () =>
        makeVectorValue([
          { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [0, 0] } },
          { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [1, 1] } },
        ]),
      executeTool: async () => {
        callIndex++;
        if (callIndex === 1) {
          return {
            out: makeVectorValue([
              { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [0, 0] } },
            ]),
          };
        } else {
          return { out: makeRasterValue("test_raster", 1) };
        }
      },
      emitOutput: () => {},
      log: () => {},
    });

    assert.ok(result.error);
    assert.match(result.error.message, /Collector received mixed vector and raster results/);
  });

  // H. Model graph: iterator validation and fallback behavior
  it("rejects iterators without a body or collector in validateModelGraph", () => {
    const graph: ProcessingModelGraph = {
      nodes: [
        { id: "in", kind: "input", x: 0, y: 0, layerId: "pts" },
        { id: "iter", kind: "iterate-features", x: 100, y: 0 },
        { id: "out", kind: "output", x: 200, y: 0, name: "Out" },
      ],
      edges: [
        { id: "e1", from: "in", fromPort: "out", to: "iter", toPort: "collection" },
        { id: "e2", from: "iter", fromPort: "feature", to: "out", toPort: "in" },
      ],
    };

    const issues = validateModelGraph(graph, resolve);
    const iterIssue = issues.find((i) => i.code === "invalid-iterator");
    assert.ok(iterIssue);
    assert.match(
      iterIssue.message,
      /requires an iteration body or a downstream Collect Results node/,
    );
  });

  it("fails execution with explicit error when iterator lacks body and collector", async () => {
    const graph: ProcessingModelGraph = {
      nodes: [
        { id: "in", kind: "input", x: 0, y: 0, layerId: "pts" },
        { id: "iter", kind: "iterate-features", x: 100, y: 0 },
        { id: "out", kind: "output", x: 200, y: 0, name: "Out" },
      ],
      edges: [
        { id: "e1", from: "in", fromPort: "out", to: "iter", toPort: "collection" },
        { id: "e2", from: "iter", fromPort: "feature", to: "out", toPort: "in" },
      ],
    };

    const result = await runModelGraph(graph, {
      resolveDescriptor: resolve,
      resolveInput: () =>
        makeVectorValue([
          { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [0, 0] } },
        ]),
      executeTool: async () => ({}),
      emitOutput: () => {},
      log: () => {},
    });

    assert.ok(result.error);
    assert.match(
      result.error.message,
      /requires an iteration body or a downstream Collect Results node/,
    );
  });

  // I. Model graph: multiple rasters preserved in iterate-rasters output
  it("stores the full raster collection in iterate-rasters output port", async () => {
    const raster1 = makeRasterValue("r1", 1);
    const raster2 = makeRasterValue("r2", 2);

    const graph: ProcessingModelGraph = {
      nodes: [
        {
          id: "iter",
          kind: "iterate-rasters",
          x: 100,
          y: 0,
          parameters: { layers: ["r1", "r2"] },
          body: {
            nodes: [
              { id: "bin", kind: "input", x: 0, y: 0, layerId: "current" },
              { id: "bout", kind: "output", x: 100, y: 0 },
            ],
            edges: [{ id: "be", from: "bin", fromPort: "out", to: "bout", toPort: "in" }],
          },
        },
        { id: "out", kind: "output", x: 300, y: 0, name: "Collection" },
      ],
      edges: [{ id: "e1", from: "iter", fromPort: "raster", to: "out", toPort: "in" }],
    };

    const result = await runModelGraph(graph, {
      resolveDescriptor: resolve,
      resolveInput: (id) => (id === "r1" ? raster1 : raster2),
      executeTool: async () => ({}),
      emitOutput: () => {},
      log: () => {},
    });

    assert.equal(result.error, undefined);
    const outVal = result.outputs["out"];
    assert.ok(outVal && outVal.kind === "raster-collection");
    assert.equal(outVal.items.length, 2);
  });
});
