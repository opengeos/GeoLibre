import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  reloadForStaleChunk,
  STALE_CHUNK_RELOAD_COOLDOWN_MS,
} from "../apps/geolibre-desktop/src/lib/stale-chunk-reload";

function makeDeps(initial: { now: number; lastReloadAt: number | null }) {
  const state = {
    now: initial.now,
    lastReloadAt: initial.lastReloadAt,
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
    },
  };
}

describe("reloadForStaleChunk", () => {
  it("reloads on the first stale-chunk error and records the timestamp", () => {
    const { state, deps } = makeDeps({ now: 1000, lastReloadAt: null });

    assert.equal(reloadForStaleChunk(deps), true);
    assert.equal(state.reloads, 1);
    assert.equal(state.lastReloadAt, 1000);
  });

  it("suppresses a reload that fires within the cooldown", () => {
    const { state, deps } = makeDeps({ now: 5000, lastReloadAt: null });

    assert.equal(reloadForStaleChunk(deps), true);
    state.now += STALE_CHUNK_RELOAD_COOLDOWN_MS - 1;

    // A second error right after the reload means the build is broken, not
    // merely stale, so it must not loop.
    assert.equal(reloadForStaleChunk(deps), false);
    assert.equal(state.reloads, 1);
  });

  it("reloads again once the cooldown has elapsed", () => {
    const { state, deps } = makeDeps({ now: 0, lastReloadAt: null });

    assert.equal(reloadForStaleChunk(deps), true);
    // The guard is strict `< cooldown`, so a diff of exactly the cooldown is
    // already past it (the just-expired edge) and reloads again.
    state.now += STALE_CHUNK_RELOAD_COOLDOWN_MS;

    // A later redeploy in a long-lived session should recover too.
    assert.equal(reloadForStaleChunk(deps), true);
    assert.equal(state.reloads, 2);
    assert.equal(state.lastReloadAt, STALE_CHUNK_RELOAD_COOLDOWN_MS);
  });
});
