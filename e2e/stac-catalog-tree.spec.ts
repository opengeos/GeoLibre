import { expect, test, type Page } from "@playwright/test";
import { waitForMap } from "./helpers";

// The catalog tree paints its selection through inline styles, which only a real browser resolves:
// `hsl(var(--primary))` is a string until a CSSOM accepts it and a stylesheet defines the variable.
// The unit tests run against a DOM double that stores any string it is given, so a highlight that
// never appears — or never goes away — reads as passing there. This suite is the check that cannot
// be faked: it asks the browser what colour the row actually is.
const ROOT = "https://stac.test/catalog.json";

const DOCUMENTS: Record<string, unknown> = {
  "https://stac.test/catalog.json": {
    type: "Catalog",
    id: "e2e",
    title: "E2E Catalog",
    links: [
      { rel: "child", href: "./hazards/collection.json", title: "Hazards" },
      { rel: "child", href: "./geology/collection.json", title: "Geology" },
      { rel: "child", href: "./topics/catalog.json", title: "Topics" },
    ],
  },
  "https://stac.test/topics/catalog.json": {
    type: "Catalog",
    id: "topics",
    links: [{ rel: "child", href: "./water/collection.json", title: "Water" }],
  },
  "https://stac.test/geology/collection.json": {
    type: "Collection",
    id: "geology",
    extent: { spatial: { bbox: [[-112, 39, -111, 40]] } },
    links: [{ rel: "item", href: "./outcrop.json" }],
  },
  "https://stac.test/geology/outcrop.json": {
    type: "Feature",
    stac_version: "1.0.0",
    id: "outcrop",
    collection: "geology",
    bbox: [-112, 39, -111, 40],
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [-112, 39],
          [-111, 39],
          [-111, 40],
          [-112, 40],
          [-112, 39],
        ],
      ],
    },
    properties: { datetime: "2024-05-01T00:00:00Z" },
    assets: {},
    links: [],
  },
  "https://stac.test/hazards/collection.json": {
    type: "Collection",
    id: "hazards",
    extent: { spatial: { bbox: [[-114, 37, -109, 42]] } },
    links: [{ rel: "item", href: "./slide.json" }],
  },
  "https://stac.test/hazards/slide.json": {
    type: "Feature",
    stac_version: "1.0.0",
    id: "landslide",
    collection: "hazards",
    bbox: [-113, 38, -112, 39],
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [-113, 38],
          [-112, 38],
          [-112, 39],
          [-113, 39],
          [-113, 38],
        ],
      ],
    },
    properties: { datetime: "2024-05-01T00:00:00Z" },
    assets: {},
    links: [],
  },
};

/** Serves the fixture catalog, so the suite needs no network and no third-party catalog. */
/**
 * Serves the fixture catalog. `slow` names a document that answers late, so a race can be staged
 * rather than hoped for, and the returned promise says when that late answer has landed: waiting
 * on it beats sleeping for longer than the delay and hoping.
 */
async function serveCatalog(
  page: Page,
  asked: string[] = [],
  slow?: string,
): Promise<{ slowAnswered: Promise<void> }> {
  let answered: () => void = () => {};
  const slowAnswered = new Promise<void>((resolve) => {
    answered = resolve;
  });
  await page.route("https://stac.test/**", async (route) => {
    const url = route.request().url();
    asked.push(url);
    const late = Boolean(slow && url.includes(slow));
    if (late) await new Promise((resolve) => setTimeout(resolve, 2500));
    const document = DOCUMENTS[route.request().url()];
    if (!document) {
      await route.fulfill({ status: 404, body: "not found" });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(document),
    });
    if (late) answered();
  });
  return { slowAnswered };
}

async function openStacPanel(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  await page.getByRole("menuitem", { name: "Web Services" }).click();
  await page.getByRole("menuitem", { name: "STAC Catalogs" }).click();
  await page.getByPlaceholder("https://example.org/stac/").fill(ROOT);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
}

const backgroundOf = (page: Page, name: string) =>
  page.getByRole("treeitem", { name }).evaluate((row) => getComputedStyle(row).backgroundColor);

/** The map's own bounds, as the status bar reports them: west, south, east, north. */
async function mapBounds(page: Page): Promise<number[]> {
  const text = (await page.locator("footer, [class*=status]").first().textContent()) ?? "";
  const found = /BBox: (-?[\d.]+), (-?[\d.]+), (-?[\d.]+), (-?[\d.]+)/.exec(text);
  return found ? found.slice(1, 5).map(Number) : [];
}

test("the tree paints the selection, and lets go of it", async ({ page }) => {
  await serveCatalog(page);
  await waitForMap(page);
  await openStacPanel(page);

  const hazards = page.getByRole("treeitem", { name: "Hazards" });
  const geology = page.getByRole("treeitem", { name: "Geology" });
  await expect(hazards).toBeVisible();

  const unselected = await backgroundOf(page, "Hazards");
  await hazards.click();
  const selected = await backgroundOf(page, "Hazards");
  expect(selected).not.toBe(unselected);
  expect(selected).not.toBe("rgba(0, 0, 0, 0)");

  // The bug this guards: the highlight stayed on every row ever clicked, because the code removed
  // it by string surgery on a `cssText` the browser had already rewritten.
  await geology.click();
  expect(await backgroundOf(page, "Hazards")).toBe(unselected);
  expect(await backgroundOf(page, "Geology")).toBe(selected);
  await expect(hazards).toHaveAttribute("aria-selected", "false");
  await expect(geology).toHaveAttribute("aria-selected", "true");
});

test("a selected row wears the theme's own highlight pair, the right way round", async ({
  page,
}) => {
  await serveCatalog(page);
  await waitForMap(page);
  await openStacPanel(page);

  const hazards = page.getByRole("treeitem", { name: "Hazards" });
  await hazards.click();
  const [background, color] = await hazards.evaluate((row) => {
    const style = getComputedStyle(row);
    return [style.backgroundColor, style.color];
  });

  // Resolved from the live theme rather than hard-coded, so this holds in light and dark alike —
  // and still fails if the pair is swapped, or if only the background is painted.
  const [primary, foreground] = await page.evaluate(() => {
    const probe = document.createElement("div");
    document.body.append(probe);
    probe.style.background = "hsl(var(--primary))";
    probe.style.color = "hsl(var(--primary-foreground))";
    const style = getComputedStyle(probe);
    const pair = [style.backgroundColor, style.color];
    probe.remove();
    return pair;
  });

  expect(background).toBe(primary);
  expect(color).toBe(foreground);
  expect(background).not.toBe(color);
});

test("depth is indented, and a folder reads its children only when opened", async ({ page }) => {
  await serveCatalog(page);
  await waitForMap(page);
  await openStacPanel(page);

  const topics = page.getByRole("treeitem", { name: "Topics" });
  await expect(topics).toHaveAttribute("aria-expanded", "false");
  await topics.click();

  const water = page.getByRole("treeitem", { name: "Water" });
  await expect(water).toBeVisible();
  await expect(topics).toHaveAttribute("aria-expanded", "true");

  // Indentation is what makes the nesting readable; a unitless or physical value would leave the
  // tree flat in the browser while the inline string still looked right.
  const [parent, child] = await Promise.all([
    topics.evaluate((row) => getComputedStyle(row).paddingInlineStart),
    water.evaluate((row) => getComputedStyle(row).paddingInlineStart),
  ]);
  expect(parseFloat(child)).toBeGreaterThan(parseFloat(parent));
});

test("the tree is one tab stop, and the arrows move within it", async ({ page }) => {
  await serveCatalog(page);
  await waitForMap(page);
  await openStacPanel(page);

  const hazards = page.getByRole("treeitem", { name: "Hazards" });
  await expect(hazards).toBeVisible();

  // Reaching the tree costs one tab, and reaching what follows it costs one more — not one per
  // row, which on a catalog of hundreds is the difference between usable and not.
  await page.getByPlaceholder("https://example.org/stac/").focus();
  const stops: string[] = [];
  for (let press = 0; press < 6; press += 1) {
    await page.keyboard.press("Tab");
    stops.push(
      await page.evaluate(() => {
        const active = document.activeElement;
        return active?.getAttribute("role") === "treeitem"
          ? `treeitem:${active.textContent}`
          : (active?.tagName.toLowerCase() ?? "none");
      }),
    );
  }
  expect(stops.filter((stop) => stop.startsWith("treeitem"))).toHaveLength(1);

  await hazards.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("treeitem", { name: "Geology" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("treeitem", { name: "Topics" })).toBeFocused();

  // Right opens a folder and steps into it; Enter chooses the row it lands on.
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("treeitem", { name: "Topics" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await page.keyboard.press("ArrowRight");
  const water = page.getByRole("treeitem", { name: "Water" });
  await expect(water).toBeFocused();

  // Enter chooses, as it does on any button. Ctrl+Enter is the keyboard's double-click, so
  // searching a collection is reachable without a mouse.
  await page.keyboard.press("Enter");
  await expect(water).toHaveAttribute("aria-selected", "true");
});

test("Ctrl+Enter on a collection searches it and takes the map to it", async ({ page }) => {
  await serveCatalog(page);
  await waitForMap(page);
  await openStacPanel(page);
  await page.getByLabel("Limit search to the current map extent").uncheck();

  const view = async (): Promise<string> => {
    const text = (await page.locator("footer, [class*=status]").first().textContent()) ?? "";
    return /BBox:[^A-Z]*/.exec(text)?.[0] ?? "";
  };
  const before = await view();
  expect(before).toMatch(/BBox:/);

  // The collection was only guessed from its link, so its extent is not known until the search
  // asks for it — the map still has to end up there.
  const hazards = page.getByRole("treeitem", { name: "Hazards" });
  await hazards.focus();
  await page.keyboard.press("Control+Enter");

  await expect(page.getByText("Showing 1 of 1 items.")).toBeVisible({ timeout: 15_000 });
  await expect(hazards).toHaveAttribute("aria-selected", "true");
  await expect.poll(view, { timeout: 15_000 }).not.toBe(before);

  // The collection's extent, not the item's: the item sits at -113..-112, so a fit to the item
  // would pass a "the view moved" check while missing what was asked for.
  const [west, south, east, north] = await mapBounds(page);
  expect(west).toBeLessThanOrEqual(-114);
  expect(east).toBeGreaterThanOrEqual(-109);
  expect(south).toBeLessThanOrEqual(37);
  expect(north).toBeGreaterThanOrEqual(42);
  expect(east - west).toBeLessThan(30);
});

test("Ctrl-click adds a second collection, and Meta+Enter searches like Ctrl does", async ({
  page,
}) => {
  await serveCatalog(page);
  await waitForMap(page);
  await openStacPanel(page);
  await page.getByLabel("Limit search to the current map extent").uncheck();

  const hazards = page.getByRole("treeitem", { name: "Hazards" });
  const geology = page.getByRole("treeitem", { name: "Geology" });
  await hazards.click();
  await geology.click({ modifiers: ["ControlOrMeta"] });

  // Both stay chosen: the modifier adds rather than replaces.
  await expect(hazards).toHaveAttribute("aria-selected", "true");
  await expect(geology).toHaveAttribute("aria-selected", "true");

  // Ctrl/Cmd+Enter asks for both, since both are chosen.
  await hazards.focus();
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(page.getByText("Showing 2 of 2 items.")).toBeVisible({ timeout: 15_000 });
});

test("a folder is not read until it is opened", async ({ page }) => {
  const asked: string[] = [];
  await serveCatalog(page, asked);
  await waitForMap(page);
  await openStacPanel(page);

  const topics = page.getByRole("treeitem", { name: "Topics" });
  await expect(topics).toBeVisible();
  // Connecting reads the root and nothing else; an eager walk would have this already.
  expect(asked.filter((url) => url.includes("topics/catalog.json"))).toHaveLength(0);

  await topics.click();
  await expect(page.getByRole("treeitem", { name: "Water" })).toBeVisible();
  expect(asked.filter((url) => url.includes("topics/catalog.json"))).toHaveLength(1);
});

test("asking for a second collection wins, however slowly the first one answers", async ({
  page,
}) => {
  const { slowAnswered } = await serveCatalog(page, [], "hazards/collection.json");
  await waitForMap(page);
  await openStacPanel(page);
  await page.getByLabel("Limit search to the current map extent").uncheck();

  // Hazards spans -114..-109; Geology sits inside it at -112..-111. Hazards' extent arrives late,
  // so a fit that ignores which search it belongs to would drag the map back out to the wider box.
  await page.getByRole("treeitem", { name: "Hazards" }).click();
  await page.keyboard.press("ControlOrMeta+Enter");
  await page.getByRole("treeitem", { name: "Geology" }).click();
  await page.keyboard.press("ControlOrMeta+Enter");

  await expect(page.getByText("Showing 1 of 1 items.")).toBeVisible({ timeout: 15_000 });

  // The stale answer has landed, so whatever the map does next is the answer to the second ask.
  await slowAnswered;
  await expect
    .poll(async () => (await mapBounds(page))[0], { timeout: 10_000 })
    .toBeGreaterThan(-114);
  const [west, , east] = await mapBounds(page);
  expect(east - west).toBeLessThan(4);
  expect(west).toBeGreaterThan(-114);
});
