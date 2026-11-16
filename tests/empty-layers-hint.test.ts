import assert from "node:assert/strict";
import { describe, it } from "node:test";
import "./helpers/dom";

// Loaded after the harness so its CSS imports and Vite globals are handled.
const { emptyLayersHintKey } =
  await import("../apps/geolibre-desktop/src/components/panels/layer-panel/layer-panel-utils");

describe("emptyLayersHintKey", () => {
  // Issue #3474: the hint names only the menus the toolbar actually shows.
  const cases = [
    [true, true, true, "layers.emptyBeginner"],
    [true, false, true, "layers.emptyBeginnerBasemapsOnly"],
    [true, true, false, "layers.emptyBeginnerDataOnly"],
    [true, false, false, "layers.emptyNoAdd"],
    [false, true, true, "layers.empty"],
    [false, true, false, "layers.empty"],
    [false, false, true, "layers.emptyNoAdd"],
    [false, false, false, "layers.emptyNoAdd"],
  ] as const;
  for (const [beginner, canAddData, canUsePlugins, expected] of cases) {
    it(`beginner=${beginner} addData=${canAddData} plugins=${canUsePlugins} -> ${expected}`, () => {
      assert.equal(emptyLayersHintKey({ beginner, canAddData, canUsePlugins }), expected);
    });
  }
});
