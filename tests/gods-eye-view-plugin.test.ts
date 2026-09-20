import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  godsEyeViewPlugin,
  reattachGodsEyeView,
} from "../packages/plugins/src/plugins/gods-eye-view";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";

// The plugin's reattach path (issue #2462). `CesiumEngine.getCesiumScene()`
// mints a brand-new handle object on every call, and the host re-runs the
// reattach on every project load — so a guard that compares handles instead of
// viewers never short-circuits, and each load silently re-fetches both public
// feeds and re-takes the clock. These drive it against a fake that reproduces
// the fresh-object-per-call shape.

/** A Cesium widget reduced to what the plugin reads, behind a fresh handle. */
function makeGlobe() {
  const viewer = { id: "viewer", clock: { shouldAnimate: false } };
  let handles = 0;
  const app = {
    getMap: () => null,
    getCesiumScene: () => {
      handles += 1;
      return {
        viewer,
        clock: viewer.clock,
        primary: true,
        requestRender: () => {},
      };
    },
    registerRightPanel: () => () => {},
    openRightPanel: () => {},
    onLocaleChange: () => () => {},
  } as unknown as GeoLibreAppAPI;
  return { app, viewer, handleCount: () => handles };
}

/** Count feed requests without touching the network; failures are expected. */
function stubFetch(): { calls: () => number; restore: () => void } {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error("offline");
  }) as typeof fetch;
  console.warn = () => {};
  return {
    calls: () => calls,
    restore: () => {
      globalThis.fetch = originalFetch;
      console.warn = originalWarn;
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("God's Eye View reattach", () => {
  it("re-binds on an engine swap and no-ops on a project load", async () => {
    const net = stubFetch();
    const first = makeGlobe();
    try {
      godsEyeViewPlugin.activate?.(first.app);
      for (let i = 0; i < 4; i++) await flush();
      const afterActivate = net.calls();
      assert.ok(afterActivate > 0, "activating on the globe loads the enabled feeds");
      assert.equal(first.viewer.clock.shouldAnimate, true);

      // The user paused the clock, then loaded a project: the handle is a new
      // object but the viewer is the same one, so nothing should restart.
      first.viewer.clock.shouldAnimate = false;
      reattachGodsEyeView(first.app);
      for (let i = 0; i < 4; i++) await flush();
      assert.equal(net.calls(), afterActivate, "an unchanged viewer re-fetches nothing");
      assert.equal(first.viewer.clock.shouldAnimate, false, "and does not override the pause");
      assert.ok(first.handleCount() > 1, "the fake mints a fresh handle per call, as Cesium does");

      // A renderer swap hands over a different viewer: that is a real rebind.
      const second = makeGlobe();
      reattachGodsEyeView(second.app);
      for (let i = 0; i < 4; i++) await flush();
      assert.ok(net.calls() > afterActivate, "a new viewer reloads the feeds");
      assert.equal(second.viewer.clock.shouldAnimate, true);

      godsEyeViewPlugin.deactivate?.(second.app);
      for (let i = 0; i < 4; i++) await flush();
    } finally {
      godsEyeViewPlugin.deactivate?.(first.app);
      net.restore();
    }
  });
});
