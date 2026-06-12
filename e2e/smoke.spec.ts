import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURE_PATH = join(__dirname, "fixtures", "smoke.geojson");
const FIXTURE_TEXT = readFileSync(FIXTURE_PATH, "utf8");
// Derived from the fixture so the expected row count can't drift if a feature
// is added or removed.
const FIXTURE_FEATURE_COUNT = (
  JSON.parse(FIXTURE_TEXT) as { features: unknown[] }
).features.length;

/** Waits for MapLibre to mount its WebGL canvas — the app's "map ready" signal. */
async function waitForMap(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("map-canvas")).toBeVisible();
  await expect(page.locator(".maplibregl-canvas")).toBeVisible({
    timeout: 30_000,
  });
}

/**
 * Drops a GeoJSON file onto the map surface, exercising the real browser
 * drag-and-drop path (`handleDrop` -> `addGeoJsonLayer`). A `.geojson` file is
 * parsed in-browser with no DuckDB/CDN dependency, so this stays hermetic.
 */
async function dropGeoJson(page: Page, name: string, text: string): Promise<void> {
  // `name` is test-controlled and assumed simple/ASCII: it is the dropped
  // file's base name and, after the drop pipeline strips the extension, the
  // layer name interpolated into the CSS attribute selector below.
  const dataTransfer = await page.evaluateHandle(
    ({ contents, fileName }) => {
      const dt = new DataTransfer();
      dt.items.add(
        new File([contents], fileName, { type: "application/geo+json" }),
      );
      return dt;
    },
    { contents: text, fileName: `${name}.geojson` },
  );
  for (const type of ["dragenter", "dragover", "drop"]) {
    await page.dispatchEvent('[data-testid="map-canvas"]', type, {
      dataTransfer,
    });
  }
  await dataTransfer.dispose();
  await expect(
    page.locator(`[data-testid="layer-row"][data-layer-name="${name}"]`),
  ).toBeVisible();
}

test("loads a GeoJSON layer, opens the attribute table, and toggles visibility", async ({
  page,
}) => {
  await waitForMap(page);

  // 1. Add a layer via drag-and-drop and confirm it appears in the layer panel.
  await dropGeoJson(page, "smoke", FIXTURE_TEXT);
  // dropGeoJson already asserted exactly one row with this name is visible.
  const row = page.locator('[data-testid="layer-row"][data-layer-name="smoke"]');

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

test("has no critical accessibility violations on the initial view", async ({
  page,
}, testInfo) => {
  await waitForMap(page);

  const results = await new AxeBuilder({ page }).analyze();
  await testInfo.attach("axe-violations", {
    body: JSON.stringify(results.violations, null, 2),
    contentType: "application/json",
  });

  // A full a11y gate lands with the accessibility pass (#272); this smoke check
  // guards only against the most severe (critical-impact) regressions.
  const critical = results.violations.filter((v) => v.impact === "critical");
  expect(
    critical,
    `critical a11y violations: ${critical.map((v) => v.id).join(", ") || "none"}`,
  ).toEqual([]);
});
