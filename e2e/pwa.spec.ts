import { expect, test, type Page } from "@playwright/test";

/**
 * Validates the web build's PWA/offline support (issue #274):
 *  - a valid, installable web manifest is linked from the document,
 *  - the service worker registers and takes control of the page, and
 *  - the app shell still boots after going offline once it has been visited.
 *
 * Runs against the production build served by `vite preview` (the dev server
 * ships no service worker — `devOptions.enabled` is false in vite.config.ts).
 */

interface WebManifest {
  name?: string;
  display?: string;
  start_url?: string;
  icons?: { sizes?: string }[];
}

test("exposes a valid, installable web manifest", async ({ page }) => {
  await page.goto("/");

  const manifestHref = await page.locator('link[rel="manifest"]').getAttribute("href");
  expect(manifestHref, "document should link a web manifest").toBeTruthy();

  const manifest: WebManifest = await page.evaluate(async (href) => {
    const res = await fetch(href!);
    if (!res.ok) {
      throw new Error(`Manifest fetch failed: ${res.status} ${res.statusText}`);
    }
    return res.json();
  }, manifestHref);

  expect(manifest.name).toBe("GeoLibre");
  expect(manifest.display).toBe("standalone");
  expect(manifest.start_url).toBeTruthy();
  // Installability needs at least a 192px and a 512px icon.
  const sizes = (manifest.icons ?? []).map((icon) => icon.sizes);
  expect(sizes).toContain("192x192");
  expect(sizes).toContain("512x512");
});

test("registers a service worker and serves the shell offline after first visit", async ({
  page,
  context,
}) => {
  // This test chains several long, sequential waits whose explicit ceilings sum
  // to ~255s — past the 60s default per-test timeout (playwright.config.ts):
  // the SW taking control (30s), the warm map boot, caching every loaded asset
  // (60s), and the offline cold boot that re-parses/executes the ~13 MB MapLibre
  // chunk from cache under software WebGL (60s + 60s). None of these is a fixed
  // cost — each returns as soon as its condition is met — but the per-assertion
  // budgets are deliberately generous, so the test-level cap (plus the untimed
  // goto/networkidle/reload navigations that inherit it) must be larger than
  // their sum for those budgets, rather than the cap, to govern. See issue #274.
  test.setTimeout(360_000);

  // waitForLoadedAssetsCached() below enumerates the boot's assets from
  // performance.getEntriesByType("resource"), whose buffer defaults to 250
  // entries; once full, the *earliest* entries (the entry/React/MapLibre chunks
  // the offline boot needs) are dropped and silently skipped by the cache check.
  // Enlarge the buffer before any resource loads so every asset is verified.
  await page.addInitScript(() => {
    performance.setResourceTimingBufferSize(1000);
  });

  await page.goto("/");

  // The service worker activates and (via clientsClaim) takes control of the
  // already-open page. Wait for that before asserting offline behavior.
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, {
    timeout: 30_000,
  });

  // On the very first visit the SW installs and (via clientsClaim) takes control
  // of the already-open page — but the heavy globIgnored chunks (notably the
  // ~13 MB MapLibre chunk) were fetched *before* the SW was controlling, so they
  // bypassed the CacheFirst runtime rule and were never stored. Reload once while
  // still online so the now-controlling SW serves the navigation and routes every
  // boot asset through CacheFirst, populating the runtime cache the offline boot
  // depends on. (Without this, waitForLoadedAssetsCached below never sees those
  // chunks reach Cache Storage.)
  await page.reload();

  // The active SW should retain control immediately on the reloaded page, but
  // assert it before relying on CacheFirst to store the boot assets.
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, {
    timeout: 30_000,
  });

  // Warm boot under SW control: the map fetches the (non-precached) MapLibre
  // chunk through the SW, which CacheFirst then stores for offline use.
  await expect(page.getByTestId("map-canvas")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".maplibregl-canvas")).toBeVisible({
    timeout: 30_000,
  });

  // The service worker writes its CacheFirst runtime caches asynchronously,
  // *after* the page's fetch for a chunk resolves — so the map canvas can be
  // visible (the ~13 MB MapLibre chunk ran in-page) while the SW is still
  // persisting that chunk. Going offline in that window leaves the chunk
  // uncached, so the offline reload can't import it and never renders the map.
  // Wait for all requests to finish, then for every same-origin build asset the
  // boot pulled in to be durably present in Cache Storage.
  await page.waitForLoadState("networkidle", { timeout: 60_000 });
  await waitForLoadedAssetsCached(page);

  // Drop the network and reload: the precached shell plus the runtime-cached
  // MapLibre chunk must still bring the app up with no connectivity.
  await context.setOffline(true);
  try {
    await page.reload();
    // The offline cold boot re-parses/executes the ~13 MB MapLibre chunk from
    // cache under software WebGL on CI, so give it a generous budget.
    await expect(page.getByTestId("map-canvas")).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.locator(".maplibregl-canvas")).toBeVisible({
      timeout: 60_000,
    });
  } finally {
    await context.setOffline(false);
  }
});

/**
 * Wait until every same-origin build asset the first load pulled in is durably
 * present in Cache Storage, so going offline can't strip a chunk the cold boot
 * needs. Each `/assets/` file is cached either by the revision-keyed precache
 * (durable at SW install) or by the CacheFirst runtime rule (written
 * asynchronously *after* the page's fetch resolves — see vite.config.ts). The
 * runtime write is the race: "canvas visible" can happen while the SW is still
 * persisting a chunk. Polling every loaded asset (not just the >4 MB ones, which
 * misses the smaller globIgnored feature chunks) gives a deterministic
 * "ready to go offline" signal. `ignoreSearch` lets the plain resource URL match
 * a revision-keyed precache entry (`…?__WB_REVISION__=…`) as well as the
 * plain-URL runtime entry.
 *
 * NOTE: this must NOT use `page.waitForFunction` with an async predicate.
 * waitForFunction does not await a promise the predicate returns — a returned
 * promise is truthy, so the poll "passes" on the very first tick without ever
 * checking the caches. (That silent vacuous pass is exactly why this gate let
 * the test go offline before the ~13 MB MapLibre chunk's CacheFirst write had
 * finished, intermittently failing the offline boot.) `page.evaluate` *does*
 * await the async function and return its resolved value, so we drive the poll
 * from Node with `expect.poll`.
 */
async function waitForLoadedAssetsCached(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const origin = location.origin;
          const urls = performance
            .getEntriesByType("resource")
            .map((entry) => (entry as PerformanceResourceTiming).name)
            .filter(
              (name) =>
                name.startsWith(origin) &&
                name.includes("/assets/") &&
                (name.endsWith(".js") || name.endsWith(".css")),
            );
          // The shell's JS/CSS must have loaded for the warm boot above; if
          // nothing is visible yet, keep polling rather than passing vacuously.
          if (urls.length === 0) return false;
          for (const url of urls) {
            // ignoreVary: the heavy chunks are fetched via crossorigin
            // modulepreload, so their cached responses carry a Vary header; a
            // plain-URL match would false-negative without it. ignoreSearch lets
            // the plain URL match a revision-keyed precache entry too.
            if (
              !(await caches.match(url, {
                ignoreSearch: true,
                ignoreVary: true,
              }))
            ) {
              return false;
            }
          }
          return true;
        }),
      { timeout: 60_000, intervals: [0, 500] },
    )
    .toBe(true);
}
