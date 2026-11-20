import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  CONTEXT_MENU_RELEASE_WINDOW_MS,
  CONTEXT_MENU_TOUCH_HOLD_MS,
  CONTEXT_MENU_TOUCH_TOLERANCE_PX,
  ContextMenuGestureTracker,
  type ContextMenuRequest,
  type ContextMenuTimerScheduler,
} from "../apps/geolibre-desktop/src/lib/context-menu-gesture";

const RIGHT = 2;
const LEFT = 0;

function pointer(button: number, clientX: number, clientY: number, pointerId = 1) {
  return { pointerId, button, clientX, clientY };
}

describe("ContextMenuGestureTracker", () => {
  let opened: ContextMenuRequest[];
  let clock: number;
  let tracker: ContextMenuGestureTracker;

  beforeEach(() => {
    opened = [];
    clock = 1000;
    tracker = new ContextMenuGestureTracker(
      (request) => opened.push(request),
      () => clock,
    );
  });

  it("opens on a right-click when contextmenu fires at press (Linux/macOS)", () => {
    tracker.pointerDown(pointer(RIGHT, 100, 100));
    tracker.contextMenu({ clientX: 100, clientY: 100 });
    assert.equal(opened.length, 0, "deferred while the button is held");
    tracker.pointerUp(pointer(RIGHT, 101, 100));
    assert.deepEqual(opened, [{ clientX: 100, clientY: 100 }]);
  });

  it("suppresses a right-drag when contextmenu fires at press (Linux/macOS)", () => {
    tracker.pointerDown(pointer(RIGHT, 100, 100));
    tracker.contextMenu({ clientX: 100, clientY: 100 });
    tracker.pointerMove(pointer(RIGHT, 140, 80));
    tracker.pointerUp(pointer(RIGHT, 180, 60));
    assert.equal(opened.length, 0);
  });

  it("opens on a right-click when contextmenu fires at release (Windows)", () => {
    tracker.pointerDown(pointer(RIGHT, 100, 100));
    tracker.pointerUp(pointer(RIGHT, 102, 101));
    tracker.contextMenu({ clientX: 102, clientY: 101 });
    assert.deepEqual(opened, [{ clientX: 102, clientY: 101 }]);
  });

  it("suppresses a right-drag when contextmenu fires at release (Windows)", () => {
    tracker.pointerDown(pointer(RIGHT, 100, 100));
    tracker.pointerMove(pointer(RIGHT, 150, 60));
    tracker.pointerUp(pointer(RIGHT, 150, 60));
    tracker.contextMenu({ clientX: 150, clientY: 60 });
    assert.equal(opened.length, 0);
  });

  it("catches a drag reported only by the release position", () => {
    tracker.pointerDown(pointer(RIGHT, 100, 100));
    tracker.contextMenu({ clientX: 100, clientY: 100 });
    tracker.pointerUp(pointer(RIGHT, 120, 100));
    assert.equal(opened.length, 0);
  });

  it("opens immediately for a keyboard-invoked menu", () => {
    tracker.contextMenu({ clientX: 10, clientY: 20 });
    assert.deepEqual(opened, [{ clientX: 10, clientY: 20 }]);
  });

  it("does not let a stale right-drag swallow a later keyboard menu", () => {
    tracker.pointerDown(pointer(RIGHT, 100, 100));
    tracker.pointerMove(pointer(RIGHT, 200, 100));
    tracker.pointerUp(pointer(RIGHT, 200, 100));
    clock += CONTEXT_MENU_RELEASE_WINDOW_MS + 1;
    tracker.contextMenu({ clientX: 5, clientY: 5 });
    assert.equal(opened.length, 1);
  });

  it("opens after a left-button drag followed by the menu key", () => {
    tracker.pointerDown(pointer(LEFT, 100, 100));
    tracker.pointerMove(pointer(LEFT, 200, 100));
    tracker.pointerUp(pointer(LEFT, 200, 100));
    tracker.contextMenu({ clientX: 5, clientY: 5 });
    assert.equal(opened.length, 1);
  });

  it("opens a macOS Ctrl+click on release", () => {
    tracker.pointerDown(pointer(LEFT, 50, 50));
    tracker.contextMenu({ clientX: 50, clientY: 50 });
    assert.equal(opened.length, 0);
    tracker.pointerUp(pointer(LEFT, 50, 50));
    assert.equal(opened.length, 1);
  });

  it("ignores moves and releases from another pointer", () => {
    tracker.pointerDown(pointer(RIGHT, 100, 100, 1));
    tracker.contextMenu({ clientX: 100, clientY: 100 });
    tracker.pointerMove(pointer(RIGHT, 300, 300, 2));
    tracker.pointerUp(pointer(RIGHT, 300, 300, 2));
    assert.equal(opened.length, 0, "still waiting for pointer 1");
    tracker.pointerUp(pointer(RIGHT, 100, 100, 1));
    assert.equal(opened.length, 1);
  });

  it("drops a deferred menu when the gesture is cancelled", () => {
    tracker.pointerDown(pointer(RIGHT, 100, 100));
    tracker.contextMenu({ clientX: 100, clientY: 100 });
    tracker.cancel();
    tracker.pointerUp(pointer(RIGHT, 100, 100));
    assert.equal(opened.length, 0);
  });

  it("ignores a pointercancel from another pointer", () => {
    tracker.pointerDown(pointer(RIGHT, 100, 100, 1));
    tracker.pointerMove(pointer(RIGHT, 200, 100, 1));
    tracker.pointerUp(pointer(RIGHT, 200, 100, 1));
    tracker.cancel(2);
    tracker.contextMenu({ clientX: 200, clientY: 100 });
    assert.equal(opened.length, 0, "the drag is still suppressed");
  });

  it("opens on a stationary touch long-press and suppresses duplicate native contextmenu", () => {
    const timers = new Map<number, () => void>();
    let nextId = 1;
    const scheduler: ContextMenuTimerScheduler = {
      setTimeout(cb) {
        const id = nextId++;
        timers.set(id, cb);
        return id;
      },
      clearTimeout(id) {
        timers.delete(id as number);
      },
    };
    const touchTracker = new ContextMenuGestureTracker(
      (request) => opened.push(request),
      () => clock,
      scheduler,
    );

    touchTracker.pointerDown({
      pointerId: 10,
      pointerType: "touch",
      button: 0,
      clientX: 80,
      clientY: 120,
    });
    assert.equal(timers.size, 1);
    clock += CONTEXT_MENU_TOUCH_HOLD_MS;
    for (const cb of [...timers.values()]) cb();
    assert.deepEqual(opened, [{ clientX: 80, clientY: 120, isTouch: true }]);

    // Synthetic native contextmenu on Android right after hold must not double-open.
    touchTracker.contextMenu({ clientX: 80, clientY: 120 });
    assert.equal(opened.length, 1);
  });

  it("cancels a touch long-press on pan or pinch (second finger)", () => {
    const timers = new Map<number, () => void>();
    let nextId = 1;
    const scheduler: ContextMenuTimerScheduler = {
      setTimeout(cb) {
        const id = nextId++;
        timers.set(id, cb);
        return id;
      },
      clearTimeout(id) {
        timers.delete(id as number);
      },
    };
    const touchTracker = new ContextMenuGestureTracker(
      (request) => opened.push(request),
      () => clock,
      scheduler,
    );

    // Pan beyond tolerance cancels hold.
    touchTracker.pointerDown({
      pointerId: 1,
      pointerType: "touch",
      button: 0,
      clientX: 50,
      clientY: 50,
    });
    touchTracker.pointerMove({
      pointerId: 1,
      pointerType: "touch",
      button: 0,
      clientX: 50 + CONTEXT_MENU_TOUCH_TOLERANCE_PX + 2,
      clientY: 50,
    });
    assert.equal(timers.size, 0);
    touchTracker.pointerUp({
      pointerId: 1,
      pointerType: "touch",
      button: 0,
      clientX: 70,
      clientY: 50,
    });

    // Second finger cancels hold.
    touchTracker.pointerDown({
      pointerId: 2,
      pointerType: "touch",
      button: 0,
      clientX: 100,
      clientY: 100,
    });
    assert.equal(timers.size, 1);
    touchTracker.pointerDown({
      pointerId: 3,
      pointerType: "touch",
      button: 0,
      clientX: 150,
      clientY: 150,
    });
    assert.equal(timers.size, 0);
  });

  it("suppresses Android native contextmenu arriving before the 500ms hold timer fires", () => {
    const opened: ContextMenuRequest[] = [];
    let clock = 5000;
    const timers = new Map<number, () => void>();
    let nextId = 1;
    const scheduler = {
      setTimeout: (cb: () => void) => {
        const id = nextId++;
        timers.set(id, cb);
        return id as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: (handle: ReturnType<typeof setTimeout>) => {
        timers.delete(handle as unknown as number);
      },
    };
    const touchTracker = new ContextMenuGestureTracker(
      (request) => opened.push(request),
      () => clock,
      scheduler,
    );

    touchTracker.pointerDown({
      pointerId: 10,
      pointerType: "touch",
      button: 0,
      clientX: 120,
      clientY: 140,
    });
    // Native Android contextmenu fires at 400ms before our 500ms timer.
    clock += 400;
    touchTracker.contextMenu({ clientX: 120, clientY: 140 });
    assert.equal(opened.length, 0);

    // Our 500ms timer fires once and opens cleanly.
    clock += 100;
    for (const cb of [...timers.values()]) cb();
    assert.equal(opened.length, 1);
    assert.deepEqual(opened[0], { clientX: 120, clientY: 140, isTouch: true });
  });
});
