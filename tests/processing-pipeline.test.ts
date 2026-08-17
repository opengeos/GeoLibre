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
});
