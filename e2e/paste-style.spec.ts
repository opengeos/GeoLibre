import { expect, test } from "@playwright/test";
import { dropGeoJson, layerRow, readFixture, waitForMap } from "./helpers";

const FIXTURE_TEXT = readFixture("smoke.geojson");

/** A stacked Mapbox GL style: two classes carry a colour, one deliberately does not. */
const STACKED_STYLE = JSON.stringify({
  version: 8,
  sources: {},
  layers: [
    {
      id: "north",
      type: "circle",
      source: "s",
      filter: ["==", ["get", "category"], "north"],
      paint: { "circle-color": "#4ce600" },
    },
    {
      id: "south",
      type: "circle",
      source: "s",
      filter: ["==", ["get", "category"], "south"],
      paint: { "circle-color": "#e60000" },
    },
  ],
});

/**
 * Pasting a style, rather than being made to save it to a file first.
 *
 * The reading itself is unit-tested (`tests/style-import.test.ts`); what needs a browser is the
 * dialog around it — that a failure keeps the pasted text instead of losing it, and that the two
 * doors into it behave the same way.
 */
test("a pasted style reaches the layer, and a bad one keeps the text", async ({ page }) => {
  await waitForMap(page);
  await dropGeoJson(page, "smoke", FIXTURE_TEXT);

  const row = layerRow(page, "smoke");
  await expect(row).toBeVisible();
  await row.locator('button[aria-label="Layer actions"]').click();
  await page.getByRole("menuitem", { name: "Styles", exact: true }).click();
  await page.getByRole("menuitem", { name: "Import style from text…" }).click();

  const box = page.getByRole("textbox", { name: "Import style from text…" });
  await expect(box).toBeVisible();
  // Nothing to import yet, so the button stays out of reach.
  await expect(page.getByRole("button", { name: "Import", exact: true })).toBeDisabled();

  // A failure is reported in the dialog and the text survives it: the user is looking straight at
  // the box, and closing on an error would throw away what they pasted.
  await box.fill("this is not a style at all");
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await expect(page.getByText("That is not valid JSON, SLD, or QML.")).toBeVisible();
  await expect(box).toHaveValue("this is not a style at all");

  // The real thing closes the dialog and reports on the layer row. The style stacks two filtered
  // layers of one type, which imports as rules rather than a single symbol.
  await box.fill(STACKED_STYLE);
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await expect(box).toBeHidden();
  await expect(row).toContainText("Style imported.");
  // The parser could not carry every paint property across, and says so. Asserted rather than
  // left to the success text alone: a warning that stops being appended is the failure this
  // reporting exists to prevent, and "Style imported." alone would not notice.
  await expect(row).toContainText("were combined as rules");
});

/** The Style panel is the other door, and must gate and behave identically. */
test("the Style panel offers the same paste box", async ({ page }) => {
  await waitForMap(page);
  await dropGeoJson(page, "smoke", FIXTURE_TEXT);

  const row = layerRow(page, "smoke");
  await row.locator('button[aria-label="Open Style panel"]').click();

  await page.getByRole("button", { name: "Import style from text…" }).click();
  const box = page.getByRole("textbox", { name: "Import style from text…" });
  await expect(box).toBeVisible();
  // Opened fresh, not carrying anything a previous paste left behind.
  await expect(box).toHaveValue("");

  await box.fill(STACKED_STYLE);
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await expect(box).toBeHidden();
  // This panel has no per-layer row to write to, so the import reports itself here — including
  // whatever the parser could not represent.
  const notice = page.getByTestId("style-paste-notice");
  await expect(notice).toContainText("Style imported.");
  await expect(notice).toContainText("were combined as rules");
});
