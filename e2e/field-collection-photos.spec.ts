import { expect, test } from "@playwright/test";
import { waitForMap } from "./helpers";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);

test("field collection appends, removes, validates and saves multiple photos", async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as unknown as Record<string, unknown>).showSaveFilePicker;
    // Hold real image reads until the test releases them, without timing-based sleeps.
    const read = FileReader.prototype.readAsDataURL;
    const pending: (() => void)[] = [];
    window.addEventListener("release-photo-read", () => pending.shift()?.());
    FileReader.prototype.readAsDataURL = function (blob) {
      if (blob instanceof File && /^[abcd]\.png$/.test(blob.name)) {
        pending.push(() => read.call(this, blob));
      } else if (blob instanceof File && blob.name === "broken.png") {
        this.dispatchEvent(new ProgressEvent("error"));
      } else {
        read.call(this, blob);
      }
    };
  });
  await waitForMap(page, "/?lang=en");
  await page.getByRole("button", { name: "Controls", exact: true }).click();
  await page.getByRole("menuitem", { name: "Field Collection" }).click();
  const dialog = page.getByRole("dialog", { name: "Field Collection" });
  await dialog.getByLabel("Layer name", { exact: true }).fill("Photos");
  await dialog.getByRole("button", { name: "Create layer", exact: true }).click();
  await dialog.getByRole("button", { name: "Pick on map", exact: true }).click();
  await page.locator(".maplibregl-canvas").click({ position: { x: 350, y: 240 } });

  const save = dialog.getByRole("button", { name: "Save point", exact: true });
  const input = dialog.locator('input[type="file"]');
  await input.setInputFiles([
    { name: "a.png", mimeType: "image/png", buffer: PNG },
    { name: "b.png", mimeType: "image/png", buffer: PNG },
  ]);
  await expect(save).toBeDisabled();
  await page.evaluate(() => window.dispatchEvent(new Event("release-photo-read")));
  await expect(save).toBeDisabled();
  await page.evaluate(() => window.dispatchEvent(new Event("release-photo-read")));
  await expect(dialog.getByRole("img")).toHaveCount(2);
  await expect(save).toBeEnabled();
  await dialog.getByRole("button", { name: "Remove (1: a.png)", exact: true }).click();
  await expect(dialog.getByRole("img")).toHaveAttribute("alt", "b.png");
  // Separate selections can overlap: finishing one must not enable Save yet.
  await input.setInputFiles({ name: "c.png", mimeType: "image/png", buffer: PNG });
  await input.setInputFiles({ name: "d.png", mimeType: "image/png", buffer: PNG });
  await expect(save).toBeDisabled();
  await page.evaluate(() => window.dispatchEvent(new Event("release-photo-read")));
  await expect(dialog.getByRole("img")).toHaveCount(2);
  await expect(save).toBeDisabled();
  await page.evaluate(() => window.dispatchEvent(new Event("release-photo-read")));
  await expect(dialog.getByRole("img")).toHaveCount(3);
  await expect(save).toBeEnabled();
  await dialog.getByRole("button", { name: "Remove (3: d.png)", exact: true }).click();

  await input.setInputFiles([
    { name: "valid.png", mimeType: "image/png", buffer: PNG },
    { name: "large.png", mimeType: "image/png", buffer: Buffer.alloc(2 * 1024 * 1024 + 1) },
  ]);
  await expect(dialog.getByText(/That photo is too large/)).toBeVisible();
  await expect(dialog.getByRole("img")).toHaveCount(2);
  await input.setInputFiles({ name: "broken.png", mimeType: "image/png", buffer: PNG });
  await expect(dialog.getByText("Couldn't read that image. Try another file.")).toBeVisible();
  await expect(dialog.getByRole("img")).toHaveCount(2);
  await expect(save).toBeEnabled();
  await save.click();
  await expect(dialog.getByText("Saved 1 point to Photos.")).toBeVisible();
  await expect(dialog.getByRole("img")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Done", exact: true }).click();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Project", exact: true }).click();
  await page.getByRole("menuitem", { name: "Save", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
  const stream = await (await downloadPromise).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const project = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const properties = project.layers.find((layer: { name: string }) => layer.name === "Photos")
    .geojson.features[0].properties;
  expect(properties.geolibre_photo_names).toEqual(["b.png", "c.png"]);
  expect(properties.geolibre_photos).toEqual([
    `data:image/png;base64,${PNG.toString("base64")}`,
    `data:image/png;base64,${PNG.toString("base64")}`,
  ]);
  expect(properties.photo).toBe(properties.geolibre_photos[0]);
});
