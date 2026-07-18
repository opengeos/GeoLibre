import { expect, test, type Page } from "@playwright/test";

/**
 * Exercises the glTF 3D model layer (#306): the "3D Model (glTF)" Add Data
 * entry, single-location placement, and the resulting deck.gl scenegraph store
 * layer. The store-layer assertion is hermetic — it does not depend on the
 * model URL actually loading (model loading happens asynchronously in a deck.gl
 * worker and is non-fatal if the network is unavailable), so this runs without
 * external network access.
 */

/** Waits for MapLibre to mount its WebGL canvas — the app's "map ready" signal. */
async function waitForMap(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("map-canvas")).toBeVisible();
  await expect(page.locator(".maplibregl-canvas")).toBeVisible({
    timeout: 30_000,
  });
}

test("adds a glTF 3D model layer placed at a single coordinate", async ({ page }) => {
  await waitForMap(page);

  // Open Add Data -> 3D Model (glTF).
  await page.getByRole("button", { name: "Add Data" }).click();
  await page.getByRole("menuitem", { name: "3D Model (glTF)" }).click();

  // The dialog opens pre-selected on the scenegraph layer type, pre-filled from
  // the bundled example: model URL plus a default single-location coordinate so
  // the user can place a model with one click.
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("glTF / GLB model URL")).not.toHaveValue("");
  await expect(dialog.getByLabel("Longitude")).not.toHaveValue("");
  await expect(dialog.getByLabel("Latitude")).not.toHaveValue("");

  await dialog.getByRole("button", { name: "Add layer" }).click();

  // The layer appears in the panel as a deck.gl (scenegraph) layer.
  const row = page.locator('[data-testid="layer-row"][data-layer-name="3D model (glTF)"]');
  await expect(row).toBeVisible();
  await expect(dialog).toBeHidden();
});

test("blocks single-location placement without a valid coordinate", async ({ page }) => {
  await waitForMap(page);

  await page.getByRole("button", { name: "Add Data" }).click();
  await page.getByRole("menuitem", { name: "3D Model (glTF)" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  // Clearing the pre-filled longitude and submitting surfaces a validation
  // error and keeps the dialog open (a blank field must not be read as the
  // coordinate 0).
  await dialog.getByLabel("Longitude").fill("");
  await dialog.getByRole("button", { name: "Add layer" }).click();
  await expect(dialog.getByText("Enter a valid longitude and latitude.")).toBeVisible();
  await expect(dialog).toBeVisible();
});
