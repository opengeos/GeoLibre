import { expect, test, type Page } from "@playwright/test";
import { dropGeoJson, layerRow, readFixture, waitForMap } from "./helpers";

const FIXTURE_TEXT = readFixture("smoke.geojson");

/** Ordered `data-layer-name` values of the layer rows currently in the panel. */
async function layerOrder(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid="layer-row"]')
    .evaluateAll((rows) => rows.map((r) => r.getAttribute("data-layer-name") ?? ""));
}

/**
 * The layer panel is one of the highest-churn surfaces yet only its visibility
 * toggle and attribute-table entry were covered (smoke.spec). This exercises the
 * two remaining destructive/reordering interactions — Move up reordering and the
 * confirm-gated Remove — against two real layers, so a regression in reorder
 * math or in the removal confirm flow is caught.
 */
test("reorders layers and removes one through the confirm dialog", async ({ page }) => {
  await waitForMap(page);

  // Two layers so reorder has something to swap.
  await dropGeoJson(page, "aaa", FIXTURE_TEXT);
  await expect(layerRow(page, "aaa")).toBeVisible();
  await dropGeoJson(page, "bbb", FIXTURE_TEXT);
  await expect(layerRow(page, "bbb")).toBeVisible();

  // Reorder: moving the lower of the two up must flip their relative order.
  // Asserting the swap (rather than a fixed direction) is agnostic to whether
  // the panel lists top-of-stack first or last.
  const initial = (await layerOrder(page)).filter((n) => ["aaa", "bbb"].includes(n));
  expect(initial).toHaveLength(2);
  const [top, bottom] = initial;

  await layerRow(page, bottom).locator('button[aria-label="Move up"]').click();

  await expect
    .poll(async () => (await layerOrder(page)).filter((n) => ["aaa", "bbb"].includes(n)))
    .toEqual([bottom, top]);

  // Remove one layer through the confirm dialog; the other must survive.
  await layerRow(page, "aaa").locator('button[aria-label="Remove layer"]').click();
  const dialog = page.getByRole("dialog", { name: "Remove layer?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Remove", exact: true }).click();

  await expect(layerRow(page, "aaa")).toHaveCount(0);
  await expect(layerRow(page, "bbb")).toBeVisible();
});

test("long layer names truncate without widening the layer panel", async ({ page }) => {
  await waitForMap(page);
  await dropGeoJson(page, "short-name", FIXTURE_TEXT);

  const row = layerRow(page, "short-name");
  const panel = page.getByRole("complementary", { name: "Layers" });
  const panelBoxBefore = await panel.boundingBox();
  expect(panelBoxBefore).not.toBeNull();
  await row.getByTitle("Double-click to rename").dblclick();
  const renameInput = page.getByRole("textbox", { name: "Rename short-name" });
  await renameInput.fill(
    "This is an exceptionally long vector layer name that should truncate cleanly",
  );
  await renameInput.press("Enter");

  const renamedRow = layerRow(
    page,
    "This is an exceptionally long vector layer name that should truncate cleanly",
  );
  const name = renamedRow.getByTitle("Double-click to rename");
  const typeBadge = renamedRow.getByText("vector", { exact: true });
  const opacitySlider = renamedRow.getByRole("slider");

  await expect(renamedRow).toBeVisible();
  await expect(name).toHaveCSS("text-overflow", "ellipsis");
  await expect(typeBadge).toBeVisible();
  await expect(opacitySlider).toBeVisible();
  await expect
    .poll(async () => {
      const [rowBox, panelBox, typeBadgeBox, opacitySliderBox, viewportWidth] = await Promise.all([
        renamedRow.boundingBox(),
        panel.boundingBox(),
        typeBadge.boundingBox(),
        opacitySlider.boundingBox(),
        page.evaluate(() => window.innerWidth),
      ]);
      return Boolean(
        rowBox &&
        panelBox &&
        typeBadgeBox &&
        opacitySliderBox &&
        panelBoxBefore &&
        panelBox.x === panelBoxBefore.x &&
        panelBox.width === panelBoxBefore.width &&
        panelBox.x >= 0 &&
        panelBox.x + panelBox.width <= viewportWidth &&
        rowBox.x >= panelBox.x &&
        rowBox.x + rowBox.width <= panelBox.x + panelBox.width &&
        typeBadgeBox.x >= rowBox.x &&
        typeBadgeBox.x + typeBadgeBox.width <= rowBox.x + rowBox.width &&
        opacitySliderBox.x >= rowBox.x &&
        opacitySliderBox.x + opacitySliderBox.width <= rowBox.x + rowBox.width,
      );
    })
    .toBe(true);
  await expect
    .poll(() => name.evaluate((element) => element.scrollWidth > element.clientWidth))
    .toBe(true);
});

test("opens the selected layer in the Style panel from its card", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 720 });
  await waitForMap(page);
  await dropGeoJson(page, "first", FIXTURE_TEXT);
  await expect(layerRow(page, "first")).toBeVisible();
  await dropGeoJson(page, "second", FIXTURE_TEXT);
  await expect(layerRow(page, "second")).toBeVisible();

  // Exact, so the collapsed rail ("Layer style (collapsed)") cannot satisfy the
  // default substring match.
  const stylePanel = page.getByRole("complementary", { name: "Layer style", exact: true });
  await expect(stylePanel).toHaveCount(0);

  await layerRow(page, "first").getByRole("button", { name: "Open Style panel" }).click();

  await expect(stylePanel).toBeVisible();
  await expect(stylePanel.getByText("Style - first", { exact: true })).toBeVisible();
});

test("opens the Style panel from the layer card by keyboard", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 720 });
  await waitForMap(page);
  await dropGeoJson(page, "first", FIXTURE_TEXT);
  await expect(layerRow(page, "first")).toBeVisible();
  await dropGeoJson(page, "second", FIXTURE_TEXT);
  await expect(layerRow(page, "second")).toBeVisible();

  const stylePanel = page.getByRole("complementary", { name: "Layer style", exact: true });
  const styleButton = (name: string) =>
    layerRow(page, name).getByRole("button", { name: "Open Style panel" });

  // The card is a role="button" wrapper; its key handler must not swallow the
  // activation of the action buttons nested inside it.
  await styleButton("first").focus();
  await page.keyboard.press("Enter");
  await expect(stylePanel).toBeVisible();
  await expect(stylePanel.getByText("Style - first", { exact: true })).toBeVisible();

  await styleButton("second").focus();
  await page.keyboard.press("Space");
  await expect(stylePanel.getByText("Style - second", { exact: true })).toBeVisible();
});
