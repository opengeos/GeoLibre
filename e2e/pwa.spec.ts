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
  // uncached, so the offline reload can't import MapLibre and never renders the
  // map. Wait for all first-load requests to finish, then for every heavy
  // runtime-cached chunk the boot pulled in to be durably stored.
  await page.waitForLoadState("networkidle");
  await waitForHeavyAssetsCached(page);

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
 * Wait until every heavy runtime-cached asset the first load pulled in is
 * durably present in Cache Storage. Chunks larger than the precache size limit
 * (4 MB — the MapLibre bundle, DuckDB-WASM, etc.) are excluded from the precache
 * and CacheFirst-cached on first fetch; that write completes asynchronously
 * after the page's fetch resolves, so "canvas visible" alone does not guarantee
 * the chunk is on disk. Polling `caches.match()` for each heavy `/assets/` chunk
 * the page actually loaded gives a deterministic "ready to go offline" signal —
 * runtime CacheFirst entries are keyed by plain URL, so the match is reliable
 * (unlike revision-keyed precache entries, which are already durable at SW
 * install and need no wait).
 */
async function waitForHeavyAssetsCached(page: Page): Promise<void> {
  await page.waitForFunction(
    async () => {
      const origin = location.origin;
      const heavy = performance
        .getEntriesByType("resource")
        .filter((entry): entry is PerformanceResourceTiming => {
          const resource = entry as PerformanceResourceTiming;
          return (
            resource.name.startsWith(origin) &&
            resource.name.includes("/assets/") &&
            resource.name.endsWith(".js") &&
            // > 4 MB: globIgnored from the precache, so CacheFirst-cached at
            // runtime (matches maximumFileSizeToCacheInBytes in vite.config.ts).
            resource.decodedBodySize > 4 * 1024 * 1024
          );
        })
        .map((resource) => resource.name);
      // The MapLibre chunk must have loaded for the warm map boot above; if no
      // heavy chunk is visible yet, keep polling rather than passing vacuously.
      if (heavy.length === 0) return false;
      for (const url of heavy) {
        if (!(await caches.match(url))) return false;
      }
      return true;
    },
    undefined,
    { timeout: 60_000, polling: 500 },
  );
}
