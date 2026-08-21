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

    const other = makeLayer("empty2", "Empty 2", { type: "FeatureCollection", features: [] });
    const failed = runMerge([empty, other], { layers: ["empty", "empty2"] });
    assert.equal(failed.results.length, 0);
    assert.ok(failed.messages.some((m) => m.includes("none of the selected layers")));
  });

  it("distinguishes a missing layer from one with no usable geometry", () => {
    const nullGeom = makeLayer("n", "Null geometry", {
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: { a: 1 }, geometry: null }],
    });
    const run = runMerge([pointsA, nullGeom], { layers: ["a", "n", "gone"] });
    assert.ok(run.messages.some((m) => m.includes("1 selected layer(s) that no longer exist")));
    assert.ok(run.messages.some((m) => m.includes("1 selected layer(s) with no usable geometry")));
    // Only the one usable layer is reported as merged, and it contributes all
    // the output features.
    assert.ok(run.messages.some((m) => m.includes("Merged 1 layer(s): 2 feature(s)")));
    assert.equal(run.results[0].features.length, 2);
  });

  it("builds the schema only from features that reach the output", () => {
    const mixed = makeLayer("m", "Mixed", {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { kept: 1 },
          geometry: { type: "Point", coordinates: [1, 1] },
        },
        // Dropped by the geometry filter, so "dropped" must not become a column.
        { type: "Feature", properties: { dropped: 2 }, geometry: null },
      ],
    });
    const { results } = runMerge([pointsA, mixed], { layers: ["a", "m"], addSourceField: false });
    const props = results[0].features.map((f) => f.properties ?? {});
    assert.equal(results[0].features.length, 3);
    assert.ok(props.every((p) => !("dropped" in p)));
    assert.ok(props.every((p) => "kept" in p));
  });

  it("errors when fewer than two layers are selected", () => {
    const none = runMerge([pointsA], {});
    assert.equal(none.results.length, 0);
    assert.ok(none.messages.some((m) => m.includes('parameter "layers"')));

    const one = runMerge([pointsA], { layers: ["a"] });
    assert.equal(one.results.length, 0);
    assert.ok(one.messages.some((m) => m.includes("at least two")));
  });

  it("drops feature ids so colliding ids across layers cannot survive the merge", () => {
    const one = makeLayer("x", "X", {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          id: 0,
          properties: {},
          geometry: { type: "Point", coordinates: [0, 0] },
        },
      ],
    });
    const two = makeLayer("y", "Y", {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          id: 0,
          properties: {},
          geometry: { type: "Point", coordinates: [1, 1] },
        },
      ],
    });
    const { results } = runMerge([one, two], { layers: ["x", "y"], addSourceField: false });
    assert.equal(results[0].features.length, 2);
    // Both inputs use id 0; carrying them through would emit duplicates.
    assert.ok(results[0].features.every((f) => f.id === undefined));
  });

  it('fills a "__proto__" column with null rather than Object.prototype', () => {
    // JSON.parse creates an *own* "__proto__" key, so this reaches the merge
    // from an ordinary GeoJSON file.
    const withProto = makeLayer(
      "p",
      "Proto",
      JSON.parse(String.raw`{
        "type": "FeatureCollection",
        "features": [
          {
            "type": "Feature",
            "properties": { "__proto__": 5 },
            "geometry": { "type": "Point", "coordinates": [0, 0] }
          }
        ]
      }`) as FeatureCollection,
    );
    const { results } = runMerge([withProto, pointsA], {
      layers: ["p", "a"],
      addSourceField: false,
    });
    assert.equal(results[0].features.length, 3);
    // pointsA's features have no "__proto__" of their own, so the column is null
    // for them -- not a reference to Object.prototype.
    for (const feature of results[0].features.slice(1)) {
      const value = Object.getOwnPropertyDescriptor(feature.properties ?? {}, "__proto__")?.value;
      assert.equal(value, null);
    }
  });

  it("de-duplicates repeated layer ids", () => {
    const dup = runMerge([pointsA, linesB], { layers: ["a", "a", "b"], addSourceField: false });
    // "a" contributes its 2 features once, not twice.
    assert.equal(dup.results[0].features.length, 3);

    // A repeat is not a second layer, so this is still a one-layer selection.
    const single = runMerge([pointsA], { layers: ["a", "a"] });
    assert.equal(single.results.length, 0);
    assert.ok(single.messages.some((m) => m.includes("at least two")));
  });

  it("refuses to overwrite an input attribute with the source field", () => {
    const collides = makeLayer("c", "Collides", {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { source: "keep me" },
          geometry: { type: "Point", coordinates: [0, 0] },
        },
      ],
    });
    const failed = runMerge([pointsA, collides], { layers: ["a", "c"] });
    assert.equal(failed.results.length, 0);
    assert.ok(failed.messages.some((m) => m.includes("already exists")));

    // A different field name, or no source field at all, still merges.
    const renamed = runMerge([pointsA, collides], {
      layers: ["a", "c"],
      sourceFieldName: "origin",
    });
    assert.equal(renamed.results[0].features.length, 3);
    assert.equal(renamed.results[0].features[2].properties?.source, "keep me");

    const without = runMerge([pointsA, collides], { layers: ["a", "c"], addSourceField: false });
    assert.equal(without.results[0].features.length, 3);
  });
});
