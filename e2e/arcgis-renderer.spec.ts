import { expect, test } from "@playwright/test";
import { layerRow, readFixture } from "./helpers";
import { DESKTOP_SETTINGS_STORAGE_KEY } from "../apps/geolibre-desktop/src/lib/storage-keys";

// Opt-in: this drives the ArcGIS Maps SDK for JavaScript from Esri's real CDN
// and its basemap styles service. ARCGIS_API_KEY is supplied at runtime, never
// saved in a fixture or project.
test.skip(
  !process.env.ARCGIS_API_KEY && process.env.ARCGIS_E2E !== "1",
  "Set ARCGIS_E2E=1 (keyless) or ARCGIS_API_KEY to test the ArcGIS renderer",
);
test.use({ actionTimeout: 30_000 });

test("ArcGIS renderer draws the project basemap, a dropped GeoJSON layer and identifies a feature", async ({
  page,
}) => {
  test.skip(!process.env.ARCGIS_API_KEY, "Esri basemap styles require ARCGIS_API_KEY");
  test.setTimeout(180_000);
  await page.addInitScript(
    ({ key, apiKey }) => {
      const settings = JSON.parse(localStorage.getItem(key) || "{}");
      localStorage.setItem(
        key,
        JSON.stringify({
          ...settings,
          arcgisApiKey: apiKey,
          uiProfile: { onboarded: true, hiddenDataSources: [] },
        }),
      );
    },
    { key: DESKTOP_SETTINGS_STORAGE_KEY, apiKey: process.env.ARCGIS_API_KEY! },
  );
  await page.goto("/");
  await page.getByRole("button", { name: "View", exact: true }).click();
  await page.getByRole("menuitem", { name: "Rendering engine", exact: true }).hover();
  await page.getByRole("menuitemradio", { name: "ArcGIS", exact: true }).click();

  // The SDK view mounts with the Esri Streets basemap (the key is present) and
  // the built-in widgets the Controls menu governs; nothing ArcGIS-specific is
  // in the bundle, so every module arrives from js.arcgis.com.
  const view = page.locator("[data-testid=arcgis-canvas] .esri-view");
  await expect(view).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("arcgis-canvas")).toHaveAttribute("aria-busy", "false", {
    timeout: 60_000,
  });
  await expect(page.locator(".esri-attribution__sources")).toContainText("Esri", {
    timeout: 60_000,
  });
  await expect(page.locator(".esri-ui .esri-compass")).toBeVisible();
  // New projects use the globe projection, which the SDK draws as a 3D
  // SceneView. Its toggle switches to a flat MapView, the only view the SDK's
  // scale bar measures.
  const globe = page.locator(".geolibre-arcgis-globe button");
  await expect(globe).toHaveClass(/maplibregl-ctrl-globe-enabled/);
  await expect(page.locator(".esri-ui .esri-scale-bar")).toHaveCount(0);
  await globe.click();
  // A view swap keeps the outgoing canvas until its replacement draws.
  await expect(globe).toHaveCount(1, { timeout: 60_000 });
  await expect(page.locator(".geolibre-arcgis-globe button")).toHaveClass(
    /maplibregl-ctrl-globe$/,
    {
      timeout: 60_000,
    },
  );
  await expect(page.locator(".esri-ui .esri-scale-bar")).toBeVisible({ timeout: 60_000 });

  // Esri choices persist separately from the shared basemap, with exactly one
  // selected choice; choosing a shared style clears the native override.
  await page.getByRole("button", { name: "Change background", exact: true }).click();
  await expect(page.getByRole("button", { name: "ArcGIS Streets", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: "ArcGIS Imagery", exact: true }).click();
  await page.getByRole("button", { name: "Change background", exact: true }).click();
  await expect(page.getByRole("button", { name: "ArcGIS Imagery", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("dialog").locator('button[aria-pressed="true"]')).toHaveCount(1);
  await page.getByRole("button", { name: "Liberty", exact: true }).click();
  await page.getByRole("button", { name: "Change background", exact: true }).click();
  await expect(page.getByRole("button", { name: "Liberty", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("button", { name: "ArcGIS Imagery", exact: true })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await page.getByRole("button", { name: "ArcGIS Streets", exact: true }).click();

  // Sources without an SDK adapter are greyed out while ArcGIS is primary.
  await page.getByRole("button", { name: "Add Data", exact: true }).click();
  for (const name of ["Gaussian Splatting", "Cesium Ion Asset", "CZML Dynamic 3D Scene"]) {
    await expect(page.getByRole("menuitem", { name, exact: true })).toBeDisabled();
  }
  for (const name of [
    "Vector Layer",
    "Raster Layer",
    "PMTiles Layer",
    "Deck.gl Layer",
    "MBTiles Layer",
    "Zarr Layer",
    "NetCDF / HDF",
    "LiDAR Layer",
    "DuckDB Layer",
    "3D Tiles Layer",
  ]) {
    await expect(page.getByRole("menuitem", { name, exact: true })).toBeEnabled();
  }
  await expect(page.getByRole("menuitem", { name: "XYZ Layer", exact: true })).toBeEnabled();
  await page.keyboard.press("Escape");

  // Drop a GeoJSON file the way a user would; the host importer materializes
  // it as a store layer the engine compiles into GeoJSONLayers.
  const geojson = readFixture("smoke.geojson");
  await page.evaluate((text) => {
    const dt = new DataTransfer();
    dt.items.add(new File([text], "smoke.geojson", { type: "application/geo+json" }));
    const target = document.querySelector('[data-testid="desktop-shell"]');
    if (!target) throw new Error("desktop shell drop target not found");
    for (const type of ["dragenter", "dragover", "drop"])
      target.dispatchEvent(
        new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }),
      );
  }, geojson);
  await expect(layerRow(page, "smoke")).toBeVisible({ timeout: 30_000 });
  await expect(layerRow(page, "smoke")).not.toContainText("No ArcGIS");
  await page
    .getByTestId("arcgis-canvas")
    .getByRole("button", { name: "Expand", exact: true })
    .click();
  await page.getByRole("button", { name: "Hide smoke", exact: true }).click();
  await expect(
    layerRow(page, "smoke").getByRole("button", { name: "Show layer", exact: true }),
  ).toBeVisible();
  await layerRow(page, "smoke").getByRole("button", { name: "Show layer", exact: true }).click();
  await expect(page.getByRole("button", { name: "Hide smoke", exact: true })).toBeVisible();
  await expect(page.locator("[data-testid=arcgis-canvas] [role=alert]")).toHaveCount(0);
});

for (const keyed of [false, true]) {
  test(`ArcGIS place search navigates to coordinates and H3 cells ${keyed ? "with" : "without"} an API key`, async ({
    page,
  }) => {
    test.skip(keyed && !process.env.ARCGIS_API_KEY, "Set ARCGIS_API_KEY for keyed search");
    test.setTimeout(180_000);
    await page.addInitScript(
      ({ key, apiKey }) => {
        const settings = JSON.parse(localStorage.getItem(key) || "{}");
        localStorage.setItem(
          key,
          JSON.stringify({
            ...settings,
            arcgisApiKey: apiKey,
            uiProfile: { onboarded: true, hiddenDataSources: [] },
          }),
        );
      },
      { key: DESKTOP_SETTINGS_STORAGE_KEY, apiKey: keyed ? process.env.ARCGIS_API_KEY! : "" },
    );
    await page.goto("/");
    // An empty device setting falls back to build-time credentials. Override
    // both runtime names so this also exercises the keyless path on keyed builds.
    await page.getByRole("button", { name: "View", exact: true }).waitFor();
    if (!keyed)
      await page.evaluate(() => {
        window.__GEOLIBRE_RUNTIME_ENV__ = {
          ...window.__GEOLIBRE_RUNTIME_ENV__,
          VITE_ARCGIS_API_KEY: "",
          ARCGIS_API_KEY: "",
        };
        window.dispatchEvent(new CustomEvent("geolibre:runtime-env-change"));
      });
    await page.getByRole("button", { name: "View", exact: true }).click();
    await page.getByRole("menuitem", { name: "Rendering engine", exact: true }).hover();
    await page.getByRole("menuitemradio", { name: "ArcGIS", exact: true }).click();
    await expect(page.locator("[data-testid=arcgis-canvas] .esri-view")).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByTestId("arcgis-canvas")).toHaveAttribute("aria-busy", "false", {
      timeout: 60_000,
    });
    if (!keyed)
      await expect(page.getByText("Add an ArcGIS API key in", { exact: false })).toBeVisible();
    const search = page.getByRole("combobox", { name: "Search places", exact: true });
    await search.fill("38.8977, -77.0365");
    await page.getByRole("option").first().click();
    await expect(page.getByText("Zoom: 12.00", { exact: true })).toBeVisible({ timeout: 30_000 });
    const bounds = page.getByText(/^BBox:/);
    await expect
      .poll(async () => {
        const values = (await bounds.innerText()).replace("BBox:", "").split(",").map(Number);
        return Math.hypot(
          (values[0] + values[2]) / 2 + 77.0365,
          (values[1] + values[3]) / 2 - 38.8977,
        );
      })
      .toBeLessThan(0.02);
    await search.fill("8928308280fffff");
    await page.getByRole("option").first().click();
    await expect
      .poll(
        async () => {
          const values = (await bounds.innerText()).replace("BBox:", "").split(",").map(Number);
          return Math.hypot(
            (values[0] + values[2]) / 2 + 122.418,
            (values[1] + values[3]) / 2 - 37.7767,
          );
        },
        { timeout: 30_000 },
      )
      .toBeLessThan(0.02);
    await search.press("Escape");
    await expect(search).toHaveValue("");
    await expect(page.locator("[data-testid=arcgis-canvas] [role=alert]")).toHaveCount(0);
  });
}
