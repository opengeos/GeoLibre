import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { waitForMap } from "./helpers";

const PLUGINS_DOC = join(__dirname, "..", "docs", "user-guide", "plugins.md");

/**
 * The link names in the "Open a plugin from a link" table of the Plugins page,
 * one backticked name in the second column of each row.
 */
function documentedLinkNames(): string[] {
  const doc = readFileSync(PLUGINS_DOC, "utf8");
  const start = doc.indexOf("## Open a plugin from a link");
  expect(start, "plugins.md lost its 'Open a plugin from a link' section").toBeGreaterThan(-1);
  const section = doc.slice(start, doc.indexOf("\n## ", start + 1));
  return [...section.matchAll(/^\|[^|\n]+\|\s*`([^`]+)`\s*\|$/gm)].map((match) => match[1]).sort();
}

test("?plugin= activates a built-in plugin", async ({ page }) => {
  await waitForMap(page, "/?plugin=swipe");
  await expect(page.locator(".swipe-control")).toBeVisible({ timeout: 30_000 });
});

/**
 * The app is the only place the full list of deep-linkable plugins exists (the
 * plugins can't be imported into a node test), so this reads it from the
 * warning an unknown name prints and holds the docs table to it. A new built-in
 * plugin fails here until the Plugins page lists its link name.
 */
test("the Plugins page lists every ?plugin= link name", async ({ page }) => {
  const warning = page.waitForEvent("console", {
    predicate: (message) => message.text().includes("in the ?plugin= link"),
    timeout: 60_000,
  });
  // Keep the registry lookup an unknown name triggers off the network.
  await page.route("https://plugins.geolibre.app/**", (route) => route.abort());
  await waitForMap(page, "/?plugin=not-a-real-plugin");
  const text = (await warning).text();
  const match = /Valid names: (.+)$/.exec(text);
  expect(match, `unexpected warning: ${text}`).not.toBeNull();
  const valid = match![1].split(", ").sort();

  expect(documentedLinkNames()).toEqual(valid);
});

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
