import { expect, test, type Page } from "./test";
import { waitForMap } from "./helpers";

/**
 * Picks an entry from the 3D Tiles panel's "Load sample data..." menu.
 *
 * @param page - The app page.
 * @param label - The sample's label.
 */
async function pickSample(page: Page, label: string): Promise<void> {
  await page.getByRole("button", { name: "Load sample data...", exact: true }).click();
  await page.getByRole("option", { name: label, exact: true }).click();
}

// Switching samples must rename the layer and drop the Google API-key header
// (keeping a typed key for a return to Google), while a name the user typed
// survives a pick (#3258). Only the form fields are
// checked, so nothing is fetched from the tileset hosts.
test("3D Tiles sample picks rename the layer unless the user typed one", async ({ page }) => {
  await waitForMap(page);
  await page.getByRole("button", { name: "Add data", exact: true }).click();
  await page.getByRole("menuitem", { name: "3D Tiles layer", exact: true }).click();

  const url = page.getByRole("textbox", { name: "Tileset URL", exact: true });
  const name = page.getByRole("textbox", { name: "Layer name", exact: true });
  const headers = page.getByRole("textbox", { name: "Request headers", exact: true });

  await pickSample(page, "Google Photorealistic 3D Tiles");
  await expect(url).toHaveValue("https://tile.googleapis.com/v1/3dtiles/root.json");
  await expect(name).toHaveValue("Google Photorealistic 3D Tiles");
  await headers.fill("X-GOOG-API-KEY: e2e-test-key");

  await pickSample(page, "3D BAG Netherlands (LoD 2.2)");
  await expect(url).toHaveValue(/3dbag\.nl/);
  await expect(name).toHaveValue("3D BAG Netherlands (LoD 2.2)");
  await expect(headers).not.toHaveValue(/X-GOOG-API-KEY/i);

  // The typed key stays in panel memory, so returning to Google restores it.
  await pickSample(page, "Google Photorealistic 3D Tiles");
  await expect(name).toHaveValue("Google Photorealistic 3D Tiles");
  await expect(headers).toHaveValue(/X-GOOG-API-KEY/i);
  await pickSample(page, "3D BAG Netherlands (LoD 2.2)");

  await name.fill("My buildings");
  await pickSample(page, "AGI HQ");
  await expect(url).toHaveValue(/agi-hq/);
  await expect(name).toHaveValue("My buildings");
  // A second pick must not mistake the kept name for a sample-filled one.
  await pickSample(page, "Google Photorealistic 3D Tiles");
  await expect(url).toHaveValue("https://tile.googleapis.com/v1/3dtiles/root.json");
  await expect(name).toHaveValue("My buildings");
});
