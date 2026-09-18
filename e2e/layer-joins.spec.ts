import { expect, test } from "@playwright/test";
import * as XLSX from "@e965/xlsx";
import { dropGeoJson, layerRow, readFixture, waitForMap } from "./helpers";

for (const format of ["csv", "xlsx"]) {
  test(`joins a local ${format} table without coordinates`, async ({ page }) => {
    await waitForMap(page);
    await dropGeoJson(page, "target", readFixture("smoke.geojson"));
    await layerRow(page, "target").getByRole("button", { name: "Open Style panel" }).click();
    const joins = page.getByTestId("layer-joins-section");
    await expect(joins.getByRole("button", { name: "Add join", exact: true })).toBeEnabled();
    await joins.getByRole("button", { name: "Add join", exact: true }).click();
    const chooser = page.waitForEvent("filechooser");
    await joins.getByRole("button", { name: "Choose file" }).click();
    let buffer = Buffer.from("key,population\nAlpha,100\nCharlie,300\n");
    if (format === "xlsx") {
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(
        workbook,
        XLSX.utils.aoa_to_sheet([["wrong"], ["ignore"]]),
        "Other",
      );
      XLSX.utils.book_append_sheet(
        workbook,
        XLSX.utils.aoa_to_sheet([
          ["key", "population"],
          ["Alpha", 100],
          ["Charlie", 300],
        ]),
        "Population",
      );
      buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
    }
    await (
      await chooser
    ).setFiles({
      name: `population.${format}`,
      mimeType: "application/octet-stream",
      buffer,
    });
    if (format === "xlsx")
      await joins.getByLabel("Worksheet", { exact: true }).selectOption("Population");
    await joins.getByRole("button", { name: "Add layer", exact: true }).click();
    await joins.getByLabel("Join field", { exact: true }).selectOption("key");
    await joins.getByLabel("Target field", { exact: true }).selectOption("name");
    await joins.getByRole("button", { name: "Add", exact: true }).click();
    await expect(joins).toContainText("2 of 3 features matched");
    await layerRow(page, "target")
      .getByRole("button", { name: "Layer actions", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Open attribute table", exact: true }).click();
    const table = page.getByTestId("attribute-table");
    await expect(table).toContainText("population");
    await expect(table.locator("tbody tr").filter({ hasText: "Alpha" })).toContainText("100");
    await expect(table.locator("tbody tr").filter({ hasText: "Charlie" })).toContainText("300");
  });
}
