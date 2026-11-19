import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FeatureCollection } from "geojson";
import { planSketchAttributeUpdates } from "../packages/plugins/src/plugins/geo-editor-sketch-attributes";

const original: FeatureCollection = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      id: "feature-1",
      geometry: { type: "Point", coordinates: [10, 50] },
      properties: {
        name: "Before",
        obsolete: true,
        __gm_id: "feature-1",
        __gm_shape: "circle_marker",
      },
    },
  ],
};
describe("Sketches property-only synchronization", () => {
  it("replaces user attributes without sending Geoman shape parameters to the property setter", () => {
    const stored = structuredClone(original);
    stored.features[0].properties = {
      name: "After",
      __gm_id: "feature-1",
      __gm_shape: "circle_marker",
    };
    assert.deepEqual(planSketchAttributeUpdates(original, stored), [
      { id: "feature-1", properties: { name: "After" } },
    ]);
    assert.equal(original.features[0].properties?.obsolete, true);
  });
  it("requires a full import for geometry, shape-parameter, identity, or feature-count changes", () => {
    const moved = structuredClone(original);
    moved.features[0].geometry = { type: "Point", coordinates: [20, 60] };
    assert.equal(planSketchAttributeUpdates(original, moved), null);
    const shape = structuredClone(original);
    shape.features[0].properties!.__gm_shape = "marker";
    assert.equal(planSketchAttributeUpdates(original, shape), null);
    const renamed = structuredClone(original);
    renamed.features[0].id = "different";
    assert.equal(planSketchAttributeUpdates(original, renamed), null);
    assert.equal(
      planSketchAttributeUpdates(original, { type: "FeatureCollection", features: [] }),
      null,
    );
  });
  it("does not update unchanged collections and refuses ambiguous duplicate IDs", () => {
    assert.deepEqual(planSketchAttributeUpdates(original, structuredClone(original)), []);
    const duplicates = { ...original, features: [original.features[0], original.features[0]] };
    assert.equal(planSketchAttributeUpdates(duplicates, duplicates), null);
  });
});

it("addresses Geoman's own ID when an imported feature has a separate public ID", () => {
  const editor = structuredClone(original);
  editor.features[0].id = "public-id";
  const stored = structuredClone(editor);
  stored.features[0].properties!.name = "Updated";
  assert.equal(planSketchAttributeUpdates(editor, stored)?.[0].id, "feature-1");
});

it("treats reordered geometry and shape-property keys as the same target", () => {
  const stored = structuredClone(original);
  stored.features[0].geometry = { coordinates: [10, 50], type: "Point" };
  stored.features[0].properties = {
    __gm_shape: "circle_marker",
    __gm_id: "feature-1",
    obsolete: true,
    name: "After",
  };
  assert.deepEqual(planSketchAttributeUpdates(original, stored), [
    { id: "feature-1", properties: { obsolete: true, name: "After" } },
  ]);
});

it("preserves untouched empty strings and missing form fields while allowing explicit clears", async () => {
  const { normalizeEditorFormProperties } =
    await import("../packages/plugins/src/plugins/geo-editor-sketch-attributes");
  const fields = [
    { name: "empty", type: "string" },
    { name: "missing", type: "number" },
    { name: "cleared", type: "textarea" },
    { name: "active", type: "select" },
  ];
  const previous = { empty: "", cleared: "Before", active: null, count: 1 };
  const result = normalizeEditorFormProperties(fields, previous, {
    empty: null,
    missing: null,
    cleared: null,
    active: null,
    count: 2,
  });
  assert.deepEqual(result, { empty: "", cleared: null, active: null, count: 2 });
  assert.deepEqual(previous, { empty: "", cleared: "Before", active: null, count: 1 });
});
