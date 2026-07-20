import { expect, test } from "@playwright/test";

test("the explicit MapLibre primary engine keeps the stable map host", async ({ page }) => {
  await page.goto("/?engine=maplibre");
  await expect(page.getByTestId("map-canvas")).toBeVisible();
});

test("an unknown primary engine safely falls back to MapLibre", async ({ page }) => {
  await page.goto("/?engine=unknown");
  await expect(page.getByTestId("map-canvas")).toBeVisible();
});
