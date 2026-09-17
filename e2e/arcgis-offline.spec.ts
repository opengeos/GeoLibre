import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { createEmptyProject, DEFAULT_LAYER_STYLE } from "@geolibre/core";
import { readFixture } from "./helpers";

// Real CDN checks are opt-in; no Esri service or API key is needed.
test.skip(process.env.ARCGIS_E2E !== "1", "Set ARCGIS_E2E=1 to test CDN/CSP/offline boot");
test.setTimeout(240_000);

const project = createEmptyProject();
project.primaryRenderer = "arcgis";
project.mapProjection = "mercator";
project.basemapStyleUrl = "";
project.preferences.map.arcgisBasemap = undefined;
project.preferences.map.terrainEnabled = false;
project.layers = [
  {
    id: "offline-geojson",
    name: "Offline GeoJSON",
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: DEFAULT_LAYER_STYLE,
    metadata: {},
    geojson: JSON.parse(readFixture("smoke.geojson")),
  },
];

async function openProject(page: Page, waitUntilReady = true) {
  await page.getByTestId("desktop-shell").waitFor();
  await expect(page.getByRole("button", { name: "Add Data", exact: true })).toBeEnabled({
    timeout: 60_000,
  });
  await page.evaluate((text) => {
    window.__GEOLIBRE_RUNTIME_ENV__ = {
      ...window.__GEOLIBRE_RUNTIME_ENV__,
      ARCGIS_API_KEY: "",
      VITE_ARCGIS_API_KEY: "",
    };
    window.dispatchEvent(new CustomEvent("geolibre:runtime-env-change"));
    const dt = new DataTransfer();
    dt.items.add(new File([text], "offline.geolibre.json", { type: "application/json" }));
    const target = document.querySelector('[data-testid="desktop-shell"]')!;
    for (const type of ["dragenter", "dragover", "drop"])
      target.dispatchEvent(
        new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }),
      );
  }, JSON.stringify(project));
  const discard = page.getByRole("button", { name: "Do not save", exact: true });
  if (await discard.isVisible()) await discard.click();
  if (!waitUntilReady) return;
  await expect(page.getByTestId("arcgis-canvas")).toHaveAttribute("aria-busy", "false", {
    timeout: 90_000,
  });
  await expect(page.locator('[data-layer-name="Offline GeoJSON"]')).toBeVisible();
  await expect(page.getByTestId("arcgis-canvas").getByRole("alert")).toHaveCount(0);
}

test.describe("desktop content security policy", () => {
  test.use({ serviceWorkers: "block" });
  test("boots the keyless SDK under the production Tauri CSP", async ({ page, baseURL }) => {
    const config = JSON.parse(
      readFileSync(join(__dirname, "../apps/geolibre-desktop/src-tauri/tauri.conf.json"), "utf8"),
    );
    const csp = config.app.security.csp;
    await page.route(new URL("/", baseURL).href, async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        headers: { ...response.headers(), "content-security-policy": csp },
      });
    });
    await page.addInitScript(() => {
      Object.assign(window, { arcgisCspViolations: [] });
      document.addEventListener("securitypolicyviolation", (event) => {
        if (event.blockedURI.includes("arcgis.com"))
          (window as unknown as { arcgisCspViolations: string[] }).arcgisCspViolations.push(
            event.effectiveDirective,
          );
      });
    });
    await page.goto("/");
    await openProject(page);
    expect(
      await page.evaluate(
        () => (window as unknown as { arcgisCspViolations: string[] }).arcgisCspViolations,
      ),
    ).toEqual([]);
  });
});

test("boots cached SDK modules and inline data after going offline", async ({ page, context }) => {
  await page.addInitScript(() => performance.setResourceTimingBufferSize(5000));
  await page.goto("/");
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, undefined, {
    timeout: 60_000,
  });
  await page.reload();
  await openProject(page);
  await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          const cache = await caches.open("geolibre-arcgis-sdk");
          const keys = await cache.keys();
          return keys.length;
        }),
      { timeout: 60_000 },
    )
    .toBeGreaterThan(200);
  // Wait for every SDK module this view requested, not just a cache entry count.
  await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          const urls = performance
            .getEntriesByType("resource")
            .map((e) => e.name)
            .filter((url) => url.startsWith("https://js.arcgis.com/"));
          return (
            await Promise.all(urls.map(async (url) => Boolean(await caches.match(url))))
          ).every(Boolean);
        }),
      { timeout: 60_000 },
    )
    .toBe(true);
  await context.setOffline(true);
  try {
    page.once("dialog", (dialog) => dialog.accept());
    await page.reload();
    await openProject(page);
    expect(await page.evaluate(() => navigator.onLine)).toBe(false);
  } finally {
    await context.setOffline(false);
  }
});

test.describe("unavailable CDN", () => {
  test.use({ serviceWorkers: "block" });
  test("reports a cold first-use network failure", async ({ page }) => {
    await page.route("https://js.arcgis.com/**", (route) => route.abort("internetdisconnected"));
    await page.goto("/");
    await openProject(page, false);
    await expect(page.getByTestId("arcgis-canvas").getByRole("alert")).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole("button", { name: "View", exact: true })).toBeEnabled();
  });
});
