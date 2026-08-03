import { expect, test, type Page } from "@playwright/test";
import { dropGeoJson, layerRow, readFixture, waitForMap } from "./helpers";

/**
 * Regression cover for GeoLibre#1664: the drag-and-drop overlay could outlive
 * its drag and sit over the map forever.
 *
 * The overlay is one boolean fed from two places — the webview drag handlers
 * (balanced by a depth counter) and, on desktop, Tauri's native drag events (no
 * counter). Either feed can strand it: a native "leave" the OS never delivers,
 * or an unbalanced webview enter/leave pair that leaves the counter above zero.
 * These tests strand it the second way, which is the one a browser can drive,
 * and assert the recovery paths that clear it either way.
 */

const OVERLAY = '[data-testid="file-drop-overlay"]';

/** Fires one file-drag event at the shell, without completing a drop. */
async function fireFileDrag(page: Page, type: "dragenter" | "dragleave"): Promise<void> {
  const dataTransfer = await page.evaluateHandle(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["{}"], "style.json", { type: "application/json" }));
    return dt;
  });
  await page.dispatchEvent('[data-testid="map-canvas"]', type, { dataTransfer });
  await dataTransfer.dispose();
}

/**
 * Leaves the overlay showing with no drag in progress, by sending one more
 * `dragenter` than `dragleave` — the shape a swallowed leave event produces.
 */
async function strandOverlay(page: Page): Promise<void> {
  await fireFileDrag(page, "dragenter");
  await fireFileDrag(page, "dragenter");
  await fireFileDrag(page, "dragleave");
  await expect(page.locator(OVERLAY)).toBeVisible();
}

test("Escape dismisses a drop overlay that outlived its drag", async ({ page }) => {
  await waitForMap(page);
  await strandOverlay(page);

  await page.keyboard.press("Escape");
  await expect(page.locator(OVERLAY)).toBeHidden();
});

test("a pointer press dismisses a drop overlay that outlived its drag", async ({ page }) => {
  await waitForMap(page);
  await strandOverlay(page);

  // A mouse button cannot go down during a real drag, so this is the signal
  // that heals the overlay without the user knowing to press anything.
  await page.mouse.click(400, 400);
  await expect(page.locator(OVERLAY)).toBeHidden();
});

test("a press on a control that stops propagation still dismisses the overlay", async ({
  page,
}) => {
  await waitForMap(page);
  await strandOverlay(page);

  // The panel resize handles call stopPropagation() on pointerdown, so a bubble
  // phase listener on window would never see this press. The recovery listens
  // in the capture phase precisely so it does.
  await page.locator('[aria-label="Resize Layers panel"]').first().click();
  await expect(page.locator(OVERLAY)).toBeHidden();
});

test("a balanced drag still shows and hides the overlay", async ({ page }) => {
  await waitForMap(page);

  await fireFileDrag(page, "dragenter");
  await expect(page.locator(OVERLAY)).toBeVisible();
  await fireFileDrag(page, "dragleave");
  await expect(page.locator(OVERLAY)).toBeHidden();
});

test("a real file drop still imports a layer and clears the overlay", async ({ page }) => {
  await waitForMap(page);

  // The recovery listeners are only mounted while the overlay is up, so guard
  // that they cannot swallow the drop that the overlay exists to invite.
  await dropGeoJson(page, "dropped", readFixture("smoke.geojson"));

  await expect(layerRow(page, "dropped")).toBeVisible();
  await expect(page.locator(OVERLAY)).toBeHidden();
});
