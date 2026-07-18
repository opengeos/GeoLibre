import { expect, test, type Download, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// A GeoJSON drop is parsed in-browser; GeoPackage export uses bundled sql.js and
// Shapefile export is pure JS + fflate, so this stays hermetic (no DuckDB/CDN).
const FIXTURE_TEXT = readFileSync(join(__dirname, "fixtures", "smoke.geojson"), "utf8");

async function waitForMap(page: Page): Promise<void> {
  // Force the anchor-download fallback so Playwright can capture the bytes (the
  // File System Access API opens a native picker we cannot drive here).
  await page.addInitScript(() => {
    // @ts-expect-error - removing the optional API selects the fallback path
    delete window.showSaveFilePicker;
  });
  await page.goto("/");
  await expect(page.getByTestId("map-canvas")).toBeVisible();
  await expect(page.locator(".maplibregl-canvas")).toBeVisible({
    timeout: 30_000,
  });
}

async function dropGeoJson(page: Page, name: string): Promise<void> {
  const dataTransfer = await page.evaluateHandle(
    ({ contents, fileName }) => {
      const dt = new DataTransfer();
      dt.items.add(new File([contents], fileName, { type: "application/geo+json" }));
      return dt;
    },
    { contents: FIXTURE_TEXT, fileName: `${name}.geojson` },
  );
  for (const type of ["dragenter", "dragover", "drop"]) {
    await page.dispatchEvent('[data-testid="map-canvas"]', type, {
      dataTransfer,
    });
  }
  await dataTransfer.dispose();
  await expect(page.locator(`[data-testid="layer-row"][data-layer-name="${name}"]`)).toBeVisible();
}

async function exportVia(page: Page, menuItem: string): Promise<Buffer> {
  const row = page.locator('[data-testid="layer-row"][data-layer-name="smoke"]');
  await row.locator('button[aria-label="Layer actions"]').click();
  await page.getByRole("menuitem", { name: "Export" }).hover();
  const item = page.getByRole("menuitem", { name: menuItem, exact: true });
  await expect(item).toBeVisible();
  const downloadPromise = page.waitForEvent("download", { timeout: 60_000 });
  await item.click();
  const download: Download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

test("exports a layer to GeoPackage", async ({ page }) => {
  await waitForMap(page);
  await dropGeoJson(page, "smoke");
  // GeoPackage is a SQLite database: the file starts with the SQLite magic.
  const gpkg = await exportVia(page, "GeoPackage");
  expect(gpkg.subarray(0, 16).toString("latin1")).toBe("SQLite format 3\0");
  expect(gpkg.length).toBeGreaterThan(1000);
});

test("exports a layer to a zipped Shapefile", async ({ page }) => {
  await waitForMap(page);
  await dropGeoJson(page, "smoke");
  // The Shapefile arrives as a zip (PK\x03\x04 magic) carrying its parts.
  const zip = await exportVia(page, "Shapefile (zipped)");
  expect(zip.subarray(0, 4).toString("latin1")).toBe("PK\x03\x04");
  const text = zip.toString("latin1");
  for (const part of [".shp", ".shx", ".dbf", ".prj"]) {
    expect(text).toContain(`smoke${part}`);
  }
});
