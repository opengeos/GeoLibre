import { expect, test } from "./test";
import { dropGeoJson, layerRow, waitForMap } from "./helpers";

/**
 * The attribute table's vertical scrollbar overlays the viewport's end edge;
 * the last column must leave room for it so right-aligned numbers in that
 * column are not hidden underneath it.
 */
test("the attribute table's last column clears the vertical scrollbar", async ({ page }) => {
  const features = Array.from({ length: 60 }, (_, i) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [i * 0.1, 0] },
    properties: { NAME: `n${i}`, ALAND: 4845023362 + i, AWATER: 260307928 + i },
  }));
  await waitForMap(page);
  await dropGeoJson(page, "big", JSON.stringify({ type: "FeatureCollection", features }));
  await layerRow(page, "big").locator('button[aria-label="Layer actions"]').click();
  await page.getByRole("menuitem", { name: "Open attribute table" }).click();
  const table = page.getByTestId("attribute-table");
  await expect(table).toBeVisible();
  const r = await page.evaluate(() => {
    const tableEl = document.querySelector('[data-testid="attribute-table"]')!;
    // The table's own ScrollArea scrollbar, not some other vertical widget.
    const bar = tableEl
      .closest("[data-radix-scroll-area-viewport]")!
      .parentElement!.querySelector(':scope > [data-orientation="vertical"]')!
      .getBoundingClientRect();
    const span = tableEl.querySelector("tbody tr:nth-child(2) td:last-child span")!;
    const range = document.createRange();
    range.selectNodeContents(span);
    return {
      barLeft: bar.left,
      textRight: range.getBoundingClientRect().right,
      text: span.textContent,
    };
  });
  expect(r.textRight).toBeLessThanOrEqual(r.barLeft);
});
