import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type LayerLibraryEntry } from "@geolibre/core";
import { sortLayerLibraryEntriesByStoredOrder } from "../apps/geolibre-desktop/src/lib/layer-library-store";

function entry(id: string, order?: number): LayerLibraryEntry {
  return {
    id,
    name: id,
    addedAt: "",
    layerType: "geojson",
    source: { data: `https://example.com/${id}.geojson` },
    style: { ...DEFAULT_LAYER_STYLE },
    opacity: 1,
    metadata: {},
    ...(order === undefined ? {} : ({ order } as Record<string, number>)),
  };
}

describe("sortLayerLibraryEntriesByStoredOrder", () => {
  it("restores the persisted display order from key-ordered reads", () => {
    // IndexedDB getAll() returns entries in key (id) order, which is unrelated
    // to the most-recently-saved-first order the library is shown in.
    const read = [entry("a", 2), entry("b", 0), entry("c", 1)];
    assert.deepEqual(
      sortLayerLibraryEntriesByStoredOrder(read).map((e) => e.id),
      ["b", "c", "a"],
    );
  });

  it("trails entries written before the order field existed, keeping their order", () => {
    const read = [entry("legacy-a"), entry("ordered", 0), entry("legacy-b")];
    assert.deepEqual(
      sortLayerLibraryEntriesByStoredOrder(read).map((e) => e.id),
      ["ordered", "legacy-a", "legacy-b"],
    );
  });

  it("ignores a non-numeric order value", () => {
    const read = [
      { ...entry("bad"), order: "first" } as unknown as LayerLibraryEntry,
      entry("good", 0),
    ];
    assert.deepEqual(
      sortLayerLibraryEntriesByStoredOrder(read).map((e) => e.id),
      ["good", "bad"],
    );
  });

  it("does not mutate its input", () => {
    const read = [entry("a", 1), entry("b", 0)];
    sortLayerLibraryEntriesByStoredOrder(read);
    assert.deepEqual(
      read.map((e) => e.id),
      ["a", "b"],
    );
  });
});
