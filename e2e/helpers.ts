import { expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Shared E2E helpers for driving the built web app. */

/** Reads a fixture file from `e2e/fixtures/` as UTF-8 text. */
export function readFixture(name: string): string {
  return readFileSync(join(__dirname, "fixtures", name), "utf8");
}

/** Waits for MapLibre to mount its WebGL canvas — the app's "map ready" signal. */
export async function waitForMap(page: Page, path = "/"): Promise<void> {
  await page.goto(path);
  await expect(page.getByTestId("map-canvas")).toBeVisible();
  await expect(page.locator(".maplibregl-canvas")).toBeVisible({
    timeout: 30_000,
  });
}

/**
 * Dispatches a real browser drag-and-drop of a file onto the map surface,
 * exercising the `handleDrop` -> parse -> `addGeoJsonLayer` path. A `.geojson`
 * file is parsed in-browser with no DuckDB/CDN dependency, so this stays
 * hermetic. Does not assert — the caller decides whether a layer should appear
 * (valid input) or not (malformed input).
 *
 * `name` is test-controlled and assumed simple/ASCII: it is the dropped file's
 * base name and, after the drop pipeline strips the extension, the layer name.
 */
export async function dropGeoJson(page: Page, name: string, text: string): Promise<void> {
  const dataTransfer = await page.evaluateHandle(
    ({ contents, fileName }) => {
      const dt = new DataTransfer();
      dt.items.add(new File([contents], fileName, { type: "application/geo+json" }));
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
}

/** The layer-panel row for a dropped GeoJSON layer, keyed by its base name. */
export function layerRow(page: Page, name: string) {
  return page.locator(`[data-testid="layer-row"][data-layer-name="${name}"]`);
}
