import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDedupedLabelFeatures } from "../packages/map/src/label-dedup";

function fc(
  features: Array<{ coords: [number, number]; props: Record<string, unknown> }>,
): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: features.map((f) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: f.coords },
      properties: f.props,
    })),
  };
}

describe("buildDedupedLabelFeatures", () => {
  it("returns null when the mode is off or the field is empty", () => {
    const collection = fc([{ coords: [0, 0], props: { name: "A" } }]);
    assert.equal(buildDedupedLabelFeatures(collection, "name", "off"), null);
    assert.equal(buildDedupedLabelFeatures(collection, "", "unique"), null);
  });

  it("collapses co-located points to one label in unique mode", () => {
    const collection = fc([
      { coords: [10, 20], props: { name: "Antenna 1" } },
      { coords: [10, 20], props: { name: "Antenna 2" } },
      { coords: [30, 40], props: { name: "Other" } },
    ]);
    const result = buildDedupedLabelFeatures(collection, "name", "unique");
    assert.ok(result);
    assert.equal(result.features.length, 2);
    const labels = result.features.map((f) => f.properties?.__geolibre_label).sort();
    assert.deepEqual(labels, ["Antenna 1", "Other"]);
  });

  it("joins distinct values at a location in concatenate mode", () => {
    const collection = fc([
      { coords: [10, 20], props: { name: "A" } },
      { coords: [10, 20], props: { name: "B" } },
      // A repeat of an existing value at the same point is not duplicated.
      { coords: [10, 20], props: { name: "A" } },
    ]);
    const result = buildDedupedLabelFeatures(collection, "name", "concatenate");
    assert.ok(result);
    assert.equal(result.features.length, 1);
    assert.equal(result.features[0].properties?.__geolibre_label, "A\nB");
    assert.deepEqual(result.features[0].geometry, {
      type: "Point",
      coordinates: [10, 20],
    });
  });

  it("skips points whose field value is empty or null", () => {
    const collection = fc([
      { coords: [1, 1], props: { name: "" } },
      { coords: [2, 2], props: { name: null } },
      { coords: [3, 3], props: { name: "Keep" } },
    ]);
    const result = buildDedupedLabelFeatures(collection, "name", "unique");
    assert.ok(result);
    assert.equal(result.features.length, 1);
    assert.equal(result.features[0].properties?.__geolibre_label, "Keep");
  });

  it("ignores non-point geometries", () => {
    const collection: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: {
            type: "LineString",
            coordinates: [
              [0, 0],
              [1, 1],
            ],
          },
          properties: { name: "Line" },
        },
      ],
    };
    assert.equal(buildDedupedLabelFeatures(collection, "name", "unique"), null);
  });

  it("coerces non-string field values to strings", () => {
    const collection = fc([{ coords: [5, 5], props: { id: 42 } }]);
    const result = buildDedupedLabelFeatures(collection, "id", "unique");
    assert.ok(result);
    assert.equal(result.features[0].properties?.__geolibre_label, "42");
  });
});
