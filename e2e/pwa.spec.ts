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

  const manifestHref = await page
    .locator('link[rel="manifest"]')
    .getAttribute("href");
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
  // This test chains several long, sequential waits whose ceilings already sum
  // past the 60s default per-test timeout (playwright.config.ts): the SW taking
  // control (30s), the warm map boot, caching every loaded asset (60s), and the
  // offline cold boot that re-parses/executes the ~13 MB MapLibre chunk from
  // cache under software WebGL (60s). None of these is a fixed cost — each
  // returns as soon as its condition is met — but on a slow CI runner the
  // cumulative time tips past 60s and the whole test times out before the
  // offline assertion (with its own generous budget) can finish. Give the test
  // headroom larger than the sum of its steps so the per-assertion budgets,
  // rather than the test-level cap, govern. See issue #274.
  test.setTimeout(300_000);

  await page.goto("/");

  // The service worker activates and (via clientsClaim) takes control of the
  // already-open page. Wait for that before asserting offline behavior.
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, {
    timeout: 30_000,
  });

  // Warm the runtime caches: the map boot fetches the (non-precached) MapLibre
  // chunk, which CacheFirst then stores for offline use.
  await expect(page.getByTestId("map-canvas")).toBeVisible();
  await expect(page.locator(".maplibregl-canvas")).toBeVisible({
    timeout: 30_000,
  });

  // The service worker writes its CacheFirst runtime caches asynchronously,
  // *after* the page's fetch for a chunk resolves — so the map canvas can be
  // visible (the ~13 MB MapLibre chunk ran in-page) while the SW is still
  // persisting that chunk. Going offline in that window leaves the chunk
  // uncached, so the offline reload can't import it and never renders the map.
  // Wait for all first-load requests to finish, then for every same-origin
  // build asset the boot pulled in to be durably present in Cache Storage.
  await page.waitForLoadState("networkidle");
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
 */
async function waitForLoadedAssetsCached(page: Page): Promise<void> {
  await page.waitForFunction(
    async () => {
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
      // The shell's JS/CSS must have loaded for the warm boot above; if nothing
      // is visible yet, keep polling rather than passing vacuously.
      if (urls.length === 0) return false;
      for (const url of urls) {
        if (!(await caches.match(url, { ignoreSearch: true }))) return false;
      }
      return true;
    },
    undefined,
    { timeout: 60_000, polling: 500 },
  );
}
