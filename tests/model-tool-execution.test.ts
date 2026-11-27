import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ModelGraphNode } from "@geolibre/core";
import type { ModelToolDescriptor } from "@geolibre/processing";
import { executeModelTool } from "../apps/geolibre-desktop/src/components/processing/model-builder/model-tool-execution";
import { nodeInspectorTitle } from "../apps/geolibre-desktop/src/components/processing/model-builder/model-builder-labels";

const t = ((key: string) => key) as never;

/** Run the client buffer tool through executeModelTool, collecting its log. */
async function runBuffer(signal?: AbortSignal): Promise<string[]> {
  const lines: string[] = [];
  await executeModelTool({
    node: {
      id: "n1",
      kind: "tool",
      x: 0,
      y: 0,
      provider: "vector",
      toolId: "buffer",
      parameters: { distance: 1, units: "kilometers" },
    } as ModelGraphNode,
    descriptor: {
      provider: "vector",
      toolId: "buffer",
      inputs: [],
      outputs: [{ id: "out" }],
    } as unknown as ModelToolDescriptor,
    inputs: {
      layer: {
        kind: "vector",
        geojson: {
          type: "FeatureCollection",
          features: [
            { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [0, 0] } },
          ],
        },
      },
    },
    signal,
    layers: [],
    duckdb: undefined as never,
    log: (message) => lines.push(message),
    t,
  });
  return lines;
}

describe("executeModelTool", () => {
  it("logs the tool's messages for a live run", async () => {
    assert.equal((await runBuffer(new AbortController().signal)).length, 1);
  });

  it("drops log writes once the run is aborted (#3697)", async () => {
    // An abandoned run's tool can finish after the abort; its messages must
    // not reach the log of the model that replaced it.
    const controller = new AbortController();
    controller.abort();
    assert.deepEqual(await runBuffer(controller.signal), []);
  });
});

describe("nodeInspectorTitle (#3697)", () => {
  const node = (kind: string) => ({ id: "n", kind, x: 0, y: 0 }) as unknown as ModelGraphNode;

  it("titles control-flow nodes with their own name, not Output", () => {
    assert.equal(
      nodeInspectorTitle(t, node("conditional-switch"), undefined),
      "processing.modelBuilder.controlFlow.kinds.conditionalSwitch",
    );
    assert.equal(
      nodeInspectorTitle(t, node("iterate-features"), undefined),
      "processing.modelBuilder.controlFlow.kinds.iterateFeatures",
    );
    assert.equal(
      nodeInspectorTitle(t, node("collect-results"), undefined),
      "processing.modelBuilder.controlFlow.kinds.collectResults",
    );
  });

  it("keeps the input and output headings", () => {
    assert.equal(
      nodeInspectorTitle(t, node("input"), undefined),
      "processing.modelBuilder.inputNode",
    );
    assert.equal(
      nodeInspectorTitle(t, node("output"), undefined),
      "processing.modelBuilder.outputNode",
    );
  });
});
