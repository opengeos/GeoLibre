import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { dropGeoJson, layerRow, readFixture, waitForMap } from "./helpers";

const FIXTURE_TEXT = readFixture("smoke.geojson");

// Same allowlist as a11y.spec.ts: the layer-panel selection cards (including
// the always-present basemap row) are a known, tracked nested-interactive
// finding; any other node still fails the scan.
function isAllowlistedSerious(violation: {
  id: string;
  nodes: Array<{ target: string[]; html: string }>;
}): boolean {
  if (violation.id !== "nested-interactive" || violation.nodes.length === 0) {
    return false;
  }
  return violation.nodes.every((node) => node.html.includes("data-layer-card"));
}

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

  const { violations } = await new AxeBuilder({ page }).analyze();
  await testInfo.attach("axe-rtl-initial", {
    body: JSON.stringify(violations, null, 2),
    contentType: "application/json",
  });
  const blocking = violations.filter(
    (v) => v.impact === "critical" || (v.impact === "serious" && !isAllowlistedSerious(v)),
  );
  expect(
    blocking,
    `rtl shell — blocking a11y violations: ${
      blocking.map((v) => `${v.impact}/${v.id}`).join(", ") || "none"
    }`,
  ).toEqual([]);

  // Core data path must work unchanged under the mirrored layout.
  await dropGeoJson(page, "smoke", FIXTURE_TEXT);
  await expect(layerRow(page, "smoke")).toBeVisible();
});
