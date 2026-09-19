import { expect, test, type Page } from "@playwright/test";
import { layerRow } from "./helpers";
import { DESKTOP_SETTINGS_STORAGE_KEY } from "../apps/geolibre-desktop/src/lib/storage-keys";

const DATA_PATH = "e2e/fixtures/smoke.geojson";

test.skip(!process.env.MAPBOX_TOKEN, "Set MAPBOX_TOKEN to test the Mapbox renderer");
test.use({ actionTimeout: 30_000 });

async function chooseSelectionTool(page: Page, layerName: string, toolName: string) {
  const row = layerRow(page, layerName);
  await row.locator('button[aria-label="Layer actions"]').click();
  await page.getByRole("menuitem", { name: "Select features", exact: true }).hover();
  await page.getByRole("menuitem", { name: toolName, exact: true }).click();
}

async function bindMapboxMap(page: Page) {
  await page.waitForFunction(() => {
    const header = document.querySelector("header") as unknown as Record<string, unknown>;
    if (!header) return false;
    let fiber = header[Object.keys(header).find((key) => key.startsWith("__reactFiber"))!] as any;
    while (fiber) {
      for (const side of [fiber, fiber.alternate]) {
        let hook = side?.memoizedState;
        while (hook) {
          const engine = hook.memoizedState?.current;
          if (engine?.kind === "mapbox" && engine.getMapboxMap?.()) {
            (window as any).mapboxCursorTestMap = engine.getMapboxMap();
            return true;
          }
          hook = hook.next;
        }
      }
      fiber = fiber.return;
    }
    return false;
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`Mapbox feature-selection gestures select real GeoJSON (${theme})`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);
    await page.addInitScript(
      ({ key, token }) => {
        const settings = JSON.parse(localStorage.getItem(key) || "{}");
        localStorage.setItem(
          key,
          JSON.stringify({
            ...settings,
            mapboxAccessToken: token,
            uiProfile: { onboarded: true, hiddenDataSources: [] },
          }),
        );
      },
      { key: DESKTOP_SETTINGS_STORAGE_KEY, token: process.env.MAPBOX_TOKEN! },
    );
    await page.goto("/");
    if (theme === "dark") {
      await page.getByRole("button", { name: "Switch to Dark Mode" }).click();
    }
    await page.getByRole("button", { name: "View", exact: true }).click();
    await page.getByRole("menuitem", { name: "Rendering engine", exact: true }).hover();
    await page.getByRole("menuitemradio", { name: "Mapbox", exact: true }).click();
    const canvas = page.locator(".mapboxgl-canvas");
    await expect(canvas).toBeVisible();

    await page.getByRole("button", { name: "Add Data", exact: true }).click();
    await page.getByRole("menuitem", { name: "Vector Layer", exact: true }).click();
    await page.locator('input[type="file"]').setInputFiles(DATA_PATH);
    const row = layerRow(page, "smoke");
    await expect(row).toBeVisible();
    await page.getByRole("button", { name: "Close panel", exact: true }).click();

    await bindMapboxMap(page);
    await row.getByRole("button", { name: "Identify features", exact: true }).click();
    await expect(canvas).toHaveCSS("cursor", "crosshair");
    expect(
      await page.evaluate(
        () => getComputedStyle((window as any).mapboxCursorTestMap.getCanvasContainer()).cursor,
      ),
    ).toBe("crosshair");
    await row.getByRole("button", { name: "Zoom to layer", exact: true }).click();
    await page.waitForFunction(() => !(window as any).mapboxCursorTestMap.isMoving());
    await expect
      .poll(() =>
        page.evaluate(() => {
          const map = (window as any).mapboxCursorTestMap;
          const point = map.project([-118.24, 34.05]);
          return map
            .queryRenderedFeatures(point)
            .some((feature: any) => feature.properties?.name === "Bravo");
        }),
      )
      .toBe(true);
    const featurePoint = await page.evaluate(() => {
      const map = (window as any).mapboxCursorTestMap;
      const point = map.project([-118.24, 34.05]);
      const rect = map.getCanvas().getBoundingClientRect();
      return { x: rect.left + point.x, y: rect.top + point.y };
    });
    await page.mouse.click(featurePoint.x, featurePoint.y);
    await expect(page.locator(".mapboxgl-popup.geolibre-identify-popup")).toBeVisible();
    await expect(canvas).toHaveCSS("cursor", "crosshair");
    expect(
      await page.evaluate(({ x, y }) => {
        const element = document.elementFromPoint(x, y);
        return element
          ? { className: element.className, cursor: getComputedStyle(element).cursor }
          : null;
      }, featurePoint),
    ).toMatchObject({ cursor: "crosshair" });
    await row.getByRole("button", { name: "Deactivate identify", exact: true }).click();

    for (const tool of [
      "Select features by click",
      "Select features by rectangle",
      "Select features by polygon",
      "Select features by freehand",
      "Select features by radius",
    ]) {
      await chooseSelectionTool(page, "smoke", tool);
      await expect(canvas).toHaveCSS("cursor", "crosshair");
      await page.keyboard.press("Escape");
      await expect(canvas).not.toHaveCSS("cursor", "crosshair");
    }

    await chooseSelectionTool(page, "smoke", "Select features by rectangle");
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + 5, box!.y + 5);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width - 5, box!.y + box!.height - 5, { steps: 8 });
    await page.mouse.up();
    await expect(canvas).not.toHaveCSS("cursor", "crosshair");

    await row.locator('button[aria-label="Layer actions"]').click();
    await expect(
      page.getByRole("menuitem", { name: "Zoom to Selection", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await page.screenshot({ path: testInfo.outputPath(`mapbox-feature-selection-${theme}.png`) });
  });
}
