import { expect, test } from "@playwright/test";

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

  // Drop the network and reload: the precached shell plus the runtime-cached
  // MapLibre chunk must still bring the app up with no connectivity.
  await context.setOffline(true);
  try {
    await page.reload();
    await expect(page.getByTestId("map-canvas")).toBeVisible();
    await expect(page.locator(".maplibregl-canvas")).toBeVisible({
      timeout: 30_000,
    });
  } finally {
    await context.setOffline(false);
  }
});
