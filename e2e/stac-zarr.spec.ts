import { expect, test, type Page } from "@playwright/test";
import { waitForMap } from "./helpers";

// A Zarr store is a directory read key by key, so only a run through the real panel shows that the
// store URL, the chosen variable and the reader's own requests line up.
const API = "https://api.stac.test/v1";
const STORE = "https://store.stac.test/mini.zarr";

/**
 * A Zarr v2 store, built here rather than committed: it is a directory of a dozen tiny files, and
 * every byte of it is derivable from the shape below.
 */
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
  "precipitation/.zarray": zarray([N, N]),
  "precipitation/.zattrs": zattrs(["lat", "lon"], "mm"),
};
STORE_METADATA[".zmetadata"] = JSON.stringify({
  metadata: Object.fromEntries(
    Object.entries(STORE_METADATA).map(([key, value]) => [key, JSON.parse(value)]),
  ),
  zarr_consolidated_format: 1,
});

/** A chunk of `count` float32 values, ascending so the array is not uniformly the fill value. */
function chunk(count: number): Buffer {
  const values = Float32Array.from({ length: count }, (_, index) => index);
  return Buffer.from(values.buffer);
}

const STORE_CHUNKS: Record<string, Buffer> = {
  "lat/0": chunk(N),
  "lon/0": chunk(N),
  "temperature/0.0": chunk(N * N),
  "precipitation/0.0": chunk(N * N),
};

const COLLECTIONS = [
  { id: "cube", title: "Demo cubes", extent: { spatial: { bbox: [[-114, 37, -109, 42]] } } },
];

function item(): Record<string, unknown> {
  return {
    type: "Feature",
    stac_version: "1.0.0",
    id: "cube-1",
    collection: "cube",
    stac_extensions: ["https://stac-extensions.github.io/datacube/v2.2.0/schema.json"],
    bbox: [-114, 37, -109, 42],
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [-114, 37],
          [-109, 37],
          [-109, 42],
          [-114, 42],
          [-114, 37],
        ],
      ],
    },
    properties: {
      datetime: "2024-05-01T00:00:00Z",
      "cube:dimensions": {
        lat: { type: "spatial", axis: "y" },
        lon: { type: "spatial", axis: "x" },
      },
      "cube:variables": {
        // Spans no two spatial dimensions, so it must not be offered as something to draw.
        lat_bounds: { dimensions: ["lat"], type: "data" },
        temperature: { dimensions: ["lat", "lon"], type: "data", unit: "degC" },
        precipitation: { dimensions: ["lat", "lon"], type: "data", unit: "mm" },
      },
    },
    assets: { data: { href: STORE, type: "application/vnd+zarr", title: "Demo cube" } },
    links: [],
  };
}

async function serveApi(page: Page): Promise<void> {
  await page.route("https://api.stac.test/**", async (route) => {
    const url = route.request().url();
    const json = (body: unknown) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

    if (url.endsWith("/collections")) return json({ collections: COLLECTIONS });
    if (url.includes("/search")) {
      return json({ type: "FeatureCollection", features: [item()], numberMatched: 1, links: [] });
    }
    return json({
      type: "Catalog",
      id: "api",
      title: "E2E STAC API",
      conformsTo: [
        "https://api.stacspec.org/v1.0.0/core",
        "https://api.stacspec.org/v1.0.0/item-search",
      ],
      links: [
        { rel: "data", href: `${API}/collections` },
        { rel: "search", href: `${API}/search`, method: "POST" },
      ],
    });
  });
}

/** Serves the store key by key, so the reader's own requests decide whether the layer loads. */
async function serveStore(page: Page, reads: string[]): Promise<void> {
  await page.route("https://store.stac.test/**", async (route) => {
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
    // A store is probed for keys it need not have (`zarr.json` on a v2 store, say).
    return route.fulfill({ status: 404, body: "" });
  });
}

test("a Zarr asset from a STAC item reaches the map as the chosen variable", async ({ page }) => {
  const reads: string[] = [];
  await serveApi(page);
  await serveStore(page, reads);
  await waitForMap(page);

  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  await page.getByRole("menuitem", { name: "Web Services" }).click();
  await page.getByRole("menuitem", { name: "STAC Catalogs" }).click();
  await page.getByPlaceholder("https://example.org/stac/").fill(API);
  await page.getByRole("button", { name: "Connect", exact: true }).click();

  await page.getByLabel("Limit search to the current map extent").uncheck();
  const collection = page.getByRole("option", { name: "Demo cubes" });
  await collection.click();
  await collection.dblclick();
  await expect(page.getByText(/Showing \d+ of \d+ items\./)).toBeVisible();

  // The asset names its format, and the store's drawable arrays are offered — bounds excluded.
  await expect(page.getByRole("combobox").filter({ hasText: "Demo cube — Zarr" })).toBeVisible();
  const targets = page.getByRole("combobox").filter({ hasText: "temperature (degC)" });
  await expect(targets).toBeVisible();
  await expect(targets.getByRole("option")).toHaveText([
    "temperature (degC)",
    "precipitation (mm)",
  ]);

  await targets.selectOption({ label: "precipitation (mm)" });
  const add = page.getByRole("button", { name: "Add", exact: true }).first();
  await expect(add).toBeEnabled();
  await add.click();

  // Named for the item, its asset and the variable actually drawn. Scoped to the panel because
  // the name also renders in the on-map layer control.
  const layers = page.getByRole("complementary", { name: "Layers" });
  await expect(layers.getByText("cube-1 — Demo cube — precipitation")).toBeVisible();
  await expect(page.getByText("Added Demo cube to the map.")).toBeVisible();

  // The reader was pointed at the store and read its metadata from there. Chunk reads are left
  // out on purpose: those only happen once deck.gl paints, which headless WebGL may never do.
  expect(reads).toContain(".zmetadata");
});
