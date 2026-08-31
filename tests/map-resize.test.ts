import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  createMapResizeScheduler,
  PANEL_RESIZE_END_EVENT,
  PANEL_RESIZE_START_EVENT,
  RESIZE_DEBOUNCE_MS,
} from "../packages/map/src/map-resize";

/**
 * The scheduler is a small state machine over three signals that cannot be
 * exercised through a real browser here: ResizeObserver callbacks, the window
 * `resize` burst of a drag, and the panel splitter events. GeoLibre#2172 was
 * caused by resizing the WebGL canvas on every one of those callbacks, so what
 * these tests pin down is *how many* `map.resize()` calls each path produces and
 * *when* — the branch order in `resizeMap` is exactly what a future edit could
 * silently undo.
 */

interface Harness {
  /** Resize the container and fire the observer, as the browser would. */
  setContainerSize: (width: number, height: number) => void;
  /** Fire a window `resize` event, as a continuous window drag does. */
  windowResize: (width?: number, height?: number) => void;
  /**
   * Shrink the window and deliver *only* the ResizeObserver callback, as an
   * engine that dispatches observer entries before the `resize` event would.
   */
  windowResizeObserverFirst: (width: number, height: number) => void;
  dispatch: (type: string) => void;
  /** Run every queued animation frame callback. */
  flushFrames: () => void;
  /** Advance the fake clock, running timers as they come due. */
  advance: (ms: number) => void;
  setDevicePixelRatio: (ratio: number) => void;
  resizeCalls: () => number;
  listenerCount: () => number;
}

let harness: Harness;
let dispose: () => void;

function install(): Harness {
  let now = 0;
  let nextId = 1;
  const frames = new Map<number, () => void>();
  const timers = new Map<number, { due: number; run: () => void }>();
  const listeners = new Map<string, Set<() => void>>();
  const mediaListeners = new Map<string, Set<() => void>>();
  const container = { clientWidth: 800, clientHeight: 600 };
  // Mirrors MapLibre: `resize()` writes the container's client dimensions back
  // as the canvas CSS size, which is what `mapNeedsResize` compares against.
  const canvas = { style: { width: "800px", height: "600px" } };
  let resizeCalls = 0;
  const map = {
    getCanvas: () => canvas,
    resize: () => {
      resizeCalls += 1;
      canvas.style.width = `${container.clientWidth}px`;
      canvas.style.height = `${container.clientHeight}px`;
    },
  };

  let observerCallback: (() => void) | null = null;
  const fakeWindow = {
    devicePixelRatio: 1,
    innerWidth: 1000,
    innerHeight: 800,
    requestAnimationFrame(callback: () => void) {
      const id = nextId++;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id: number) {
      frames.delete(id);
    },
    setTimeout(callback: () => void, delay: number) {
      const id = nextId++;
      timers.set(id, { due: now + delay, run: callback });
      return id;
    },
    clearTimeout(id: number) {
      timers.delete(id);
    },
    addEventListener(type: string, handler: () => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(handler);
    },
    removeEventListener(type: string, handler: () => void) {
      listeners.get(type)?.delete(handler);
    },
    matchMedia(query: string) {
      return {
        addEventListener(_type: string, handler: () => void) {
          if (!mediaListeners.has(query)) mediaListeners.set(query, new Set());
          mediaListeners.get(query)!.add(handler);
        },
        removeEventListener(_type: string, handler: () => void) {
          mediaListeners.get(query)?.delete(handler);
        },
      };
    },
  };
  const fakeResizeObserver = class {
    constructor(callback: () => void) {
      observerCallback = callback;
    }
    observe() {}
    disconnect() {
      observerCallback = null;
    }
  };

  const previous = {
    window: globalThis.window,
    ResizeObserver: globalThis.ResizeObserver,
  };
  Object.assign(globalThis, { window: fakeWindow, ResizeObserver: fakeResizeObserver });
  restoreGlobals = () => Object.assign(globalThis, previous);

  // The browser lays the window out before either signal is delivered, so both
  // the window and the map container carry their new size by then.
  const shrinkWindow = (width: number, height: number) => {
    fakeWindow.innerWidth = width + 200;
    fakeWindow.innerHeight = height + 200;
    container.clientWidth = width;
    container.clientHeight = height;
  };
  const dispatch = (type: string) => {
    for (const handler of [...(listeners.get(type) ?? [])]) handler();
  };
  const flushFrames = () => {
    const queued = [...frames.values()];
    frames.clear();
    for (const frame of queued) frame();
  };
  const advance = (ms: number) => {
    const target = now + ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.due <= target)
        .sort((a, b) => a[1].due - b[1].due)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].due;
      due[1].run();
    }
    now = target;
  };

  dispose = createMapResizeScheduler({ getMap: () => map as never, container: container as never });

  return {
    setContainerSize(width, height) {
      container.clientWidth = width;
      container.clientHeight = height;
      observerCallback?.();
    },
    windowResize(width, height) {
      if (width !== undefined && height !== undefined) {
        shrinkWindow(width, height);
      }
      dispatch("resize");
      observerCallback?.();
    },
    windowResizeObserverFirst(width, height) {
      shrinkWindow(width, height);
      observerCallback?.();
    },
    dispatch,
    flushFrames,
    advance,
    setDevicePixelRatio(ratio) {
      fakeWindow.devicePixelRatio = ratio;
      for (const handlers of mediaListeners.values()) {
        for (const handler of [...handlers]) handler();
      }
    },
    resizeCalls: () => resizeCalls,
    listenerCount: () =>
      [...listeners.values()].reduce((total, set) => total + set.size, 0) +
      [...mediaListeners.values()].reduce((total, set) => total + set.size, 0),
  };
}

let restoreGlobals: () => void = () => {};

beforeEach(() => {
  harness = install();
});

afterEach(() => {
  dispose();
  restoreGlobals();
});

describe("createMapResizeScheduler", () => {
  it("does not resize on mount when the canvas already matches the container", () => {
    harness.flushFrames();
    assert.equal(harness.resizeCalls(), 0);
  });

  it("resizes a discrete layout change on the next frame, without waiting out the debounce", () => {
    harness.setContainerSize(600, 600);
    harness.flushFrames();
    assert.equal(harness.resizeCalls(), 1);
  });

  it("coalesces a continuous window drag into a single resize once dimensions settle", () => {
    for (let width = 799; width > 779; width -= 1) {
      harness.windowResize(width, 600);
      harness.flushFrames();
    }
    assert.equal(harness.resizeCalls(), 0, "the previous frame stays on screen during the drag");

    harness.advance(RESIZE_DEBOUNCE_MS);
    harness.flushFrames();
    assert.equal(harness.resizeCalls(), 1);
  });

  it("drops a frame queued by a discrete change when a window drag starts", () => {
    // GeoLibre#2173 review: the rAF from the discrete change would otherwise
    // fire mid-drag and reallocate the framebuffer the debounce exists to keep.
    harness.setContainerSize(700, 600);
    harness.windowResize(690, 600);
    harness.flushFrames();
    assert.equal(harness.resizeCalls(), 0);

    harness.advance(RESIZE_DEBOUNCE_MS);
    harness.flushFrames();
    assert.equal(harness.resizeCalls(), 1);
  });

  it("debounces a window drag whose ResizeObserver callback beats the resize event", () => {
    // The delivery order of ResizeObserver entries and the `resize` event is
    // not guaranteed across engines, so the drag is detected from the window's
    // own dimensions rather than from whichever callback ran first.
    for (let width = 799; width > 789; width -= 1) {
      harness.windowResizeObserverFirst(width, 600);
      harness.flushFrames();
    }
    assert.equal(harness.resizeCalls(), 0);

    harness.advance(RESIZE_DEBOUNCE_MS);
    harness.flushFrames();
    assert.equal(harness.resizeCalls(), 1);
  });

  it("suppresses resizes while a panel splitter is dragged and commits once on release", () => {
    harness.dispatch(PANEL_RESIZE_START_EVENT);
    for (let width = 780; width > 760; width -= 2) {
      harness.setContainerSize(width, 600);
      harness.flushFrames();
    }
    assert.equal(harness.resizeCalls(), 0);

    harness.dispatch(PANEL_RESIZE_END_EVENT);
    harness.flushFrames();
    assert.equal(harness.resizeCalls(), 1);
  });

  it("keeps a settling window drag from leaking into a following panel drag", () => {
    harness.windowResize(700, 600);
    harness.dispatch(PANEL_RESIZE_START_EVENT);
    harness.dispatch(PANEL_RESIZE_END_EVENT);
    harness.flushFrames();
    assert.equal(harness.resizeCalls(), 1);

    // The window-drag burst was cleared with the panel drag, so the next
    // discrete change takes the immediate path rather than the debounce.
    harness.setContainerSize(650, 600);
    harness.flushFrames();
    assert.equal(harness.resizeCalls(), 2);
  });

  it("resizes on a devicePixelRatio change that leaves the CSS box untouched", () => {
    harness.setDevicePixelRatio(2);
    harness.flushFrames();
    assert.equal(harness.resizeCalls(), 1);
  });

  it("detaches every listener on dispose", () => {
    assert.ok(harness.listenerCount() > 0);
    dispose();
    dispose = () => {};
    assert.equal(harness.listenerCount(), 0);
  });
});
