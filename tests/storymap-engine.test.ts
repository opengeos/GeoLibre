import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { MapViewState, StoryChapterLocation } from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import { applyStoryViewAndWait } from "../apps/geolibre-desktop/src/components/storymap/storymap-engine";

const location: StoryChapterLocation = {
  center: [-77, 39],
  zoom: 8,
  bearing: 0,
  pitch: 0,
};

const originalWindow = globalThis.window;
const originalRaf = globalThis.requestAnimationFrame;

before(() => {
  globalThis.window = {
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  } as unknown as Window & typeof globalThis;
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) =>
    setTimeout(() => callback(performance.now()), 0)) as unknown as typeof requestAnimationFrame;
});

after(() => {
  globalThis.window = originalWindow;
  globalThis.requestAnimationFrame = originalRaf;
});

// The camera a fake engine reports before the story view is applied.
const CURRENT_VIEW: MapViewState = { center: [0, 0], zoom: 2, bearing: 30, pitch: 45 };

function engineWith(
  applyView: (view: MapViewState) => void | Promise<void>,
  pending: () => string[] = () => [],
  kind: MapEngine["kind"] = "maplibre",
): MapEngine {
  return {
    kind,
    applyView,
    readView: () => CURRENT_VIEW,
    getRenderStatus: () => ({ pending: pending(), errors: [] }),
    isCameraMoving: () => false,
    onCameraMove: () => () => {},
    onCameraIdle: () => () => {},
  } as unknown as MapEngine;
}

describe("applyStoryViewAndWait", () => {
  it("resolves synchronous camera applications after a rendered frame", async () => {
    let applied = false;
    const engine = engineWith(
      () => {
        applied = true;
      },
      () => [],
      "cesium",
    );

    const started = performance.now();
    await applyStoryViewAndWait(engine, location, () => false, 1_000);
    assert.equal(applied, true);
    assert.ok(performance.now() - started >= 450);
  });

  it("waits for an asynchronous engine camera application", async () => {
    let complete!: () => void;
    const application = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const engine = engineWith(() => application);
    let resolved = false;
    const waiting = applyStoryViewAndWait(engine, location, () => false, 1_000).then(() => {
      resolved = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(resolved, false);
    complete();
    await waiting;
    assert.equal(resolved, true);
  });

  it("keeps the camera's pitch and bearing when the chapter omits them", async () => {
    const applied: MapViewState[] = [];
    await applyStoryViewAndWait(
      engineWith((view) => void applied.push(view)),
      { center: [-77, 39], zoom: 8 },
      () => false,
      1_000,
    );
    assert.deepEqual(applied, [{ center: [-77, 39], zoom: 8, bearing: 30, pitch: 45 }]);
  });

  it("falls back to the timeout while renderer work remains pending", async () => {
    const started = performance.now();
    await applyStoryViewAndWait(
      engineWith(
        () => {},
        () => ["tiles"],
      ),
      location,
      () => false,
      20,
    );
    assert.ok(performance.now() - started >= 15);
  });

  it("stops waiting when the export is aborted", async () => {
    const started = performance.now();
    let applied = false;
    await applyStoryViewAndWait(
      engineWith(
        () => {
          applied = true;
        },
        () => ["tiles"],
      ),
      location,
      () => true,
      500,
    );
    assert.ok(performance.now() - started < 400);
    assert.equal(applied, false);
  });
});
