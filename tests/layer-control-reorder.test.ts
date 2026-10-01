import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { layerControlReorderMove } from "../packages/map/src/layer-control-host";

// The on-map layer control reports a reorder only as the new panel order (top
// to bottom). layerControlReorderMove finds the one layer that moved and the
// store index it lands at, for the store's moveLayer (the store lists the
// top-most layer last).
const panel = ["top", "g1", "s1", "s2", "g2", "bottom"];

describe("layerControlReorderMove", () => {
  it("returns null when nothing moved", () => {
    assert.equal(layerControlReorderMove(panel, [...panel]), null);
  });

  it("finds the moved layer and its store index", () => {
    // g2 dragged to just under g1, above s1/s2.
    assert.deepEqual(layerControlReorderMove(panel, ["top", "g1", "g2", "s1", "s2", "bottom"]), {
      layerId: "g2",
      storeIndex: 3,
    });
  });

  it("handles a move to the top and to the bottom", () => {
    assert.deepEqual(layerControlReorderMove(panel, ["bottom", "top", "g1", "s1", "s2", "g2"]), {
      layerId: "bottom",
      storeIndex: 5,
    });
    assert.deepEqual(layerControlReorderMove(panel, ["g1", "s1", "s2", "g2", "bottom", "top"]), {
      layerId: "top",
      storeIndex: 0,
    });
  });

  it("resolves an adjacent swap to the same final order either way", () => {
    const move = layerControlReorderMove(panel, ["g1", "top", "s1", "s2", "g2", "bottom"]);
    assert.ok(move);
    const store = [...panel].reverse().filter((id) => id !== move.layerId);
    store.splice(move.storeIndex, 0, move.layerId);
    assert.deepEqual(store.reverse(), ["g1", "top", "s1", "s2", "g2", "bottom"]);
  });

  it("returns null when the orders differ by more than one move", () => {
    assert.equal(layerControlReorderMove(panel, ["bottom", "g2", "s2", "s1", "g1", "top"]), null);
  });

  it("returns null when the layer sets differ", () => {
    assert.equal(layerControlReorderMove(panel, panel.slice(1)), null);
  });
});
