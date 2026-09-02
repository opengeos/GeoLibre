import { expect, test, type Page } from "@playwright/test";
import { dropGeoJson, layerRow, waitForMap } from "./helpers";

/**
 * End-to-end coverage for **View → Rendering engine** (issue #2217): the globe
 * as the *primary* map, not just a pane beside one.
 *
 * The unit tests cover the store and the project round-trip against a fake
 * Cesium, which by construction cannot catch what this checks — that swapping
 * the primary renderer actually unmounts the MapLibre map and mounts a live
 * globe in a 1x1 workspace, that the shared camera and the user's layers
 * survive the round trip in both directions, and that swapping back restores
 * the 2D map (i.e. `CesiumWidget.destroy()` releases the container cleanly).
 *
 * Like `cesium-globe.spec.ts` this runs **keyless on purpose** and asserts
 * nothing about tiles: imagery comes from third-party hosts, so a runner with
 * no egress must still pass.
 */

/** A tiny point layer, so the Layers panel has something to carry across. */
const CITY = JSON.stringify({
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [-122.42, 37.77] },
      properties: { name: "San Francisco" },
    },
  ],
});

/** The status bar's bbox readout, which reflects the shared store camera. */
function bboxReadout(page: Page) {
  return page.getByText(/^BBox:/);
}

/** Pick a primary renderer from View → Rendering engine. */
async function chooseRenderer(page: Page, label: "MapLibre 2D" | "Cesium 3D"): Promise<void> {
  await page.getByRole("button", { name: "View", exact: true }).click();
  await page.getByRole("menuitem", { name: "Rendering engine" }).click();
  await page.getByRole("menuitemradio", { name: label }).click();
}

test.describe("Cesium as the primary rendering engine", () => {
  test("swaps the primary map, keeps the project, and swaps back", async ({ page }) => {
    // The engine is a ~4.9 MB lazily imported chunk that then loads its Workers
    // and Assets, so the per-assertion budgets below need more than the
    // config's 60s per-test cap allows.
    test.setTimeout(180_000);

    await waitForMap(page);
    await dropGeoJson(page, "cities", CITY);
    await expect(layerRow(page, "cities")).toBeVisible();

    // Move off the default camera so "the camera carried across" is a real
    // assertion rather than a coincidence of two default views agreeing.
    const mapCanvas = page.getByTestId("map-canvas");
    const box = await mapCanvas.boundingBox();
    expect(box).not.toBeNull();
    const cx = box!.x + box!.width / 2;
    const cy = box!.y + box!.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx - 120, cy - 80, { steps: 10 });
    await page.mouse.up();
    await expect(bboxReadout(page)).toBeVisible();
    const bboxOn2d = await bboxReadout(page).textContent();
    expect(bboxOn2d).toBeTruthy();

    await chooseRenderer(page, "Cesium 3D");

    // The globe replaces the 2D map rather than joining it: no grid appears,
    // and MapLibre is unmounted (not merely hidden) so it frees its context.
    const globe = page.getByTestId("primary-cesium");
    await expect(globe).toBeVisible({ timeout: 60_000 });
    await expect(globe.locator("canvas")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("map-canvas")).toHaveCount(0);
    await expect(page.getByTestId("map-grid")).toHaveCount(0);

    // CesiumCanvas renders its failure message in place of the globe, so an
    // empty error region is what distinguishes "mounted" from "threw".
    await expect(globe.getByText(/CESIUM_BASE_URL|Cannot read|undefined|failed/i)).toHaveCount(0);

    // The MapLibre-only tools are not mounted while the globe draws the
    // workspace, so say so rather than leaving their absence unexplained.
    await expect(
      globe.getByText("3D globe renderer — tools that need the 2D map are unavailable"),
    ).toBeVisible();

    // The project is untouched by the swap: the layer is still there, and the
    // camera the user left the 2D map on is the one the globe seeded from.
    await expect(layerRow(page, "cities")).toBeVisible();
    expect(await bboxReadout(page).textContent()).toBe(bboxOn2d);

    // Dragging the globe writes back into the shared `mapView` — the primary
    // globe owns that camera outright, with no pane record in between.
    const globeCanvas = globe.locator("canvas");
    const globeBox = await globeCanvas.boundingBox();
    expect(globeBox).not.toBeNull();
    const gx = globeBox!.x + globeBox!.width / 2;
    const gy = globeBox!.y + globeBox!.height / 2;
    await page.mouse.move(gx, gy);
    await page.mouse.down();
    // Several steps: Cesium's camera controller integrates pointer motion, so a
    // single jump can be swallowed as a click.
    await page.mouse.move(gx - 90, gy - 60, { steps: 12 });
    await page.mouse.up();
    await expect
      .poll(async () => bboxReadout(page).textContent(), { timeout: 30_000 })
      .not.toBe(bboxOn2d);
    const bboxOn3d = await bboxReadout(page).textContent();

    // Switching back remounts MapLibre, which runs CesiumWidget's teardown —
    // a destroy that threw, or Cesium state left holding the container, shows
    // up as the 2D canvas never reappearing.
    await chooseRenderer(page, "MapLibre 2D");
    await expect(page.getByTestId("map-canvas")).toBeVisible({ timeout: 60_000 });
    await expect(page.locator(".maplibregl-canvas")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("primary-cesium")).toHaveCount(0);
    await expect(layerRow(page, "cities")).toBeVisible();
    // The camera the globe left behind is the one the 2D map picks up.
    expect(await bboxReadout(page).textContent()).toBe(bboxOn3d);
  });
});
