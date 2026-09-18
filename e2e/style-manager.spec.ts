import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { dropGeoJson, readFixture, waitForMap } from "./helpers";

async function openStyleManager(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("menuitem", { name: "Style Manager", exact: true }).click();
  return page.getByRole("region", { name: "Style Manager", exact: true });
}

for (const theme of ["light", "dark"]) {
  test(`style preset rename preserves styles and persists in ${theme} mode`, async ({ page }) => {
    // Two app boots plus the full editing/export flow can exceed 60s on CI's
    // shared software-rendered browser workers. Keep assertion timeouts unchanged.
    test.setTimeout(120_000);
    // Capture the exported bytes through the browser download fallback.
    await page.addInitScript(() => {
      // @ts-expect-error - removing the optional API selects the fallback path
      delete window.showSaveFilePicker;
    });
    await waitForMap(page, `/?theme=${theme}`);
    await dropGeoJson(page, "Cities", readFixture("smoke.geojson"));
    const panel = await openStyleManager(page);
    await panel.getByRole("button", { name: "Save current style…" }).click();
    await panel.getByLabel("Name", { exact: true }).fill("Original preset");
    await panel.getByRole("button", { name: "Save style", exact: true }).click();

    const exportLibrary = async () => {
      const downloading = page.waitForEvent("download");
      await panel.getByRole("button", { name: "Export…", exact: true }).click();
      const download = await downloading;
      return JSON.parse(await readFile((await download.path())!, "utf8"));
    };
    const before = await exportLibrary();
    await panel.getByText("Original preset", { exact: true }).dblclick();
    let editor = panel.getByRole("textbox", { name: "Rename Original preset" });
    await expect(editor).toBeFocused();
    await editor.fill("  Renamed preset  ");
    await editor.press("Enter");
    await expect(panel.getByText("Renamed preset", { exact: true })).toBeVisible();

    const row = panel.getByRole("listitem").filter({ hasText: "Renamed preset" });
    await row.getByRole("button", { name: "Preset actions" }).click();
    await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
    editor = panel.getByRole("textbox", { name: "Rename Renamed preset" });
    await expect(editor).toBeFocused();
    await editor.fill("Cancelled");
    await editor.press("Escape");
    await expect(panel).toBeVisible();
    await expect(row).toBeVisible();

    await row.getByText("Renamed preset", { exact: true }).dblclick();
    await editor.fill("   ");
    await editor.press("Enter");
    await expect(row).toBeVisible();
    await row.getByText("Renamed preset", { exact: true }).dblclick();
    await editor.fill("Final preset");
    await panel.getByRole("textbox", { name: "Search styles and tags…" }).click();
    await expect(panel.getByText("Final preset", { exact: true })).toBeVisible();

    const builtIn = panel.getByRole("listitem").filter({ hasText: "Boundary outline (bold)" });
    await expect(builtIn.getByRole("button", { name: "Preset actions" })).toHaveCount(0);
    await builtIn.getByText("Boundary outline (bold)", { exact: true }).dblclick();
    await expect(panel.getByRole("textbox", { name: /Rename/ })).toHaveCount(0);

    const after = await exportLibrary();
    expect(after.entries).toEqual([{ ...before.entries[0], name: "Final preset" }]);
    page.on("dialog", (dialog) => dialog.accept());
    await page.reload();
    await openStyleManager(page);
    await expect(panel.getByText("Final preset", { exact: true })).toBeVisible();
    await panel.getByRole("textbox", { name: "Search styles and tags…" }).fill("Final preset");
    await expect(panel.getByRole("listitem")).toHaveCount(1);
    await panel.getByRole("button", { name: "Preset actions" }).click();
    await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
    await expect(panel.getByRole("listitem")).toHaveCount(0);
  });
}
