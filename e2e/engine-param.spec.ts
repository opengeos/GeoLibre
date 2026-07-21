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

test("the ArcGIS SceneView opt-in mounts in a secondary globe pane", async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on("pageerror", (error) => pageErrors.push(error));

  await page.goto("/?sceneEngine=arcgis");
  await page.getByRole("button", { name: "View" }).click();
  await page.getByText("Split View", { exact: true }).hover();
  await page.getByText("Two columns", { exact: true }).click();
  const globeToggle = page.getByRole("button", { name: "Show map 2 as a 3D globe" });
  await expect(globeToggle).toBeVisible();
  await globeToggle.click();

  const scene = page.getByTestId("arcgis-scene-canvas");
  await expect(scene).toBeVisible();
  await expect(scene).toHaveAttribute("data-engine-id", "arcgis-scene");
  await expect(scene).toHaveAttribute("data-engine-ready", "true", { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Diagnostics: 0" })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("an unknown primary engine safely falls back to MapLibre", async ({ page }) => {
  await page.goto("/?engine=unknown");
  await expect(page.getByTestId("map-canvas")).toBeVisible();
});
