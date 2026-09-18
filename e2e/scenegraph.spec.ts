import { expect, test, type Page } from "@playwright/test";

/**
 * Exercises the glTF 3D model layer (#306): the "3D Model (glTF)" Add Data
 * entry, single-location placement, and the resulting deck.gl scenegraph store
 * layer. The store-layer assertion is hermetic — it does not depend on the
 * model URL actually loading (model loading happens asynchronously in a deck.gl
 * worker and is non-fatal if the network is unavailable), so this runs without
 * external network access.
 */

/** Waits for MapLibre to mount its WebGL canvas — the app's "map ready" signal. */
async function waitForMap(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("map-canvas")).toBeVisible();
  await expect(page.locator(".maplibregl-canvas")).toBeVisible({
    timeout: 30_000,
  });
}

test("adds a glTF 3D model layer placed at a single coordinate", async ({ page }) => {
  await waitForMap(page);

  // Open Add Data -> 3D Model (glTF).
  await page.getByRole("button", { name: "Add Data" }).click();
  await page.getByRole("menuitem", { name: "3D Model (glTF)" }).click();

  // The dialog opens pre-selected on the scenegraph layer type, pre-filled from
  // the bundled example: model URL plus a default single-location coordinate so
  // the user can place a model with one click.
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("glTF / GLB model URL")).not.toHaveValue("");
  await expect(dialog.getByLabel("Longitude")).not.toHaveValue("");
  await expect(dialog.getByLabel("Latitude")).not.toHaveValue("");

  await dialog.getByRole("button", { name: "Add layer" }).click();

  // The layer appears in the panel as a deck.gl (scenegraph) layer.
  const row = page.locator('[data-testid="layer-row"][data-layer-name="3D model (glTF)"]');
  await expect(row).toBeVisible();
  await expect(dialog).toBeHidden();
});

test("blocks single-location placement without a valid coordinate", async ({ page }) => {
  await waitForMap(page);

  await page.getByRole("button", { name: "Add Data" }).click();
  await page.getByRole("menuitem", { name: "3D Model (glTF)" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  // Clearing the pre-filled longitude and submitting surfaces a validation
  // error and keeps the dialog open (a blank field must not be read as the
  // coordinate 0).
  await dialog.getByLabel("Longitude").fill("");
  await dialog.getByRole("button", { name: "Add layer" }).click();
  await expect(dialog.getByText("Enter a valid longitude and latitude.")).toBeVisible();
  await expect(dialog).toBeVisible();
});

test("imports an embedded local glTF and rejects missing companion files", async ({ page }) => {
  await waitForMap(page);
  await page.getByRole("button", { name: "Add Data" }).click();
  await page.getByRole("menuitem", { name: "3D Model (glTF)" }).click();
  const dialog = page.getByRole("dialog");
  const choose = async (name: string, model: object) => {
    const picker = page.waitForEvent("filechooser");
    await dialog.getByRole("button", { name: "Choose local model" }).click();
    await (
      await picker
    ).setFiles({ name, mimeType: "model/gltf+json", buffer: Buffer.from(JSON.stringify(model)) });
  };
  await choose("missing.gltf", { asset: { version: "2.0" }, buffers: [{ uri: "mesh.bin" }] });
  await expect(dialog.getByText(/This model references separate files/)).toBeVisible();
  await choose("local.gltf", { asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [] }] });
  await expect(dialog.getByRole("status")).toHaveText("local.gltf");
  await expect(dialog.getByLabel("Scale", { exact: true })).toHaveValue("1");
  await dialog.getByRole("button", { name: "Add layer" }).click();
  await expect(
    page.locator('[data-testid="layer-row"][data-layer-name="3D model (glTF)"]'),
  ).toBeVisible();
});

test("Shanghai sample fills the geographic origin and meter-scale placement", async ({ page }) => {
  await waitForMap(page);
  await page.getByRole("button", { name: "Add Data" }).click();
  await page.getByRole("menuitem", { name: "3D Model (glTF)" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Sample dataset").selectOption("shanghai");
  await expect(dialog.getByLabel("glTF / GLB model URL")).toHaveValue(
    "https://data.source.coop/giswqs/opengeos/shanghai-3d-model.glb",
  );
  await expect(dialog.getByLabel("Longitude", { exact: true })).toHaveValue("121.495");
  await expect(dialog.getByLabel("Latitude", { exact: true })).toHaveValue("31.235");
  await expect(dialog.getByLabel("Scale", { exact: true })).toHaveValue("1");
  await dialog.getByRole("button", { name: "Add layer" }).click();
  await expect(
    page.locator('[data-testid="layer-row"][data-layer-name="Shanghai — central city"]'),
  ).toBeVisible();
});

test("preserves scale edits made while a local model is being embedded", async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as unknown as Record<string, unknown>).showSaveFilePicker;
    const read = FileReader.prototype.readAsDataURL;
    FileReader.prototype.readAsDataURL = function (blob) {
      if (blob.type === "model/gltf+json") {
        // Hold embedding until the test has edited the still-enabled scale input.
        (window as unknown as { finishModelRead: () => void }).finishModelRead = () => {
          read.call(this, blob);
        };
      } else {
        read.call(this, blob);
      }
    };
  });
  await waitForMap(page);
  await page.getByRole("button", { name: "Add Data" }).click();
  await page.getByRole("menuitem", { name: "3D Model (glTF)" }).click();
  const dialog = page.getByRole("dialog");
  const picker = page.waitForEvent("filechooser");
  await dialog.getByRole("button", { name: "Choose local model" }).click();
  await (
    await picker
  ).setFiles({
    name: "delayed.gltf",
    mimeType: "model/gltf+json",
    buffer: Buffer.from(
      JSON.stringify({ asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [] }] }),
    ),
  });
  await page.waitForFunction(
    () =>
      typeof (window as unknown as { finishModelRead?: unknown }).finishModelRead === "function",
  );
  await dialog.getByLabel("Scale", { exact: true }).fill("25");
  await page.evaluate(() =>
    (window as unknown as { finishModelRead: () => void }).finishModelRead(),
  );
  await expect(dialog.getByRole("status")).toHaveText("delayed.gltf");
  await expect(dialog.getByLabel("Scale", { exact: true })).toHaveValue("25");
  await dialog.getByRole("button", { name: "Add layer" }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Project", exact: true }).click();
  await page.getByRole("menuitem", { name: "Save", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
  const stream = await (await downloadPromise).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const saved = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const model = saved.layers.find((layer: { type: string }) => layer.type === "deckgl-viz");
  expect(model.metadata.vizConfig.scenegraph.sizeScale).toBe(25);
  expect(model.metadata.vizConfig.scenegraph.modelUrl).toMatch(/^data:model\/gltf\+json;base64,/);
});
