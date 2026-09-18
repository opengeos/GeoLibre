import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { StoryChapterLocation } from "@geolibre/core";
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

function engineWith(
  applyView: () => void | Promise<void>,
  pending: () => string[] = () => [],
  kind: MapEngine["kind"] = "maplibre",
): MapEngine {
  return {
    kind,
    applyView,
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
