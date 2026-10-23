import { expect, test } from "./test";
import { dropGeoJson, layerRow, readFixture, waitForMap } from "./helpers";

const VALID_TEXT = readFixture("smoke.geojson");
const MALFORMED_TEXT = readFixture("malformed.geojson");

/**
 * The E2E suite only ever exercised valid inputs, so a regression that turned a
 * parse failure into a crash (or a phantom empty layer) would slip through. This
 * drops a truncated, unparseable `.geojson` and asserts the app stays alive and
 * adds no layer, then drops a valid file to prove it recovered and remains
 * usable — the failure must be contained, not fatal.
 */
test("rejects a malformed GeoJSON drop and stays usable", async ({ page }) => {
  await waitForMap(page);

  await dropGeoJson(page, "malformed", MALFORMED_TEXT);

  // Synchronize on a positive signal: the import-error notification (a warning
  // toast) appears once the async parse pipeline has actually run and failed.
  // Asserting the negative row count only after this avoids the trivial
  // "passes because the row never existed yet" race the reviewers flagged.
  await expect(
    page.locator('[data-testid="notification"][data-kind="warning"]').first(),
  ).toBeVisible();
  await expect(layerRow(page, "malformed")).toHaveCount(0);
  // The app shell survived the failure — the map is still mounted.
  await expect(page.getByTestId("map-canvas")).toBeVisible();

  // Recovery: a subsequent valid drop still loads, proving the failed parse did
  // not wedge the drop pipeline or the store.
  await dropGeoJson(page, "recovered", VALID_TEXT);
  await expect(layerRow(page, "recovered")).toBeVisible();
});
