import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { layerFilteredHintKey } from "../apps/geolibre-desktop/src/lib/layer-filter-hint";

describe("layerFilteredHintKey", () => {
  it("names the persistent filter when only it is active", () => {
    assert.equal(
      layerFilteredHintKey({ filterExpression: [">", ["get", "pop"], 10] }),
      "selection.layerFilteredHint",
    );
  });

  it("names quick filters when only they are active", () => {
    assert.equal(
      layerFilteredHintKey({
        quickFilters: [{ id: "q1", field: "kind", kind: "categorical", values: ["park"] }],
      }),
      "quickFilters.layerFilteredHint",
    );
  });

  it("names both when both narrow the layer", () => {
    assert.equal(
      layerFilteredHintKey({
        filterExpression: [">", ["get", "pop"], 10],
        quickFilters: [{ id: "q1", field: "kind", kind: "categorical", values: ["park"] }],
      }),
      "selection.layerFilteredBothHint",
    );
  });

  it("ignores a quick filter that compiles to nothing", () => {
    // An emptied categorical selection places no constraint, so it must not
    // claim a share of the hint.
    assert.equal(
      layerFilteredHintKey({
        filterExpression: [">", ["get", "pop"], 10],
        quickFilters: [{ id: "q1", field: "kind", kind: "categorical", values: [] }],
      }),
      "selection.layerFilteredHint",
    );
  });

  it("ignores an empty filter expression array", () => {
    assert.equal(
      layerFilteredHintKey({
        filterExpression: [],
        quickFilters: [{ id: "q1", field: "kind", kind: "categorical", values: ["park"] }],
      }),
      "quickFilters.layerFilteredHint",
    );
  });
});
