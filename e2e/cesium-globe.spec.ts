import { expect, test, type Page } from "@playwright/test";
import { waitForMap } from "./helpers";

/**
 * Smoke test for the CesiumJS 3D globe pane.
 *
 * The globe had no e2e coverage at all: a regression in the camera conversion
 * or the layer/basemap sync only showed up in unit tests driving a *fake*
 * Cesium, which by construction cannot catch anything about the real engine —
 * that the chunk loads, that `CESIUM_BASE_URL` resolves its Workers/Assets in a
 * production build, or that the camera actually moves. Two behavioural changes
 * shipped on the globe (#2205, #2207) verified only by hand in a browser.
 *
 * This runs **keyless on purpose**. Until #2205 the pane was hidden without a
 * Cesium Ion token, so it could not mount in CI without a secret; the toggle is
 * now always offered and the globe draws the project basemap. That makes the
 * test itself the guard on that behaviour: if the token gating ever comes back,
 * this fails at `globeToggle` rather than silently skipping.
 *
 * It deliberately asserts nothing about tiles. Imagery comes from third-party
 * hosts, so a CI runner with no egress must still pass — the globe mounts and
 * its camera works whether or not a single tile arrives.
 */

/** The status bar's bbox readout, which reflects the shared store camera. */
function bboxReadout(page: Page) {
  return page.getByText(/^BBox:/);
}

/** Split the workspace into two panes via View → Split View → Two columns. */
async function splitIntoTwoPanes(page: Page): Promise<void> {
  await page.getByRole("button", { name: "View", exact: true }).click();
  await page.getByRole("menuitem", { name: "Split View" }).click();
  await page.getByRole("menuitemradio", { name: "Two columns" }).click();
  await expect(page.getByTestId("map-grid")).toBeVisible();
}

test.describe("Cesium 3D globe pane", () => {
  test("mounts keyless and drives the shared camera", async ({ page }) => {
    await waitForMap(page);
    await splitIntoTwoPanes(page);

    // The toggle is offered with or without an Ion token (#2180). Its presence
    // here, in a CI run with no secret configured, is the keyless guarantee.
    const globeToggle = page.getByRole("button", { name: "Show map 2 as a 3D globe" });
    await expect(globeToggle).toBeVisible();
    await globeToggle.click();

    // The engine is a ~4.9 MB lazily imported chunk that then loads its Workers
    // and Assets from CESIUM_BASE_URL, so allow well past the default timeout
    // on a cold, software-rendered runner.
    const globe = page.getByTestId("cesium-canvas");
    await expect(globe).toBeVisible({ timeout: 60_000 });
    await expect(globe.locator("canvas")).toBeVisible({ timeout: 60_000 });

    // CesiumCanvas renders the failure message in place of the globe, so an
    // empty error region is what distinguishes "mounted" from "threw".
    await expect(globe.getByText(/CESIUM_BASE_URL|Cannot read|undefined|failed/i)).toHaveCount(0);

    // Toggling back and forth must leave a working 2D pane behind — the pane
    // swaps the whole canvas component, so a torn-down globe that left Cesium
    // state behind would show up here.
    await expect(page.getByRole("button", { name: "Show map 2 as a 2D map" })).toBeVisible();

    // Dragging the globe writes back into the shared `mapView`, which moves the
    // primary MapLibre pane. Reading the status bar proves the whole round trip:
    // Cesium camera -> readMapViewFromCamera -> store -> the 2D map.
    const before = await bboxReadout(page).textContent();
    expect(before).toBeTruthy();

    const box = await globe.locator("canvas").boundingBox();
    expect(box).not.toBeNull();
    const cx = box!.x + box!.width / 2;
    const cy = box!.y + box!.height / 2;

    await page.mouse.move(cx, cy);
    await page.mouse.down();
    // Several steps: Cesium's camera controller integrates pointer motion, so a
    // single jump can be swallowed as a click.
    await page.mouse.move(cx - 90, cy - 60, { steps: 12 });
    await page.mouse.up();

    await expect
      .poll(async () => bboxReadout(page).textContent(), { timeout: 30_000 })
      .not.toBe(before);
  });
});
