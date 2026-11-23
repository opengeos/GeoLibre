import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clampDragPosition,
  clampOr,
  computePanelResize,
  createKeyframeId,
  DEFAULT_TOUR_CONFIG_NAME,
  MIN_PANEL_HEIGHT,
  MIN_PANEL_WIDTH,
  moveKeyframe,
  newKeyframe,
  RESIZE_KEY_STEP,
  resizeKeyDelta,
  roundCameraView,
  secondsToMs,
  tourConfigFileName,
  tourVideoFileName,
} from "../apps/geolibre-desktop/src/lib/record-tour-model";
import {
  DEFAULT_HOLD_SECONDS,
  DEFAULT_SEGMENT_SECONDS,
  type TourKeyframe,
} from "../apps/geolibre-desktop/src/lib/tour-recorder";

const VIEWPORT = { width: 1280, height: 800 };

function kf(id: string): TourKeyframe {
  return { id, center: [0, 0], zoom: 1, pitch: 0, bearing: 0, holdMs: 0, transitionMs: 0 };
}

describe("record tour model: numbers", () => {
  it("clampOr clamps finite values and falls back on NaN/Infinity", () => {
    assert.equal(clampOr(5, 1, 10, 3), 5);
    assert.equal(clampOr(-2, 1, 10, 3), 1);
    assert.equal(clampOr(42, 1, 10, 3), 10);
    // An emptied field parses as 0, which clamps rather than falling back.
    assert.equal(clampOr(Number(""), 1, 10, 3), 1);
    assert.equal(clampOr(Number("abc"), 1, 10, 3), 3);
    assert.equal(clampOr(Infinity, 1, 10, 3), 3);
  });

  it("secondsToMs rounds to whole milliseconds", () => {
    assert.equal(secondsToMs(1.5), 1500);
    assert.equal(secondsToMs(0.0004), 0);
    assert.equal(secondsToMs(2.0006), 2001);
  });

  it("roundCameraView keeps 6/3/1/1 decimals", () => {
    assert.deepEqual(
      roundCameraView({
        center: [12.123456789, -45.987654321],
        zoom: 10.123456,
        pitch: 45.06,
        bearing: -170.04,
      }),
      { center: [12.123457, -45.987654], zoom: 10.123, pitch: 45.1, bearing: -170 },
    );
  });

  it("createKeyframeId returns distinct ids", () => {
    const ids = new Set(Array.from({ length: 20 }, () => createKeyframeId()));
    assert.equal(ids.size, 20);
  });
});

describe("record tour model: keyframes", () => {
  it("newKeyframe seeds the default hold and transition", () => {
    const view = { center: [1, 2] as [number, number], zoom: 3, pitch: 4, bearing: 5 };
    assert.deepEqual(newKeyframe(view, "k1"), {
      id: "k1",
      ...view,
      holdMs: DEFAULT_HOLD_SECONDS * 1000,
      transitionMs: DEFAULT_SEGMENT_SECONDS * 1000,
    });
  });

  it("moveKeyframe swaps neighbours without mutating the input", () => {
    const list = [kf("a"), kf("b"), kf("c")];
    const down = moveKeyframe(list, 0, 1);
    assert.deepEqual(
      down?.map((k) => k.id),
      ["b", "a", "c"],
    );
    assert.deepEqual(
      list.map((k) => k.id),
      ["a", "b", "c"],
    );
    assert.deepEqual(
      moveKeyframe(list, 2, -1)?.map((k) => k.id),
      ["a", "c", "b"],
    );
  });

  it("moveKeyframe reports out-of-range moves as a no-op", () => {
    const list = [kf("a"), kf("b")];
    assert.equal(moveKeyframe(list, 0, -1), null);
    assert.equal(moveKeyframe(list, 1, 1), null);
    assert.equal(moveKeyframe(list, 5, -1), null);
    assert.equal(moveKeyframe([], 0, 1), null);
  });
});

describe("record tour model: panel geometry", () => {
  it("clampDragPosition keeps the panel inside the viewport", () => {
    const panel = { width: 300, height: 200 };
    const offset = { x: 10, y: 5 };
    assert.deepEqual(clampDragPosition({ x: 110, y: 105 }, offset, panel, VIEWPORT), {
      x: 100,
      y: 100,
    });
    assert.deepEqual(clampDragPosition({ x: -50, y: -50 }, offset, panel, VIEWPORT), {
      x: 0,
      y: 0,
    });
    assert.deepEqual(clampDragPosition({ x: 5000, y: 5000 }, offset, panel, VIEWPORT), {
      x: 980,
      y: 600,
    });
  });

  const base = { width: 400, height: 400, left: 200, top: 100 };

  it("se resize keeps the left edge fixed and caps at the viewport", () => {
    assert.deepEqual(computePanelResize("se", base, 50, 30, VIEWPORT), {
      pos: { x: 200, y: 100 },
      size: { width: 450, height: 430 },
    });
    // Capped at the right and bottom viewport edges.
    assert.deepEqual(computePanelResize("se", base, 5000, 5000, VIEWPORT), {
      pos: { x: 200, y: 100 },
      size: { width: 1080, height: 700 },
    });
    // Never below the minimum size.
    assert.deepEqual(computePanelResize("se", base, -5000, -5000, VIEWPORT).size, {
      width: MIN_PANEL_WIDTH,
      height: MIN_PANEL_HEIGHT,
    });
  });

  it("sw resize keeps the right edge fixed and stops at x = 0", () => {
    const grown = computePanelResize("sw", base, 50, 0, VIEWPORT);
    assert.deepEqual(grown, { pos: { x: 150, y: 100 }, size: { width: 450, height: 400 } });
    // Right edge stays at left + width = 600.
    assert.equal(grown.pos.x + grown.size.width, 600);
    const maxed = computePanelResize("sw", base, 5000, 0, VIEWPORT);
    assert.deepEqual(maxed.pos, { x: 0, y: 100 });
    assert.equal(maxed.size.width, 600);
    const shrunk = computePanelResize("sw", base, -5000, 0, VIEWPORT);
    assert.equal(shrunk.size.width, MIN_PANEL_WIDTH);
    assert.equal(shrunk.pos.x, 600 - MIN_PANEL_WIDTH);
  });

  it("resizeKeyDelta maps arrows per corner and ignores other keys", () => {
    assert.deepEqual(resizeKeyDelta("se", "ArrowDown"), { dx: 0, dy: RESIZE_KEY_STEP });
    assert.deepEqual(resizeKeyDelta("sw", "ArrowUp"), { dx: 0, dy: -RESIZE_KEY_STEP });
    assert.deepEqual(resizeKeyDelta("sw", "ArrowLeft"), { dx: RESIZE_KEY_STEP, dy: 0 });
    assert.deepEqual(resizeKeyDelta("se", "ArrowLeft"), { dx: -RESIZE_KEY_STEP, dy: 0 });
    assert.deepEqual(resizeKeyDelta("sw", "ArrowRight"), { dx: -RESIZE_KEY_STEP, dy: 0 });
    assert.deepEqual(resizeKeyDelta("se", "ArrowRight"), { dx: RESIZE_KEY_STEP, dy: 0 });
    assert.equal(resizeKeyDelta("se", "Enter"), null);
  });
});

describe("record tour model: file names", () => {
  it("tourVideoFileName trims, drops a typed .webm and falls back", () => {
    assert.equal(tourVideoFileName("  my tour  "), "my tour.webm");
    assert.equal(tourVideoFileName("clip.WEBM"), "clip.webm");
    assert.equal(tourVideoFileName("   "), "map-tour.webm");
  });

  it("tourConfigFileName sanitizes and avoids a doubled extension", () => {
    assert.equal(tourConfigFileName("tour"), "tour.json");
    assert.equal(tourConfigFileName("tour.json "), "tour.json");
    assert.equal(tourConfigFileName("tour.json."), "tour.json");
    assert.equal(tourConfigFileName("tour.JSON"), "tour.json");
    assert.equal(tourConfigFileName("a/b\\c:d"), "a_b_c_d.json");
    assert.equal(tourConfigFileName("x\u0000y"), "x_y.json");
    assert.equal(tourConfigFileName(" ... "), `${DEFAULT_TOUR_CONFIG_NAME}.json`);
    assert.equal(tourConfigFileName(""), `${DEFAULT_TOUR_CONFIG_NAME}.json`);
  });
});
