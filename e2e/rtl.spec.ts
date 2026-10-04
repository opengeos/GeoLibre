import { expect, test } from "./test";
import { expectAccessible } from "./a11y";
import { dropGeoJson, layerRow, readFixture, waitForMap } from "./helpers";

const FIXTURE_TEXT = readFixture("smoke.geojson");

/**
 * Arabic is the app's first right-to-left locale, and the rest of the E2E
 * suite runs left-to-right only. The documented `?locale=ar` embed parameter
 * sets the initial language with no click-through (see getInitialLanguage),
 * and the languageChanged hook mirrors the document on first paint. This
 * drives the mirrored shell end-to-end as a regression guard: document
 * direction and language, the map controls staying pinned ltr, accessibility
 * of the mirrored chrome, and the data path working unchanged. Locators are
 * test-id based so assertions stay language-neutral.
 */
test("mirrors the document and loads a layer in the Arabic locale", async ({ page }, testInfo) => {
  await waitForMap(page, "/?locale=ar");

  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");

  // MapLibre's own control container opts out of the mirror so its physically
  // anchored controls don't half-flip, while the rest of the map subtree (and
  // app overlays portalled into it, like the story-map presenter) still mirror
  // in RTL (see the .maplibregl-control-container rule in index.css).
  await expect(page.locator(".maplibregl-control-container")).toHaveCSS("direction", "ltr");

  await expectAccessible(page, "rtl-initial", testInfo);

  // Core data path must work unchanged under the mirrored layout.
  await dropGeoJson(page, "smoke", FIXTURE_TEXT);
  await expect(layerRow(page, "smoke")).toBeVisible();
});
