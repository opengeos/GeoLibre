import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clampSelectionPanelPosition,
  selectionPanelMaxHeight,
} from "../apps/geolibre-desktop/src/components/selection/selection-panel-geometry";

/**
 * The card height `selectionPanelMaxHeight` lets through at `top` in a map
 * area of `areaHeight`, for a card whose content is `natural` tall.
 */
function renderedHeight(top: number, areaHeight: number, natural: number): number {
  const offset = Number(/calc\(100% - (\d+)px\)/.exec(selectionPanelMaxHeight(top))?.[1]);
  return Math.min(natural, areaHeight - offset);
}

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

  it("moves a card up just far enough to keep it whole when the area shrinks", () => {
    const card = { width: 384, height: 280 };
    // Area shrank from 800 to 400 with the card at y=500: y=108 shows all of it.
    const pos = clampSelectionPanelPosition({ x: 0, y: 500 }, { width: 1000, height: 400 }, card);
    assert.deepEqual(pos, { x: 0, y: 108 });
    assert.equal(renderedHeight(pos.y, 400, card.height), card.height);
    // Enough room: the position is left alone.
    assert.deepEqual(
      clampSelectionPanelPosition({ x: 0, y: 100 }, { width: 1000, height: 600 }, card),
      { x: 0, y: 100 },
    );
    // Too short for the card: pinned to the top, where the cap leaves the most room.
    assert.equal(
      clampSelectionPanelPosition({ x: 0, y: 50 }, { width: 1000, height: 200 }, card).y,
      0,
    );
  });

  it("never squashes a card that is dragged down step by step", () => {
    // Clamping against the rendered (capped) height let each drag step lower
    // the cap a little further; the natural height keeps the card whole.
    const area = { width: 1000, height: 300 };
    const card = { width: 384, height: 240 };
    let y = 0;
    for (let step = 0; step < 30; step += 1) {
      y = clampSelectionPanelPosition({ x: 0, y: y + 12 }, area, card).y;
      assert.equal(renderedHeight(y, area.height, card.height), card.height);
    }
    assert.equal(y, 48);
  });

  it("pulls a dragged card back in when the map area narrows", () => {
    const card = { width: 384, height: 200 };
    const area = { width: 600, height: 800 };
    assert.deepEqual(clampSelectionPanelPosition({ x: 500, y: 40 }, area, card), { x: 216, y: 40 });
    assert.deepEqual(clampSelectionPanelPosition({ x: 100, y: 40 }, area, card), { x: 100, y: 40 });
    // A card wider than the area sticks to the left edge.
    assert.equal(
      clampSelectionPanelPosition({ x: 50, y: 0 }, { width: 300, height: 800 }, card).x,
      0,
    );
  });
});
