import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createWakeLockController,
  type WakeLockSentinelLike,
} from "../apps/geolibre-desktop/src/lib/wake-lock";

describe("createWakeLockController", () => {
  it("reports unsupported cleanly when navigator.wakeLock is unavailable", async () => {
    const controller = createWakeLockController({ navigator: {} });
    assert.equal(controller.supported, false);
    assert.equal(await controller.acquire(), false);
    controller.dispose();
  });

  it("acquires, re-acquires after OS release on visibilitychange, and deduplicates concurrent requests", async () => {
    let requestCount = 0;
    let releaseCount = 0;
    let visibilityListener: (() => void) | null = null;
    let visibilityState: DocumentVisibilityState = "visible";
    const states: boolean[] = [];
    const sentinels: Array<{ sentinel: WakeLockSentinelLike; emitOsRelease: () => void }> = [];

    const makeSentinel = () => {
      const listeners: Array<() => void> = [];
      const sentinel: WakeLockSentinelLike = {
        released: false,
        async release() {
          sentinel.released = true;
          releaseCount += 1;
          for (const fn of [...listeners]) fn();
        },
        addEventListener(_type: string, fn: () => void) {
          listeners.push(fn);
        },
        removeEventListener(_type: string, fn: () => void) {
          const idx = listeners.indexOf(fn);
          if (idx >= 0) listeners.splice(idx, 1);
        },
      };
      const entry = {
        sentinel,
        emitOsRelease: () => {
          sentinel.released = true;
          for (const fn of [...listeners]) fn();
        },
      };
      sentinels.push(entry);
      return sentinel;
    };

    let deferNextRequest: ((value: WakeLockSentinelLike) => void) | null = null;

    const controller = createWakeLockController({
      navigator: {
        wakeLock: {
          request() {
            requestCount += 1;
            if (deferNextRequest !== null) {
              return new Promise<WakeLockSentinelLike>((resolve) => {
                deferNextRequest = resolve;
              });
            }
            return Promise.resolve(makeSentinel());
          },
        },
      },
      document: {
        get visibilityState() {
          return visibilityState;
        },
        addEventListener(_type: string, listener: EventListenerOrEventListenerObject) {
          if (typeof listener === "function") {
            visibilityListener = () => listener({} as Event);
          }
        },
        removeEventListener() {
          visibilityListener = null;
        },
      },
      onChange: (active) => states.push(active),
    });

    assert.equal(controller.supported, true);
    assert.equal(await controller.acquire(), true);
    assert.equal(requestCount, 1);
    assert.equal(states.at(-1), true);

    // Simulate the OS dropping the sentinel when the page is backgrounded.
    visibilityState = "hidden";
    sentinels[0].emitOsRelease();
    assert.equal(states.at(-1), false);

    // Returning to foreground should automatically re-acquire exactly once.
    visibilityState = "visible";
    const invokeVisibility = visibilityListener as (() => void) | null;
    assert.ok(invokeVisibility);
    invokeVisibility();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(requestCount, 2);
    assert.equal(states.at(-1), true);

    // A second visibilitychange while the sentinel is active is a no-op.
    invokeVisibility();
    assert.equal(requestCount, 2, "does not duplicate an active sentinel");

    // Explicit release drops the active lock.
    await controller.release();
    assert.equal(releaseCount, 1);
    assert.equal(states.at(-1), false);

    // Concurrent acquire() calls while a request is pending share one wakeLock.request().
    deferNextRequest = () => {};
    const pendingA = controller.acquire();
    const pendingB = controller.acquire();
    assert.equal(requestCount, 3, "concurrent acquire calls share a single request");
    (deferNextRequest as (value: WakeLockSentinelLike) => void)(makeSentinel());
    deferNextRequest = null;
    assert.deepEqual(await Promise.all([pendingA, pendingB]), [true, true]);

    controller.dispose();
    assert.equal(visibilityListener, null);
  });
});
