import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_MOBILE_PIXEL_RATIO,
  resolveMapPixelRatio,
  watchMapPixelRatio,
} from "../packages/map/src/mobile-pixel-ratio";

describe("resolveMapPixelRatio", () => {
  it("caps high-DPR touch devices at MAX_MOBILE_PIXEL_RATIO", () => {
    assert.equal(
      resolveMapPixelRatio({ devicePixelRatio: 3, isTouchDevice: true }),
      MAX_MOBILE_PIXEL_RATIO,
    );
    assert.equal(resolveMapPixelRatio({ devicePixelRatio: 1.5, isTouchDevice: true }), 1.5);
  });

  it("leaves desktop devicePixelRatio uncapped", () => {
    assert.equal(resolveMapPixelRatio({ devicePixelRatio: 3, isTouchDevice: false }), 3);
    assert.equal(resolveMapPixelRatio({ devicePixelRatio: 2, isTouchDevice: false }), 2);
  });

  it("handles missing or invalid pixel ratios safely", () => {
    assert.equal(resolveMapPixelRatio({ devicePixelRatio: 0, isTouchDevice: true }), undefined);
    assert.equal(
      resolveMapPixelRatio({ devicePixelRatio: Number.NaN, isTouchDevice: true }),
      undefined,
    );
  });
});

describe("watchMapPixelRatio", () => {
  it("re-subscribes across DPR changes, survives throwing callbacks, and cleans up on dispose", () => {
    let currentDpr = 1;
    const queries: string[] = [];
    const activeListeners = new Map<string, () => void>();
    const received: number[] = [];

    const matchMedia = (query: string) => {
      queries.push(query);
      return {
        matches: true,
        addEventListener(_type: string, listener: () => void) {
          activeListeners.set(query, listener);
        },
        removeEventListener(_type: string, listener: () => void) {
          if (activeListeners.get(query) === listener) {
            activeListeners.delete(query);
          }
        },
      };
    };

    let shouldThrow = true;
    const dispose = watchMapPixelRatio(
      (ratio) => {
        received.push(ratio);
        if (shouldThrow) {
          shouldThrow = false;
          throw new Error("transient map error");
        }
      },
      {
        getDevicePixelRatio: () => currentDpr,
        matchMedia,
        isTouchDevice: true,
      },
    );

    assert.deepEqual(queries, ["(resolution: 1dppx)"]);

    // First DPR change: callback throws, but watcher already re-subscribed to 3dppx.
    currentDpr = 3;
    assert.throws(() => activeListeners.get("(resolution: 1dppx)")?.(), /transient map error/);
    assert.deepEqual(received, [MAX_MOBILE_PIXEL_RATIO]);
    assert.deepEqual(queries, ["(resolution: 1dppx)", "(resolution: 3dppx)"]);

    // Second DPR change still fires cleanly.
    currentDpr = 1.5;
    activeListeners.get("(resolution: 3dppx)")?.();
    assert.deepEqual(received, [MAX_MOBILE_PIXEL_RATIO, 1.5]);
    assert.equal(activeListeners.has("(resolution: 1.5dppx)"), true);

    // Dispose detaches the active listener.
    dispose();
    assert.equal(activeListeners.size, 0);
  });

  it("recomputes pixel ratio when (pointer: coarse) changes dynamically and cleans up both listeners", () => {
    let coarsePointer = false;
    const activeListeners = new Map<string, () => void>();
    const received: number[] = [];

    const matchMedia = (query: string) => ({
      get matches() {
        return query === "(pointer: coarse)" ? coarsePointer : true;
      },
      addEventListener(_type: string, listener: () => void) {
        activeListeners.set(query, listener);
      },
      removeEventListener(_type: string, listener: () => void) {
        if (activeListeners.get(query) === listener) {
          activeListeners.delete(query);
        }
      },
    });

    const dispose = watchMapPixelRatio((ratio) => received.push(ratio), {
      getDevicePixelRatio: () => 3,
      matchMedia,
    });

    assert.equal(activeListeners.has("(pointer: coarse)"), true);
    assert.equal(activeListeners.has("(resolution: 3dppx)"), true);

    // Switching from fine pointer to coarse touch caps DPR=3 at 2x.
    coarsePointer = true;
    activeListeners.get("(pointer: coarse)")?.();
    assert.deepEqual(received, [MAX_MOBILE_PIXEL_RATIO]);

    // Switching back to fine pointer restores uncapped DPR=3.
    coarsePointer = false;
    activeListeners.get("(pointer: coarse)")?.();
    assert.deepEqual(received, [MAX_MOBILE_PIXEL_RATIO, 3]);

    // Dispose detaches both resolution and pointer listeners.
    dispose();
    assert.equal(activeListeners.size, 0);
  });
});
