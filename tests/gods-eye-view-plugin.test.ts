import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
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

const originalDocument = globalThis.document;
afterEach(() => {
  globalThis.document = originalDocument;
});

/** A Cesium widget reduced to what the plugin reads, behind a fresh handle. */
function makeGlobe() {
  const viewer = { id: "viewer", clock: { shouldAnimate: false, multiplier: 0 } };
  let handles = 0;
  // The panel is plain DOM, so it renders only when the host calls `render`.
  const { document } = parseHTML('<html><body><div id="panel"></div></body></html>');
  const panel = document.getElementById("panel") as unknown as HTMLElement;
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
    registerRightPanel: (options: { render: (container: HTMLElement) => () => void }) => {
      globalThis.document = document;
      options.render(panel);
      return () => {};
    },
    openRightPanel: () => {},
    onLocaleChange: () => () => {},
  } as unknown as GeoLibreAppAPI;
  return { app, viewer, panel, handleCount: () => handles };
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

describe("God's Eye View clock speed", () => {
  it("runs at real time by default and persists the chosen speed", async () => {
    const net = stubFetch();
    const globe = makeGlobe();
    try {
      godsEyeViewPlugin.applyProjectState?.(globe.app, {});
      assert.deepEqual(godsEyeViewPlugin.getProjectState?.(), {
        earthquakes: true,
        satellites: true,
        // Real time, not the 60x the feeds used to hard-code: at 60x the ISS
        // laps the planet in ninety seconds, which reads as an animation
        // rather than as where the satellite is now.
        speed: 1,
      });

      godsEyeViewPlugin.activate?.(globe.app);
      for (let i = 0; i < 4; i++) await flush();
      assert.equal(globe.viewer.clock.multiplier, 1);

      // The panel's select re-times the live globe without reloading a feed.
      const select = globe.panel.querySelector("select") as HTMLSelectElement;
      assert.deepEqual(
        [...select.options].map((option) => option.value),
        ["1", "10", "60", "600"],
      );
      assert.equal(select.value, "1");
      const afterActivate = net.calls();
      // linkedom's `select.value` is read-only, so pick the way a user does:
      // clear the current choice, then select the new one.
      for (const option of select.options) if (option.selected) option.selected = false;
      const sixty = [...select.options].find((option) => option.value === "60");
      assert.ok(sixty);
      sixty.selected = true;
      select.dispatchEvent(new (globe.panel.ownerDocument.defaultView as Window).Event("change"));
      // The panel re-renders on a setting change; the fresh select shows it.
      assert.equal((globe.panel.querySelector("select") as HTMLSelectElement).value, "60");
      assert.equal(globe.viewer.clock.multiplier, 60);
      assert.equal(net.calls(), afterActivate, "changing speed refetches nothing");
      assert.equal(godsEyeViewPlugin.getProjectState?.().speed, 60);

      // A project carrying a speed re-times a globe that is already running;
      // a hand-edited one carrying nonsense falls back to real time.
      godsEyeViewPlugin.applyProjectState?.(globe.app, {
        earthquakes: true,
        satellites: true,
        speed: 10,
      });
      assert.equal(globe.viewer.clock.multiplier, 10);
      godsEyeViewPlugin.applyProjectState?.(globe.app, { speed: 7 });
      assert.equal(globe.viewer.clock.multiplier, 1);
    } finally {
      godsEyeViewPlugin.deactivate?.(globe.app);
      godsEyeViewPlugin.applyProjectState?.(globe.app, {});
      net.restore();
    }
  });
});

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
