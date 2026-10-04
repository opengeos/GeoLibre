import { expect, test, type Page } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { bindMapLibreMap, dropGeoJson, layerRow, readFixture, waitForMap } from "./helpers";

/**
 * The axe sweep past the five screens `a11y.spec.ts` gates every pull request
 * on: the Add Data dialogs, the Processing toolbox, the Style panel for a
 * vector and a raster layer, the Settings sections, the Project dialogs,
 * Manage Plugins, and an error toast (#2858). It runs nightly in `features`,
 * because each screen is a full-document scan over a WebGL app and together
 * they would more than double the per-commit a11y cost.
 *
 * Every network dependency is served by `page.route`, so a failure here is the
 * app's markup and not a flaky remote.
 */

const FIXTURE_TEXT = readFixture("smoke.geojson");

/** A 1x1 transparent PNG, served for every raster tile. */
const TILE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const TILE_HOST = "https://tiles.a11y.test";
const BROKEN_TILE_HOST = "https://broken-tiles.a11y.test";

/** Opens a toolbar menu and picks one of its items. */
async function openMenuItem(page: Page, menu: string, item: string): Promise<void> {
  await page.getByRole("button", { name: menu, exact: true }).click();
  await page.getByRole("menuitem", { name: item, exact: true }).click();
}

/** Closes the topmost dialog with Escape and waits for it to leave. */
async function closeDialog(page: Page, name: string): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name })).toHaveCount(0);
}

/**
 * Waits for the basemap style to finish loading. A map-control panel opened
 * before then (Add Data → Vector Layer) is hidden again as the style settles.
 */
async function waitForStyleLoaded(page: Page): Promise<void> {
  await bindMapLibreMap(page);
  await page.waitForFunction(() => window.__geolibreTestMap?.loaded(), undefined, {
    timeout: 60_000,
  });
}

/** Adds an XYZ raster layer through its Add Data dialog. */
async function addXyzLayer(page: Page, name: string, template: string): Promise<void> {
  await openMenuItem(page, "Add Data", "XYZ Layer");
  const dialog = page.getByRole("dialog", { name: "Add XYZ Layer" });
  await dialog.getByRole("textbox", { name: "Layer name" }).fill(name);
  await dialog.getByRole("textbox", { name: "XYZ template or TileJSON URL" }).fill(template);
  await dialog.getByRole("button", { name: "Add layer" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(layerRow(page, name)).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.route(`${TILE_HOST}/**`, (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: TILE_PNG }),
  );
  await page.route(`${BROKEN_TILE_HOST}/**`, (route) =>
    route.fulfill({ status: 500, contentType: "text/plain", body: "tile server error" }),
  );
});

test("Add Data dialogs", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  await waitForMap(page);
  await waitForStyleLoaded(page);

  // The vector and raster entries open map-control panels, not dialogs.
  await openMenuItem(page, "Add Data", "Vector Layer");
  await expect(page.locator(".geolibre-vector-panel")).toBeVisible();
  await expectAccessible(page, "add-vector-panel", testInfo);
  await page.locator(".geolibre-vector-panel").getByRole("button", { name: "Close panel" }).click();
  await expect(page.locator(".geolibre-vector-panel")).toBeHidden();

  await openMenuItem(page, "Add Data", "Raster Layer");
  await expect(page.locator(".geolibre-raster-panel")).toBeVisible();
  await expectAccessible(page, "add-raster-panel", testInfo);

  for (const [item, title] of [
    ["XYZ Layer", "Add XYZ Layer"],
    ["WMS Layer", "Add WMS Layer"],
    ["OGC API - Features", "Add OGC API - Features Layer"],
  ] as const) {
    await openMenuItem(page, "Add Data", item);
    await expect(page.getByRole("dialog", { name: title })).toBeVisible();
    await expectAccessible(page, `add-data-${item}`, testInfo);
    await closeDialog(page, title);
  }
});

test("Processing toolbox", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  await waitForMap(page);
  await dropGeoJson(page, "smoke", FIXTURE_TEXT);
  await expect(layerRow(page, "smoke")).toBeVisible();

  // A Vector tool opens the toolbox on that tool, with the layer picker shown.
  await page.getByRole("button", { name: "Processing", exact: true }).click();
  await page.getByRole("menuitem", { name: "Vector", exact: true }).click();
  await page.getByRole("menuitem", { name: "Geometry Processing", exact: true }).click();
  await page.getByRole("menuitem", { name: "Centroid Vector", exact: true }).click();
  const toolbox = page.getByRole("dialog", { name: "Whitebox Toolbox" });
  await expect(toolbox.getByRole("heading", { name: "Centroid Vector" })).toBeVisible();
  await expectAccessible(page, "processing-vector-tool", testInfo);
  await closeDialog(page, "Whitebox Toolbox");

  await openMenuItem(page, "Processing", "Whitebox Toolbox");
  await expect(
    toolbox.getByRole("textbox", { name: "Search tools or describe a task" }),
  ).toBeVisible();
  await expectAccessible(page, "processing-whitebox-toolbox", testInfo);
});

test("Style panel for a vector and a raster layer", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  await waitForMap(page);
  const stylePanel = page.getByRole("complementary", { name: "Layer style" });

  await dropGeoJson(page, "smoke", FIXTURE_TEXT);
  await layerRow(page, "smoke").getByRole("button", { name: "Open Style panel" }).click();
  await expect(stylePanel.getByRole("textbox", { name: "Fill color" })).toBeVisible();
  await expectAccessible(page, "style-vector", testInfo);

  await addXyzLayer(page, "tiles", `${TILE_HOST}/{z}/{x}/{y}.png`);
  await layerRow(page, "tiles").getByRole("button", { name: "Open Style panel" }).click();
  await expect(stylePanel.getByText("Style - tiles")).toBeVisible();
  await expectAccessible(page, "style-raster", testInfo);
});

test("Settings sections", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  await waitForMap(page);
  await openMenuItem(page, "Settings", "Map Preferences");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  const nav = dialog.getByRole("navigation");
  for (const section of [
    "Language",
    "Map",
    "Layout",
    "Appearance",
    "Interface",
    "Geocoding",
    "AI Providers",
    "Environment",
    "Cloud Storage",
    "Startup",
  ]) {
    await nav.getByRole("button", { name: section, exact: true }).click();
    await expectAccessible(page, `settings-${section}`, testInfo);
  }
});

test("Project dialogs: New Project, History, Print Layout", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  // Starter-project thumbnails are remote images; serve none so the scan
  // never waits on them (their alt text is what matters).
  await page.route("**/*.{png,jpg,jpeg,webp}", (route) =>
    route.request().url().startsWith(TILE_HOST) ? route.fallback() : route.abort(),
  );
  await waitForMap(page);

  await openMenuItem(page, "Project", "New...");
  const newProject = page.getByRole("dialog", { name: "New project" });
  await expect(newProject).toBeVisible();
  // The Examples section (#2884) starts collapsed; scan it open.
  const examples = newProject.getByRole("button", { name: "Examples" });
  await examples.click();
  await expect(examples).toHaveAttribute("aria-expanded", "true");
  await expectAccessible(page, "new-project", testInfo);
  await closeDialog(page, "New project");

  await openMenuItem(page, "Project", "History...");
  await expect(page.getByRole("dialog", { name: "Project History" })).toBeVisible();
  await expectAccessible(page, "project-history", testInfo);
  await closeDialog(page, "Project History");

  await openMenuItem(page, "Project", "Print Layout...");
  await expect(page.getByRole("dialog", { name: "Print Layout" })).toBeVisible();
  await expectAccessible(page, "print-layout", testInfo);
});

test("Manage Plugins", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  await page.route("https://plugins.geolibre.app/plugin-registry.json", (route) =>
    route.fulfill({
      json: [
        {
          id: "a11y-sample-plugin",
          name: "Sample Plugin",
          version: "1.0.0",
          manifestUrl: "https://example.com/a11y-sample-plugin/plugin.json",
          description: "A registry entry served by the accessibility test.",
          author: "GeoLibre",
          homepage: "https://example.com/a11y-sample-plugin",
          categories: ["Data"],
        },
      ],
    }),
  );
  await waitForMap(page);
  await openMenuItem(page, "Settings", "Manage Plugins");
  const dialog = page.getByRole("dialog", { name: "Manage Plugins" });
  await expect(dialog.getByRole("button", { name: "Install Sample Plugin" })).toBeVisible();
  await expectAccessible(page, "manage-plugins", testInfo);
});

test("error notification toast", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  await waitForMap(page);
  // A tile server answering 500 is a map error the app reports as a toast.
  await addXyzLayer(page, "broken", `${BROKEN_TILE_HOST}/{z}/{x}/{y}.png`);
  const toast = page.locator('[data-testid="notification"][data-kind="error"]');
  await expect(toast).toBeVisible({ timeout: 30_000 });
  await expectAccessible(page, "error-toast", testInfo);
});
