import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import {
  getVectorTool,
  runAlgorithmCapture,
  runModel,
  type RunnerHost,
} from "@geolibre/processing";

const points: GeoLibreLayer = {
  id: "pts",
  name: "Points",
  type: "geojson",
  source: { type: "geojson" },
  visible: true,
  opacity: 1,
  style: { ...DEFAULT_LAYER_STYLE },
  metadata: {},
  geojson: {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { name: "A" },
        geometry: { type: "Point", coordinates: [-78, 35] },
      },
      {
        type: "Feature",
        properties: { name: "B" },
        geometry: { type: "Point", coordinates: [-77, 36] },
      },
    ],
  },
};

function makeHost(overrides: Partial<RunnerHost> = {}): RunnerHost {
  return { layers: [points], log: () => {}, ...overrides };
}

describe("processing runner", () => {
  it("captures a single tool's output instead of adding it to the map", async () => {
    const tool = getVectorTool("buffer");
    assert.ok(tool);
    const output = await runAlgorithmCapture(
      tool,
      { layer: "pts", distance: 1, units: "kilometers" },
      makeHost(),
    );
    assert.ok(output);
    assert.equal(output.features.length, 2);
    assert.ok(
      output.features.every(
        (f) => f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon",
      ),
    );
  });

  it("returns null when a tool produces no result layer", async () => {
    // Reproject's client run defers to the Python engine and adds nothing.
    const tool = getVectorTool("reproject");
    assert.ok(tool);
    const output = await runAlgorithmCapture(
      tool,
      { layer: "pts", source_crs: "EPSG:3857" },
      makeHost(),
    );
    assert.equal(output, null);
  });

  it("chains a model's steps, feeding each output into the next", async () => {
    // buffer (points -> polygons) -> centroids (polygons -> points).
    const model = {
      id: "m1",
      name: "Buffer then centroids",
      steps: [
        {
          id: "s1",
          toolId: "buffer",
          parameters: { layer: "pts", distance: 1, units: "kilometers" },
        },
        // The stored `layer` here is ignored; the runner rewires it to step 1's
        // output. A bogus value proves the override happens.
        { id: "s2", toolId: "centroids", parameters: { layer: "ignored" } },
      ],
    };

    const results = await runModel(model, makeHost());
    assert.equal(results.length, 2);
    assert.equal(results[0].error, undefined);
    assert.equal(results[1].error, undefined);
    const final = results[1].output;
    assert.ok(final);
    assert.equal(final.features.length, 2);
    assert.ok(final.features.every((f) => f.geometry.type === "Point"));
  });

  it("stops at an unknown tool and records the error", async () => {
    const model = {
      id: "m2",
      name: "Bad",
      steps: [
        {
          id: "s1",
          toolId: "buffer",
          parameters: { layer: "pts", distance: 1 },
        },
        { id: "s2", toolId: "not-a-tool", parameters: {} },
      ],
    };
    const results = await runModel(model, makeHost());
    assert.equal(results.length, 2);
    assert.equal(results[0].error, undefined);
    assert.match(results[1].error ?? "", /Unknown tool/);
  });

  it("stops when an upstream step produces no output to chain", async () => {
    // select-by-value with a predicate that matches nothing yields an empty
    // FeatureCollection (a real, non-null output), so the chain continues; but a
    // tool that adds nothing (reproject) leaves the next step with no input.
    const model = {
      id: "m3",
      name: "Stalled",
      steps: [
        {
          id: "s1",
          toolId: "reproject",
          parameters: { layer: "pts", source_crs: "EPSG:3857" },
        },
        { id: "s2", toolId: "centroids", parameters: {} },
      ],
    };
    const results = await runModel(model, makeHost());
    assert.equal(results.length, 2);
    assert.equal(results[0].output, null);
    assert.match(results[1].error ?? "", /no output/);
  });

  it("does not run further steps once the signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const model = {
      id: "m4",
      name: "Aborted",
      steps: [
        {
          id: "s1",
          toolId: "buffer",
          parameters: { layer: "pts", distance: 1 },
        },
      ],
    };
    const results = await runModel(model, makeHost({ signal: controller.signal }));
    assert.equal(results.length, 0);
  });

  it("reports each captured step result through onStepResult", async () => {
    const seen: number[] = [];
    const model = {
      id: "m5",
      name: "Callback",
      steps: [
        {
          id: "s1",
          toolId: "buffer",
          parameters: { layer: "pts", distance: 1 },
        },
        { id: "s2", toolId: "centroids", parameters: {} },
      ],
    };
    await runModel(model, makeHost(), {
      onStepResult: (_result, index) => {
        seen.push(index);
      },
    });
    assert.deepEqual(seen, [0, 1]);
  });
});
