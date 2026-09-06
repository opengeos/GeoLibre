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
async function chooseRenderer(page: Page, label: "MapLibre" | "Cesium"): Promise<void> {
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

    await chooseRenderer(page, "Cesium");

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
    await chooseRenderer(page, "MapLibre");
    await expect(page.getByTestId("map-canvas")).toBeVisible({ timeout: 60_000 });
    await expect(page.locator(".maplibregl-canvas")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("primary-cesium")).toHaveCount(0);
    await expect(layerRow(page, "cities")).toBeVisible();
    // The camera the globe left behind is the one the 2D map picks up.
    expectSameZoom(await waitForStableZoom(page), zoomOn3d);
  });
});

/**
 * Cesium's own toolbar buttons on the globe (issue #2270): the home button, the
 * scene-mode picker, and the fullscreen button.
 *
 * The unit tests cover the camera maths and the morph guards against a fake
 * Cesium, which by construction cannot catch what matters here — that the
 * widgets actually mount and bind (they are Knockout-driven DOM built outside
 * React), that a real morph runs to completion, and that the scale the store
 * carries survives it. That last one is the whole point: 2D swaps the frustum
 * for an orthographic box, so a zoom Cesium considers preserved is not the one
 * the rest of the app holds unless the engine re-derives it.
 *
 * Keyless like the specs above, and asserts nothing about tiles.
 */
test.describe("Cesium toolbar controls on the globe", () => {
  /** One of the scene-mode picker's *drop-down* entries, by its tooltip. */
  const sceneMode = (page: Page, title: string) =>
    page.locator(`.cesium-sceneModePicker-dropDown-icon[title="${title}"]`);

  /** Open the picker's drop-down and choose a mode, then wait out the morph. */
  async function chooseSceneMode(page: Page, title: string): Promise<void> {
    // The trigger carries the *selected* mode's tooltip, so it collides with the
    // drop-down entry of the same name; `sceneMode` matches only the entries.
    await page.locator(".cesium-sceneModePicker-wrapper button").first().click();
    await sceneMode(page, title).click();
    // A 3D↔2D morph is two animations back to back — Cesium flies the camera out
    // before it morphs — and the whole time the engine refuses camera reads and
    // writes, because Cesium throws from them mid-morph. There is no DOM signal
    // for "the morph landed", and the zoom readout is no help either: it is
    // *frozen* at the last applied view for the duration, so it looks stable the
    // instant the morph begins. Hence a plain wait, generous enough to cover both
    // animations on a software renderer.
    await page.waitForTimeout(6_000);
  }

  test("switches scene mode and resets the view without losing the camera", async ({ page }) => {
    test.setTimeout(180_000);

    await waitForMap(page);

    // Zoom the 2D map in first, so the globe seeds from a close camera rather
    // than the default whole-Earth view. That is not incidental tidying: wheel
    // zoom on a globe framed at the full Earth trips a `DeveloperError:
    // normalized result is not a number` inside Cesium's own
    // ScreenSpaceCameraController and stops the render loop. It reproduces on an
    // unmodified build, so it predates these controls and is not what this test
    // is here to catch — the test above avoids it the same way, by arriving on
    // the globe already zoomed in.
    const mapBox = await page.getByTestId("map-canvas").boundingBox();
    expect(mapBox).not.toBeNull();
    await page.mouse.move(mapBox!.x + mapBox!.width / 2, mapBox!.y + mapBox!.height / 2);
    for (let tick = 0; tick < 5; tick++) {
      await page.mouse.wheel(0, -200);
      await page.waitForTimeout(80);
    }
    const zoomOn2dMap = await waitForStableZoom(page);
    expect(zoomOn2dMap).toBeGreaterThan(2);

    await chooseRenderer(page, "Cesium");
    const globe = page.getByTestId("primary-cesium");
    await expect(globe).toBeVisible({ timeout: 60_000 });
    await expect(globe.locator("canvas")).toBeVisible({ timeout: 60_000 });

    // All three controls mount into the globe's control host.
    await expect(page.locator(".cesium-home-button")).toBeVisible({ timeout: 60_000 });
    await expect(page.locator(".cesium-sceneModePicker-wrapper")).toBeVisible();
    await expect(page.locator(".cesium-fullscreenButton")).toBeVisible();
    // Tooltips come from the app's catalogs, not the widgets' English defaults.
    // The fullscreen one is the interesting case: Cesium derives it from the
    // fullscreen state as a read-only computed, so it is written onto the button
    // rather than pushed through a view model.
    await expect(page.locator(".cesium-home-button")).toHaveAttribute("title", "Reset view");
    await expect(page.locator(".cesium-fullscreenButton")).toHaveAttribute(
      "title",
      "Enter fullscreen",
    );

    // They line up. Cesium gives the scene-mode picker's wrapper a 3px side
    // margin and leaves the fullscreen button to inherit a size from a `Viewer`
    // layout that does not exist here, so both drifted out of the column before
    // `index.css` pinned them.
    const edges = await page
      .locator(".geolibre-cesium-ctrl button:visible")
      .evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().right));
    expect(edges).toHaveLength(3);
    for (const edge of edges) expect(edge).toBeCloseTo(edges[0], 0);

    // The globe seeded from the 2D camera, so this is the scale to preserve.
    const zoomOn3d = await waitForStableZoom(page);
    expectSameZoom(zoomOn3d, zoomOn2dMap);

    // 2D keeps that scale. The orthographic frustum has no camera distance, so
    // an engine that kept deriving the zoom from one would report a constant.
    await chooseSceneMode(page, "2D map");
    expectSameZoom(await waitForStableZoom(page), zoomOn3d);
    // 2D is north-up and untilted, and says so. Sub-degree rather than exactly
    // zero, and signed: `isSameView`'s 0.1° tolerance is what suppresses the
    // camera echo, so a residual tenth of a degree can survive the morph
    // unpublished (and reads as "-0.0" once formatted). Anything a user could
    // see would be far larger.
    await expect(page.getByText(/^Pitch:/)).toHaveText(/^Pitch: -?0\.\d°$/);
    await expect(page.getByText(/^Bearing:/)).toHaveText(/^Bearing: -?0\.\d°$/);

    // Navigating in 2D still reaches the shared store. Nothing in the 3D
    // readback survives the switch — there is no camera distance to measure —
    // so this is what says the 2D-specific path is actually wired up.
    const globeBox = await globe.locator("canvas").boundingBox();
    expect(globeBox).not.toBeNull();
    await page.mouse.move(globeBox!.x + globeBox!.width / 2, globeBox!.y + globeBox!.height / 2);
    for (let tick = 0; tick < 4; tick++) {
      await page.mouse.wheel(0, -200);
      await page.waitForTimeout(100);
    }
    await expect.poll(() => readZoom(page), { timeout: 30_000 }).toBeGreaterThan(zoomOn3d + 0.3);
    const zoomOn2d = await waitForStableZoom(page);

    // Back to 3D, carrying the zoom the user reached in 2D.
    await chooseSceneMode(page, "3D globe");
    expectSameZoom(await waitForStableZoom(page), zoomOn2d);

    // Home flies out to a view of the whole Earth, and the store follows it
    // there — the button drives Cesium's own `camera.flyHome`, so this also
    // asserts that such a move still reaches `mapView` through the engine's
    // camera publisher rather than moving the globe behind the store's back.
    await page.locator(".cesium-home-button").click();
    await expect.poll(() => readZoom(page), { timeout: 60_000 }).toBeLessThan(zoomOn2d - 1);
  });

  test("lets Controls -> Fullscreen govern the globe's fullscreen button", async ({ page }) => {
    test.setTimeout(120_000);

    await waitForMap(page);
    await chooseRenderer(page, "Cesium");
    await expect(page.locator(".cesium-fullscreenButton")).toBeVisible({ timeout: 60_000 });

    // The menu row exists for every renderer, but the globe used to refuse every
    // built-in control outright, so toggling it did nothing and the checkmark
    // would not even move. The engine now answers for this one id.
    const toggleFullscreen = async () => {
      await page.getByRole("button", { name: "Controls", exact: true }).click();
      await page.getByRole("menuitem", { name: /^Fullscreen/ }).click();
      await page.keyboard.press("Escape");
    };

    await toggleFullscreen();
    await expect(page.locator(".cesium-fullscreenButton")).toHaveCount(0);
    // The other two have no menu counterpart and are unaffected.
    await expect(page.locator(".cesium-home-button")).toBeVisible();

    await toggleFullscreen();
    await expect(page.locator(".cesium-fullscreenButton")).toBeVisible();
  });
});
