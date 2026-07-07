import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dropGeoJson, layerRow, waitForMap } from "./helpers";

const VALID_TEXT = readFileSync(
  join(__dirname, "fixtures", "smoke.geojson"),
  "utf8",
);
const MALFORMED_TEXT = readFileSync(
  join(__dirname, "fixtures", "malformed.geojson"),
  "utf8",
);

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

  // No layer row should ever appear for the bad file. Give the async parse path
  // time to run and fail rather than racing it.
  await expect(layerRow(page, "malformed")).toHaveCount(0);
  // The app shell survived the failure — the map is still mounted.
  await expect(page.getByTestId("map-canvas")).toBeVisible();

  // Recovery: a subsequent valid drop still loads, proving the failed parse did
  // not wedge the drop pipeline or the store.
  await dropGeoJson(page, "recovered", VALID_TEXT);
  await expect(layerRow(page, "recovered")).toBeVisible();
});
