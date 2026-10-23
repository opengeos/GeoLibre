import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  APP_UPDATE_CHECK_INTERVAL_MS,
  APP_UPDATE_DEDUPE_KEY,
  entryScriptUrl,
  isNewBuildDeployed,
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
    // Pinned, so later toasts cannot evict it while it is unanswered.
    assert.equal(shown[0].options?.pinned, true);
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

const indexHtml = (src: string) =>
  `<!doctype html><html><head><script type="module" crossorigin src="${src}"></script></head></html>`;

describe("entryScriptUrl", () => {
  it("resolves a relative entry src against the index URL", () => {
    assert.equal(
      entryScriptUrl(indexHtml("./assets/main-abc.js"), "https://example.org/demo/index.html"),
      "https://example.org/demo/assets/main-abc.js",
    );
  });

  it("finds the entry whatever the attribute order, skipping non-module scripts", () => {
    const html =
      '<script src="./runtime-config.js"></script>' +
      '<script crossorigin src="./assets/main-abc.js" type="module"></script>';
    assert.equal(
      entryScriptUrl(html, "https://example.org/index.html"),
      "https://example.org/assets/main-abc.js",
    );
  });

  it("ignores data-type and data-src look-alike attributes", () => {
    const html =
      '<script data-type="module" src="./not-module.js"></script>' +
      '<script data-src="./wrong.js" src="./assets/main-abc.js" type="module"></script>';
    assert.equal(
      entryScriptUrl(html, "https://example.org/index.html"),
      "https://example.org/assets/main-abc.js",
    );
  });

  it("returns null when the document has no module entry", () => {
    assert.equal(entryScriptUrl("<html></html>", "https://example.org/index.html"), null);
  });
});

describe("isNewBuildDeployed", () => {
  const current = "https://example.org/demo/assets/main-abc.js";

  it("is false when the deployed index loads the running entry", async () => {
    const fetched: string[] = [];
    const isNew = await isNewBuildDeployed({
      currentEntryUrl: current,
      fetchText: async (url) => {
        fetched.push(url);
        return indexHtml("./assets/main-abc.js");
      },
    });
    assert.equal(isNew, false);
    // index.html is read from the deployment base, one level above assets/.
    assert.deepEqual(fetched, ["https://example.org/demo/index.html"]);
  });

  it("is true when the deployed index loads a different entry", async () => {
    const isNew = await isNewBuildDeployed({
      currentEntryUrl: current,
      fetchText: async () => indexHtml("./assets/main-def.js"),
    });
    assert.equal(isNew, true);
  });

  it("trusts the worker when the build cannot be compared", async () => {
    assert.equal(
      await isNewBuildDeployed({ currentEntryUrl: null, fetchText: async () => "" }),
      true,
    );
    assert.equal(
      await isNewBuildDeployed({
        currentEntryUrl: current,
        fetchText: () => Promise.reject(new Error("offline")),
      }),
      true,
    );
    assert.equal(
      await isNewBuildDeployed({ currentEntryUrl: current, fetchText: async () => "<html>" }),
      true,
    );
  });
});
