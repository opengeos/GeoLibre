import { expect, test, type Page } from "@playwright/test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Waits for MapLibre to mount its WebGL canvas — the app's "map ready" signal. */
async function waitForMap(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("map-canvas")).toBeVisible();
  await expect(page.locator(".maplibregl-canvas")).toBeVisible({
    timeout: 30_000,
  });
}

/** Opens Project → Story Map and returns the dialog locator. */
async function openStoryMapPanel(page: Page) {
  await page.getByRole("button", { name: "Project" }).click();
  await page.getByRole("menuitem", { name: "Story Map..." }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Story Map" })).toBeVisible();
  return dialog;
}

/**
 * Verifies the #299 regression: a story map authored in the panel must survive
 * a save-to-file -> reload -> reopen round trip (it was previously dropped from
 * the serialized project because `buildCurrentProject` never read it from the
 * store).
 *
 * Drives the *real* save/open handlers. The File System Access pickers open a
 * native OS dialog Playwright can't touch, so they're removed up front to force
 * the download (save) and `<input type=file>` (open) fallbacks, both drivable.
 */
test("persists a story map across save and reopen", async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as unknown as Record<string, unknown>).showSaveFilePicker;
    delete (window as unknown as Record<string, unknown>).showOpenFilePicker;
  });

  await waitForMap(page);

  // 1. Author a story map by loading the bundled five-city sample.
  let dialog = await openStoryMapPanel(page);
  await dialog.getByRole("button", { name: "Load sample story" }).click();
  await expect(dialog.getByRole("heading", { name: "Chapters (5)" })).toBeVisible();
  await expect(dialog.getByText("San Francisco, California")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();

  // 2. Save the project and capture the downloaded `.geolibre.json`.
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Project" }).click();
  await page.getByRole("menuitem", { name: "Save", exact: true }).click();
  // Browsers without the File System Access picker (deleted above) prompt for a
  // file name before downloading; accept the pre-filled default and confirm.
  await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  expect(downloadPath).toBeTruthy();

  // The serialized project must actually carry the story map (the bug: it didn't).
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const saved = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
    storymap?: { title?: string; chapters?: unknown[] };
  };
  expect(saved.storymap?.title).toBe("A Tour of Five Cities");
  expect(saved.storymap?.chapters).toHaveLength(5);

  // Re-home the download to a stable path so we can feed it back to the picker.
  const dir = await mkdtemp(join(tmpdir(), "geolibre-storymap-"));
  const savedPath = join(dir, "story.geolibre.json");
  await writeFile(savedPath, Buffer.concat(chunks));

  // 3. Reload to a fresh store (no localStorage persistence of project state),
  //    then reopen the saved project through the real file-open flow.
  await waitForMap(page);
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Project" }).click();
  await page.getByRole("menuitem", { name: "Open From" }).click();
  await page.getByRole("menuitem", { name: "File..." }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles(savedPath);

  // 4. The reopened project must render the story map again.
  dialog = await openStoryMapPanel(page);
  await expect(dialog.getByRole("heading", { name: "Chapters (5)" })).toBeVisible();
  await expect(dialog.getByText("San Francisco, California")).toBeVisible();
  // First non-file input is the story Title field (the panel's hidden import
  // file input would otherwise match first).
  await expect(dialog.locator('input:not([type="file"])').first()).toHaveValue(
    "A Tour of Five Cities",
  );
});

/**
 * #917: the exported HTML must render in the same projection as the app (globe
 * by default), not 2D Mercator. #921: with no native save picker, exporting
 * must prompt for a file name first instead of auto-downloading a default.
 */
test("exports the story as a globe HTML page after a name prompt", async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as unknown as Record<string, unknown>).showSaveFilePicker;
  });

  await waitForMap(page);

  const dialog = await openStoryMapPanel(page);
  await dialog.getByRole("button", { name: "Load sample story" }).click();
  await expect(dialog.getByRole("heading", { name: "Chapters (5)" })).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Export HTML" }).click();

  // No native save picker, so a name prompt appears first (#921). Confirm it.
  const prompt = page.getByRole("dialog").filter({ hasText: "Save file as" });
  await expect(prompt).toBeVisible();
  await prompt.getByRole("button", { name: "Save", exact: true }).click();

  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const html = Buffer.concat(chunks).toString("utf8");

  // The exported page must carry and apply the globe projection (#917).
  expect(html).toMatch(/"projection":\s*"globe"/);
  expect(html).toMatch(/setProjection\(\{ type: config\.projection/);
});

/**
 * #918: exiting a presentation that was launched from the editor must return to
 * the editor, not drop the user onto the bare map.
 */
test("returns to the editor after exiting a presentation", async ({ page }) => {
  await waitForMap(page);

  const dialog = await openStoryMapPanel(page);
  await dialog.getByRole("button", { name: "Load sample story" }).click();
  await expect(dialog.getByRole("heading", { name: "Chapters (5)" })).toBeVisible();

  // Enter the presentation; the editor dialog closes.
  await dialog.getByRole("button", { name: "Present" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();

  // Exit the presentation; the editor must reopen (#918).
  await page.getByRole("button", { name: "Exit" }).click();
  await expect(page.getByRole("dialog").getByRole("heading", { name: "Story Map" })).toBeVisible();
});
