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
