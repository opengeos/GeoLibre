import { expect, test, type Page } from "@playwright/test";
import { waitForMap } from "./helpers";

// `maplibre-stac.ts` builds its panel by hand and exports nothing to call, so the wiring between
// the catalog tree, the collection list and the search only exists here. An API is the half that
// has no tree at all: it answers item search itself, and offering a tree of its hierarchy would
// promise a way in that its endpoint does not honour.
const API = "https://api.stac.test/v1";

const COLLECTIONS = [
  {
    id: "sentinel-2",
    title: "Sentinel-2 L2A",
    extent: { spatial: { bbox: [[4, 50, 6, 52]] } },
  },
  {
    id: "landsat-9",
    title: "Landsat 9",
    extent: { spatial: { bbox: [[-114, 37, -109, 42]] } },
  },
];

function item(
  id: string,
  collection: string,
  assets: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "Feature",
    stac_version: "1.0.0",
    id,
    collection,
    bbox: [4, 50, 6, 52],
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [4, 50],
          [6, 50],
          [6, 52],
          [4, 52],
          [4, 50],
        ],
      ],
    },
    properties: { datetime: "2024-05-01T00:00:00Z" },
    assets,
    links: [],
  };
}

/** A STAC API that answers item search, and a hierarchy underneath it that must not be offered. */
async function serveApi(
  page: Page,
  searches: string[],
  assets: Record<string, unknown> = {},
): Promise<void> {
  await page.route("https://api.stac.test/**", async (route) => {
    const request = route.request();
    const url = request.url();
    const json = (body: unknown) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body),
      });

    if (url.endsWith("/collections")) return json({ collections: COLLECTIONS });
    if (url.includes("/search")) {
      const asked = request.postDataJSON() ?? {};
      searches.push(JSON.stringify(asked.collections ?? []));
      const collection = asked.collections?.[0] ?? "sentinel-2";
      return json({
        type: "FeatureCollection",
        features: [
          item(`${collection}-1`, collection, assets),
          item(`${collection}-2`, collection, assets),
        ],
        numberMatched: 2,
        links: [],
      });
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
        // An API may also advertise a hierarchy. It is not a way in: only the endpoint is.
        { rel: "child", href: `${API}/providers/ESA`, title: "ESA" },
      ],
    });
  });
}

test("asset options identify their format and whether they can be added", async ({ page }) => {
  const searches: string[] = [];
  await serveApi(page, searches, {
    red: {
      href: "https://data.test/red.tif",
      type: "image/tiff",
      title: "Red Band",
    },
    boundaries: {
      href: "https://data.test/boundaries.geojson",
      type: "application/geo+json",
      title: "Boundaries",
    },
    tiles: {
      href: "https://data.test/tiles.pmtiles",
      type: "application/vnd.pmtiles",
      title: "Vector tiles",
    },
    data: {
      href: "https://data.test/data.parquet",
      type: "application/vnd.apache.parquet",
      title: "Dataset root",
    },
    metadata: { href: "https://data.test/metadata.bin", title: "Metadata" },
  });
  await waitForMap(page);
  await connect(page, API);

  await page.getByLabel("Limit search to the current map extent").uncheck();
  await page.getByRole("button", { name: "Search items" }).click();

  const assets = page
    .locator("select")
    .filter({ has: page.locator('option[value="red"]') })
    .first();
  await expect(assets.getByRole("option")).toHaveText([
    "Red Band — COG",
    "Boundaries — GeoJSON",
    "Vector tiles — PMTiles",
    "Dataset root — Parquet",
    "Metadata — Unknown format (not addable)",
  ]);
});

async function connect(page: Page, url: string): Promise<void> {
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  await page.getByRole("menuitem", { name: "Web Services" }).click();
  await page.getByRole("menuitem", { name: "STAC Catalogs" }).click();
  await page.getByPlaceholder("https://example.org/stac/").fill(url);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
}

test("an API is offered as a collection list, never as a tree", async ({ page }) => {
  const searches: string[] = [];
  await serveApi(page, searches);
  await waitForMap(page);
  await connect(page, API);

  await expect(page.getByText("E2E STAC API")).toBeVisible();
  const list = page.getByRole("listbox");
  await expect(list).toBeVisible();
  await expect(list.getByRole("option", { name: "Sentinel-2 L2A" })).toBeVisible();

  // The catalog advertises a child link; offering it would hand the user a branch this panel
  // cannot search, because the branch answers on its own endpoint rather than this one.
  await expect(page.getByRole("tree")).toBeHidden();
  await expect(page.getByRole("treeitem")).toHaveCount(0);
});

test("double-clicking a collection in the list searches it and moves the map", async ({ page }) => {
  const searches: string[] = [];
  await serveApi(page, searches);
  await waitForMap(page);
  await connect(page, API);

  await page.getByLabel("Limit search to the current map extent").uncheck();
  // The status bar's own reading of where the map is, so this asserts the view moved rather than
  // that some text somewhere changed.
  const view = async (): Promise<string> => {
    const text = (await page.locator("footer, [class*=status]").first().textContent()) ?? "";
    return /BBox:[^A-Z]*/.exec(text)?.[0] ?? "";
  };
  const bounds = async (): Promise<number[]> => {
    const text = (await page.locator("footer, [class*=status]").first().textContent()) ?? "";
    const found = /BBox: (-?[\d.]+), (-?[\d.]+), (-?[\d.]+), (-?[\d.]+)/.exec(text);
    return found ? found.slice(1, 5).map(Number) : [];
  };
  const before = await view();
  const landsat = page.getByRole("option", { name: "Landsat 9" });
  await landsat.click();
  await landsat.dblclick();

  // The same gesture as in the tree, and it must reach the search on its own rather than leaving
  // the user to find the button.
  await expect(page.getByText(/Showing \d+ of \d+ items\./)).toBeVisible();
  expect(searches.at(-1)).toBe(JSON.stringify(["landsat-9"]));

  await expect.poll(async () => await view(), { timeout: 10_000 }).not.toBe(before);

  // Landsat's extent, not the items': the fixture returns items over Belgium precisely so a fit
  // to the results would fail this.
  const [west, south, east, north] = await bounds();
  expect(west).toBeLessThanOrEqual(-114);
  expect(east).toBeGreaterThanOrEqual(-109);
  expect(south).toBeLessThanOrEqual(37);
  expect(north).toBeGreaterThanOrEqual(42);
  expect(east - west).toBeLessThan(60);
});

test("connecting to an API after a static catalog clears the tree", async ({ page }) => {
  const searches: string[] = [];
  await serveApi(page, searches);
  await page.route("https://static.stac.test/**", async (route) => {
    // Clicking a collection reads it, so the child needs a document of its own — answering every
    // path with the catalog would nest a second copy of the same row under the first.
    const collection = route.request().url().includes("hazards");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        collection
          ? { type: "Collection", id: "hazards", links: [] }
          : {
              type: "Catalog",
              id: "static",
              title: "E2E Static",
              links: [
                {
                  rel: "child",
                  href: "./hazards/collection.json",
                  title: "Hazards",
                },
              ],
            },
      ),
    });
  });
  await waitForMap(page);
  await connect(page, "https://static.stac.test/catalog.json");

  const hazards = page.getByRole("treeitem", { name: "Hazards" });
  await expect(hazards).toBeVisible();
  await hazards.click();
  await expect(hazards).toHaveAttribute("aria-selected", "true");

  // A catalog the user has left must not leave its rows, or its selection, behind.
  await page.getByPlaceholder("https://example.org/stac/").fill(API);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByText("E2E STAC API")).toBeVisible();
  await expect(page.getByRole("tree")).toBeHidden();
  await expect(page.getByRole("treeitem")).toHaveCount(0);
});
