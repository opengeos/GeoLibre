import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GeoLibreLayer } from "../packages/core/src/types";
import type { ModelToolDescriptor } from "../packages/processing/src/model-graph";
import { buildAssistantModel } from "../apps/geolibre-desktop/src/lib/assistant/model-builder";

const BUFFER: ModelToolDescriptor = {
  key: "vector:buffer",
  provider: "vector",
  toolId: "buffer",
  name: "Buffer",
  group: "Geometry",
  inputs: [{ id: "layer", label: "Input", kind: "vector", required: true }],
  outputs: [{ id: "out", label: "Output", kind: "vector" }],
  // `vectorToolDescriptor` lists a layer parameter as both a port and a
  // parameter, so a single-node model can name a layer without an input node.
  parameters: [
    { id: "layer", label: "Input", type: "layer", required: true },
    { id: "distance", label: "Distance", type: "number", required: true },
  ],
};

const CLIP: ModelToolDescriptor = {
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
  parameters: [
    { id: "layer", label: "Input", type: "layer", required: true },
    { id: "overlay", label: "Overlay", type: "layer", required: true },
  ],
};

/** A same-id tool from the other registry, the collision `modelToolKey` guards. */
const WHITEBOX_BUFFER: ModelToolDescriptor = {
  key: "whitebox:buffer",
  provider: "whitebox",
  toolId: "buffer",
  name: "Buffer Raster",
  group: "Whitebox",
  inputs: [{ id: "input", label: "Input", kind: "raster", required: true }],
  outputs: [{ id: "out", label: "Output", kind: "raster" }],
  parameters: [],
};

const layers = [
  { id: "roads-id", name: "Roads", type: "geojson" },
  { id: "counties-id", name: "Counties", type: "geojson" },
] as GeoLibreLayer[];

function ids(): () => string {
  let next = 0;
  return () => `id-${++next}`;
}

describe("AI-created Model Builder models", () => {
  it("turns a natural-language-style pipeline definition into a saved graph", () => {
    const model = buildAssistantModel(
      {
        name: "Road buffers clipped to counties",
        inputs: [
          { key: "roads", layer: "Roads" },
          { key: "counties", layer: "counties-id" },
        ],
        steps: [
          {
            key: "buffered",
            algorithm: "buffer",
            inputs: { layer: "roads" },
            parameters: { distance: 100 },
          },
          {
            key: "clipped",
            algorithm: "clip",
            inputs: { layer: "buffered", overlay: "counties" },
          },
        ],
        outputs: [{ source: "clipped", name: "Clipped road buffers" }],
      },
      layers,
      [BUFFER, CLIP],
      ids(),
    );

    assert.equal(model.name, "Road buffers clipped to counties");
    assert.equal(model.graph?.nodes.length, 5);
    assert.equal(model.graph?.edges.length, 4);
    // A two-input clip is a graph rather than a legacy linear model.
    assert.deepEqual(model.steps, []);
    const toolNodes = model.graph?.nodes.filter((node) => node.kind === "tool") ?? [];
    assert.deepEqual(
      toolNodes.map((node) => [node.toolId, node.parameters]),
      [
        ["buffer", { distance: 100 }],
        ["clip", {}],
      ],
    );
  });

  it("rejects unknown algorithms, ports, sources, and layers", () => {
    const base = {
      name: "Bad model",
      inputs: [{ key: "roads", layer: "Roads" }],
      steps: [
        {
          key: "result",
          algorithm: "buffer",
          inputs: { layer: "roads" },
          parameters: { distance: 100 },
        },
      ],
      outputs: [{ source: "result", name: "Result" }],
    };
    assert.throws(
      () =>
        buildAssistantModel(
          { ...base, inputs: [{ key: "x", layer: "Missing" }] },
          layers,
          [BUFFER],
          ids(),
        ),
      /No layer matching/,
    );
    assert.throws(
      () =>
        buildAssistantModel(
          { ...base, steps: [{ ...base.steps[0], algorithm: "invented" }] },
          layers,
          [BUFFER],
          ids(),
        ),
      /not a Model Builder algorithm/,
    );
    assert.throws(
      () =>
        buildAssistantModel(
          { ...base, steps: [{ ...base.steps[0], inputs: { bogus: "roads" } }] },
          layers,
          [BUFFER],
          ids(),
        ),
      /no input port/,
    );
    assert.throws(
      () =>
        buildAssistantModel(
          { ...base, outputs: [{ source: "missing", name: "Result" }] },
          layers,
          [BUFFER],
          ids(),
        ),
      /Unknown model output source/,
    );
  });

  it("keeps the provider part of a tool's identity", () => {
    const base = {
      name: "Colliding ids",
      inputs: [{ key: "roads", layer: "Roads" }],
      steps: [
        {
          key: "result",
          algorithm: "buffer",
          inputs: { layer: "roads" },
          parameters: { distance: 100 },
        },
      ],
      outputs: [{ source: "result", name: "Result" }],
    };
    // A bare id both registries define resolves to neither.
    assert.throws(
      () => buildAssistantModel(base, layers, [BUFFER, WHITEBOX_BUFFER], ids()),
      /defined by more than one provider/,
    );
    const model = buildAssistantModel(
      { ...base, steps: [{ ...base.steps[0], algorithm: "vector:buffer" }] },
      layers,
      [BUFFER, WHITEBOX_BUFFER],
      ids(),
    );
    const tool = model.graph?.nodes.find((node) => node.kind === "tool");
    assert.equal(tool?.provider, "vector");
  });

  it("resolves a layer named in parameters rather than wired to a port", () => {
    const base = {
      name: "Named layer",
      inputs: [],
      steps: [
        {
          key: "result",
          algorithm: "buffer",
          inputs: {},
          parameters: { layer: "Roads", distance: 100 } as Record<string, unknown>,
        },
      ],
      outputs: [{ source: "result", name: "Result" }],
    };
    const model = buildAssistantModel(base, layers, [BUFFER], ids());
    const tool = model.graph?.nodes.find((node) => node.kind === "tool");
    // Run time looks the value up by exact id, so the name must not survive.
    assert.equal(tool?.parameters?.layer, "roads-id");
    assert.throws(
      () =>
        buildAssistantModel(
          { ...base, steps: [{ ...base.steps[0], parameters: { layer: "Rivers", distance: 1 } }] },
          layers,
          [BUFFER],
          ids(),
        ),
      /No layer matching "Rivers"/,
    );
  });

  it("checks step parameters against the tool's own declaration", () => {
    const base = {
      name: "Bad parameters",
      inputs: [{ key: "roads", layer: "Roads" }],
      steps: [
        {
          key: "result",
          algorithm: "buffer",
          inputs: { layer: "roads" },
          parameters: { distance: 100 } as Record<string, unknown>,
        },
      ],
      outputs: [{ source: "result", name: "Result" }],
    };
    assert.throws(
      () =>
        buildAssistantModel(
          { ...base, steps: [{ ...base.steps[0], parameters: { distance: 100, invented: 1 } }] },
          layers,
          [BUFFER],
          ids(),
        ),
      /has no parameter "invented"/,
    );
    assert.throws(
      () =>
        buildAssistantModel(
          { ...base, steps: [{ ...base.steps[0], parameters: { distance: "far" } }] },
          layers,
          [BUFFER],
          ids(),
        ),
      /expects a number value/,
    );
    assert.throws(
      () =>
        buildAssistantModel(
          { ...base, steps: [{ ...base.steps[0], parameters: {} }] },
          layers,
          [BUFFER],
          ids(),
        ),
      /"distance" of "buffer" is required/,
    );
  });
});
