import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import type { FeatureCollection } from "geojson";

// vector-export.ts statically pulls in tauri-io -> shpjs, whose bundle reads the
// browser `self` global at module-eval time; shim it before the dynamic import.
(globalThis as { self?: unknown }).self ??= globalThis;

type ShapefileFieldWarnings = (geojson: FeatureCollection) => string[];
let shapefileFieldWarnings: ShapefileFieldWarnings;

function fc(properties: Record<string, unknown>[]): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: properties.map((props) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [0, 0] },
      properties: props,
    })),
  };
}

describe("shapefileFieldWarnings", () => {
  before(async () => {
    ({ shapefileFieldWarnings } = await import("../apps/geolibre-desktop/src/lib/vector-export"));
  });

  it("returns no warnings when every field name is Shapefile-safe", () => {
    assert.deepEqual(shapefileFieldWarnings(fc([{ name: "a", id: 1, value: 2 }])), []);
  });

  it("warns about field names longer than 10 characters", () => {
    const warnings = shapefileFieldWarnings(fc([{ population_total: 1, name: "x" }]));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /truncates field names to 10 characters/);
    assert.match(warnings[0], /population_total/);
  });

  it("warns when truncation collapses distinct fields into one name", () => {
    const warnings = shapefileFieldWarnings(
      fc([{ measurement_value_a: 1, measurement_value_b: 2 }]),
    );
    // Both names are long (truncation) and collide on the first 10 chars.
    assert.equal(warnings.length, 2);
    assert.match(warnings[1], /duplicate field names/);
    assert.match(warnings[1], /measurement_value_a, measurement_value_b/);
  });

  it("collects field names across features with differing properties", () => {
    const warnings = shapefileFieldWarnings(fc([{ short: 1 }, { another_long_field: 2 }]));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /another_long_field/);
  });

  it("detects collisions caused by non-alphanumeric normalization", () => {
    // "my-field-x" and "my_field_x" both normalize to "my_field_x".
    const warnings = shapefileFieldWarnings(fc([{ "my-field-x": 1, my_field_x: 2 }]));
    assert.ok(warnings.some((w) => /duplicate field names/.test(w)));
  });

  it("warns when geometry families are mixed (extra families dropped)", () => {
    const warnings = shapefileFieldWarnings({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [0, 0] },
          properties: {},
        },
        {
          type: "Feature",
          geometry: {
            type: "LineString",
            coordinates: [
              [0, 0],
              [1, 1],
            ],
          },
          properties: {},
        },
      ],
    });
    assert.ok(warnings.some((w) => /without geometry/.test(w)));
  });

  it("does not warn about null geometries in a single-family layer", () => {
    const warnings = shapefileFieldWarnings({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [0, 0] },
          properties: {},
        },
        { type: "Feature", geometry: null, properties: {} },
      ],
    });
    assert.deepEqual(warnings, []);
  });
});
