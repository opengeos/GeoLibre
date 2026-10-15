import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  APP_UPDATE_CHECK_INTERVAL_MS,
  APP_UPDATE_DEDUPE_KEY,
  offerAppUpdate,
  watchForAppUpdates,
  type AppUpdateWatchEnv,
} from "../apps/geolibre-desktop/src/lib/app-update";
import type { NotifyOptions } from "../apps/geolibre-desktop/src/lib/notify";

describe("offerAppUpdate", () => {
  it("shows a persistent, deduplicated notice whose action reloads", () => {
    const shown: Array<{ message: string; options?: NotifyOptions }> = [];
    let reloads = 0;

    offerAppUpdate({
      showInfo: (message, options) => shown.push({ message, options }),
      message: "A new version of GeoLibre is available.",
      reloadLabel: "Reload",
      reload: () => {
        reloads += 1;
      },
    });

    assert.equal(shown.length, 1);
    assert.equal(shown[0].message, "A new version of GeoLibre is available.");
    // The reload is the user's call, so the notice must not time out on its own.
    assert.equal(shown[0].options?.durationMs, null);
    assert.equal(shown[0].options?.dedupeKey, APP_UPDATE_DEDUPE_KEY);
    assert.equal(shown[0].options?.action?.label, "Reload");
    assert.equal(reloads, 0);
    shown[0].options?.action?.onClick();
    assert.equal(reloads, 1);
  });
});

function fakeEnv(visibility: DocumentVisibilityState) {
  const listeners = new Map<string, () => void>();
  let interval: { handler: () => void; ms: number } | null = null;
  let cleared = false;
  const doc = {
    visibilityState: visibility,
    addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
    removeEventListener: (type: string) => listeners.delete(type),
  };
  const env = {
    document: doc as unknown as AppUpdateWatchEnv["document"],
    setInterval: (handler: () => void, ms: number) => {
      interval = { handler, ms };
      return 1;
    },
    clearInterval: () => {
      cleared = true;
    },
  };
  return {
    env,
    doc,
    listeners,
    tick: () => interval?.handler(),
    intervalMs: () => interval?.ms,
    cleared: () => cleared,
  };
}

describe("watchForAppUpdates", () => {
  it("checks for a new worker when the tab becomes visible and on a timer", () => {
    const fake = fakeEnv("visible");
    let checks = 0;
    watchForAppUpdates({ update: async () => void (checks += 1) } as never, fake.env);

    assert.equal(fake.intervalMs(), APP_UPDATE_CHECK_INTERVAL_MS);
    fake.listeners.get("visibilitychange")?.();
    fake.tick();
    assert.equal(checks, 2);
  });

  it("skips checks while the tab is hidden", () => {
    const fake = fakeEnv("hidden");
    let checks = 0;
    watchForAppUpdates({ update: async () => void (checks += 1) } as never, fake.env);

    fake.listeners.get("visibilitychange")?.();
    fake.tick();
    assert.equal(checks, 0);
  });

  it("swallows a failed check so an offline tab does not throw", async () => {
    const fake = fakeEnv("visible");
    watchForAppUpdates({ update: () => Promise.reject(new Error("offline")) } as never, fake.env);

    assert.doesNotThrow(() => fake.tick());
    // Let the rejected promise settle; an unhandled rejection would fail the run.
    await new Promise((resolve) => setImmediate(resolve));
  });

  it("stops watching when disposed", () => {
    const fake = fakeEnv("visible");
    const stop = watchForAppUpdates({ update: async () => undefined } as never, fake.env);

    stop();
    assert.equal(fake.listeners.has("visibilitychange"), false);
    assert.equal(fake.cleared(), true);
  });
});
