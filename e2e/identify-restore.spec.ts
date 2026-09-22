import { expect, test, type Page } from "@playwright/test";
import { bindMapLibreMap, dropGeoJson, layerRow, readFixture, waitForMap } from "./helpers";

/**
 * Issue #2500: the camera must not chase the selection an Identify popup
 * restores when it is dismissed.
 *
 * Dismissing a resolved Identify popup rolls the pre-Identify selection back
 * (#2498), and "Zoom to selection" normally frames whatever becomes selected.
 * The rollback is exempt: it is an undo, not a pick, so the camera stays where
 * the user left it. That exemption rides on a read-once marker
 * (`consumePendingIdentifyRestore`) written by `restoreIdentifySelection` and
 * read by `MapCanvas`'s selection effect, which runs a commit later than the
 * restore call. The shared-module tests pin the marker's exactly-once
 * semantics; only a mounted map can show the effect actually observing it in
 * that window, which is what these specs do.
 *
 * Layout of the two fixtures: `identify-context` is one wide polygon spanning
 * the lower 48, `identify-targets` two small squares inside it. Selecting the
 * wide polygon frames the whole continent; identifying a square zooms in hard.
 * That gap is what makes an unsuppressed re-fit unmistakable — it would fling
 * the camera back out to the continent view.
 */

const CONTEXT_TEXT = readFixture("identify-context.geojson");
const TARGETS_TEXT = readFixture("identify-targets.geojson");

/** The east target square's centre, where the Identify click lands. */
const EAST_TARGET: [number, number] = [-90, 37];
/** That square's west edge, the anchor the miss-click measures itself from. */
const EAST_TARGET_WEST_EDGE: [number, number] = [-91, 37];

interface Camera {
  lng: number;
  lat: number;
  zoom: number;
}

declare global {
  interface Window {
    /** Consecutive still polls seen by `waitForCameraIdle`, kept page-side. */
    __geolibreIdleTicks?: number;
    /** Camera movements counted since `watchCameraMoves` last reset it. */
    __geolibreMoveCount?: number;
  }
}

/** How many consecutive still polls count as "the camera has come to rest". */
const STILL_POLLS = 5;

/**
 * How far west of the identified square's own edge the miss-click lands, in
 * pixels. Anchored to the rendered feature rather than to the fit's padding, so
 * it stays a miss whatever `FIT_BOUNDS_PADDING` becomes.
 */
const MISS_CLICK_GAP = 20;

/** Reads the live camera through the handle `bindMapLibreMap` stashed. */
async function readCamera(page: Page): Promise<Camera> {
  return page.evaluate(() => {
    const map = window.__geolibreTestMap!;
    const center = map.getCenter();
    return { lng: center.lng, lat: center.lat, zoom: map.getZoom() };
  });
}

/**
 * Waits for the camera to come to rest.
 *
 * A fit is animated, so a single `isMoving()` probe can catch the gap before
 * an animation starts as well as the stillness after it ends. Require several
 * consecutive still polls instead, which only the latter can produce.
 */
async function waitForCameraIdle(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__geolibreIdleTicks = 0;
  });
  await page.waitForFunction(
    (stillPolls) => {
      const map = window.__geolibreTestMap;
      if (!map) return false;
      if (map.isMoving() || map.isZooming() || map.isRotating()) {
        window.__geolibreIdleTicks = 0;
        return false;
      }
      window.__geolibreIdleTicks = (window.__geolibreIdleTicks ?? 0) + 1;
      return window.__geolibreIdleTicks >= stillPolls;
    },
    STILL_POLLS,
    { polling: 100 },
  );
}

/**
 * Starts counting camera movements on the page, from zero.
 *
 * `movestart` fires the instant a fit begins, so the count answers "did the
 * camera move at all since this point" rather than "is it moving right now".
 * That is what a suppression assertion needs: a re-fit cannot slip between two
 * polls, and the answer does not depend on catching an animation mid-flight.
 */
async function watchCameraMoves(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (window.__geolibreMoveCount === undefined) {
      window.__geolibreTestMap!.on("movestart", () => {
        window.__geolibreMoveCount = (window.__geolibreMoveCount ?? 0) + 1;
      });
    }
    window.__geolibreMoveCount = 0;
  });
}

/** How many camera movements began since `watchCameraMoves`. */
async function readCameraMoves(page: Page): Promise<number> {
  return page.evaluate(() => window.__geolibreMoveCount ?? 0);
}

/** Clicks the map at a geographic position, projecting it through the camera. */
async function clickLngLat(page: Page, lngLat: [number, number]): Promise<void> {
  const point = await page.evaluate((target) => {
    const map = window.__geolibreTestMap!;
    const projected = map.project(target);
    const rect = map.getCanvas().getBoundingClientRect();
    return { x: rect.left + projected.x, y: rect.top + projected.y };
  }, lngLat);
  await page.mouse.click(point.x, point.y);
}

/** The Identify popup MapLibre renders for a resolved hit. */
function identifyPopup(page: Page) {
  return page.locator(".maplibregl-popup.geolibre-identify-popup");
}

/**
 * The attribute-table panel. Asserted against by text rather than by the
 * layer-name element's visibility: that element is `truncate`d inside a
 * nowrap toolbar, so at narrow widths it collapses to a zero-size box that
 * Playwright reads as hidden even while the name is in the DOM.
 */
function attributeTable(page: Page) {
  return page.getByRole("region", { name: "Attribute table" });
}

/** The attribute table's rows, which mirror the store's feature selection. */
function attributeRows(page: Page) {
  return page.locator('[data-testid="attribute-table"] tbody tr');
}

/**
 * Loads both fixtures, arms Identify on the targets layer, and leaves the
 * context layer selected with its attribute table open and "Zoom to selection"
 * on. Returns the camera framing the context polygon — the view an
 * unsuppressed restore would snap back to.
 *
 * Order matters: the layer row's Identify button also selects its layer, so
 * Identify has to be armed *before* the context selection is made, or it would
 * wipe the very selection the restore is supposed to bring back.
 */
async function setUpIdentifyOverContextSelection(page: Page): Promise<Camera> {
  await waitForMap(page);
  await bindMapLibreMap(page);
  await dropGeoJson(page, "identify-context", CONTEXT_TEXT);
  await dropGeoJson(page, "identify-targets", TARGETS_TEXT);

  const targets = layerRow(page, "identify-targets");
  await expect(targets).toBeVisible();
  await targets.getByRole("button", { name: "Identify features", exact: true }).click();

  const context = layerRow(page, "identify-context");
  await context.locator('button[aria-label="Layer actions"]').click();
  await page.getByRole("menuitem", { name: "Open attribute table" }).click();
  await expect(page.getByTestId("attribute-table")).toBeVisible();
  // Free the full map surface: the Layers panel overlays the side the Identify
  // click has to reach. Collapse it before the camera is read, so its resize
  // cannot be mistaken for a fit.
  await page.getByRole("button", { name: "Collapse layers", exact: true }).click();

  await page.getByLabel("Zoom to selection").check();
  await attributeRows(page).first().click();
  await expect(page.getByTestId("attribute-table-status")).toContainText("1 selected");
  await waitForCameraIdle(page);
  return readCamera(page);
}

test("dismissing an Identify popup restores the selection without moving the camera", async ({
  page,
}) => {
  const contextCamera = await setUpIdentifyOverContextSelection(page);
  const contextFeatureId = await attributeRows(page).first().locator("td").first().innerText();

  // Identify a square on the other layer. That takes over the selection, and
  // "Zoom to selection" frames it — this move is a genuine pick, so it is
  // supposed to happen.
  await clickLngLat(page, EAST_TARGET);
  await expect(identifyPopup(page)).toBeVisible();
  await expect(attributeTable(page)).toContainText("- identify-targets");
  await waitForCameraIdle(page);
  const identifiedCamera = await readCamera(page);
  expect(identifiedCamera.zoom).toBeGreaterThan(contextCamera.zoom + 1);

  // From here on, any camera movement at all is a failure, so count movements
  // rather than sampling positions.
  await watchCameraMoves(page);
  await identifyPopup(page).locator(".maplibregl-popup-close-button").click();
  await expect(identifyPopup(page)).toHaveCount(0);

  // The pre-Identify selection is back: the attribute table follows the
  // selected layer, so its header naming the context layer and the same row
  // reading as selected together pin layer and feature.
  await expect(attributeTable(page)).toContainText("- identify-context");
  await expect(page.getByTestId("attribute-table-status")).toContainText("1 selected");
  const restoredRow = attributeRows(page).first();
  await expect(restoredRow).toHaveAttribute("data-state", "selected");
  expect(await restoredRow.locator("td").first().innerText()).toBe(contextFeatureId);

  // ...and the camera stayed on the square. Before the read-once marker this
  // is where it flew back out to `contextCamera`.
  await waitForCameraIdle(page);
  expect(await readCameraMoves(page)).toBe(0);
  const restoredCamera = await readCamera(page);
  expect(restoredCamera.zoom).toBeCloseTo(identifiedCamera.zoom, 2);
  expect(restoredCamera.lng).toBeCloseTo(identifiedCamera.lng, 2);
  expect(restoredCamera.lat).toBeCloseTo(identifiedCamera.lat, 2);
  expect(restoredCamera.zoom).toBeGreaterThan(contextCamera.zoom + 1);
});

test("a selection made while the Identify popup is open survives its dismissal", async ({
  page,
}) => {
  await setUpIdentifyOverContextSelection(page);

  await clickLngLat(page, EAST_TARGET);
  await expect(identifyPopup(page)).toBeVisible();
  await expect(attributeTable(page)).toContainText("- identify-targets");

  // The attribute table now follows the identified layer, so picking the row
  // Identify did *not* select is the user changing the selection out from under
  // the popup. Address it as "the unselected row" rather than by index: the
  // snapshot comparison is what this case turns on, so re-picking the
  // identified feature would silently make the assertion vacuous.
  const otherRow = page.locator(
    '[data-testid="attribute-table"] tbody tr:not([data-state="selected"])',
  );
  await expect(otherRow).toHaveCount(1);
  const otherFeatureId = await otherRow.locator("td").first().innerText();
  await otherRow.click();
  await waitForCameraIdle(page);
  const pickedCamera = await readCamera(page);

  await watchCameraMoves(page);
  await identifyPopup(page).locator(".maplibregl-popup-close-button").click();
  await expect(identifyPopup(page)).toHaveCount(0);

  // The user's pick stands: same layer, same feature, no rollback.
  await expect(attributeTable(page)).toContainText("- identify-targets");
  await expect(page.getByTestId("attribute-table-status")).toContainText("1 selected");
  const selectedRow = page.locator(
    '[data-testid="attribute-table"] tbody tr[data-state="selected"]',
  );
  await expect(selectedRow).toHaveCount(1);
  expect(await selectedRow.locator("td").first().innerText()).toBe(otherFeatureId);

  await waitForCameraIdle(page);
  expect(await readCameraMoves(page)).toBe(0);
  const afterCamera = await readCamera(page);
  expect(afterCamera.zoom).toBeCloseTo(pickedCamera.zoom, 2);
  expect(afterCamera.lng).toBeCloseTo(pickedCamera.lng, 2);
  expect(afterCamera.lat).toBeCloseTo(pickedCamera.lat, 2);
});

/**
 * The other way a popup goes away: clicking the map somewhere with nothing
 * under it. That is a miss, not a dismissal, and both renderers deliberately
 * treat it as clearing the Identify result rather than undoing it (the parity
 * decision on #2498) — the popup and the feature selection go, the identified
 * layer stays selected, and nothing is restored. Pinned here so the difference
 * from the × button above is a choice the suite records, not a gap.
 */
test("clicking past the features clears the Identify result instead of restoring", async ({
  page,
}) => {
  await setUpIdentifyOverContextSelection(page);

  await clickLngLat(page, EAST_TARGET);
  await expect(identifyPopup(page)).toBeVisible();
  await waitForCameraIdle(page);
  const identifiedCamera = await readCamera(page);

  // A point on screen but off both squares, measured from the identified
  // square's own west edge rather than from the fit's padding, so the gap
  // survives a change to that constant. The edge assertion is what would catch
  // a future fit that left no room to the west of it.
  await watchCameraMoves(page);
  const miss = await page.evaluate(
    ([edgeLngLat, gap]) => {
      const map = window.__geolibreTestMap!;
      const edge = map.project(edgeLngLat as [number, number]);
      const rect = map.getCanvas().getBoundingClientRect();
      return {
        edgeX: edge.x,
        x: rect.left + edge.x - (gap as number),
        y: rect.top + rect.height / 2,
      };
    },
    [EAST_TARGET_WEST_EDGE, MISS_CLICK_GAP] as const,
  );
  expect(miss.edgeX).toBeGreaterThan(MISS_CLICK_GAP);
  await page.mouse.click(miss.x, miss.y);

  await expect(identifyPopup(page)).toHaveCount(0);
  await expect(attributeTable(page)).toContainText("- identify-targets");
  await expect(page.getByTestId("attribute-table-status")).toContainText("0 selected");

  await waitForCameraIdle(page);
  expect(await readCameraMoves(page)).toBe(0);
  const clearedCamera = await readCamera(page);
  expect(clearedCamera.zoom).toBeCloseTo(identifiedCamera.zoom, 2);
  expect(clearedCamera.lng).toBeCloseTo(identifiedCamera.lng, 2);
  expect(clearedCamera.lat).toBeCloseTo(identifiedCamera.lat, 2);
});
