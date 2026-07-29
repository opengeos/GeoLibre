import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { drawPrintExtent } from "../apps/geolibre-desktop/src/lib/print-extent";

/**
 * Tests for the "Draw print extent" interaction (`print-extent.ts`), which had
 * no coverage before: it is DOM-driven (mousedown/mousemove/mouseup on the
 * MapLibre map, plus window-level fallback listeners, plus touch support) so
 * this file stubs the pieces `node --test` doesn't provide — `window`,
 * `requestAnimationFrame` — and a minimal event-emitting fake `Map`, closely
 * mirroring how `assistant-provider.test.ts` stubs `globalThis.window`.
 *
 * Coordinates: the fake canvas reports a bounding rect at (left: 100, top: 50),
 * and the fake `unproject` maps a canvas-relative pixel (x, y) to
 * `{ lng: x / 10, lat: y / 10 }` — not geographically meaningful, just a
 * deterministic, invertible mapping so the resulting extent is easy to assert.
 */

type Listener = (event: unknown) => void;

function fakeHandler() {
  let enabled = true;
  return {
    isEnabled: () => enabled,
    enable: () => {
      enabled = true;
    },
    disable: () => {
      enabled = false;
    },
  };
}

class FakeMap {
  listeners = new Map<string, Listener[]>();
  dragPan = fakeHandler();
  scrollZoom = fakeHandler();
  doubleClickZoom = fakeHandler();
  touchZoomRotate = fakeHandler();
  touchPitch = fakeHandler();
  private canvasEl = {
    style: { cursor: "" },
    getBoundingClientRect: () => ({
      left: 100,
      top: 50,
      right: 900,
      bottom: 650,
      width: 800,
      height: 600,
    }),
  };

  getCanvas() {
    return this.canvasEl;
  }

  on(type: string, fn: Listener) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  off(type: string, fn: Listener) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((l) => l !== fn),
    );
  }

  emit(type: string, event: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }

  unproject([x, y]: [number, number]) {
    return { lng: x / 10, lat: y / 10 };
  }

  // The print-extent source/layer plumbing is exercised via `drawBox: false`
  // in these tests (they assert on the resolved/previewed extent, not the
  // MapLibre rendering side effects), but stub it anyway in case a test needs
  // the default.
  addSource() {}
  getSource() {
    return undefined;
  }
  addLayer() {}
  getLayer() {
    return undefined;
  }
  removeLayer() {}
  removeSource() {}
  setLayoutProperty() {}
}

let originalWindow: typeof globalThis.window;
let originalRaf: typeof globalThis.requestAnimationFrame;
let originalCancelRaf: typeof globalThis.cancelAnimationFrame;
let windowListeners: Map<string, Listener[]>;

/** Fire a `type` listener registered on the stubbed `globalThis.window`. */
function dispatchWindowEvent(type: string, event: unknown) {
  for (const fn of windowListeners.get(type) ?? []) fn(event);
}

beforeEach(() => {
  originalWindow = globalThis.window;
  originalRaf = globalThis.requestAnimationFrame;
  originalCancelRaf = globalThis.cancelAnimationFrame;
  windowListeners = new Map<string, Listener[]>();
  globalThis.window = {
    addEventListener: (type: string, fn: Listener) => {
      const list = windowListeners.get(type) ?? [];
      list.push(fn);
      windowListeners.set(type, list);
    },
    removeEventListener: (type: string, fn: Listener) => {
      windowListeners.set(
        type,
        (windowListeners.get(type) ?? []).filter((l) => l !== fn),
      );
    },
  } as unknown as Window & typeof globalThis;
  // Synchronous "next frame" so preview()/commit() effects are observable
  // immediately after emitting an event, with no real animation timing.
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  }) as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => {}) as typeof globalThis.cancelAnimationFrame;
});

afterEach(() => {
  globalThis.window = originalWindow;
  globalThis.requestAnimationFrame = originalRaf;
  globalThis.cancelAnimationFrame = originalCancelRaf;
});

describe("drawPrintExtent (mouse)", () => {
  it("resolves the dragged extent on mouseup", async () => {
    const map = new FakeMap();
    const promise = drawPrintExtent(map as never, { drawBox: false });
    map.emit("mousedown", { originalEvent: { button: 0, clientX: 150, clientY: 100 } });
    map.emit("mousemove", {
      originalEvent: { button: 0, clientX: 250, clientY: 200, shiftKey: false },
    });
    map.emit("mouseup", {
      originalEvent: { button: 0, clientX: 350, clientY: 300, shiftKey: false },
    });
    // Canvas-relative: (50, 50) -> (250, 250); unproject/10 -> [5, 5, 25, 25].
    assert.deepEqual(await promise, [5, 5, 25, 25]);
  });

  it("discards a click with no drag", async () => {
    const map = new FakeMap();
    const promise = drawPrintExtent(map as never, { drawBox: false });
    map.emit("mousedown", { originalEvent: { button: 0, clientX: 150, clientY: 100 } });
    map.emit("mouseup", {
      originalEvent: { button: 0, clientX: 150, clientY: 100, shiftKey: false },
    });
    assert.equal(await promise, null);
  });

  it("cancels on Escape mid-drag", async () => {
    const map = new FakeMap();
    const promise = drawPrintExtent(map as never, { drawBox: false });
    map.emit("mousedown", { originalEvent: { button: 0, clientX: 150, clientY: 100 } });
    map.emit("mousemove", {
      originalEvent: { button: 0, clientX: 250, clientY: 200, shiftKey: false },
    });
    dispatchWindowEvent("keydown", { key: "Escape" });
    assert.equal(await promise, null);
  });

  it("restores dragPan/scrollZoom/doubleClickZoom/touch handlers after resolving", async () => {
    const map = new FakeMap();
    const promise = drawPrintExtent(map as never, { drawBox: false });
    assert.equal(map.dragPan.isEnabled(), false);
    assert.equal(map.touchZoomRotate.isEnabled(), false);
    assert.equal(map.touchPitch.isEnabled(), false);
    map.emit("mousedown", { originalEvent: { button: 0, clientX: 150, clientY: 100 } });
    map.emit("mouseup", {
      originalEvent: { button: 0, clientX: 350, clientY: 300, shiftKey: false },
    });
    await promise;
    assert.equal(map.dragPan.isEnabled(), true);
    assert.equal(map.scrollZoom.isEnabled(), true);
    assert.equal(map.doubleClickZoom.isEnabled(), true);
    assert.equal(map.touchZoomRotate.isEnabled(), true);
    assert.equal(map.touchPitch.isEnabled(), true);
  });
});

describe("drawPrintExtent (touch)", () => {
  it("resolves the dragged extent on a single-finger touchend", async () => {
    const map = new FakeMap();
    const promise = drawPrintExtent(map as never, { drawBox: false });
    map.emit("touchstart", {
      points: [{ x: 60, y: 60 }],
      point: { x: 60, y: 60 },
      originalEvent: {},
    });
    map.emit("touchmove", {
      points: [{ x: 160, y: 160 }],
      point: { x: 160, y: 160 },
      originalEvent: {},
    });
    map.emit("touchend", { points: [], point: { x: 260, y: 260 }, originalEvent: {} });
    // Touch points are already canvas-relative: (60,60) -> (260,260) -> [6, 6, 26, 26].
    assert.deepEqual(await promise, [6, 6, 26, 26]);
  });

  it("cancels the draw when a second finger joins mid-drag", async () => {
    const map = new FakeMap();
    const promise = drawPrintExtent(map as never, { drawBox: false });
    map.emit("touchstart", {
      points: [{ x: 60, y: 60 }],
      point: { x: 60, y: 60 },
      originalEvent: {},
    });
    map.emit("touchmove", {
      points: [
        { x: 160, y: 160 },
        { x: 200, y: 200 },
      ],
      point: { x: 180, y: 180 },
      originalEvent: {},
    });
    assert.equal(await promise, null);
  });

  it("cancels on touchcancel", async () => {
    const map = new FakeMap();
    const promise = drawPrintExtent(map as never, { drawBox: false });
    map.emit("touchstart", {
      points: [{ x: 60, y: 60 }],
      point: { x: 60, y: 60 },
      originalEvent: {},
    });
    map.emit("touchcancel", { points: [], point: { x: 60, y: 60 }, originalEvent: {} });
    assert.equal(await promise, null);
  });

  it("ignores a touchstart with more than one finger and stays armed for a real drag", async () => {
    const map = new FakeMap();
    const promise = drawPrintExtent(map as never, { drawBox: false });
    // Two fingers down at once: not a draw start, so `start` is never set and
    // the tool stays armed (mirrors "ignore a stray mouseup before a press"
    // for the mouse path) rather than resolving out from under the caller.
    map.emit("touchstart", {
      points: [
        { x: 60, y: 60 },
        { x: 100, y: 100 },
      ],
      point: { x: 80, y: 80 },
      originalEvent: {},
    });
    map.emit("touchend", { points: [], point: { x: 260, y: 260 }, originalEvent: {} });
    // A stray touchend with no `start` must not resolve the draw either.
    let settled = false;
    void promise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    assert.equal(settled, false);
    // A proper single-finger drag afterwards still completes normally.
    map.emit("touchstart", {
      points: [{ x: 60, y: 60 }],
      point: { x: 60, y: 60 },
      originalEvent: {},
    });
    map.emit("touchend", { points: [], point: { x: 260, y: 260 }, originalEvent: {} });
    assert.deepEqual(await promise, [6, 6, 26, 26]);
  });

  it("disables touchZoomRotate/touchPitch for the duration of the draw", async () => {
    const map = new FakeMap();
    const promise = drawPrintExtent(map as never, { drawBox: false });
    assert.equal(map.touchZoomRotate.isEnabled(), false);
    assert.equal(map.touchPitch.isEnabled(), false);
    map.emit("touchstart", {
      points: [{ x: 60, y: 60 }],
      point: { x: 60, y: 60 },
      originalEvent: {},
    });
    map.emit("touchend", { points: [], point: { x: 260, y: 260 }, originalEvent: {} });
    await promise;
    assert.equal(map.touchZoomRotate.isEnabled(), true);
    assert.equal(map.touchPitch.isEnabled(), true);
  });
});
