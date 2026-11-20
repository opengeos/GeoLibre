import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { setHistoryCoalesceMs } from "../packages/core/src/history";
import { useAppStore, withoutHistory } from "../packages/core/src/store";
import type { GeoLibreLayer } from "../packages/core/src/types";
import { geojsonLayer } from "./helpers/layer-fixtures";

function start(layers: GeoLibreLayer[]): void {
  setHistoryCoalesceMs(0);
  const layerGroups = [
    ...new Set(layers.flatMap((item) => (item.groupId ? [item.groupId] : []))),
  ].map((id) => ({ id, name: id, visible: true, collapsed: false, opacity: 1 }));
  useAppStore.getState().newProject({ name: "order", layers, layerGroups });
  useAppStore.temporal.getState().clear();
}

const layer = (id: string, groupId?: string) =>
  geojsonLayer({ id, name: id, ...(groupId ? { groupId } : {}) });
const ids = () => useAppStore.getState().layers.map((item) => item.id);
const pastLength = () => useAppStore.temporal.getState().pastStates.length;

describe("applyLayerOrder", () => {
  beforeEach(() => start([layer("a"), layer("b"), layer("c"), layer("d")]));

  it("applies a full order in one update and one undo step", () => {
    useAppStore.getState().applyLayerOrder(["d", "c", "b", "a"]);
    assert.deepEqual(ids(), ["d", "c", "b", "a"]);
    assert.equal(useAppStore.getState().isDirty, true);
    assert.equal(pastLength(), 1);
  });

  it("reorders only the listed layers, inside the positions they already hold", () => {
    // b and d swap; a and c, left out, stay where they are.
    useAppStore.getState().applyLayerOrder(["d", "b"]);
    assert.deepEqual(ids(), ["a", "d", "c", "b"]);
  });

  it("ignores unknown and repeated ids", () => {
    useAppStore.getState().applyLayerOrder(["missing", "c", "c", "a"]);
    assert.deepEqual(ids(), ["c", "b", "a", "d"]);
  });

  it("records no undo step through withoutHistory", () => {
    withoutHistory(() => useAppStore.getState().applyLayerOrder(["d", "c", "b", "a"]));
    assert.deepEqual(ids(), ["d", "c", "b", "a"]);
    assert.equal(pastLength(), 0);
  });

  it("leaves the store untouched when the order already holds", () => {
    const before = useAppStore.getState().layers;
    useAppStore.getState().applyLayerOrder(["a", "b", "c", "d"]);
    assert.equal(useAppStore.getState().layers, before);
    assert.equal(useAppStore.getState().isDirty, false);
    assert.equal(pastLength(), 0);
  });

  it("keeps each group's members together", () => {
    start([layer("x"), layer("g1", "g"), layer("g2", "g"), layer("y")]);
    // An order that splits the group puts it back together, anchored at its
    // bottom-most member.
    useAppStore.getState().applyLayerOrder(["g2", "y", "x", "g1"]);
    assert.deepEqual(ids(), ["g2", "g1", "y", "x"]);
  });

  it("lets group contiguity override the requested order and move unlisted layers", () => {
    start([layer("g1", "g"), layer("g2", "g"), layer("x"), layer("a")]);
    // Placing a and g1 swaps their slots ([a, g2, x, g1]), then g1 is pulled
    // down beside g2, which pushes the unlisted x up past it.
    useAppStore.getState().applyLayerOrder(["a", "g1"]);
    assert.deepEqual(ids(), ["a", "g2", "g1", "x"]);
  });
});

describe("moveLayer", () => {
  it("keeps a moved group member inside its group's block", () => {
    start([layer("g1", "g"), layer("g2", "g"), layer("x"), layer("y")]);
    useAppStore.getState().moveLayer("g2", 3);
    assert.deepEqual(ids(), ["g1", "g2", "x", "y"]);
    assert.equal(useAppStore.getState().isDirty, false);
  });

  it("still moves an ungrouped layer", () => {
    start([layer("g1", "g"), layer("g2", "g"), layer("x"), layer("y")]);
    useAppStore.getState().moveLayer("y", 0);
    assert.deepEqual(ids(), ["y", "g1", "g2", "x"]);
    assert.equal(useAppStore.getState().isDirty, true);
  });
});
