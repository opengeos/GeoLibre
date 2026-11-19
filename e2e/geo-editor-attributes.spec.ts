import { expect, test, type Page } from "./test";
import { bindMapLibreMap, layerRow, waitForMap } from "./helpers";

/** Close the automatically opened properties form without changing any values. */
async function closeProperties(page: Page) {
  const panel = page.locator(".geo-editor-attribute-panel");
  if (
    (await panel.isVisible()) &&
    !(await panel.getAttribute("class"))?.includes("attribute-panel--hidden")
  ) {
    await panel.getByRole("button", { name: "Close", exact: true }).click();
  }
}

/** Wait for Geoman's asynchronous mode activation before sending drawing clicks. */
async function drawMode(page: Page, mode: "Rectangle" | "Polygon") {
  await bindMapLibreMap(page);
  await page.waitForFunction(() => {
    const map = window.__geolibreTestMap as unknown as { gm?: { loaded: boolean } };
    return map.gm?.loaded;
  });
  await page.getByRole("button", { name: mode, exact: true }).click();
  await page.waitForFunction((expected) => {
    const map = window.__geolibreTestMap as unknown as { gm?: { getActiveDrawModes(): string[] } };
    return map.gm?.getActiveDrawModes().includes(expected);
  }, mode.toLowerCase());
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
  await drawMode(page, "Rectangle");
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
  await drawMode(page, "Polygon");
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
  await expect(
    page.locator("[data-panel-body]").getByRole("textbox", { name: "category", exact: true }),
  ).toBeVisible();
  await closeProperties(page);
  await page.getByRole("button", { name: /^Undo/ }).click();
  await expect(status).toContainText("1 feature");
  await page.getByRole("button", { name: /^Redo/ }).click();
  await expect(status).toContainText("2 features");
  await expect(table.getByRole("cell", { name: "Updated", exact: true })).toBeVisible();

  // A subsequent editor-to-store sync must retain a rename and must not
  // resurrect the omitted old property through Geoman's property setter.
  await table.getByRole("button", { name: "Manage field category", exact: true }).click();
  await page.getByRole("menuitem", { name: "Rename field", exact: true }).click();
  const rename = table.getByRole("textbox", { name: "Rename field category", exact: true });
  await rename.fill("land_use");
  await rename.press("Enter");
  await drawMode(page, "Rectangle");
  for (const point of [points[0], points[2]]) await page.mouse.click(point.x, point.y);
  await expect(status).toContainText("3 features");
  await expect(table.getByRole("columnheader").filter({ hasText: "category" })).toHaveCount(0);
  await expect(table.getByRole("columnheader").filter({ hasText: "land_use" })).toHaveCount(1);
  await expect(table.getByRole("cell", { name: "Updated", exact: true })).toBeVisible();
  await closeProperties(page);
});

test("existing vector feature properties commit on session Save and roll back on Cancel", async ({
  page,
}) => {
  const { dropGeoJson } = await import("./helpers");
  await waitForMap(page);
  await dropGeoJson(
    page,
    "Parcels",
    JSON.stringify({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          id: 7,
          properties: { name: "Original", height: 12, active: null, nested: { protected: true } },
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [-101, 39],
                [-99, 39],
                [-99, 41],
                [-101, 41],
                [-101, 39],
              ],
            ],
          },
        },
        {
          type: "Feature",
          id: 8,
          properties: { name: "Other", active: true },
          geometry: { type: "Point", coordinates: [-102, 42] },
        },
      ],
    }),
  );
  const row = layerRow(page, "Parcels");
  await expect(row).toBeVisible();
  await bindMapLibreMap(page);
  await page.getByRole("button", { name: "GeoEditor", exact: true }).click();
  await expect(page.locator(".geo-editor-toolbar")).toBeVisible({ timeout: 30000 });
  async function edit() {
    await row.getByRole("button", { name: "Layer actions" }).click();
    await page.getByRole("menuitem", { name: "Edit geometry", exact: true }).click();
    await expect(row.getByRole("button", { name: "Save", exact: true })).toBeVisible();
    const location = await page.evaluate(() => {
      const map = window.__geolibreTestMap!;
      const point = map.project([-100, 40]);
      const box = map.getCanvas().getBoundingClientRect();
      return { x: point.x + box.x, y: point.y + box.y };
    });
    await page.mouse.click(location.x, location.y);
  }
  async function assertSaved(name: string) {
    await row.getByRole("button", { name: "Layer actions" }).click();
    await page.getByRole("menuitem", { name: "Open attribute table", exact: true }).click();
    await expect(
      page.getByTestId("attribute-table").getByRole("cell", { name, exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Close attribute table", exact: true }).click();
  }
  const panel = page.locator(".geo-editor-attribute-panel");
  await edit();
  await expect(panel.getByRole("textbox", { name: "name", exact: true })).toHaveValue("Original");
  await expect(panel.getByRole("spinbutton", { name: "Height (m)", exact: true })).toHaveValue(
    "12",
  );
  await expect(panel.getByRole("combobox", { name: "active", exact: true })).toHaveValue("");
  await panel.getByRole("textbox", { name: "name", exact: true }).fill("Saved");
  await panel.getByRole("spinbutton", { name: "Height (m)", exact: true }).fill("25");
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  await row.getByRole("button", { name: "Save", exact: true }).click();
  await assertSaved("Saved");
  await edit();
  await expect(panel.getByRole("spinbutton", { name: "Height (m)", exact: true })).toHaveValue(
    "25",
  );
  await expect(panel.getByRole("combobox", { name: "active", exact: true })).toHaveValue("");
  await panel.getByRole("combobox", { name: "active", exact: true }).selectOption("false");
  await panel.getByRole("textbox", { name: "name", exact: true }).fill("Discarded");
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  await row.getByRole("button", { name: "Cancel", exact: true }).click();
  await assertSaved("Saved");
  await edit();
  await expect(panel.getByRole("combobox", { name: "active", exact: true })).toHaveValue("");
  await panel.getByRole("combobox", { name: "active", exact: true }).selectOption("false");
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  await row.getByRole("button", { name: "Save", exact: true }).click();
  await edit();
  await expect(panel.getByRole("combobox", { name: "active", exact: true })).toHaveValue("false");
  await panel.getByRole("button", { name: "Close", exact: true }).click();
  await row.getByRole("button", { name: "Cancel", exact: true }).click();
});

test("Sketches table edits survive another layer's edit session", async ({ page }) => {
  const { dropGeoJson } = await import("./helpers");
  await waitForMap(page);
  await page.getByRole("button", { name: "GeoEditor", exact: true }).click();
  await drawMode(page, "Rectangle");
  let points = await vertices(page);
  for (const point of [points[0], points[2]]) await page.mouse.click(point.x, point.y);
  await closeProperties(page);
  await expect(layerRow(page, "Sketches")).toBeVisible();
  await dropGeoJson(
    page,
    "Other layer",
    JSON.stringify({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          id: 1,
          properties: { name: "Other" },
          geometry: { type: "Point", coordinates: [-100, 40] },
        },
      ],
    }),
  );
  const other = layerRow(page, "Other layer");
  await other.getByRole("button", { name: "Layer actions" }).click();
  await page.getByRole("menuitem", { name: "Edit geometry", exact: true }).click();
  await expect(other.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
  await layerRow(page, "Sketches").getByRole("button", { name: "Layer actions" }).click();
  await page.getByRole("menuitem", { name: "Open attribute table", exact: true }).click();
  await page.getByRole("button", { name: "Add field", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add field", exact: true });
  await dialog.getByRole("textbox", { name: "Field name", exact: true }).fill("category");
  await dialog.getByRole("textbox", { name: "Default value", exact: true }).fill("During session");
  await dialog.getByRole("button", { name: "Add field", exact: true }).click();
  await other.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(other.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
  await drawMode(page, "Rectangle");
  points = await vertices(page);
  for (const point of [points[0], points[2]]) await page.mouse.click(point.x, point.y);
  await expect(page.getByTestId("attribute-table-status")).toContainText("2 features");
  await expect(
    page.getByTestId("attribute-table").getByRole("cell", { name: "During session", exact: true }),
  ).toBeVisible();
  await closeProperties(page);
});
