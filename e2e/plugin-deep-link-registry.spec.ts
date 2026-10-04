import { expect, test, type Page } from "@playwright/test";
import { waitForMap } from "./helpers";

// The registry half of the `?plugin=` deep link: an unknown name prompts to
// install from plugins.geolibre.app. Split from plugin-deep-link.spec.ts so the
// docs check there stays in the per-commit `core` suite while these slower
// install flows run nightly.

const REGISTRY_PLUGIN_ID = "e2e-registry-plugin";
const REGISTRY_ORIGIN = "https://plugins.geolibre.app";

/**
 * Serves a one-plugin registry, its manifest, and its entry module in place of
 * plugins.geolibre.app. Activating the plugin sets a data attribute on `<body>`.
 */
async function mockRegistryPlugin(page: Page): Promise<void> {
  const cors = { "access-control-allow-origin": "*" };
  await page.route(`${REGISTRY_ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/plugin-registry.json") {
      return route.fulfill({
        headers: cors,
        json: {
          plugins: [
            {
              id: REGISTRY_PLUGIN_ID,
              name: "E2E Registry Plugin",
              version: "1.0.0",
              author: "E2E Author",
              description: "A plugin served by the registry mock.",
              manifestUrl: `${REGISTRY_ORIGIN}/plugins/${REGISTRY_PLUGIN_ID}/plugin.json`,
            },
          ],
        },
      });
    }
    if (path.endsWith("/plugin.json")) {
      return route.fulfill({
        headers: cors,
        json: {
          id: REGISTRY_PLUGIN_ID,
          name: "E2E Registry Plugin",
          version: "1.0.0",
          entry: "plugin.js",
        },
      });
    }
    if (path.endsWith("/plugin.js")) {
      return route.fulfill({
        headers: cors,
        contentType: "text/javascript",
        body: `export default {
          id: ${JSON.stringify(REGISTRY_PLUGIN_ID)},
          name: "E2E Registry Plugin",
          version: "1.0.0",
          activate() { document.body.dataset.e2eRegistryPlugin = "active"; },
          deactivate() { delete document.body.dataset.e2eRegistryPlugin; },
        };`,
      });
    }
    return route.fulfill({ status: 404, headers: cors });
  });
}

test("?plugin= asks before installing a registry plugin, then activates it", async ({ page }) => {
  await mockRegistryPlugin(page);
  await waitForMap(page, `/?plugin=${REGISTRY_PLUGIN_ID}`);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("E2E Registry Plugin")).toBeVisible({ timeout: 60_000 });
  await expect(dialog.getByText("by E2E Author")).toBeVisible();
  // Nothing runs until the user decides.
  await expect(page.locator("body[data-e2e-registry-plugin]")).toHaveCount(0);

  await dialog.getByRole("button", { name: "Trust and load" }).click();
  await expect(page.locator("body[data-e2e-registry-plugin='active']")).toHaveCount(1, {
    timeout: 30_000,
  });
});

test("?plugin= installs nothing when the registry prompt is dismissed", async ({ page }) => {
  await mockRegistryPlugin(page);
  await waitForMap(page, `/?plugin=${REGISTRY_PLUGIN_ID}`);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("E2E Registry Plugin")).toBeVisible({ timeout: 60_000 });
  await dialog.getByRole("button", { name: "Don't load" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("body[data-e2e-registry-plugin]")).toHaveCount(0);
});

const REGISTRY_MANIFEST_URL = `${REGISTRY_ORIGIN}/plugins/${REGISTRY_PLUGIN_ID}/plugin.json`;

test("?plugin= activates an installed registry plugin in layout=viewer", async ({ page }) => {
  await mockRegistryPlugin(page);
  // An installed plugin is just a recorded manifest URL, as Manage Plugins leaves it.
  await page.addInitScript((url) => {
    localStorage.setItem(
      "geolibre.desktopSettings",
      JSON.stringify({ uiProfile: { onboarded: true }, pluginManifestUrls: [url] }),
    );
  }, REGISTRY_MANIFEST_URL);

  await waitForMap(page, `/?plugin=${REGISTRY_PLUGIN_ID}&layout=viewer`);
  await expect(page.locator("body[data-e2e-registry-plugin='active']")).toHaveCount(1, {
    timeout: 60_000,
  });
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("?plugin= neither prompts nor installs a registry plugin in layout=viewer", async ({
  page,
}) => {
  await mockRegistryPlugin(page);
  const warning = page.waitForEvent("console", {
    predicate: (message) => message.text().includes("layout=viewer never installs plugins"),
    timeout: 60_000,
  });

  await waitForMap(page, `/?plugin=${REGISTRY_PLUGIN_ID}&layout=viewer`);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("body[data-e2e-registry-plugin]")).toHaveCount(0);
  await warning;
});
