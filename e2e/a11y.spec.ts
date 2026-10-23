import { expect, test, type Page } from "./test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expectAccessible } from "./a11y";

const FIXTURE_TEXT = readFileSync(join(__dirname, "fixtures", "smoke.geojson"), "utf8");

// Nothing is allowlisted here. The layer-panel rows used to be `role="button"`
// cards wrapping their own controls (a serious `nested-interactive` finding);
// they are listitems now, with a dedicated name button for selection (#2858).
// The broader per-dialog sweep lives in a11y-screens.spec.ts (nightly).

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
    dt.items.add(new File([contents], "smoke.geojson", { type: "application/geo+json" }));
    return dt;
  }, FIXTURE_TEXT);
  for (const type of ["dragenter", "dragover", "drop"]) {
    await page.dispatchEvent('[data-testid="map-canvas"]', type, {
      dataTransfer,
    });
  }
  await dataTransfer.dispose();
  await page.locator('[data-testid="layer-row"][data-layer-name="smoke"]').waitFor();
}

test("no critical/serious axe violations across key screens", async ({ page }, testInfo) => {
  // Five sequential axe sweeps over a WebGL app, each one a full-document scan.
  // On CI this lands at 1.8-2.1 min against the old 120s cap, so an ordinarily
  // slow runner pushed it over and the nightly failed on a timeout rather than
  // on a real violation. 240s is the value most of the heavy specs here use and
  // leaves roughly 2x headroom over the worst run observed.
  test.setTimeout(240_000);

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
  await page.locator("[data-radix-popper-content-wrapper]").waitFor({ state: "detached" });
  await expectAccessible(page, "attribute-table", testInfo);

  // Command palette (Ctrl/Cmd-K). The app picks the modifier from the platform
  // (Meta on macOS, Ctrl elsewhere), so match it here for local macOS runs.
  await page.keyboard.press(process.platform === "darwin" ? "Meta+KeyK" : "Control+KeyK");
  await expect(page.getByPlaceholder("Search commands…")).toBeVisible();
  await expectAccessible(page, "command-palette", testInfo);
  await page.keyboard.press("Escape");
  await expect(page.getByPlaceholder("Search commands…")).toBeHidden();

  // Keyboard shortcuts cheat sheet (?).
  await page.keyboard.press("?");
  await expect(page.getByRole("heading", { name: "Keyboard shortcuts" })).toBeVisible();
  await expectAccessible(page, "shortcuts-dialog", testInfo);
});
