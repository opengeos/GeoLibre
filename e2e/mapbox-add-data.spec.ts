import { expect, test, type Page } from "@playwright/test";
import { layerRow } from "./helpers";
import { DESKTOP_SETTINGS_STORAGE_KEY } from "../apps/geolibre-desktop/src/lib/storage-keys";

// Opt-in: these integration tests use real Mapbox services and public datasets.
// MAPBOX_TOKEN is supplied at runtime, never saved in a fixture or project.
test.skip(!process.env.MAPBOX_TOKEN, "Set MAPBOX_TOKEN to test the Mapbox renderer");
test.use({ actionTimeout: 30_000 });

async function openSource(page: Page, name: string) {
  await page.getByRole("button", { name: "Add Data", exact: true }).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}

for (const theme of ["light", "dark"] as const) {
  test(`Mapbox Add Data imports and service panels (${theme})`, async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(180_000);
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
    await page.goto("/");
    if (theme === "dark") {
      await page.getByRole("button", { name: "Switch to Dark Mode" }).click();
    }
    await page.getByRole("button", { name: "View", exact: true }).click();
    await page.getByRole("menuitem", { name: "Rendering engine", exact: true }).hover();
    await page.getByRole("menuitemradio", { name: "Mapbox", exact: true }).click();
    await expect(page.locator(".mapboxgl-canvas")).toBeVisible();

    await page.getByRole("button", { name: "Add Data", exact: true }).click();
    for (const name of ["MBTiles Layer", "Gaussian Splatting"]) {
      await expect(page.getByRole("menuitem", { name, exact: true })).toBeDisabled();
    }
    // Drawn through deck.gl overlays or a Mapbox-capable custom layer (see
    // mapbox-deck-overlays.spec.ts and mapbox-zarr.spec.ts for the checks).
    for (const name of ["DuckDB Layer", "Deck.gl Layer", "3D Model (glTF)", "Zarr Layer"]) {
      await expect(page.getByRole("menuitem", { name, exact: true })).toBeEnabled();
    }
    await page.keyboard.press("Escape");

    // This used to open a different importer that produced a No Mapbox layer.
    await openSource(page, "FlatGeobuf Layer");
    const countries = await request.get("https://flatgeobuf.org/test/data/countries.fgb");
    expect(countries.ok()).toBeTruthy();
    await page.locator('input[type="file"]').setInputFiles({
      name: "countries.fgb",
      mimeType: "application/octet-stream",
      buffer: await countries.body(),
    });
    await expect(page.getByText(/flatgeobuf · 179 ft/)).toBeVisible({
      timeout: 60_000,
    });
    await expect(layerRow(page, "countries")).toBeVisible();
    await expect(layerRow(page, "countries")).not.toContainText("No Mapbox");
    await page.getByRole("button", { name: "Close panel", exact: true }).click();

    // The saved service style, including its classified colors, must reach Mapbox.
    await openSource(page, "ArcGIS Layer");
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("combobox", { name: "Sample data", exact: true }).selectOption("1");
    await dialog.getByRole("button", { name: "Add layer", exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    await expect(layerRow(page, "ArcGIS Layer")).toBeVisible();
    await expect(layerRow(page, "ArcGIS Layer")).not.toContainText("No Mapbox");

    // Previously the menu silently refused to activate the STAC plugin.
    await openSource(page, "STAC Layer");
    await page
      .getByRole("textbox", { name: "STAC catalog or API URL", exact: true })
      .fill("https://earth-search.aws.element84.com/v1");
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByRole("listbox").selectOption("sentinel-2-l2a");
    await page
      .getByRole("textbox", { name: "Bounding box (west, south, east, north)" })
      .fill("-118.52,33.99,-118.44,34.06");
    await page.getByRole("button", { name: "Search items", exact: true }).click();
    await expect(layerRow(page, "STAC search footprints")).toBeVisible({
      timeout: 30_000,
    });
    await expect(layerRow(page, "STAC search footprints")).not.toContainText("No Mapbox");
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath(`mapbox-add-data-${theme}.png`),
    });
  });
}
