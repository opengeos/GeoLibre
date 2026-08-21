import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import { getVectorTool } from "@geolibre/processing";
import type { FeatureCollection } from "geojson";

function makeLayer(id: string, name: string, fc: FeatureCollection): GeoLibreLayer {
  return {
    id,
    name,
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
    geojson: fc,
  };
}

function runMerge(
  layers: GeoLibreLayer[],
  parameters: Record<string, unknown>,
): { messages: string[]; results: FeatureCollection[] } {
  const tool = getVectorTool("merge-layers");
  assert.ok(tool, "merge-layers is registered");
  const messages: string[] = [];
  const results: FeatureCollection[] = [];
  tool.run({
    layers,
    parameters,
    log: (message) => messages.push(message),
    addResultLayer: (_name, fc) => results.push(fc),
  });
  return { messages, results };
}

const pointsA = makeLayer("a", "Points A", {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { name: "a1", value: 1 },
      geometry: { type: "Point", coordinates: [0, 0] },
    },
    {
      type: "Feature",
      properties: { name: "a2" },
      geometry: { type: "Point", coordinates: [1, 1] },
    },
  ],
});

const linesB = makeLayer("b", "Lines B", {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { label: "b1", value: 7 },
      geometry: {
        type: "LineString",
        coordinates: [
          [2, 2],
          [3, 3],
        ],
      },
    },
  ],
});

describe("merge layers tool", () => {
  it("is registered with a multi-layer parameter", () => {
    const tool = getVectorTool("merge-layers");
    assert.ok(tool);
    const layersParam = tool.parameters.find((p) => p.id === "layers");
    assert.equal(layersParam?.type, "layers");
    assert.equal(layersParam?.required, true);
  });

  it("concatenates features in selection order and unites schemas with nulls", () => {
    const { messages, results } = runMerge([pointsA, linesB], {
      layers: ["a", "b"],
      addSourceField: false,
    });
    assert.equal(results.length, 1);
    const fc = results[0];
    assert.equal(fc.features.length, 3);
    // Selection order preserved: A's features first, then B's.
    assert.deepEqual(
      fc.features.map((f) => f.geometry?.type),
      ["Point", "Point", "LineString"],
    );
    // Schema union: every feature carries every attribute, missing ones null.
    for (const feature of fc.features) {
      assert.deepEqual(Object.keys(feature.properties ?? {}).sort(), ["label", "name", "value"]);
      assert.ok("label" in (feature.properties ?? {}));
      assert.ok("value" in (feature.properties ?? {}));
    }
    assert.equal(fc.features[0].properties?.label, null);
    assert.equal(fc.features[2].properties?.name, null);
    assert.equal(fc.features[2].properties?.value, 7);
    assert.ok(messages.some((m) => m.includes("Merged 2 layer(s): 3 feature(s), 3 attribute(s)")));
  });

  it("records the originating layer name in a configurable source field by default", () => {
    const { results } = runMerge([pointsA, linesB], { layers: ["a", "b"] });
    const fc = results[0];
    assert.ok(fc.features.every((f) => typeof f.properties?.source === "string"));
    assert.equal(fc.features[0].properties?.source, "Points A");
    assert.equal(fc.features[2].properties?.source, "Lines B");

    const renamed = runMerge([pointsA, linesB], {
      layers: ["a", "b"],
      sourceFieldName: "origin",
    });
    assert.ok(renamed.results[0].features.every((f) => "origin" in (f.properties ?? {})));
    assert.ok(!("source" in (renamed.results[0].features[0].properties ?? {})));
  });

  it("skips selected layers without features and errors when none remain", () => {
    const empty = makeLayer("empty", "Empty", { type: "FeatureCollection", features: [] });
    const skipped = runMerge([pointsA, empty], { layers: ["a", "empty"], addSourceField: false });
    assert.ok(skipped.messages.some((m) => m.includes("Skipped 1")));
    assert.equal(skipped.results[0].features.length, 2);

    const failed = runMerge([empty], { layers: ["empty"] });
    assert.equal(failed.results.length, 0);
    assert.ok(failed.messages.some((m) => m.startsWith("Error:")));
  });

  it("errors when no layer is selected at all", () => {
    const failed = runMerge([pointsA], {});
    assert.equal(failed.results.length, 0);
    assert.ok(failed.messages.some((m) => m.includes('parameter "layers"')));
  });
});
