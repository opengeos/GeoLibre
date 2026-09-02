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
 * This runs **keyless on purpose**. `playwright.config.ts` blanks
 * `CESIUM_TOKEN`/`VITE_CESIUM_TOKEN` for the build, which covers a token
 * exported in the shell. Two cases it cannot cover: a token in
 * `apps/geolibre-desktop/.env.local`, which `vite.config.ts` reads straight off
 * disk, and a locally reused server, which Playwright starts without applying
 * that override at all. So rather than assume the build is keyless, the test
 * asserts the tokenless hint and fails with a message explaining both.
 *
 * Until #2205 the pane was hidden without a token and could not mount without a
 * secret; the toggle is now always offered and the globe draws the project
 * basemap. That makes this the guard on that behaviour: if the token gating
 * ever comes back, it fails at `globeToggle` rather than skipping.
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
    // The config's 60s per-test cap is a hard ceiling on the whole test, not on
    // each step, so the generous per-assertion budgets below (a ~4.6 MB engine
    // chunk plus its Workers on a cold, software-rendered runner) could never
    // be reached inside it. Raise the test's own budget so they can.
    test.setTimeout(180_000);

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

    // The build is keyless (see the file header), so the pane must be offering
    // the hint about what an Ion token would add. This is the assertion that
    // distinguishes the keyless path from the tokened one — and the one that
    // catches a build the config's env override could not reach.
    await expect(
      page.getByText("Add a Cesium Ion token in Settings for terrain and Ion imagery"),
      "the globe pane came up with an Ion token, so this run is not testing the keyless path. " +
        "playwright.config.ts blanks CESIUM_TOKEN/VITE_CESIUM_TOKEN for the build, but that misses " +
        "a token in apps/geolibre-desktop/.env.local (read off disk by vite.config.ts), and is not " +
        "applied at all to a locally reused preview server — stop it and re-run to rebuild.",
    ).toBeVisible();

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

    // Toggle back to 2D. The pane swaps the whole canvas component, so this
    // runs CesiumCanvas's cleanup — `viewer.destroy()` plus the layer-sync and
    // basemap teardown — and then mounts a MapLibre pane in its place. A
    // destroy that threw, or Cesium state left holding the container, shows up
    // as the 2D canvas never appearing.
    await page.getByRole("button", { name: "Show map 2 as a 2D map" }).click();
    await expect(page.getByTestId("secondary-map-canvas")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("cesium-canvas")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Show map 2 as a 3D globe" })).toBeVisible();
  });
});
