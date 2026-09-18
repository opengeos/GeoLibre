import { expect, test, type Page } from "@playwright/test";
import { DESKTOP_SETTINGS_STORAGE_KEY } from "../apps/geolibre-desktop/src/lib/storage-keys";

// The Zarr panel on the Mapbox renderer. @carbonplan/zarr-layer is a
// CustomLayerInterface implementation that targets Mapbox GL as well as
// MapLibre, and the panel only uses the style API both engines share, so the
// same control mounts on the Mapbox map and adds its custom layer there. Like
// mapbox-deck-overlays.spec.ts this runs without a Mapbox service: a
// placeholder token satisfies mapbox-gl's constructor, the project points the
// pane at a third-party style, and the store is served from a routed host.
// Without a valid token Mapbox GL JS paints nothing, so the checks are
// structural: the custom layer is on the map, its metadata was read, and the
// layer store agrees.
const TOKEN = process.env.MAPBOX_TOKEN ?? "pk.e2e-placeholder.mapbox-token";
const PROJECT_PATH = "/mapbox-zarr.geolibre.json";
const PROJECT = {
  version: "0.2.0",
  name: "Mapbox zarr",
  mapView: { center: [-111.5, 39.5], zoom: 5, bearing: 0, pitch: 0 },
  primaryRenderer: "mapbox",
  preferences: {
    map: { mapboxStyleUrl: "https://tiles.openfreemap.org/styles/liberty" },
  },
};
const STORE = "https://store.zarr.test/mini.zarr";

// A tiny Zarr v2 store, the same shape e2e/stac-zarr.spec.ts builds: two
// 8×8 float32 grids over lat/lon, consolidated so the reader finds everything
// in one metadata read.
const N = 8;
const zarray = (shape: number[]) =>
  JSON.stringify({
    chunks: shape,
    compressor: null,
    dtype: "<f4",
    fill_value: 0,
    filters: null,
    order: "C",
    shape,
    zarr_format: 2,
  });
const zattrs = (dimensions: string[], unit?: string) =>
  JSON.stringify({ _ARRAY_DIMENSIONS: dimensions, ...(unit ? { units: unit } : {}) });
const STORE_METADATA: Record<string, string> = {
  ".zgroup": JSON.stringify({ zarr_format: 2 }),
  "lat/.zarray": zarray([N]),
  "lat/.zattrs": zattrs(["lat"]),
  "lon/.zarray": zarray([N]),
  "lon/.zattrs": zattrs(["lon"]),
  "temperature/.zarray": zarray([N, N]),
  "temperature/.zattrs": zattrs(["lat", "lon"], "degC"),
};
STORE_METADATA[".zmetadata"] = JSON.stringify({
  metadata: Object.fromEntries(
    Object.entries(STORE_METADATA).map(([key, value]) => [key, JSON.parse(value)]),
  ),
  zarr_consolidated_format: 1,
});
const chunk = (count: number) =>
  Buffer.from(Float32Array.from({ length: count }, (_, index) => index).buffer);
const STORE_CHUNKS: Record<string, Buffer> = {
  "lat/0": chunk(N),
  "lon/0": chunk(N),
  "temperature/0.0": chunk(N * N),
};

test.use({ actionTimeout: 30_000 });

async function bindMapboxEngine(page: Page) {
  await page.waitForFunction(() => {
    const header = document.querySelector("header") as unknown as Record<string, unknown>;
    if (!header) return false;
    let fiber = header[Object.keys(header).find((key) => key.startsWith("__reactFiber"))!] as any;
    while (fiber) {
      for (const side of [fiber, fiber.alternate]) {
        let hook = side?.memoizedState;
        while (hook) {
          const ref = hook.memoizedState;
          if (ref?.current?.kind === "mapbox" && ref.current.getMapboxMap?.()) {
            (window as any).mapboxZarrTestRef = ref;
            return true;
          }
          hook = hook.next;
        }
      }
      fiber = fiber.return;
    }
    return false;
  });
}

/** Ids of the custom (plugin-drawn) style layers on the Mapbox map. */
async function customLayerIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const map = (window as any).mapboxZarrTestRef.current.getMapboxMap();
    return Object.values(map.style._layers as Record<string, { id: string; type: string }>)
      .filter((layer) => layer.type === "custom")
      .map((layer) => layer.id);
  });
}

test("a Zarr store added through the panel mounts as a custom layer on the Mapbox map", async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  const reads: string[] = [];
  await page.addInitScript(
    ({ key, token }) => {
      localStorage.setItem(
        key,
        JSON.stringify({
          ...JSON.parse(localStorage.getItem(key) || "{}"),
          mapboxAccessToken: token,
          uiProfile: { onboarded: true, hiddenDataSources: [] },
        }),
      );
    },
    { key: DESKTOP_SETTINGS_STORAGE_KEY, token: TOKEN },
  );
  await page.route(
    (url) => url.pathname === PROJECT_PATH,
    (route) => route.fulfill({ json: PROJECT }),
  );
  // Served key by key, so the reader's own requests show it read the store.
  await page.route("https://store.zarr.test/**", async (route) => {
    const key = new URL(route.request().url()).pathname.replace(/^\/mini\.zarr\/?/, "");
    reads.push(key);
    if (STORE_METADATA[key]) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: STORE_METADATA[key],
      });
    }
    if (STORE_CHUNKS[key]) return route.fulfill({ status: 200, body: STORE_CHUNKS[key] });
    return route.fulfill({ status: 404, body: "" });
  });
  await page.addLocatorHandler(
    page.getByRole("heading", { name: "Recover unsaved work?" }),
    async () => {
      await page.getByRole("button", { name: "Discard", exact: true }).click();
    },
  );
  await page.goto(`/?project=${info.project.use.baseURL!}${PROJECT_PATH}`);
  await expect(page.locator(".mapboxgl-canvas")).toBeVisible();
  await bindMapboxEngine(page);
  await expect(page.getByRole("button", { name: "Add Data", exact: true })).toBeEnabled();

  await page.getByRole("button", { name: "Add Data", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Zarr Layer", exact: true })).toBeEnabled();
  await page.getByRole("menuitem", { name: "Zarr Layer", exact: true }).click();
  await page.getByRole("textbox", { name: "https://example.com/data.zarr" }).fill(STORE);
  await page.getByRole("textbox", { name: "e.g., temperature" }).fill("temperature");
  await page.getByRole("button", { name: "Add Layer", exact: true }).click();

  // Named "<store> - <variable>" by the control; match on the variable.
  const row = page.locator('[data-testid="layer-row"][data-layer-name$="- temperature"]');
  await expect(row).toBeVisible();
  await expect(row).not.toContainText("No Mapbox");
  // The engine used to reject the layer as needing a renderer-specific adapter.
  await expect(page.getByRole("alert").filter({ hasText: /^Error:/ })).toHaveCount(0);
  await expect.poll(() => customLayerIds(page)).toHaveLength(1);
  expect(reads).toContain(".zmetadata");
  await page.screenshot({ path: info.outputPath("mapbox-zarr.png") });

  // Removing the store layer takes the control's custom layer off the map.
  await row.getByRole("button", { name: "Remove layer", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove", exact: true }).click();
  await expect(row).toBeHidden();
  await expect.poll(() => customLayerIds(page)).toHaveLength(0);
});
