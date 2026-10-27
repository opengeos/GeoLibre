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
  await tabTo(page, page.getByRole("button", { name: "Add data", exact: true }));
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu", { name: "Add data" })).toBeVisible();
  await page.keyboard.type("OGC A");
  await expect(page.getByRole("menuitem", { name: "OGC API - Features" })).toBeFocused();
  await page.keyboard.press("Enter");

  const dialog = page.getByRole("dialog", { name: "Add OGC API - Features layer" });
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

test("moves across the top menus with the arrow keys (#3232)", async ({ page }) => {
  await waitForMap(page);
  const banner = page.getByRole("banner");
  const project = banner.getByRole("button", { name: "Project", exact: true });
  const edit = banner.getByRole("button", { name: "Edit", exact: true });
  const view = banner.getByRole("button", { name: "View", exact: true });

  // Closed: Right/Left move focus between the top-level menus.
  await project.focus();
  await page.keyboard.press("ArrowRight");
  await expect(edit).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(project).toBeFocused();

  // Open: Right closes the current menu and opens the next one.
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu", { name: "Project" })).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("menu", { name: "Edit" })).toBeVisible();
  await expect(page.getByRole("menu", { name: "Project" })).toHaveCount(0);
  await page.keyboard.press("ArrowRight");
  const viewMenu = page.getByRole("menu", { name: "View", exact: true });
  await expect(viewMenu).toBeVisible();

  // On a submenu trigger, Right/Left open and close the submenu instead of
  // switching top-level menus.
  const splitView = viewMenu.getByRole("menuitem", { name: "Split view" });
  await splitView.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("menu", { name: "Split view" })).toBeVisible();
  await expect(viewMenu).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("menu", { name: "Split view" })).toHaveCount(0);
  await expect(viewMenu).toBeVisible();
  await expect(splitView).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(view).toBeFocused();
});

test("wraps, jumps with Home/End, and leaves text fields alone (#3232)", async ({ page }) => {
  await waitForMap(page);
  // Not getByRole("banner"): an open (modal) menu hides the header from the
  // accessibility tree.
  const header = page.locator("header");
  // Visible only, matching the handler's own filter.
  const triggers = header.locator('[aria-haspopup="menu"]').filter({ visible: true });
  const first = triggers.first();
  const last = triggers.last();

  // Home/End jump to the ends, and Left/Right wrap around them.
  await header.getByRole("button", { name: "Edit", exact: true }).focus();
  await page.keyboard.press("End");
  await expect(last).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(first).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(last).toBeFocused();
  await page.keyboard.press("Home");
  await expect(first).toBeFocused();

  // Arrow keys in the Processing menu's search field move the caret, not the menu.
  await header.getByRole("button", { name: "Processing", exact: true }).click();
  const processingMenu = page.getByRole("menu", { name: "Processing", exact: true });
  const search = processingMenu.getByRole("combobox", { name: "Search processing tools" });
  await search.fill("buffer");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowRight");
  await expect(search).toBeFocused();
  await expect(page.getByRole("menu")).toHaveCount(1);
  await expect(processingMenu).toBeVisible();

  // A quick second Right while one menu closes and the next opens leaves one
  // menu open with focus inside it, not a menu opened from the stale trigger.
  // Whether the second press lands depends on timing, so the open menu may be
  // the next or the one after; either way it must be the menu focus is in.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await first.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("menu")).toHaveCount(1);
  const second = await triggers.nth(1).getAttribute("aria-label");
  const third = await triggers.nth(2).getAttribute("aria-label");
  // Both labels must exist, or a null poll result would match a null label.
  expect([second, third].every(Boolean)).toBe(true);
  // Compare labels as values, not through a RegExp built from them.
  await expect
    .poll(async () =>
      [second, third].includes(
        await page.evaluate(() => {
          const menu = document.activeElement?.closest('[role="menu"]');
          const owner = document.getElementById(menu?.getAttribute("aria-labelledby") ?? "");
          return owner?.getAttribute("aria-expanded") === "true"
            ? owner.getAttribute("aria-label")
            : null;
        }),
      ),
    )
    .toBe(true);
});

test("mirrors the menu-bar arrow keys in a right-to-left locale (#3232)", async ({ page }) => {
  await waitForMap(page, "/?locale=ar");
  const triggers = page
    .locator("header")
    .locator('[aria-haspopup="menu"]')
    .filter({ visible: true });

  // In RTL the next menu sits to the left, so ArrowLeft moves forward.
  await triggers.nth(0).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(triggers.nth(1)).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(triggers.nth(0)).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu")).toHaveCount(1);
  await page.keyboard.press("ArrowLeft");
  await expect(triggers.nth(1)).toHaveAttribute("aria-expanded", "true");
  await expect(triggers.nth(0)).toHaveAttribute("aria-expanded", "false");
});
