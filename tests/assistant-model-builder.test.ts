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
  parameters: [{ id: "distance", label: "Distance", type: "number", required: true }],
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
      steps: [{ key: "result", algorithm: "buffer", inputs: { layer: "roads" } }],
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
});
