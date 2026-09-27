import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ModelGraphNode, ProcessingModelGraph } from "../packages/core/src";
import type { ModelToolDescriptor } from "../packages/processing/src";
import { modelFieldOptions } from "../apps/geolibre-desktop/src/lib/model-field-options";

const fieldsByLayer = new Map([
  ["parcels", ["id", "owner", "my_field_A"]],
  ["owners", ["id", "name"]],
]);

/** The client Attribute join tool: two layer parameters, two key fields. */
const attributeJoin: ModelToolDescriptor = {
  key: "vector:attribute-join",
  provider: "vector",
  toolId: "attribute-join",
  name: "Attribute join",
  group: "Join",
  inputs: [
    { id: "layer", label: "Target layer", kind: "vector" },
    { id: "overlay", label: "Join layer", kind: "vector" },
  ],
  outputs: [{ id: "out", label: "Output", kind: "vector" }],
  parameters: [
    { id: "layer", label: "Target layer", type: "layer" },
    { id: "overlay", label: "Join layer", type: "layer" },
    { id: "target_field", label: "Target key", type: "field", fieldSource: "layer" },
    { id: "join_field", label: "Join key", type: "field", fieldSource: "overlay" },
  ],
};

/** A Whitebox tool whose field parameter could not be matched to one input. */
const whiteboxTwoInputs: ModelToolDescriptor = {
  key: "whitebox:join_tables",
  provider: "whitebox",
  toolId: "join_tables",
  name: "Join Tables",
  group: "GIS",
  inputs: [
    { id: "primary_vector", label: "primary_vector", kind: "vector" },
    { id: "foreign_vector", label: "foreign_vector", kind: "vector" },
  ],
  outputs: [{ id: "output", label: "output", kind: "vector" }],
  parameters: [{ id: "import_field", label: "Import field", type: "field" }],
};

const param = (descriptor: ModelToolDescriptor, id: string) =>
  descriptor.parameters.find((candidate) => candidate.id === id)!;

function tool(parameters: Record<string, unknown> = {}): ModelGraphNode {
  return { id: "t", kind: "tool", x: 0, y: 0, parameters };
}

describe("modelFieldOptions", () => {
  it("offers the columns of the input node wired into the field's source port", () => {
    const node = tool();
    const graph: ProcessingModelGraph = {
      nodes: [
        { id: "a", kind: "input", x: 0, y: 0, layerId: "parcels" },
        { id: "b", kind: "input", x: 0, y: 0, layerId: "owners" },
        node,
      ],
      edges: [
        { id: "e1", from: "a", fromPort: "out", to: "t", toPort: "layer" },
        { id: "e2", from: "b", fromPort: "out", to: "t", toPort: "overlay" },
      ],
    };
    const options = (id: string) =>
      modelFieldOptions(graph, node, attributeJoin, param(attributeJoin, id), fieldsByLayer);
    assert.deepEqual(options("target_field"), ["id", "owner", "my_field_A"]);
    assert.deepEqual(options("join_field"), ["id", "name"]);
  });

  it("falls back to a layer picked in the properties panel when nothing is wired", () => {
    const node = tool({ layer: "owners" });
    const graph: ProcessingModelGraph = { nodes: [node], edges: [] };
    assert.deepEqual(
      modelFieldOptions(
        graph,
        node,
        attributeJoin,
        param(attributeJoin, "target_field"),
        fieldsByLayer,
      ),
      ["id", "name"],
    );
  });

  it("offers nothing for a source fed by another tool, whose columns exist only after a run", () => {
    const node = tool();
    const graph: ProcessingModelGraph = {
      nodes: [{ id: "up", kind: "tool", x: 0, y: 0 }, node],
      edges: [{ id: "e", from: "up", fromPort: "out", to: "t", toPort: "layer" }],
    };
    assert.deepEqual(
      modelFieldOptions(
        graph,
        node,
        attributeJoin,
        param(attributeJoin, "target_field"),
        fieldsByLayer,
      ),
      [],
    );
  });

  it("offers nothing before a source layer is chosen, or for a layer with no known columns", () => {
    const empty = tool();
    assert.deepEqual(
      modelFieldOptions(
        { nodes: [empty], edges: [] },
        empty,
        attributeJoin,
        param(attributeJoin, "target_field"),
        fieldsByLayer,
      ),
      [],
    );
    const unknown = tool({ layer: "a-raster-layer" });
    assert.deepEqual(
      modelFieldOptions(
        { nodes: [unknown], edges: [] },
        unknown,
        attributeJoin,
        param(attributeJoin, "target_field"),
        fieldsByLayer,
      ),
      [],
    );
  });

  it("unions every vector input's columns when a Whitebox field names no input", () => {
    const node = tool();
    const graph: ProcessingModelGraph = {
      nodes: [
        { id: "a", kind: "input", x: 0, y: 0, layerId: "parcels" },
        { id: "b", kind: "input", x: 0, y: 0, layerId: "owners" },
        node,
      ],
      edges: [
        { id: "e1", from: "a", fromPort: "out", to: "t", toPort: "primary_vector" },
        { id: "e2", from: "b", fromPort: "out", to: "t", toPort: "foreign_vector" },
      ],
    };
    assert.deepEqual(
      modelFieldOptions(
        graph,
        node,
        whiteboxTwoInputs,
        param(whiteboxTwoInputs, "import_field"),
        fieldsByLayer,
      ),
      ["id", "owner", "my_field_A", "name"],
    );
  });
});
