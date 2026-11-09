import { expect, test, type Page } from "./test";
import { waitForMap } from "./helpers";

// `maplibre-stac.ts` builds its panel by hand and exports nothing to call, so the wiring between
// the catalog tree, the collection list and the search only exists here. An API is the half that
// has no tree at all: it answers item search itself, and offering a tree of its hierarchy would
// promise a way in that its endpoint does not honour.
const API = "https://api.stac.test/v1";
const PLANETARY_COMPUTER_API = "https://planetarycomputer.microsoft.com/api/stac/v1/";
const PRIVATE_PLANETARY_COMPUTER_COG =
  "https://ai4edataeuwest.blob.core.windows.net/private-cog/example.tif";

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

  // The card's "Assets" menu names itself and drops the asset list.
  const assets = page
    .getByRole("combobox")
    .filter({ hasText: /^Assets/ })
    .first();
  await expect(assets.getByRole("option")).toHaveText([
    "Assets",
    "Red Band — COG",
    "Boundaries — GeoJSON",
    "Vector tiles — PMTiles",
    "Dataset root — Parquet",
    "Metadata — Unknown format (not addable)",
  ]);
});

test("Planetary Computer COG assets are signed before raster reads", async ({ page }) => {
  const assetRequests: string[] = [];
  let signingRequests = 0;
  await page.route("https://planetarycomputer.microsoft.com/**", async (route) => {
    const url = new URL(route.request().url());
    const json = (body: unknown) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

    if (url.pathname.endsWith("/api/sas/v1/sign")) {
      signingRequests += 1;
      expect(url.searchParams.get("href")).toBe(PRIVATE_PLANETARY_COMPUTER_COG);
      return json({
        href: `${PRIVATE_PLANETARY_COMPUTER_COG}?sp=r&sig=signed-for-test`,
        "msft:expiry": "2099-01-01T00:00:00Z",
      });
    }
    if (url.pathname.endsWith("/collections")) {
      return json({ collections: [{ id: "private-cog", title: "Private COG" }] });
    }
    if (url.pathname.endsWith("/search")) {
      return json({
        type: "FeatureCollection",
        features: [
          item("private-cog-1", "private-cog", {
            data: { href: PRIVATE_PLANETARY_COMPUTER_COG, type: "image/tiff" },
          }),
        ],
        numberMatched: 1,
        links: [],
      });
    }
    return json({
      type: "Catalog",
      id: "planetary-computer",
      title: "Planetary Computer",
      conformsTo: ["https://api.stacspec.org/v1.0.0/item-search"],
      links: [
        { rel: "data", href: `${PLANETARY_COMPUTER_API}collections` },
        { rel: "search", href: `${PLANETARY_COMPUTER_API}search`, method: "POST" },
      ],
    });
  });
  await page.route(`${PRIVATE_PLANETARY_COMPUTER_COG}**`, async (route) => {
    assetRequests.push(route.request().url());
    await route.fulfill({ status: 404, body: "fixture only checks the signed request" });
  });

  await waitForMap(page);
  await connect(page, PLANETARY_COMPUTER_API);
  await page.getByLabel("Limit search to the current map extent").uncheck();
  await page
    .locator("select")
    .filter({ has: page.locator('option[value="private-cog"]') })
    .selectOption("private-cog");
  await page.getByRole("button", { name: "Search items" }).click();
  await expect(page.getByText(/Showing 1 of 1 items\./)).toBeVisible();
  // Choosing an asset from the "Assets" menu adds it straight away.
  await page
    .getByRole("combobox")
    .filter({ hasText: /^Assets/ })
    .first()
    .selectOption({ label: "data — COG" });

  await expect.poll(() => assetRequests.length).toBeGreaterThan(0);
  expect(signingRequests).toBe(1);
  const requestedAsset = new URL(assetRequests[0]);
  expect(requestedAsset.searchParams.get("sp")).toBe("r");
  expect(requestedAsset.searchParams.get("sig")).toBe("signed-for-test");
});

async function connect(page: Page, url: string): Promise<void> {
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  await page.getByRole("menuitem", { name: "Web services" }).click();
  await page.getByRole("menuitem", { name: "STAC catalogs" }).click();
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

test("Add rendering offers the combinations and indices an item has the bands for", async ({
  page,
}) => {
  const searches: string[] = [];
  const band = (name: string) => ({
    href: `https://data.test/${name}.tif`,
    type: "image/tiff",
    title: name,
    "eo:bands": [{ common_name: name }],
  });
  await serveApi(page, searches, {
    red: band("red"),
    green: band("green"),
    blue: band("blue"),
    nir: band("nir"),
  });
  await page.route("https://data.test/**", (route) =>
    route.fulfill({ status: 404, body: "fixture only" }),
  );
  await waitForMap(page);
  await connect(page, API);

  await page.getByLabel("Limit search to the current map extent").uncheck();
  await page.getByRole("button", { name: "Search items" }).click();

  // Only what red, green, blue and NIR can make: no SWIR combinations or indices.
  const rendering = page
    .getByRole("combobox")
    .filter({ hasText: /^Bands/ })
    .first();
  await expect(rendering.getByRole("option")).toHaveText([
    "Bands",
    "True color",
    "Color infrared (vegetation)",
    "NDVI (vegetation)",
    "NDWI (water, green/NIR)",
    "SAVI (soil-adjusted vegetation)",
    "EVI (enhanced vegetation)",
  ]);

  // Choosing one adds it straight away, as a layer named for the item and the rendering.
  await rendering.selectOption({ label: "NDVI (vegetation)" });
  const layers = page.getByRole("complementary", { name: "Layers" });
  await expect(layers.getByText(/NDVI \(vegetation\)/)).toBeVisible();
});

test("the buffer and cloud cover limits are checkboxes that unlock a number", async ({ page }) => {
  const searches: string[] = [];
  await serveApi(page, searches);
  await waitForMap(page);
  await connect(page, API);

  for (const [name, fallback] of [
    [/Buffer points and lines/, "100"],
    [/Max cloud/, "10"],
  ] as const) {
    const check = page.getByRole("checkbox", { name });
    await expect(check).not.toBeChecked();
    const box = page.getByRole("spinbutton", { name });
    await expect(box).toBeDisabled();
    await expect(box).toHaveValue(fallback);
    await check.check();
    await expect(box).toBeEnabled();
  }
});

test("the sort order and the cloud cover limit share one row", async ({ page }) => {
  const searches: string[] = [];
  await serveApi(page, searches);
  await waitForMap(page);
  await connect(page, API);

  const sort = page.getByRole("combobox").filter({ hasText: "Server default" });
  const cloud = page.getByRole("checkbox", { name: /Max cloud/ });
  // The panel can be dragged narrow, and a row that only fits in a wide one is not one row.
  await sort.evaluate((select) => {
    select.closest("label")!.parentElement!.parentElement!.style.width = "300px";
  });
  const [sortBox, cloudBox] = await Promise.all([sort.boundingBox(), cloud.boundingBox()]);
  expect(sortBox).not.toBeNull();
  expect(cloudBox).not.toBeNull();
  // Side by side, cloud cover on the left: the checkbox sits inside the dropdown's vertical span.
  expect(cloudBox!.y).toBeGreaterThanOrEqual(sortBox!.y - 4);
  expect(cloudBox!.y).toBeLessThan(sortBox!.y + sortBox!.height);
  expect(sortBox!.x).toBeGreaterThan(cloudBox!.x + cloudBox!.width);
});

test("an item's Zoom, Assets, Bands and Download share one row, whatever the asset names", async ({
  page,
}) => {
  const searches: string[] = [];
  const band = (name: string, title: string) => ({
    href: `https://data.test/${name}.tif`,
    type: "image/tiff",
    title,
    "eo:bands": [{ common_name: name }],
  });
  await serveApi(page, searches, {
    red: band("red", "Aerosol optical thickness with a very long descriptive title (AOT)"),
    green: band("green", "Green"),
    blue: band("blue", "Blue"),
    nir: band("nir", "Near infrared, narrow band, 10 m"),
  });
  await waitForMap(page);
  await connect(page, API);
  await page.getByLabel("Limit search to the current map extent").uncheck();
  await page.getByRole("button", { name: "Search items" }).click();

  const card = page.getByRole("button", { name: "Zoom", exact: true }).first().locator("..");
  const boxes = await Promise.all(
    [
      card.getByRole("button", { name: "Zoom", exact: true }),
      card.getByRole("combobox").filter({ hasText: /^Assets/ }),
      card.getByRole("combobox").filter({ hasText: /^Bands/ }),
      card.getByRole("combobox").filter({ hasText: /^Download/ }),
    ].map((control) => control.boundingBox()),
  );
  const panel = await card.boundingBox();
  for (const box of boxes) expect(box).not.toBeNull();
  const [zoom, ...menus] = boxes as NonNullable<(typeof boxes)[number]>[];
  for (const menu of menus) {
    // Same row as Zoom, and inside the card rather than spilling out of it.
    expect(Math.abs(menu.y - zoom.y)).toBeLessThan(8);
    expect(menu.x + menu.width).toBeLessThanOrEqual(panel!.x + panel!.width + 1);
  }
});

test("a band rendering has the Edit raster style entry, and its style editor", async ({ page }) => {
  const searches: string[] = [];
  const band = (name: string) => ({
    href: `https://data.test/${name}.tif`,
    type: "image/tiff",
    title: name,
    "eo:bands": [{ common_name: name }],
  });
  await serveApi(page, searches, {
    red: band("red"),
    green: band("green"),
    blue: band("blue"),
    nir: band("nir"),
  });
  await page.route("https://data.test/**", (route) =>
    route.fulfill({ status: 404, body: "fixture only" }),
  );
  await waitForMap(page);
  await connect(page, API);
  await page.getByLabel("Limit search to the current map extent").uncheck();
  await page.getByRole("button", { name: "Search items" }).click();

  const bands = page
    .getByRole("combobox")
    .filter({ hasText: /^Bands/ })
    .first();
  await bands.selectOption({ label: "NDVI (vegetation)" });
  const row = page.locator('[data-testid="layer-row"][data-layer-name$="NDVI (vegetation)"]');
  await expect(row).toBeVisible();

  // The same entry a COG layer has, opening a style editor made for this kind of layer.
  await row.locator('button[aria-label="Layer actions"]').click();
  await page.getByRole("menuitem", { name: "Edit raster style…" }).click();
  const editor = page.getByTestId("stac-rendering-style");
  await expect(editor).toBeVisible();
  await expect(editor.getByLabel("Color ramp")).toHaveValue("BrBG");

  // An edit is kept: the ramp survives the editor being closed and opened again.
  await editor.getByLabel("Color ramp").selectOption("RdYlGn");
  await page.waitForTimeout(800);
  await editor
    .locator("xpath=ancestor::aside[1]")
    .getByRole("button", { name: /Collapse/ })
    .click();
  await expect(editor).toBeHidden();
  await row.locator('button[aria-label="Layer actions"]').click();
  await page.getByRole("menuitem", { name: "Edit raster style…" }).click();
  await expect(page.getByTestId("stac-rendering-style").getByLabel("Color ramp")).toHaveValue(
    "RdYlGn",
  );
});

test("a colour composite's style editor offers brightness and gamma, not a ramp", async ({
  page,
}) => {
  const searches: string[] = [];
  const band = (name: string) => ({
    href: `https://data.test/${name}.tif`,
    type: "image/tiff",
    title: name,
    "eo:bands": [{ common_name: name }],
  });
  await serveApi(page, searches, { red: band("red"), green: band("green"), blue: band("blue") });
  await page.route("https://data.test/**", (route) =>
    route.fulfill({ status: 404, body: "fixture only" }),
  );
  await waitForMap(page);
  await connect(page, API);
  await page.getByLabel("Limit search to the current map extent").uncheck();
  await page.getByRole("button", { name: "Search items" }).click();
  await page
    .getByRole("combobox")
    .filter({ hasText: /^Bands/ })
    .first()
    .selectOption({ label: "True color" });
  const row = page.locator('[data-testid="layer-row"][data-layer-name$="True color"]');
  await row.locator('button[aria-label="Layer actions"]').click();
  await page.getByRole("menuitem", { name: "Edit raster style…" }).click();
  const editor = page.getByTestId("stac-rendering-style");
  await expect(editor.getByText("Brightness")).toBeVisible();
  await expect(editor.getByText("Gamma")).toBeVisible();
  await expect(editor.getByLabel("Color ramp")).toHaveCount(0);
});
