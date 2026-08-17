import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  modelToPipeline,
  pipelineToModel,
} from "../apps/geolibre-desktop/src/lib/processing-pipeline";

describe("processing pipeline JSON", () => {
  it("round trips an ordered model through explicit nodes and edges", () => {
    const pipeline = modelToPipeline({
      id: "model-1",
      name: "Buffer and dissolve",
      steps: [
        { id: "buffer", toolId: "buffer", parameters: { layer: "cities", distance: 5 } },
        { id: "dissolve", toolId: "dissolve", parameters: { field: "state" } },
      ],
    });
    assert.deepEqual(pipeline.edges, [{ from: "buffer", to: "dissolve" }]);
    const model = pipelineToModel(pipeline, () => "imported-id");
    assert.equal(model.name, "Buffer and dissolve");
    assert.deepEqual(
      model.steps.map((step) => step.toolId),
      ["buffer", "dissolve"],
    );
  });

  it("rejects branching graphs until the runner supports multiple inputs", () => {
    assert.throws(
      () =>
        pipelineToModel(
          {
            $schema: "https://geolibre.app/schemas/pipeline-v1.json",
            version: "1.0.0",
            name: "Branch",
            nodes: ["a", "b", "c"].map((id) => ({
              id,
              type: "transform.vector.buffer",
              name: id,
              params: {},
            })),
            edges: [
              { from: "a", to: "b" },
              { from: "a", to: "c" },
            ],
          },
          () => "id",
        ),
      /Branching pipelines/,
    );
  });

  it("rejects cycles and disconnected chains", () => {
    const node = (id: string) => ({
      id,
      type: "transform.vector.buffer",
      name: id,
      params: {},
    });
    const base = {
      $schema: "https://geolibre.app/schemas/pipeline-v1.json",
      version: "1.0.0",
      name: "Invalid graph",
    };
    assert.throws(
      () =>
        pipelineToModel(
          {
            ...base,
            nodes: [node("a"), node("b")],
            edges: [
              { from: "a", to: "b" },
              { from: "b", to: "a" },
            ],
          },
          () => "id",
        ),
      /connected chain/,
    );
    assert.throws(
      () =>
        pipelineToModel(
          {
            ...base,
            nodes: [node("a"), node("b"), node("c")],
            edges: [{ from: "a", to: "b" }],
          },
          () => "id",
        ),
      /connected chain/,
    );
    // Edge count matches a chain, but b and c form a loop the walk never enters.
    assert.throws(
      () =>
        pipelineToModel(
          {
            ...base,
            nodes: [node("a"), node("b"), node("c")],
            edges: [
              { from: "b", to: "c" },
              { from: "c", to: "b" },
            ],
          },
          () => "id",
        ),
      /Pipeline contains a cycle/,
    );
  });

  it("rejects fan-in with a merge-specific message", () => {
    assert.throws(
      () =>
        pipelineToModel(
          {
            $schema: "https://geolibre.app/schemas/pipeline-v1.json",
            version: "1.0.0",
            name: "Merge",
            nodes: ["a", "b", "c"].map((id) => ({
              id,
              type: "transform.vector.buffer",
              name: id,
              params: {},
            })),
            edges: [
              { from: "a", to: "c" },
              { from: "b", to: "c" },
            ],
          },
          () => "id",
        ),
      /Merging pipelines/,
    );
  });

  it("rejects malformed node properties with a stable validation error", () => {
    const base = {
      $schema: "https://geolibre.app/schemas/pipeline-v1.json",
      version: "1.0.0",
      name: "Malformed",
      edges: [],
    };
    for (const node of [
      { id: "a", type: 42, params: {} },
      { id: "a", type: "transform.vector.buffer", params: [] },
      { id: "a", type: "transform.vector.buffer", params: {}, inputParam: 7 },
    ]) {
      assert.throws(
        () => pipelineToModel({ ...base, nodes: [node] }, () => "id"),
        /Unsupported pipeline node/,
      );
    }
    assert.throws(
      () =>
        pipelineToModel(
          { ...base, nodes: [{ id: "", type: "transform.vector.buffer", params: {} }] },
          () => "id",
        ),
      /unique id/,
    );
  });

  it("keeps the imported node id rather than minting a new one", () => {
    const model = pipelineToModel(
      {
        $schema: "https://geolibre.app/schemas/pipeline-v1.json",
        version: "1.0.0",
        name: "Single",
        nodes: [{ id: "buffer-1", type: "transform.vector.buffer", params: { distance: 5 } }],
        edges: [],
      },
      () => "minted",
    );
    assert.deepEqual(
      model.steps.map((step) => step.id),
      ["buffer-1"],
    );
  });
});
