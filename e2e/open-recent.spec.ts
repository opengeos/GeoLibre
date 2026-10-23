import { expect, test } from "./test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dropGeoJson, layerRow, readFixture, waitForMap } from "./helpers";

test("reopens a project saved on the web from Open Recent via the file picker", async ({
  page,
}) => {
  await page.addInitScript(() => {
    delete (window as unknown as Record<string, unknown>).showSaveFilePicker;
    delete (window as unknown as Record<string, unknown>).showOpenFilePicker;
  });

  const dir = await mkdtemp(join(tmpdir(), "geolibre-recent-"));
  try {
    await waitForMap(page);
    await dropGeoJson(page, "smoke", readFixture("smoke.geojson"));
    await expect(layerRow(page, "smoke")).toBeVisible();

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Project" }).click();
    await page.getByRole("menuitem", { name: "Save", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
    const download = await downloadPromise;
    const fileName = download.suggestedFilename();
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const savedPath = join(dir, fileName);
    await writeFile(savedPath, Buffer.concat(chunks));

    await waitForMap(page);
    await expect(layerRow(page, "smoke")).toHaveCount(0);

    const chooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Project" }).click();
    await page.getByRole("menuitem", { name: "Open Recent" }).click();
    await page.getByRole("menuitem").filter({ hasText: fileName }).first().click();
    const chooser = await chooserPromise;
    await chooser.setFiles(savedPath);

    await expect(layerRow(page, "smoke")).toBeVisible();
    await expect(
      page.getByText("Recent local projects can only be reopened in GeoLibre Desktop."),
    ).toHaveCount(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
