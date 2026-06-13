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
  // uncached, so the offline reload can't boot the map. Wait for all first-load
  // requests to finish, then for the Cache Storage entry count to stop growing,
  // so every runtime-cached chunk is durably stored before we drop the network.
  await page.waitForLoadState("networkidle");
  await waitForCacheStorageToSettle(page);

  // Drop the network and reload: the precached shell plus the runtime-cached
  // MapLibre chunk must still bring the app up with no connectivity.
  await context.setOffline(true);
  try {
    await page.reload();
    // The offline cold boot re-parses/executes every chunk from cache, so give
    // the canvas the same 30s budget the warm boot above gets.
    await expect(page.getByTestId("map-canvas")).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.locator(".maplibregl-canvas")).toBeVisible({
      timeout: 30_000,
    });
  } finally {
    await context.setOffline(false);
  }
});

/**
 * Wait until the service worker's Cache Storage stops growing, i.e. it has
 * finished persisting the runtime-cached chunks the first load pulled in.
 * CacheFirst writes happen asynchronously after the page's fetch resolves, so
 * "canvas visible" alone does not guarantee the chunk is cached; polling the
 * total entry count until two consecutive reads match (and it is non-zero)
 * gives a deterministic "caches settled" signal before we go offline.
 */
async function waitForCacheStorageToSettle(page: Page): Promise<void> {
  await page.waitForFunction(
    async () => {
      const w = window as unknown as { __prevCacheEntryCount?: number };
      const names = await caches.keys();
      let count = 0;
      for (const name of names) {
        count += (await (await caches.open(name)).keys()).length;
      }
      const previous = w.__prevCacheEntryCount ?? -1;
      w.__prevCacheEntryCount = count;
      return count > 0 && count === previous;
    },
    undefined,
    { timeout: 30_000, polling: 1000 },
  );
}
