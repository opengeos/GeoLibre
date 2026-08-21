import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { waitForMap } from "./helpers";

// The PMTiles path is the one asset type the panel cannot fetch and hand over as JSON: the archive
// stays where it is and the map reads ranges out of it, so only a run through the real panel shows
// that an item's asset reaches the map at all.
const API = "https://api.stac.test/v1";
const ARCHIVE = "https://archives.stac.test/mini.pmtiles";

// The committed z0-4 archive the unit tests read.
const archiveBytes = readFileSync(join(__dirname, "..", "tests", "fixtures", "mini.pmtiles"));

const COLLECTIONS = [
  { id: "topo", title: "Topographic maps", extent: { spatial: { bbox: [[-47, -24, -45, -22]] } } },
];

function item(id: string): Record<string, unknown> {
  return {
    type: "Feature",
    stac_version: "1.0.0",
    id,
    collection: "topo",
    bbox: [-46, -23.32, -45.68, -23],
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [-46, -23.32],
          [-45.68, -23.32],
          [-45.68, -23],
          [-46, -23],
          [-46, -23.32],
        ],
      ],
    },
    properties: { datetime: "2024-05-01T00:00:00Z" },
    assets: {
      data: {
        href: "https://archives.stac.test/mini.parquet",
        type: "application/vnd.apache.parquet",
      },
      pmtiles: { href: ARCHIVE, type: "application/vnd.pmtiles", title: "PMTiles vector tiles" },
    },
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
      return json({
        type: "FeatureCollection",
        features: [item("topo-1")],
        numberMatched: 1,
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
      ],
    });
  });
}

/** Serves the archive the way a real host does: Range requests answered with 206 and a range. */
async function serveArchive(page: Page, reads: string[]): Promise<void> {
  await page.route(ARCHIVE, async (route) => {
    const range = /bytes=(\d+)-(\d+)/.exec(route.request().headers().range ?? "");
    if (!range) {
      return route.fulfill({ status: 200, body: archiveBytes });
    }
    reads.push(range[0]);
    const start = Number(range[1]);
    const end = Math.min(Number(range[2]), archiveBytes.length - 1);
    return route.fulfill({
      status: 206,
      headers: { "content-range": `bytes ${start}-${end}/${archiveBytes.length}` },
      body: archiveBytes.subarray(start, end + 1),
    });
  });
}

test("a PMTiles asset from a STAC item reaches the map", async ({ page }) => {
  const reads: string[] = [];
  await serveApi(page);
  await serveArchive(page, reads);
  await waitForMap(page);

  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  await page.getByRole("menuitem", { name: "Web Services" }).click();
  await page.getByRole("menuitem", { name: "STAC Catalogs" }).click();
  await page.getByPlaceholder("https://example.org/stac/").fill(API);
  await page.getByRole("button", { name: "Connect", exact: true }).click();

  await page.getByLabel("Limit search to the current map extent").uncheck();
  const collection = page.getByRole("option", { name: "Topographic maps" });
  await collection.click();
  await collection.dblclick();
  await expect(page.getByText(/Showing \d+ of \d+ items\./)).toBeVisible();

  // The parquet beside the archive is addable too, and being listed first it is the one the
  // panel preselects, so the archive is chosen explicitly rather than taken as the default.
  const assets = page
    .locator("select")
    .filter({ has: page.locator('option[value="pmtiles"]') })
    .first();
  await assets.selectOption("pmtiles");

  const add = page.getByRole("button", { name: "Add", exact: true }).first();
  await expect(add).toBeEnabled();
  await add.click();

  // Named for the item and its asset, and rendering rather than standing in as a placeholder.
  await expect(page.getByText("topo-1 — PMTiles vector tiles")).toBeVisible();
  await expect(page.getByText("could not be displayed")).toBeHidden();
  // The header was read out of the archive over ranges, not downloaded whole.
  expect(reads.length).toBeGreaterThan(0);
});
