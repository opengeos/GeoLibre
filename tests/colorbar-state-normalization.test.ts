import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeColorbarState } from "../packages/plugins/src/plugins/maplibre-components.ts";

/**
 * The colorbar plugin persists a `stackOrientation` flag (vertical vs
 * horizontal stacking) in the saved project state. These tests guard the
 * normalization path that runs on both live control snapshots and deserialized
 * project JSON, so a user's horizontal choice round-trips on reopen and old
 * projects without the field fall back to the previous (vertical) behavior.
 */
describe("normalizeColorbarState stackOrientation", () => {
  it("keeps a horizontal stack orientation", () => {
    const normalized = normalizeColorbarState({
      visible: true,
      colorbars: [],
      stackOrientation: "horizontal",
    });
    assert.equal(normalized?.stackOrientation, "horizontal");
  });

  it("defaults missing stack orientation to vertical (backward compat)", () => {
    const normalized = normalizeColorbarState({ visible: true, colorbars: [] });
    assert.equal(normalized?.stackOrientation, "vertical");
  });

  it("coerces an unknown stack orientation to vertical", () => {
    const normalized = normalizeColorbarState({
      visible: true,
      colorbars: [],
      stackOrientation: "diagonal",
    });
    assert.equal(normalized?.stackOrientation, "vertical");
  });

  it("round-trips a horizontal choice through a second normalization", () => {
    const once = normalizeColorbarState({
      visible: true,
      colorbars: [
        {
          mode: "named",
          colormap: "viridis",
          customColors: "",
          vmin: 0,
          vmax: 100,
          label: "Depth",
          units: "",
          orientation: "vertical",
          colorbarPosition: "bottom-right",
        },
      ],
      stackOrientation: "horizontal",
    });
    const twice = normalizeColorbarState(once);
    assert.equal(twice?.stackOrientation, "horizontal");
    assert.deepEqual(twice, once);
  });
});
