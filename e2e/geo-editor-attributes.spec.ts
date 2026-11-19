import { expect, test, type Page } from "./test";
import { layerRow, waitForMap } from "./helpers";

/** Close the automatically opened properties form without changing any values. */
async function closeProperties(page: Page) {
  const panel = page.locator("[data-panel-body]").locator("..");
  if (await panel.isVisible()) {
    await panel.getByRole("button", { name: "Close", exact: true }).click();
  }
}

/** Return polygon vertex positions inside the current map viewport. */
async function vertices(page: Page) {
  const box = await page.locator(".maplibregl-canvas").boundingBox();
  if (!box) throw new Error("Map canvas is unavailable");
  return [
    [0.3, 0.35],
    [0.55, 0.35],
    [0.45, 0.6],
    [0.3, 0.35],
  ].map(([x, y]) => ({ x: box.x + box.width * x, y: box.y + box.height * y }));
}

test("Sketches attribute saves preserve unfinished drawing and GeoEditor undo history", async ({
  page,
}) => {
  await waitForMap(page);
  await page.getByRole("button", { name: "GeoEditor", exact: true }).click();
  await page.getByRole("button", { name: "Rectangle", exact: true }).click();
  const rectangle = await vertices(page);
  for (const point of [rectangle[0], rectangle[2]]) await page.mouse.click(point.x, point.y);
  await closeProperties(page);
  await page.getByRole("button", { name: "Collapse toolbar", exact: true }).click();
  await layerRow(page, "Sketches").getByRole("button", { name: "Layer actions" }).click();
  await page.getByRole("menuitem", { name: "Open attribute table", exact: true }).click();
  const table = page.getByTestId("attribute-table");
  await expect(table).toBeVisible();
  await expect(table.getByRole("columnheader").filter({ hasText: "__gm_" })).toHaveCount(0);
  await page.getByRole("button", { name: "Add field", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add field", exact: true });
  await dialog.getByRole("textbox", { name: "Field name", exact: true }).fill("category");
  await dialog.getByRole("textbox", { name: "Default value", exact: true }).fill("Original");
  await dialog.getByRole("button", { name: "Add field", exact: true }).click();

  // Leave a second polygon unfinished while saving an attribute on the first.
  await page.getByRole("button", { name: "Expand toolbar", exact: true }).click();
  await page.getByRole("button", { name: "Polygon", exact: true }).click();
  const points = await vertices(page);
  for (const point of points.slice(0, 2)) await page.mouse.click(point.x, point.y);
  await page.getByRole("button", { name: "Edit attribute values", exact: true }).click();
  await page
    .getByRole("textbox", { name: /^Edit category for feature / })
    .first()
    .fill("Updated");
  await page.getByRole("button", { name: "Save attribute edits", exact: true }).click();
  for (const point of points.slice(2)) await page.mouse.click(point.x, point.y);
  const status = page.getByTestId("attribute-table-status");
  await expect(status).toContainText("2 features");
  // Completing the drawing flushes Geoman's collection back into the store;
  // this value survives only if the earlier table edit reached the editor.
  await expect(table.getByRole("cell", { name: "Updated", exact: true })).toBeVisible();
  await closeProperties(page);
  await page.getByRole("button", { name: /^Undo/ }).click();
  await expect(status).toContainText("1 feature");
  await page.getByRole("button", { name: /^Redo/ }).click();
  await expect(status).toContainText("2 features");
  await expect(table.getByRole("cell", { name: "Updated", exact: true })).toBeVisible();
});
