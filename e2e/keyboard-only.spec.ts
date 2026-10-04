import { expect, test, type Locator, type Page } from "./test";
import { bindMapLibreMap, layerRow, readFixture, waitForMap } from "./helpers";

/**
 * A keyboard-only pass over the core data loop (#2858): add a GeoJSON layer
 * through a URL dialog, restyle it, and export it, with no pointer input at
 * all. Focus moves only by Tab, Enter, arrows and menu type-ahead, so a control
 * that is unreachable or inoperable from the keyboard fails this spec.
 *
 * The OGC API - Features endpoint is served by `page.route`, so the spec is
 * hermetic.
 */

const SERVICE = "https://ogc.a11y.test";
const FEATURES = JSON.parse(readFixture("smoke.geojson")) as {
  type: string;
  features: unknown[];
};

/**
 * Presses Tab until `target` holds focus. Fails if it is not reached within
 * `maxPresses`, i.e. it is not in the tab order.
 */
async function tabTo(page: Page, target: Locator, maxPresses = 80): Promise<void> {
  for (let presses = 0; presses < maxPresses; presses += 1) {
    // A short per-check timeout: a target not rendered yet counts as not
    // focused, so the loop keeps pressing Tab instead of stalling here.
    const focused = await target
      .evaluate((element) => element === document.activeElement, undefined, { timeout: 1_000 })
      .catch(() => false);
    if (focused) return;
    await page.keyboard.press("Tab");
  }
  await expect(target, `not reached within ${maxPresses} Tab presses`).toBeFocused();
}

test("adds, restyles and exports a GeoJSON layer with the keyboard alone", async ({ page }) => {
  test.setTimeout(120_000);
  // The anchor-download fallback, so the export lands as a download event.
  await page.addInitScript(() => {
    // @ts-expect-error - removing the optional API selects the fallback path
    delete window.showSaveFilePicker;
  });
  await page.route(`${SERVICE}/collections/cities/items*`, (route) =>
    route.fulfill({
      contentType: "application/geo+json",
      json: { ...FEATURES, numberReturned: FEATURES.features.length },
    }),
  );
  await waitForMap(page);

  // Add Data → OGC API - Features, reached by Tab and menu type-ahead.
  await tabTo(page, page.getByRole("button", { name: "Add Data", exact: true }));
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu", { name: "Add Data" })).toBeVisible();
  await page.keyboard.type("OGC A");
  await expect(page.getByRole("menuitem", { name: "OGC API - Features" })).toBeFocused();
  await page.keyboard.press("Enter");

  const dialog = page.getByRole("dialog", { name: "Add OGC API - Features Layer" });
  await expect(dialog).toBeVisible();
  await tabTo(page, dialog.getByRole("textbox", { name: "Layer name" }));
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("cities");
  // A collection URL names the collection itself; Enter submits the form.
  await tabTo(page, dialog.getByRole("textbox", { name: "Service URL" }));
  await page.keyboard.type(`${SERVICE}/collections/cities`);
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  const row = layerRow(page, "cities");
  await expect(row).toBeVisible();

  // Select the layer from its name button, then open its Style panel.
  const selectButton = row.getByRole("button", { name: "cities", exact: true });
  await tabTo(page, selectButton);
  await page.keyboard.press("Enter");
  await expect(selectButton).toHaveAttribute("aria-pressed", "true");
  await tabTo(page, row.getByRole("button", { name: "Open Style panel" }));
  await page.keyboard.press("Enter");

  // The fixture is points, so the circle radius is the style to change. (The
  // colour fields are native colour inputs, whose picker is OS chrome.)
  const stylePanel = page.getByRole("complementary", { name: "Layer style" });
  const radius = stylePanel.getByRole("spinbutton", { name: "Circle radius" });
  await tabTo(page, radius, 120);
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("9");
  await page.keyboard.press("Tab");
  await expect(radius).toHaveValue("9");
  // The edit reached the map, not just the field.
  await bindMapLibreMap(page);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const map = window.__geolibreTestMap as unknown as {
          getStyle(): { layers: Array<{ type: string; paint?: Record<string, unknown> }> };
        };
        return map
          .getStyle()
          .layers.some((layer) => layer.type === "circle" && layer.paint?.["circle-radius"] === 9);
      }),
    )
    .toBe(true);

  // Layer actions → Export → GeoJSON.
  await tabTo(page, row.getByRole("button", { name: "Layer actions" }), 120);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu", { name: "Layer actions" })).toBeVisible();
  await page.keyboard.type("Exp");
  await expect(page.getByRole("menuitem", { name: "Export", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  const geojsonItem = page.getByRole("menuitem", { name: "GeoJSON", exact: true });
  await expect(geojsonItem).toBeFocused();
  const downloading = page.waitForEvent("download", { timeout: 60_000 });
  await page.keyboard.press("Enter");
  const download = await downloading;
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const exported = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
    type: string;
    features: unknown[];
  };
  expect(exported.type).toBe("FeatureCollection");
  expect(exported.features).toHaveLength(FEATURES.features.length);
});
