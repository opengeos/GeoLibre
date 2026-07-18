import { expect, test, type Page } from "@playwright/test";
import { strToU8, zipSync } from "fflate";

// A minimal but valid external GeoLibre plugin: the entry is a self-contained
// ESM module exporting a GeoLibrePlugin whose id/name/version match the
// manifest. activate/deactivate are no-ops so the plugin registers without
// needing a live map control.
const PLUGIN_ID = "e2e-sample-plugin";
const PLUGIN_NAME = "E2E Sample Plugin";
const PLUGIN_VERSION = "1.0.0";

const MANIFEST = {
  id: PLUGIN_ID,
  name: PLUGIN_NAME,
  version: PLUGIN_VERSION,
  entry: "plugin.js",
};

const ENTRY_SOURCE = `const plugin = {
  id: ${JSON.stringify(PLUGIN_ID)},
  name: ${JSON.stringify(PLUGIN_NAME)},
  version: ${JSON.stringify(PLUGIN_VERSION)},
  activate() {},
  deactivate() {},
};
export default plugin;
`;

// Wrap the plugin in a top-level folder (as produced by zipping a plugin
// directory) so this exercises the wrapping-folder path, not just a root
// plugin.json.
function buildPluginZip(): Buffer {
  const archive = zipSync({
    "e2e-sample-plugin/plugin.json": strToU8(JSON.stringify(MANIFEST)),
    "e2e-sample-plugin/plugin.js": strToU8(ENTRY_SOURCE),
  });
  return Buffer.from(archive);
}

/** Open Manage Plugins from the Settings dropdown and switch to its Settings tab. */
async function openManagePluginsSettings(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("menuitem", { name: "Manage Plugins" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Manage Plugins")).toBeVisible();
  await dialog.getByRole("button", { name: "Settings", exact: true }).click();
  return dialog;
}

test("installs a plugin from an uploaded zip, persists it across reload, and uninstalls it", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("map-canvas")).toBeVisible();
  // The Settings dropdown trigger is part of the toolbar; wait for it before
  // driving the menu.
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();

  // 1. Install from file: the web path reads the uploaded bytes, unpacks and
  //    registers the plugin client-side, and persists it in IndexedDB.
  let dialog = await openManagePluginsSettings(page);
  const [fileChooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    dialog.getByRole("button", { name: /Choose \.zip/ }).click(),
  ]);
  await fileChooser.setFiles({
    name: `${PLUGIN_ID}.zip`,
    mimeType: "application/zip",
    buffer: buildPluginZip(),
  });

  // Success notice + the plugin appears in the "installed from file" list.
  await expect(dialog.getByText(`Installed plugin "${PLUGIN_ID}".`)).toBeVisible();
  await expect(dialog.getByText(PLUGIN_NAME)).toBeVisible();
  await expect(dialog.getByRole("button", { name: `Uninstall ${PLUGIN_NAME}` })).toBeVisible();

  // Close the dialog and confirm the plugin registered (it shows in the
  // toolbar's Plugins menu, which lists registered plugins by name).
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  await expect(page.getByRole("menu").getByText(PLUGIN_NAME)).toBeVisible();
  await page.keyboard.press("Escape");

  // 2. Persistence: reload the app. The startup loader replays the bundle from
  //    IndexedDB, so the plugin is registered again and still listed.
  await page.reload();
  await expect(page.getByTestId("map-canvas")).toBeVisible();
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  await expect(page.getByRole("menu").getByText(PLUGIN_NAME)).toBeVisible();
  await page.keyboard.press("Escape");

  dialog = await openManagePluginsSettings(page);
  await expect(dialog.getByText(PLUGIN_NAME)).toBeVisible();

  // 3. Uninstall: removes it from IndexedDB and unregisters it.
  await dialog.getByRole("button", { name: `Uninstall ${PLUGIN_NAME}` }).click();
  await expect(dialog.getByRole("button", { name: `Uninstall ${PLUGIN_NAME}` })).toHaveCount(0);

  // It no longer appears in the Plugins menu either.
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  await expect(page.getByRole("menu").getByText(PLUGIN_NAME)).toHaveCount(0);
});
