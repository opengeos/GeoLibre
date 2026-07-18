import { expect, test } from "@playwright/test";
import { dropGeoJson, layerRow, readFixture, waitForMap } from "./helpers";

const FIXTURE_TEXT = readFixture("smoke.geojson");
// Derived from the fixture so the expected row count can't drift if a feature
// is added or removed.
const FIXTURE_FEATURE_COUNT = (JSON.parse(FIXTURE_TEXT) as { features: unknown[] }).features.length;

test("loads a GeoJSON layer, opens the attribute table, and toggles visibility", async ({
  page,
}) => {
  await waitForMap(page);

  // 1. Add a layer via drag-and-drop and confirm it appears in the layer panel.
  await dropGeoJson(page, "smoke", FIXTURE_TEXT);
  const row = layerRow(page, "smoke");
  await expect(row).toBeVisible();

  // 2. Toggle layer visibility and confirm the control reflects the new state.
  // Done before the actions menu below so no Radix dropdown overlay (which
  // briefly sets pointer-events:none on the body) can intercept the click.
  await row.locator('button[aria-label="Hide layer"]').click();
  await expect(row.locator('button[aria-label="Show layer"]')).toBeVisible();

  // 3. Open the attribute table from the layer actions menu and assert rows.
  // Opening it while the layer is hidden (from step 2) is intentional and fine:
  // the table reads features from the store, not from the rendered map.
  await row.locator('button[aria-label="Layer actions"]').click();
  await page.getByRole("menuitem", { name: "Open attribute table" }).click();
  await expect(page.getByTestId("attribute-table")).toBeVisible();
  await expect(page.locator('[data-testid="attribute-table"] tbody tr')).toHaveCount(
    FIXTURE_FEATURE_COUNT,
  );
});

// The accessibility gate now lives in its own multi-screen suite (a11y.spec.ts,
// added with the #272 accessibility pass).
