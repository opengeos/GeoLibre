import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  reloadForStaleChunk,
  isExternalModuleFailure,
  installStaleChunkReload,
  STALE_CHUNK_RELOAD_COOLDOWN_MS,
} from "../apps/geolibre-desktop/src/lib/stale-chunk-reload";

function makeDeps(initial: { now: number; lastReloadAt: number | null; dirty?: boolean }) {
  const state = {
    now: initial.now,
    lastReloadAt: initial.lastReloadAt,
    dirty: initial.dirty ?? false,
    reloads: 0,
  };
  return {
    state,
    deps: {
      now: () => state.now,
      getLastReloadAt: () => state.lastReloadAt,
      setLastReloadAt: (value: number) => {
        state.lastReloadAt = value;
      },
      reload: () => {
        state.reloads += 1;
      },
      hasUnsavedChanges: () => state.dirty,
    },
  };
}

describe("reloadForStaleChunk", () => {
  it("reloads on the first stale-chunk error and records the timestamp", () => {
    const { state, deps } = makeDeps({ now: 1000, lastReloadAt: null });

    assert.equal(reloadForStaleChunk(deps), "reloaded");
    assert.equal(state.reloads, 1);
    assert.equal(state.lastReloadAt, 1000);
  });

  it("suppresses a reload that fires within the cooldown", () => {
    const { state, deps } = makeDeps({ now: 5000, lastReloadAt: null });

    assert.equal(reloadForStaleChunk(deps), "reloaded");
    state.now += STALE_CHUNK_RELOAD_COOLDOWN_MS - 1;

    // A second error right after the reload means the build is broken, not
    // merely stale, so it must not loop.
    assert.equal(reloadForStaleChunk(deps), "suppressed-cooldown");
    assert.equal(state.reloads, 1);
  });

  it("reloads again once the cooldown has elapsed", () => {
    const { state, deps } = makeDeps({ now: 0, lastReloadAt: null });

    assert.equal(reloadForStaleChunk(deps), "reloaded");
    // The guard is strict `< cooldown`, so a diff of exactly the cooldown is
    // already past it (the just-expired edge) and reloads again.
    state.now += STALE_CHUNK_RELOAD_COOLDOWN_MS;

    // A later redeploy in a long-lived session should recover too.
    assert.equal(reloadForStaleChunk(deps), "reloaded");
    assert.equal(state.reloads, 2);
    assert.equal(state.lastReloadAt, STALE_CHUNK_RELOAD_COOLDOWN_MS);
  });

  it("defers the reload when the project has unsaved changes", () => {
    const { state, deps } = makeDeps({
      now: 1000,
      lastReloadAt: null,
      dirty: true,
    });

    // Reloading would discard the user's map and raise the beforeunload prompt,
    // so recovery is withheld and nothing is reloaded or timestamped.
    assert.equal(reloadForStaleChunk(deps), "deferred-unsaved");
    assert.equal(state.reloads, 0);
    assert.equal(state.lastReloadAt, null);
  });

  it("prioritizes unsaved work over the cooldown guard", () => {
    const now = STALE_CHUNK_RELOAD_COOLDOWN_MS * 10;
    // Seed a prior reload inside the cooldown window so the test would report
    // "suppressed-cooldown" if the dirty check did not run first.
    const lastReloadAt = now - STALE_CHUNK_RELOAD_COOLDOWN_MS + 1;
    const { state, deps } = makeDeps({ now, lastReloadAt, dirty: true });

    // A dirty project must defer rather than reload, even though the cooldown
    // would otherwise be the deciding branch.
    assert.equal(reloadForStaleChunk(deps), "deferred-unsaved");
    assert.equal(state.reloads, 0);
    assert.equal(state.lastReloadAt, lastReloadAt);
  });
});

it("preserves the project for WebKit's unattributed import error", () => {
  const previous = globalThis.window;
  const target = new EventTarget();
  let reloads = 0;
  Object.assign(globalThis, {
    window: Object.assign(target, {
      location: { origin: "https://web.geolibre.app", reload: () => reloads++ },
      sessionStorage: { getItem: () => null, setItem: () => {} },
    }),
  });
  const cleanup = installStaleChunkReload({ enabled: true });
  try {
    const ambiguous = Object.assign(new Event("vite:preloadError", { cancelable: true }), {
      payload: new TypeError("IMPORTING A MODULE SCRIPT FAILED: Load failed"),
    });
    target.dispatchEvent(ambiguous);
    assert.equal(reloads, 0);
    assert.equal(ambiguous.defaultPrevented, false, "the feature still receives its rejection");
    const local = Object.assign(new Event("vite:preloadError", { cancelable: true }), {
      payload: new TypeError(
        "Failed to fetch dynamically imported module: https://web.geolibre.app/assets/old.js",
      ),
    });
    target.dispatchEvent(local);
    assert.equal(reloads, 1, "identified local chunks still recover");
    assert.equal(local.defaultPrevented, true);
  } finally {
    cleanup();
    Object.assign(globalThis, { window: previous });
  }
});

it("leaves CDN import errors to their feature while retaining local stale-chunk recovery", () => {
  const origin = "https://web.geolibre.app";
  assert.equal(
    isExternalModuleFailure(
      new TypeError(
        "Failed to fetch dynamically imported module: https://js.arcgis.com/5.1/@arcgis/core/Map.js",
      ),
      origin,
    ),
    true,
  );
  assert.equal(
    isExternalModuleFailure(
      "error loading dynamically imported module: https://cdn.jsdelivr.net/npm/example/index.js",
      origin,
    ),
    true,
  );
  assert.equal(
    isExternalModuleFailure(
      new Error(
        "Failed to fetch dynamically imported module: https://web.geolibre.app/assets/old-hash.js",
      ),
      origin,
    ),
    false,
  );
  assert.equal(
    isExternalModuleFailure(
      new Error(
        "Importing https://js.arcgis.com/5.1/@arcgis/core/Map.js from https://web.geolibre.app/assets/arcgis.js failed",
      ),
      origin,
    ),
    true,
  );
  assert.equal(
    isExternalModuleFailure(new Error("Importing a module script failed."), origin),
    false,
  );
  assert.equal(isExternalModuleFailure(undefined, origin), false);
});
