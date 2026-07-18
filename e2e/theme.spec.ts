import { expect, test } from "@playwright/test";
import { dropGeoJson, layerRow, readFixture, waitForMap } from "./helpers";

const FIXTURE_TEXT = readFixture("smoke.geojson");
const FIXTURE_FEATURE_COUNT = (JSON.parse(FIXTURE_TEXT) as { features: unknown[] }).features.length;

/**
 * Dark theme is the app's most theme-sensitive surface and ships changes
 * constantly, yet the rest of the E2E suite runs light-only. The documented
 * `?theme=dark` embed parameter sets the initial theme with no click-through
 * (see useThemeMode), so this drives the core flow — map, layer panel, and
 * attribute table — entirely in dark mode as a regression guard against dark
 * theme breaking the app shell or the data path.
 */
test("loads a layer and opens the attribute table in dark theme", async ({ page }) => {
  await waitForMap(page, "/?theme=dark");

  // The theme applies as `class="dark"` on <html> with a matching color-scheme.
  await expect(page.locator("html")).toHaveClass(/(^|\s)dark(\s|$)/);
  await expect(page.locator("html")).toHaveAttribute("style", /dark/);

  // Core data path must work unchanged under the dark theme.
  await dropGeoJson(page, "smoke", FIXTURE_TEXT);
  const row = layerRow(page, "smoke");
  await expect(row).toBeVisible();

  await row.locator('button[aria-label="Layer actions"]').click();
  await page.getByRole("menuitem", { name: "Open attribute table" }).click();
  await expect(page.getByTestId("attribute-table")).toBeVisible();
  await expect(page.locator('[data-testid="attribute-table"] tbody tr')).toHaveCount(
    FIXTURE_FEATURE_COUNT,
  );
});
