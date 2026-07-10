import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeRowSelection } from "../apps/geolibre-desktop/src/lib/attribute-selection";

const SORTED = ["a", "b", "c", "d", "e"];

describe("computeRowSelection", () => {
  it("plain click selects just the clicked row and anchors it", () => {
    const result = computeRowSelection({
      featureId: "c",
      sortedIds: SORTED,
      selectedIds: ["a", "b"],
      anchorId: "a",
      additive: false,
      range: false,
    });
    assert.deepEqual(result, { ids: ["c"], anchor: "c" });
  });

  it("Ctrl-click adds an unselected row and re-anchors it", () => {
    const result = computeRowSelection({
      featureId: "d",
      sortedIds: SORTED,
      selectedIds: ["a", "b"],
      anchorId: "b",
      additive: true,
      range: false,
    });
    assert.deepEqual(result, { ids: ["a", "b", "d"], anchor: "d" });
  });

  it("Ctrl-click removes a selected row and moves the anchor to the last id", () => {
    const result = computeRowSelection({
      featureId: "b",
      sortedIds: SORTED,
      selectedIds: ["a", "b", "c"],
      anchorId: "b",
      additive: true,
      range: false,
    });
    assert.deepEqual(result, { ids: ["a", "c"], anchor: "c" });
  });

  it("Ctrl-click removing a non-anchor row keeps the existing anchor", () => {
    const result = computeRowSelection({
      featureId: "a",
      sortedIds: SORTED,
      selectedIds: ["a", "b", "c"],
      anchorId: "b",
      additive: true,
      range: false,
    });
    assert.deepEqual(result, { ids: ["b", "c"], anchor: "b" });
  });

  it("Ctrl-click deselecting the last remaining row yields an empty set and null anchor", () => {
    const result = computeRowSelection({
      featureId: "a",
      sortedIds: SORTED,
      selectedIds: ["a"],
      anchorId: "a",
      additive: true,
      range: false,
    });
    assert.deepEqual(result, { ids: [], anchor: null });
  });

  it("Shift-click selects the contiguous range from the anchor, keeping the anchor fixed", () => {
    const result = computeRowSelection({
      featureId: "d",
      sortedIds: SORTED,
      selectedIds: ["b"],
      anchorId: "b",
      additive: false,
      range: true,
    });
    assert.deepEqual(result, { ids: ["b", "c", "d"], anchor: "b" });
  });

  it("Shift-click works when the clicked row is above the anchor", () => {
    const result = computeRowSelection({
      featureId: "a",
      sortedIds: SORTED,
      selectedIds: ["d"],
      anchorId: "d",
      additive: false,
      range: true,
    });
    assert.deepEqual(result, { ids: ["a", "b", "c", "d"], anchor: "d" });
  });

  it("Shift+Ctrl merges the new range with the existing selection (no duplicates)", () => {
    const result = computeRowSelection({
      featureId: "e",
      sortedIds: SORTED,
      selectedIds: ["a", "c"],
      anchorId: "c",
      additive: true,
      range: true,
    });
    assert.deepEqual(result, { ids: ["a", "c", "d", "e"], anchor: "c" });
  });

  it("Shift-click falls back to a single select when the anchor is not in the sorted rows", () => {
    // e.g. the anchor row was filtered out of the current view.
    const result = computeRowSelection({
      featureId: "c",
      sortedIds: SORTED,
      selectedIds: ["z"],
      anchorId: "z",
      additive: false,
      range: true,
    });
    assert.deepEqual(result, { ids: ["c"], anchor: "c" });
  });

  it("Shift-click with no anchor falls back to a single select", () => {
    const result = computeRowSelection({
      featureId: "c",
      sortedIds: SORTED,
      selectedIds: [],
      anchorId: null,
      additive: false,
      range: true,
    });
    assert.deepEqual(result, { ids: ["c"], anchor: "c" });
  });
});
