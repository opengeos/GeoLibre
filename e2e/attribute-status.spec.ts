import { expect, test } from "@playwright/test";
import { dropGeoJson, layerRow, readFixture, waitForMap } from "./helpers";

const FIXTURE_TEXT = readFixture("smoke.geojson");
const FIXTURE_FEATURE_COUNT = (JSON.parse(FIXTURE_TEXT) as { features: unknown[] }).features.length;

/**
 * The attribute table's status bar: the layer's feature count, how many rows the
 * table is currently showing, and how many features are selected. The "shown"
 * count is deliberately absent until a filter narrows the table, so the ordinary
 * case reads as one number rather than two identical ones.
 */
test("the attribute table status bar reports totals, filtering, and selection", async ({
  page,
}) => {
  await waitForMap(page);
  await dropGeoJson(page, "smoke", FIXTURE_TEXT);

  const row = layerRow(page, "smoke");
  await expect(row).toBeVisible();
  await row.locator('button[aria-label="Layer actions"]').click();
  await page.getByRole("menuitem", { name: "Open attribute table" }).click();
  await expect(page.getByTestId("attribute-table")).toBeVisible();

  const status = page.getByTestId("attribute-table-status");
  await expect(status).toContainText(`${FIXTURE_FEATURE_COUNT} features`);
  await expect(status).toContainText("0 selected");
  // Nothing is filtered, so the redundant "shown" count stays out of the way.
  await expect(status).not.toContainText("shown");

  // Selecting a row is reflected immediately.
  await page.locator('[data-testid="attribute-table"] tbody tr').first().click();
  await expect(status).toContainText("1 selected");

  // A search that matches one feature adds the "shown" count; the total stays
  // the layer's, not the filtered set's.
  await page.getByPlaceholder("Search attributes...").fill("Alpha");
  await expect(status).toContainText("1 shown");
  await expect(status).toContainText(`${FIXTURE_FEATURE_COUNT} features`);

  // Clearing the search puts it back to the unfiltered reading.
  await page.getByPlaceholder("Search attributes...").fill("");
  await expect(status).not.toContainText("shown");
});
