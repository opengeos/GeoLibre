import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clampSelectionPanelPosition,
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
    const clampY = (y: number, height: number) =>
      clampSelectionPanelPosition({ x: 0, y }, { width: 1000, height }, 384).y;
    // Map area shrank to 300px with the card dragged to y=250: keep 160px of
    // card plus the 12px margin of room below its top.
    assert.equal(clampY(250, 300), 128);
    // Enough room: the position is left alone.
    assert.equal(clampY(100, 600), 100);
    // A map area shorter than the minimum pins the card to the top.
    assert.equal(clampY(50, 120), 0);
  });

  it("pulls a dragged card back in when the map area narrows", () => {
    const area = { width: 600, height: 800 };
    assert.deepEqual(clampSelectionPanelPosition({ x: 500, y: 40 }, area, 384), { x: 216, y: 40 });
    assert.deepEqual(clampSelectionPanelPosition({ x: 100, y: 40 }, area, 384), { x: 100, y: 40 });
    // A card wider than the area sticks to the left edge.
    assert.equal(
      clampSelectionPanelPosition({ x: 50, y: 0 }, { width: 300, height: 800 }, 384).x,
      0,
    );
  });
});
