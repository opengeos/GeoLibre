import { expect, test } from "@playwright/test";

test("the explicit MapLibre primary engine keeps the stable map host", async ({ page }) => {
  await page.goto("/?engine=maplibre");
  await expect(page.getByTestId("map-canvas")).toBeVisible();
});

test("the ArcGIS opt-in mounts a ready MapView through the app-owned host", async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on("pageerror", (error) => pageErrors.push(error));

  await page.goto("/?engine=arcgis");
  const map = page.getByTestId("map-canvas");
  await expect(map).toBeVisible();
  await expect(map).toHaveAttribute("data-engine-id", "arcgis");
  await expect(map).toHaveAttribute("data-engine-ready", "true");
  await expect(page.getByRole("button", { name: "Diagnostics: 0" })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("an unknown primary engine safely falls back to MapLibre", async ({ page }) => {
  await page.goto("/?engine=unknown");
  await expect(page.getByTestId("map-canvas")).toBeVisible();
});
