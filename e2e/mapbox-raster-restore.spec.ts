import { expect, test } from "@playwright/test";
import { DESKTOP_SETTINGS_STORAGE_KEY } from "../apps/geolibre-desktop/src/lib/storage-keys";

const COG_URL = "https://data.source.coop/giswqs/opengeos/dem.tif";
const LAYER_NAME = "dem.tif";

// Opt-in: these integration tests use real Mapbox services and a public COG.
// MAPBOX_TOKEN is supplied at runtime, never saved in a fixture or project.
test.skip(!process.env.MAPBOX_TOKEN, "Set MAPBOX_TOKEN to test the Mapbox renderer");
test.use({ actionTimeout: 30_000 });

for (const theme of ["light", "dark"] as const) {
  test(`restores a raster after switching to Mapbox (${theme})`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.addInitScript(
      ({ key, token }) => {
        const settings = JSON.parse(localStorage.getItem(key) || "{}");
        localStorage.setItem(
          key,
          JSON.stringify({
            ...settings,
            mapboxAccessToken: token,
            uiProfile: { onboarded: true, hiddenDataSources: [] },
          }),
        );
      },
      { key: DESKTOP_SETTINGS_STORAGE_KEY, token: process.env.MAPBOX_TOKEN! },
    );
    await page.goto("/?loading=1");
    await expect(page.locator(".maplibregl-canvas")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("html")).toHaveAttribute("data-geolibre-load-state", "ready", {
      timeout: 30_000,
    });
    if (theme === "dark") {
      await page.getByRole("button", { name: "Switch to Dark Mode" }).click();
    }

    await page.getByRole("button", { name: "Add Data", exact: true }).click();
    await page.getByRole("menuitem", { name: "Raster Layer", exact: true }).click();
    const panel = page.locator(".geolibre-raster-panel");
    await panel.getByRole("textbox", { name: "raster-url", exact: true }).fill(COG_URL);
    await panel.getByRole("button", { name: "load-url", exact: true }).click();
    await expect(panel.locator(".mlr-layer-name")).toHaveText(LAYER_NAME, {
      timeout: 60_000,
    });
    await panel.getByRole("button", { name: "Close panel", exact: true }).click();

    await page.getByRole("button", { name: "View", exact: true }).click();
    await page.getByRole("menuitem", { name: "Rendering engine", exact: true }).hover();
    await page.getByRole("menuitemradio", { name: "Mapbox", exact: true }).click();
    await expect(page.locator(".mapboxgl-canvas")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("html")).toHaveAttribute("data-geolibre-load-state", "loading");
    await expect(page.locator("html")).toHaveAttribute("data-geolibre-load-state", "ready", {
      timeout: 60_000,
    });

    await expect(
      page
        .locator(".mapboxgl-map .geolibre-raster-panel .mlr-layer-name")
        .filter({ hasText: LAYER_NAME }),
    ).toHaveCount(1);
  });
}
