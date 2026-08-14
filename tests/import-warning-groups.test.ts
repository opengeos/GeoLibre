import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { groupImportWarnings } from "../apps/geolibre-desktop/src/lib/import-warning-groups";

interface TestWarning {
  layerName: string;
  reason: string;
  layerType?: string;
}

/** Stands in for the dialog's `t()` call: interpolates where the real one does. */
function describe_(warning: TestWarning): string {
  if (warning.reason === "layer-type") return `The ${warning.layerType} layer type is unsupported.`;
  return `Reason: ${warning.reason}.`;
}

describe("groupImportWarnings", () => {
  it("collapses layers that share a message into one group", () => {
    const warnings: TestWarning[] = [
      { layerName: "Parcels", reason: "file-geodatabase" },
      { layerName: "Roads", reason: "file-geodatabase" },
      { layerName: "Wells", reason: "file-geodatabase" },
    ];

    const groups = groupImportWarnings(warnings, describe_);

    assert.equal(groups.length, 1);
    assert.equal(groups[0].message, "Reason: file-geodatabase.");
    assert.deepEqual(groups[0].layerNames, ["Parcels", "Roads", "Wells"]);
  });

  it("sorts the largest group first so the dominant cause leads", () => {
    const warnings: TestWarning[] = [
      { layerName: "Shared", reason: "network-path" },
      { layerName: "Parcels", reason: "file-geodatabase" },
      { layerName: "Roads", reason: "file-geodatabase" },
    ];

    const groups = groupImportWarnings(warnings, describe_);

    assert.deepEqual(
      groups.map((group) => [group.message, group.layerNames.length]),
      [
        ["Reason: file-geodatabase.", 2],
        ["Reason: network-path.", 1],
      ],
    );
  });

  it("keeps report order for groups of the same size", () => {
    const warnings: TestWarning[] = [
      { layerName: "A", reason: "service" },
      { layerName: "B", reason: "missing-source" },
      { layerName: "C", reason: "network-path" },
    ];

    const groups = groupImportWarnings(warnings, describe_);

    assert.deepEqual(
      groups.map((group) => group.layerNames[0]),
      ["A", "B", "C"],
    );
  });

  it("splits one reason whose message interpolates differing detail", () => {
    // Two "layer-type" warnings are only the same warning when they render the
    // same sentence -- a scene layer and an annotation layer do not.
    const warnings: TestWarning[] = [
      { layerName: "Labels", reason: "layer-type", layerType: "CIMAnnotationLayer" },
      { layerName: "City", reason: "layer-type", layerType: "CIMSceneLayer" },
      { layerName: "Notes", reason: "layer-type", layerType: "CIMAnnotationLayer" },
    ];

    const groups = groupImportWarnings(warnings, describe_);

    assert.deepEqual(
      groups.map((group) => [group.message, group.layerNames]),
      [
        ["The CIMAnnotationLayer layer type is unsupported.", ["Labels", "Notes"]],
        ["The CIMSceneLayer layer type is unsupported.", ["City"]],
      ],
    );
  });

  it("merges reasons that render the same sentence", () => {
    // The inverse case: the dialog must never show two lines a user cannot
    // tell apart, whatever internal reason produced them.
    const warnings: TestWarning[] = [
      { layerName: "A", reason: "format" },
      { layerName: "B", reason: "format-legacy" },
    ];

    const groups = groupImportWarnings(warnings, () => "The layer's data format is not supported.");

    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].layerNames, ["A", "B"]);
  });

  it("returns nothing for no warnings", () => {
    assert.deepEqual(groupImportWarnings([], describe_), []);
  });
});
