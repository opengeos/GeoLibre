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

  it("acquires, releases, and re-acquires on visibilitychange", async () => {
    let requestCount = 0;
    let releaseCount = 0;
    let visibilityListener: (() => void) | null = null;
    let visibilityState: DocumentVisibilityState = "visible";
    const states: boolean[] = [];

    const makeSentinel = (): WakeLockSentinelLike => {
      const listeners: Array<() => void> = [];
      const sentinel: WakeLockSentinelLike = {
        released: false,
        async release() {
          sentinel.released = true;
          releaseCount += 1;
          for (const fn of listeners) fn();
        },
        addEventListener(_type: string, fn: () => void) {
          listeners.push(fn);
        },
        removeEventListener(_type: string, fn: () => void) {
          const idx = listeners.indexOf(fn);
          if (idx >= 0) listeners.splice(idx, 1);
        },
      };
      return sentinel;
    };

    const controller = createWakeLockController({
      navigator: {
        wakeLock: {
          async request() {
            requestCount += 1;
            return makeSentinel();
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

    // Simulate OS dropping lock when hidden, then returning to foreground.
    visibilityState = "hidden";
    await controller.release();
    assert.equal(releaseCount, 1);
    assert.equal(states.at(-1), false);

    // Re-acquire explicitly, then simulate foreground regain.
    await controller.acquire();
    assert.equal(requestCount, 2);
    visibilityState = "visible";
    const invokeVisibility = visibilityListener as (() => void) | null;
    if (invokeVisibility) invokeVisibility();
    assert.equal(requestCount, 2, "does not duplicate an active sentinel");

    controller.dispose();
    assert.equal(visibilityListener, null);
  });
});
