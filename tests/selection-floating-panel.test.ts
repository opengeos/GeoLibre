import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clampSelectionPanelTop,
  selectionPanelMaxHeight,
} from "../apps/geolibre-desktop/src/components/selection/selection-dialog-shared";

describe("selection floating panel sizing", () => {
  it("caps the card by the map area, not the viewport", () => {
    // A tall docked attribute table shrinks the map area; a `100vh` cap let
    // the card run past it and clip the Select features / Filter layer buttons.
    assert.equal(selectionPanelMaxHeight(null), "calc(100% - 48px)");
    assert.doesNotMatch(selectionPanelMaxHeight(null), /vh/);
  });

  it("subtracts a dragged card's top offset so its bottom stays in view", () => {
    assert.equal(selectionPanelMaxHeight(200), "calc(100% - 212px)");
    assert.equal(selectionPanelMaxHeight(0), "calc(100% - 12px)");
  });

  it("pulls a dragged card up when the map area shrinks under it", () => {
    // Map area shrank to 300px with the card dragged to y=250: keep 160px of
    // card plus the 12px margin visible.
    assert.equal(clampSelectionPanelTop(250, 300), 128);
    // Enough room: the position is left alone.
    assert.equal(clampSelectionPanelTop(100, 600), 100);
    // A map area shorter than the minimum pins the card to the top.
    assert.equal(clampSelectionPanelTop(50, 120), 0);
  });
});
