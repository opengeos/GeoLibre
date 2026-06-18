import { expect, test, type Page } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIXTURE_PATH = join(__dirname, "fixtures", "smoke.geojson");
const FIXTURE_TEXT = readFileSync(FIXTURE_PATH, "utf8");

/** Waits for MapLibre to mount its WebGL canvas — the app's "map ready" signal. */
async function waitForMap(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("map-canvas")).toBeVisible();
  await expect(page.locator(".maplibregl-canvas")).toBeVisible({
    timeout: 30_000,
  });
}

/** Drops a GeoJSON file onto the map, exercising the real drag-and-drop path. */
async function dropGeoJson(
  page: Page,
  name: string,
  text: string,
): Promise<void> {
  const dataTransfer = await page.evaluateHandle(
    ({ contents, fileName }) => {
      const dt = new DataTransfer();
      dt.items.add(
        new File([contents], fileName, { type: "application/geo+json" }),
      );
      return dt;
    },
    { contents: text, fileName: `${name}.geojson` },
  );
  for (const type of ["dragenter", "dragover", "drop"]) {
    await page.dispatchEvent('[data-testid="map-canvas"]', type, {
      dataTransfer,
    });
  }
  await dataTransfer.dispose();
  await expect(
    page.locator(`[data-testid="layer-row"][data-layer-name="${name}"]`),
  ).toBeVisible();
}

/**
 * Verifies issue #311: a layer can be placed in a folder, the group's
 * collapse/visibility controls work, and the group structure survives a
 * save -> reload -> reopen round trip (group + each child's `groupId` are
 * serialized into the `.geolibre.json` project).
 */
test("groups a layer and persists the folder across save and reopen", async ({
  page,
}) => {
  await page.addInitScript(() => {
    delete (window as unknown as Record<string, unknown>).showSaveFilePicker;
    delete (window as unknown as Record<string, unknown>).showOpenFilePicker;
  });

  await waitForMap(page);

  // 1. Add a layer, then group it from the layer's actions menu.
  await dropGeoJson(page, "smoke", FIXTURE_TEXT);
  const row = page.locator(
    '[data-testid="layer-row"][data-layer-name="smoke"]',
  );
  await row.locator('button[aria-label="Layer actions"]').click();
  await page.getByRole("menuitem", { name: "New group from layer" }).click();
  await page.keyboard.press("Escape"); // close the actions menu

  const header = page.getByTestId("layer-group-header").first();
  await expect(header).toBeVisible();

  // 2. Collapsing the group hides its child layer; expanding restores it.
  await header.locator('button[aria-label="Collapse group"]').click();
  await expect(row).toBeHidden();
  await header.locator('button[aria-label="Expand group"]').click();
  await expect(row).toBeVisible();

  // 3. Save the project and assert the group + membership are serialized.
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Project" }).click();
  await page.getByRole("menuitem", { name: "Save", exact: true }).click();
  // Browsers without the File System Access picker (deleted above) prompt for a
  // file name before downloading; accept the pre-filled default and confirm.
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Save", exact: true })
    .click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const saved = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
    layers?: { groupId?: string }[];
    layerGroups?: { id: string }[];
  };
  expect(saved.layerGroups?.length).toBe(1);
  const groupId = saved.layerGroups?.[0]?.id;
  expect(groupId).toBeTruthy();
  expect(saved.layers?.[0]?.groupId).toBe(groupId);

  const dir = await mkdtemp(join(tmpdir(), "geolibre-groups-"));
  try {
    const savedPath = join(dir, "groups.geolibre.json");
    await writeFile(savedPath, Buffer.concat(chunks));

    // 4. Reload to a fresh store, reopen the project, and confirm the folder is
    //    rebuilt with the layer still nested inside it.
    await waitForMap(page);
    const chooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Project" }).click();
    await page.getByRole("menuitem", { name: "Open From" }).click();
    await page.getByRole("menuitem", { name: "File..." }).click();
    const chooser = await chooserPromise;
    await chooser.setFiles(savedPath);

    await expect(page.getByTestId("layer-group-header").first()).toBeVisible();
    await expect(
      page.locator('[data-testid="layer-row"][data-layer-name="smoke"]'),
    ).toBeVisible();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
