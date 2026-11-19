import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BOTTOM_SHEET_DETENT_RATIOS,
  clampSheetHeight,
  detentToHeightPx,
  resolveNextDetent,
  sortDetents,
  stepDetent,
} from "../packages/ui/src/lib/bottom-sheet-snap";

describe("bottom sheet snap math", () => {
  it("sorts and deduplicates detents from shortest to tallest", () => {
    assert.deepEqual(sortDetents(["full", "peek", "half", "peek"]), ["peek", "half", "full"]);
    assert.deepEqual(sortDetents([]), ["half"]);
  });

  it("converts detents to pixel heights using default or overridden ratios", () => {
    assert.equal(detentToHeightPx("half", 800), Math.round(800 * BOTTOM_SHEET_DETENT_RATIOS.half));
    assert.equal(detentToHeightPx("peek", 1000, { peek: 0.3 }), 300);
    assert.equal(detentToHeightPx("full", -100), 0);
  });

  it("clamps live drag heights inside the container bounds", () => {
    assert.equal(clampSheetHeight(950, 800, 0, 0.92), 736);
    assert.equal(clampSheetHeight(-20, 800, 0, 0.92), 0);
    assert.equal(clampSheetHeight(100, 800, 180, 0.92), 180);
  });

  it("snaps slow drags to the nearest detent", () => {
    const detents = ["peek", "half", "full"] as const;
    assert.equal(
      resolveNextDetent({
        currentHeightPx: 420,
        containerHeight: 800,
        velocityY: 0,
        detents,
        dismissible: true,
      }),
      "half",
    );
    assert.equal(
      resolveNextDetent({
        currentHeightPx: 680,
        containerHeight: 800,
        velocityY: 0.1,
        detents,
        dismissible: true,
      }),
      "full",
    );
  });

  it("dismisses when dragged below the dismiss threshold if dismissible", () => {
    const detents = ["peek", "half", "full"] as const;
    assert.equal(
      resolveNextDetent({
        currentHeightPx: 80,
        containerHeight: 800,
        velocityY: 0,
        detents,
        dismissible: true,
      }),
      "dismiss",
    );
    assert.equal(
      resolveNextDetent({
        currentHeightPx: 80,
        containerHeight: 800,
        velocityY: 0,
        detents,
        dismissible: false,
      }),
      "peek",
    );
  });

  it("steps one detent on fast upward or downward flicks", () => {
    const detents = ["peek", "half", "full"] as const;
    assert.equal(
      resolveNextDetent({
        currentHeightPx: 400,
        containerHeight: 800,
        velocityY: -0.8,
        detents,
        dismissible: true,
      }),
      "full",
    );
    assert.equal(
      resolveNextDetent({
        currentHeightPx: 400,
        containerHeight: 800,
        velocityY: 0.8,
        detents,
        dismissible: true,
      }),
      "peek",
    );
    assert.equal(
      resolveNextDetent({
        currentHeightPx: 200,
        containerHeight: 800,
        velocityY: 0.8,
        detents,
        dismissible: true,
      }),
      "dismiss",
    );
    assert.equal(
      resolveNextDetent({
        currentHeightPx: 200,
        containerHeight: 800,
        velocityY: 0.8,
        detents,
        dismissible: false,
      }),
      "peek",
    );
  });

  it("steps detents cleanly with keyboard cycling", () => {
    const detents = ["peek", "half", "full"] as const;
    assert.equal(stepDetent("peek", "up", detents), "half");
    assert.equal(stepDetent("full", "up", detents), "full");
    assert.equal(stepDetent("half", "down", detents), "peek");
    assert.equal(stepDetent("peek", "down", detents), "peek");
  });
});
