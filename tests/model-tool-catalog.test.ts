import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProcessingAlgorithm, WhiteboxTool } from "../packages/processing/src";
import {
  buildModelToolCatalog,
  groupModelTools,
  modelToolKey,
  searchModelTools,
  vectorToolDescriptor,
  whiteboxToolDescriptor,
} from "../apps/geolibre-desktop/src/lib/model-tool-catalog";

const bufferAlgorithm: ProcessingAlgorithm = {
  id: "buffer",
  name: "Buffer",
  description: "Buffer features",
  group: "Geometry",
  parameters: [
    { id: "layer", label: "Input layer", type: "layer", required: true },
    { id: "distance", label: "Distance", type: "number", default: 10 },
  ],
  run: () => {},
};

const clipAlgorithm: ProcessingAlgorithm = {
  id: "clip",
  name: "Clip",
  description: "Clip by another layer",
  group: "Overlay",
  parameters: [
    { id: "layer", label: "Input layer", type: "layer", required: true },
    { id: "overlay", label: "Clip layer", type: "layer", required: true },
  ],
  run: () => {},
};

const slopeTool: WhiteboxTool = {
  id: "slope",
  display_name: "Slope",
  summary: "Surface slope from a DEM",
  taxonomy_category: "Terrain Analysis",
  params: [
    { name: "dem", kind: "raster_in", required: true },
    { name: "output", kind: "raster_out" },
    { name: "zfactor", kind: "double", default: 1 },
    { name: "units", kind: "enum", options: ["degrees", "radians"] },
  ],
};

describe("vector tool descriptors", () => {
  it("turns layer parameters into typed input ports", () => {
    const descriptor = vectorToolDescriptor(clipAlgorithm);
    assert.deepEqual(
      descriptor.inputs.map((port) => [port.id, port.kind, port.required]),
      [
        ["layer", "vector", true],
        ["overlay", "vector", true],
      ],
    );
  });

  it("gives every vector tool one vector output port", () => {
    const descriptor = vectorToolDescriptor(bufferAlgorithm);
    assert.deepEqual(descriptor.outputs, [{ id: "out", label: "Output", kind: "vector" }]);
  });

  it("keeps layer parameters in the properties panel as well as on ports", () => {
    // A single-node model names its layer by hand rather than drawing an input
    // node, so the field has to stay available.
    const descriptor = vectorToolDescriptor(bufferAlgorithm);
    assert.ok(descriptor.parameters.some((param) => param.id === "layer"));
    assert.ok(descriptor.parameters.some((param) => param.id === "distance"));
  });

  it("namespaces the key by provider so both registries can define `buffer`", () => {
    assert.equal(vectorToolDescriptor(bufferAlgorithm).key, "vector:buffer");
    assert.equal(modelToolKey("whitebox", "buffer"), "whitebox:buffer");
  });
});

describe("whitebox tool descriptors", () => {
  it("maps dataset parameters to ports and scalars to fields", () => {
    const descriptor = whiteboxToolDescriptor(slopeTool);
    assert.ok(descriptor);
    assert.deepEqual(
      descriptor.inputs.map((port) => [port.id, port.kind]),
      [["dem", "raster"]],
    );
    assert.deepEqual(
      descriptor.outputs.map((port) => [port.id, port.kind]),
      [["output", "raster"]],
    );
    assert.deepEqual(
      descriptor.parameters.map((param) => [param.id, param.type]),
      [
        ["zfactor", "number"],
        ["units", "select"],
      ],
    );
  });

  it("carries enum choices through as select options", () => {
    const descriptor = whiteboxToolDescriptor(slopeTool);
    const units = descriptor?.parameters.find((param) => param.id === "units");
    assert.deepEqual(units?.options, [
      { value: "degrees", label: "degrees" },
      { value: "radians", label: "radians" },
    ]);
  });

  it("classifies a vector-in/vector-out tool as vector ports", () => {
    const descriptor = whiteboxToolDescriptor({
      id: "buffer_vector",
      display_name: "Buffer Vector",
      params: [
        { name: "input", kind: "vector_in", required: true },
        { name: "output", kind: "vector_out" },
        { name: "distance", kind: "double" },
      ],
    });
    assert.equal(descriptor?.inputs[0].kind, "vector");
    assert.equal(descriptor?.outputs[0].kind, "vector");
  });

  it("carries the manifest through as `native` for the WASM runner", () => {
    // The runner builds its CLI arguments by walking `tool.params`; a descriptor
    // that drops the manifest makes every Whitebox node run with no arguments
    // and the binary rejects it as missing a required parameter.
    const descriptor = whiteboxToolDescriptor(slopeTool);
    assert.equal(descriptor?.native, slopeTool);
  });

  it("drops a tool with no output port rather than stranding it on the canvas", () => {
    const descriptor = whiteboxToolDescriptor({
      id: "print_stats",
      params: [{ name: "input", kind: "raster_in", required: true }],
    });
    assert.equal(descriptor, null);
  });

  it("keeps a LiDAR input as a field, since no edge can carry one", () => {
    const descriptor = whiteboxToolDescriptor({
      id: "lidar_thing",
      params: [
        { name: "cloud", kind: "lidar_in", required: true },
        { name: "output", kind: "raster_out" },
      ],
    });
    assert.deepEqual(
      descriptor?.inputs.map((port) => port.id),
      [],
    );
    assert.equal(descriptor?.parameters.find((param) => param.id === "cloud")?.type, "path");
  });
});

describe("the combined palette", () => {
  it("includes both registries and sorts by group then name", () => {
    const catalog = buildModelToolCatalog([bufferAlgorithm, clipAlgorithm], [slopeTool]);
    assert.deepEqual(
      catalog.map((descriptor) => descriptor.key),
      ["vector:buffer", "vector:clip", "whitebox:slope"],
    );
  });

  it("omits locked pro-tier tools, which could never run", () => {
    const catalog = buildModelToolCatalog(
      [],
      [slopeTool, { ...slopeTool, id: "locked_tool", locked: true }],
    );
    assert.deepEqual(
      catalog.map((descriptor) => descriptor.toolId),
      ["slope"],
    );
  });

  it("groups entries in their sorted order", () => {
    const groups = groupModelTools(
      buildModelToolCatalog([bufferAlgorithm, clipAlgorithm], [slopeTool]),
    );
    assert.deepEqual(
      groups.map((entry) => entry.group),
      ["Geometry", "Overlay", "Terrain Analysis"],
    );
  });

  it("searches across name, id and group", () => {
    const catalog = buildModelToolCatalog([bufferAlgorithm, clipAlgorithm], [slopeTool]);
    assert.deepEqual(
      searchModelTools(catalog, "terrain").map((descriptor) => descriptor.toolId),
      ["slope"],
    );
    assert.deepEqual(
      searchModelTools(catalog, "clip").map((descriptor) => descriptor.toolId),
      ["clip"],
    );
    assert.equal(searchModelTools(catalog, "   ").length, catalog.length);
  });
});
