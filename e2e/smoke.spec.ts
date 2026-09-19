import { expect, test } from "@playwright/test";
import { dropGeoJson, layerRow, readFixture, waitForMap } from "./helpers";

const FIXTURE_TEXT = readFixture("smoke.geojson");
// Derived from the fixture so the expected row count can't drift if a feature
// is added or removed.
const FIXTURE_FEATURE_COUNT = (JSON.parse(FIXTURE_TEXT) as { features: unknown[] }).features.length;

test("loads a GeoJSON layer, opens the attribute table, and toggles visibility", async ({
  page,
}) => {
  await waitForMap(page);

  // 1. Add a layer via drag-and-drop and confirm it appears in the layer panel.
  await dropGeoJson(page, "smoke", FIXTURE_TEXT);
  const row = layerRow(page, "smoke");
  await expect(row).toBeVisible();

  // 2. Toggle layer visibility and confirm the control reflects the new state.
  // Done before the actions menu below so no Radix dropdown overlay (which
  // briefly sets pointer-events:none on the body) can intercept the click.
  await row.locator('button[aria-label="Hide layer"]').click();
  await expect(row.locator('button[aria-label="Show layer"]')).toBeVisible();

  // 3. Open the attribute table from the layer actions menu and assert rows.
  // Opening it while the layer is hidden (from step 2) is intentional and fine:
  // the table reads features from the store, not from the rendered map.
  await row.locator('button[aria-label="Layer actions"]').click();
  await page.getByRole("menuitem", { name: "Open attribute table" }).click();
  await expect(page.getByTestId("attribute-table")).toBeVisible();
  await expect(page.locator('[data-testid="attribute-table"] tbody tr')).toHaveCount(
    FIXTURE_FEATURE_COUNT,
  );
});

test("Identify owns the MapLibre cursor across the whole interactive surface", async ({ page }) => {
  await waitForMap(page);
  await dropGeoJson(page, "smoke", FIXTURE_TEXT);
  const row = layerRow(page, "smoke");
  await expect(row).toBeVisible();

  const canvas = page.locator(".maplibregl-canvas");
  const canvasContainer = page.locator(".maplibregl-canvas-container");
  await row.getByRole("button", { name: "Identify features", exact: true }).click();
  await expect(canvas).toHaveCSS("cursor", "crosshair");
  await expect(canvasContainer).toHaveCSS("cursor", "crosshair");

  await row.locator('button[aria-label="Layer actions"]').click();
  await page.getByRole("menuitem", { name: "Select features", exact: true }).hover();
  await page.getByRole("menuitem", { name: "Select features by rectangle", exact: true }).click();
  await expect(row.getByRole("button", { name: "Identify features", exact: true })).toBeVisible();
  await expect(canvas).toHaveCSS("cursor", "crosshair");

  await page.keyboard.press("Escape");
  await expect(canvas).not.toHaveCSS("cursor", "crosshair");
  await expect(canvasContainer).toHaveCSS("cursor", "grab");
});

test("keeps every toolbar menu available on small screens", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 720 });
  await waitForMap(page);

  for (const menu of [
    "Project",
    "Edit",
    "View",
    "Add Data",
    "Processing",
    "Controls",
    "Plugins",
    "Help",
  ]) {
    const trigger = page.getByRole("button", { name: menu, exact: true });
    await expect(trigger).toBeVisible();
    await expect(trigger).toBeInViewport();
  }

  await page.getByRole("button", { name: "View", exact: true }).click();
  const renderingEngine = page.getByRole("menuitem", { name: "Rendering engine" });
  await expect(renderingEngine).toBeVisible();
  await expect(renderingEngine).toBeInViewport();
});

// The accessibility gate now lives in its own multi-screen suite (a11y.spec.ts,
// added with the #272 accessibility pass).
