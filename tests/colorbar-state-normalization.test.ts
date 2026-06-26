import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeColorbarState } from "../packages/plugins/src/plugins/maplibre-components.ts";

describe("normalizeColorbarState stackOrientation", () => {
  it("keeps a horizontal stack orientation", () => {
    const normalized = normalizeColorbarState({
      visible: true,
      colorbars: [],
      stackOrientation: "horizontal",
    });
    assert.equal(normalized?.stackOrientation, "horizontal");
  });

  it("returns undefined for null/undefined/non-object input", () => {
    assert.equal(normalizeColorbarState(null), undefined);
    assert.equal(normalizeColorbarState(undefined), undefined);
    assert.equal(normalizeColorbarState("nope"), undefined);
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

  it("preserves an explicit vertical stack orientation", () => {
    const normalized = normalizeColorbarState({
      visible: true,
      colorbars: [],
      stackOrientation: "vertical",
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
          customColors: "#440154, #31688e, #21918c, #90d743, #fde725",
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
