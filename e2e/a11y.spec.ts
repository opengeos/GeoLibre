import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURE_TEXT = readFileSync(
  join(__dirname, "fixtures", "smoke.geojson"),
  "utf8",
);

// Known, pre-existing serious issue tracked as a separate follow-up: the layer
// panel renders each row as a `role="button"` card that wraps interactive
// children (visibility toggle, opacity slider, actions menu), which axe flags
// as `nested-interactive`. The rows are already keyboard-operable; removing the
// nesting needs a layer-panel interaction redesign. It is allowlisted here so
// the suite still fails on any *new* serious/critical regression.
const ALLOWED_SERIOUS = new Set<string>(["nested-interactive"]);

async function waitForMap(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("map-canvas")).toBeVisible();
  await expect(page.locator(".maplibregl-canvas")).toBeVisible({
    timeout: 30_000,
  });
}

async function dropFixtureLayer(page: Page): Promise<void> {
  const dataTransfer = await page.evaluateHandle((contents) => {
    const dt = new DataTransfer();
    dt.items.add(
      new File([contents], "smoke.geojson", { type: "application/geo+json" }),
    );
    return dt;
  }, FIXTURE_TEXT);
  for (const type of ["dragenter", "dragover", "drop"]) {
    await page.dispatchEvent('[data-testid="map-canvas"]', type, {
      dataTransfer,
    });
  }
  await dataTransfer.dispose();
  await page
    .locator('[data-testid="layer-row"][data-layer-name="smoke"]')
    .waitFor();
}

/**
 * Run axe against the current screen and fail on any critical violation, or any
 * serious violation that isn't on the documented allowlist. Moderate/minor
 * findings are attached for review but don't fail the build. Every screen's
 * full violation list is attached as a test artifact.
 */
async function expectAccessible(
  page: Page,
  label: string,
  testInfo: TestInfo,
): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).analyze();
  await testInfo.attach(`axe-${label}`, {
    body: JSON.stringify(violations, null, 2),
    contentType: "application/json",
  });
  const blocking = violations.filter(
    (v) =>
      v.impact === "critical" ||
      (v.impact === "serious" && !ALLOWED_SERIOUS.has(v.id)),
  );
  expect(
    blocking,
    `${label} — blocking a11y violations: ${
      blocking.map((v) => `${v.impact}/${v.id}`).join(", ") || "none"
    }`,
  ).toEqual([]);
}

test("no critical/serious axe violations across key screens", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);

  await waitForMap(page);
  await expectAccessible(page, "initial", testInfo);

  await dropFixtureLayer(page);
  await expectAccessible(page, "layer-loaded", testInfo);

  // Attribute table. The layer-actions menu intentionally stays open after a
  // selection, and an open modal menu aria-hides the background, so close it
  // before scanning the table's resting state.
  const row = page.locator('[data-testid="layer-row"][data-layer-name="smoke"]');
  await row.locator('button[aria-label="Layer actions"]').click();
  await page.getByRole("menuitem", { name: "Open attribute table" }).click();
  await expect(page.getByTestId("attribute-table")).toBeVisible();
  await page.keyboard.press("Escape");
  await page
    .locator("[data-radix-popper-content-wrapper]")
    .waitFor({ state: "detached" });
  await expectAccessible(page, "attribute-table", testInfo);

  // Command palette (Ctrl/Cmd-K).
  await page.keyboard.press("Control+KeyK");
  await expect(page.getByPlaceholder("Search commands…")).toBeVisible();
  await expectAccessible(page, "command-palette", testInfo);
  await page.keyboard.press("Escape");
  await expect(page.getByPlaceholder("Search commands…")).toBeHidden();

  // Keyboard shortcuts cheat sheet (?).
  await page.keyboard.press("?");
  await expect(
    page.getByRole("heading", { name: "Keyboard shortcuts" }),
  ).toBeVisible();
  await expectAccessible(page, "shortcuts-dialog", testInfo);
});
