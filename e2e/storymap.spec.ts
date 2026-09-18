import { expect, test, type Page } from "@playwright/test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DESKTOP_SETTINGS_STORAGE_KEY } from "../apps/geolibre-desktop/src/lib/storage-keys";

/** Waits for MapLibre to mount its WebGL canvas — the app's "map ready" signal. */
async function waitForMap(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("map-canvas")).toBeVisible();
  await expect(page.locator(".maplibregl-canvas")).toBeVisible({
    timeout: 30_000,
  });
}

/** Wait until React publishes the live renderer and its map is fully loaded. */
async function waitForRenderer(page: Page, kind: "mapbox" | "maplibre"): Promise<void> {
  await page.waitForFunction((wanted) => {
    const header = document.querySelector("header") as unknown as Record<string, unknown>;
    if (!header) return false;
    let fiber = header[Object.keys(header).find((key) => key.startsWith("__reactFiber"))!] as any;
    while (fiber) {
      for (const side of [fiber, fiber.alternate]) {
        let hook = side?.memoizedState;
        while (hook) {
          const engine = hook.memoizedState?.current;
          if (engine?.kind === wanted) {
            const map = wanted === "mapbox" ? engine.getMapboxMap?.() : engine.getMap?.();
            if (map?.loaded()) return true;
          }
          hook = hook.next;
        }
      }
      fiber = fiber.return;
    }
    return false;
  }, kind);
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

test("presents and composes a story on Mapbox", async ({ page }) => {
  test.skip(!process.env.MAPBOX_TOKEN, "requires an authenticated Mapbox map");
  await page.addInitScript(
    ({ key, token }) => {
      localStorage.setItem(
        key,
        JSON.stringify({
          ...JSON.parse(localStorage.getItem(key) || "{}"),
          mapboxAccessToken: token,
        }),
      );
    },
    { key: DESKTOP_SETTINGS_STORAGE_KEY, token: process.env.MAPBOX_TOKEN! },
  );
  await waitForMap(page);

  await page.getByRole("button", { name: "View", exact: true }).click();
  await page.getByRole("menuitem", { name: "Rendering engine" }).hover();
  await page.getByRole("menuitemradio", { name: "Mapbox" }).click();
  await expect(page.locator(".mapboxgl-canvas")).toBeVisible({ timeout: 30_000 });
  await waitForRenderer(page, "mapbox");

  let dialog = await openStoryMapPanel(page);
  await dialog.getByRole("button", { name: "Load sample story" }).click();
  await dialog.getByRole("button", { name: "Present" }).click();
  await expect(page.locator(".glsm-dark").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Exit" })).toBeVisible();
  await expect(page.locator(".maplibregl-marker")).toHaveCount(2);

  await page.getByRole("button", { name: "Exit" }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Story Map" })).toBeVisible();
  await dialog.getByRole("combobox").first().selectOption({ label: "Light" });
  await dialog.getByRole("button", { name: "Present" }).click();
  await expect(page.locator(".glsm-light").first()).toBeVisible();

  await page.getByRole("button", { name: "Exit" }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Story Map" })).toBeVisible();
  await dialog.getByRole("button", { name: "Compose on map" }).first().click();
  const compose = page.getByTestId("storymap-compose-bar");
  await expect(compose).toBeVisible();
  const save = compose.getByRole("button", { name: /Save view/ });
  await expect(save).toBeEnabled();

  const canvas = page.locator(".mapboxgl-canvas");
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 30, {
    steps: 6,
  });
  await expect(save).toBeDisabled();
  await page.mouse.up();
  await expect(save).toBeEnabled();
});
