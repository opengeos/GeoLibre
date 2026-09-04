import { expect, test, type Page } from "@playwright/test";
import { dropGeoJson, layerRow, waitForMap } from "./helpers";

/**
 * End-to-end coverage for **View → Rendering engine** (issue #2217): the globe
 * as the *primary* map, not just a pane beside one.
 *
 * The unit tests cover the store and the project round trip against a fake
 * Cesium, which by construction cannot catch what this checks — that swapping
 * the primary renderer actually unmounts the MapLibre map and mounts a live
 * globe in a 1x1 workspace, that the shared camera and the user's layers
 * survive the round trip in both directions, that wheel zoom on the globe keeps
 * reaching the shared store, and that swapping back restores the 2D map (i.e.
 * `CesiumWidget.destroy()` releases the container cleanly).
 *
 * Like `cesium-globe.spec.ts` this runs **keyless on purpose** and asserts
 * nothing about tiles: imagery comes from third-party hosts, so a runner with
 * no egress must still pass.
 *
 * The camera signal throughout is the status bar's **zoom**, which both engines
 * publish to the shared `mapView`. The bbox readout deliberately is not used:
 * `readMapViewFromCamera` returns no `bbox`, so on the globe that field keeps
 * whatever MapLibre last wrote and comparing it would assert nothing.
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

/** The status bar's zoom readout as a number, or NaN. */
async function readZoom(page: Page): Promise<number> {
  const text = await page.getByText(/^Zoom:/).textContent();
  return Number(text?.match(/-?\d+(\.\d+)?/)?.[0] ?? NaN);
}

/**
 * Wait until the zoom readout stops changing, then return it.
 *
 * A gesture leaves the map easing under its own inertia, and the globe re-reads
 * its camera as terrain and tiles settle, so sampling the moment the mouse comes
 * up captures a camera the view is still moving away from.
 */
async function waitForStableZoom(page: Page): Promise<number> {
  let previous = NaN;
  await expect
    .poll(
      async () => {
        const now = await readZoom(page);
        const stable = Number.isFinite(now) && now === previous;
        previous = now;
        return stable;
      },
      { timeout: 30_000, intervals: [500] },
    )
    .toBe(true);
  return previous;
}

/**
 * Assert a camera survived an engine swap. Not to the decimal: Cesium's camera
 * is a metric range with a horizon-referenced pitch, not a Web-Mercator zoom, so
 * a view handed between the engines round-trips through a deliberately lossy
 * conversion (`isSameView` in `cesium-camera.ts` carries the same tolerance for
 * the same reason). Half a zoom level still fails hard on the regression that
 * matters here — a camera reset to the default world view, or dropped several
 * levels — while staying immune to that conversion noise.
 */
function expectSameZoom(actual: number, expected: number): void {
  expect(Math.abs(actual - expected), `zoom ${actual} vs ${expected}`).toBeLessThan(0.5);
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
    for (let tick = 0; tick < 4; tick++) {
      await page.mouse.wheel(0, -200);
      await page.waitForTimeout(80);
    }
    const zoomOn2d = await waitForStableZoom(page);
    expect(zoomOn2d).toBeGreaterThan(0);

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

    // The project is untouched by the swap: the layer is still there, and the
    // camera the user left the 2D map on is the one the globe seeded from.
    await expect(layerRow(page, "cities")).toBeVisible();
    expectSameZoom(await waitForStableZoom(page), zoomOn2d);

    // Repeated wheel zoom on the globe must keep reaching the shared store
    // rather than being undone. The globe publishes each settled camera to
    // `mapView` and then receives it straight back through the store's own
    // subscription; re-applying that echo `lookAt`s the camera again and throws
    // away whatever the user has scrolled since, which showed up as zoom bursts
    // that simply did nothing.
    //
    // This run is keyless, so there is no terrain: it covers the echo path only.
    // The sharper form of the same bug needs an Ion token — finer terrain tiles
    // land mid-gesture and the terrain correction re-applies the last settled
    // view — and is guarded by `userOwnsCameraRef` in CesiumCanvas.
    const globeCanvas = globe.locator("canvas");
    const globeBox = await globeCanvas.boundingBox();
    expect(globeBox).not.toBeNull();
    await page.mouse.move(globeBox!.x + globeBox!.width / 2, globeBox!.y + globeBox!.height / 2);
    let previous = await readZoom(page);
    for (let burst = 0; burst < 3; burst++) {
      const settled = previous;
      for (let tick = 0; tick < 3; tick++) {
        await page.mouse.wheel(0, -200);
        await page.waitForTimeout(80);
      }
      await expect.poll(() => readZoom(page), { timeout: 30_000 }).toBeGreaterThan(settled + 0.1);
      previous = await waitForStableZoom(page);
    }
    const zoomOn3d = previous;
    expect(zoomOn3d).toBeGreaterThan(zoomOn2d);

    // Switching back remounts MapLibre, which runs CesiumWidget's teardown —
    // a destroy that threw, or Cesium state left holding the container, shows
    // up as the 2D canvas never reappearing.
    await chooseRenderer(page, "MapLibre 2D");
    await expect(page.getByTestId("map-canvas")).toBeVisible({ timeout: 60_000 });
    await expect(page.locator(".maplibregl-canvas")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("primary-cesium")).toHaveCount(0);
    await expect(layerRow(page, "cities")).toBeVisible();
    // The camera the globe left behind is the one the 2D map picks up.
    expectSameZoom(await waitForStableZoom(page), zoomOn3d);
  });
});
