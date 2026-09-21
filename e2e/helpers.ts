import { expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Shared E2E helpers for driving the built web app. */

/** Reads a fixture file from `e2e/fixtures/` as UTF-8 text. */
export function readFixture(name: string): string {
  return readFileSync(join(__dirname, "fixtures", name), "utf8");
}

/**
 * A 1,065-point COPC from PDAL's test data, vendored as
 * `e2e/fixtures/1.2-with-color.copc.laz` (33 KB) so the LiDAR specs neither
 * depend on `raw.githubusercontent.com` nor on what PDAL's `master` happens to
 * hold — they assert the exact point count.
 *
 * The URL is never fetched: {@link serveCopcFixture} answers it from disk.
 */
export const COPC_FIXTURE_URL = "https://geolibre.test/fixtures/1.2-with-color.copc.laz";

/**
 * Answers {@link COPC_FIXTURE_URL} from the vendored file, honouring the byte
 * ranges a COPC reader asks for — the format is built around range requests, so
 * serving the whole file for every one of them would not exercise the same
 * path. Call before the app requests the URL.
 */
export async function serveCopcFixture(page: Page): Promise<void> {
  const body = readFileSync(join(__dirname, "fixtures", "1.2-with-color.copc.laz"));
  const headers = {
    "access-control-allow-origin": "*",
    "accept-ranges": "bytes",
    "content-type": "application/octet-stream",
  };
  await page.route(COPC_FIXTURE_URL, async (route) => {
    const request = route.request();
    if (request.method() === "HEAD") {
      await route.fulfill({
        status: 200,
        headers: { ...headers, "content-length": String(body.length) },
        body: "",
      });
      return;
    }
    const range = /bytes=(\d+)-(\d*)/.exec(request.headers().range ?? "");
    if (!range) {
      await route.fulfill({ status: 200, headers, body });
      return;
    }
    const start = Number(range[1]);
    const end = range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
    await route.fulfill({
      status: 206,
      headers: { ...headers, "content-range": `bytes ${start}-${end}/${body.length}` },
      body: body.subarray(start, end + 1),
    });
  });
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

/**
 * What one rendering-engine swap is allowed to cost, click and repaint alike.
 *
 * `setPrimaryRenderer` is a discrete React update, so the entire swap runs
 * inside the menu radio item's own click handler: the outgoing engine's
 * `map.remove()` drops its WebGL context, taking any deck overlay's buffers
 * with it, and on the way back to MapLibre `new maplibregl.Map()` builds the
 * replacement before the click event returns. Playwright does not resolve
 * `click` until the browser acknowledges that event, so the whole swap is
 * charged against `actionTimeout`. On CI's software renderer it outran the 30 s
 * the mapbox specs set, and `retries: 1` was what made them green (#2432).
 */
export const RENDERER_SWAP_TIMEOUT = 90_000;
