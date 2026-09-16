import { expect, test, type Locator, type Page } from "@playwright/test";
import { DESKTOP_SETTINGS_STORAGE_KEY } from "../apps/geolibre-desktop/src/lib/storage-keys";

// Layer Swipe on the Mapbox renderer (issue #2420). `maplibre-gl-swipe` used to
// construct a MapLibre `Map` for the clipped comparison pane, which cannot be
// layered over a mapbox-gl canvas. 0.13.0 takes a `createMap` factory (fed
// mapbox-gl's `Map`, plus the access token mapbox-gl needs per map) and
// `basemapLayerIds` (a `mapbox://` style URL cannot be fetched, which is how
// the control otherwise learns which layers are basemap).
const TOKEN = process.env.MAPBOX_TOKEN ?? "pk.e2e-placeholder.mapbox-token";
const PROJECT_PATH = "/mapbox-swipe.geolibre.json";

/** Two squares side by side, so each swipe side has something of its own. */
function square(west: number, name: string) {
  return {
    id: name,
    name,
    type: "geojson" as const,
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: { fillColor: name === "West" ? "#e6194b" : "#3cb44b", fillOpacity: 0.9 },
    metadata: {},
    geojson: {
      type: "FeatureCollection" as const,
      features: [
        {
          type: "Feature" as const,
          properties: { name },
          geometry: {
            type: "Polygon" as const,
            coordinates: [
              [
                [west, 30],
                [west + 20, 30],
                [west + 20, 45],
                [west, 45],
                [west, 30],
              ],
            ],
          },
        },
      ],
    },
  };
}

const PROJECT = {
  version: "0.2.0",
  name: "Mapbox Swipe",
  mapView: { center: [-95, 38], zoom: 3, bearing: 0, pitch: 0 },
  primaryRenderer: "mapbox",
  preferences: {
    map: { mapboxStyleUrl: "https://tiles.openfreemap.org/styles/liberty" },
  },
  layers: [square(-115, "West"), square(-85, "East")],
};

test.use({ actionTimeout: 30_000 });

/** Bind the live Mapbox engine through the React shell's own ref. */
async function bindEngine(page: Page) {
  await page.waitForFunction(() => {
    const header = document.querySelector("header") as unknown as Record<string, unknown>;
    if (!header) return false;
    let fiber = header[Object.keys(header).find((key) => key.startsWith("__reactFiber"))!] as any;
    while (fiber) {
      for (const side of [fiber, fiber.alternate]) {
        let hook = side?.memoizedState;
        while (hook) {
          const engine = hook.memoizedState?.current;
          if (engine?.kind === "mapbox" && engine.getMapboxMap?.()) {
            (window as any).swipeTestRef = hook.memoizedState;
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

/**
 * The distinct visibilities the control applied to the style layers one project
 * layer draws through, on the main map. The Mapbox engine compiles each store
 * layer into `geolibre-mapbox-<id>-<source>-<fill|line|circle>` rows, so the
 * swipe's per-layer assignment has to reach all of them.
 */
async function mainMapVisibility(page: Page, layerId: string): Promise<string[]> {
  return page.evaluate((id) => {
    const map = (window as any).swipeTestRef.current.getMapboxMap();
    const visibilities = (map.getStyle().layers ?? [])
      .filter((layer: { id: string }) => layer.id.startsWith(`geolibre-mapbox-${id}-`))
      .map((layer: { id: string }) => map.getLayoutProperty(layer.id, "visibility") ?? "visible");
    return [...new Set(visibilities)] as string[];
  }, layerId);
}

/**
 * Check or uncheck every panel row for one project layer on one side.
 *
 * The panel lists *style* layers, and the engine compiles each store layer into
 * a fill, a line and a circle row, so a per-layer assignment means all three.
 */
async function setSide(
  panel: Locator,
  layerId: string,
  side: "left" | "right",
  checked: boolean,
): Promise<void> {
  const boxes = panel.locator(
    `input[data-side="${side}"][data-layer-id^="geolibre-mapbox-${layerId}-"]`,
  );
  const count = await boxes.count();
  expect(count, `expected panel rows for ${layerId}`).toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) {
    const box = boxes.nth(index);
    if ((await box.isChecked()) !== checked) await box.click();
  }
}

async function openMapboxProject(page: Page, baseURL: string, theme: "light" | "dark") {
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
  await page.addLocatorHandler(
    page.getByRole("heading", { name: "Recover unsaved work?" }),
    async () => {
      await page.getByRole("button", { name: "Discard", exact: true }).click();
    },
  );
  await page.goto(`/?project=${baseURL}${PROJECT_PATH}${theme === "dark" ? "&theme=dark" : ""}`);
  await expect(page.locator(".mapboxgl-canvas")).toBeVisible();
  await bindEngine(page);
  await expect(page.getByRole("button", { name: "Add Data", exact: true })).toBeEnabled();
}

for (const theme of ["light", "dark"] as const) {
  test(`swipes project layers with a mapbox-gl comparison pane (${theme})`, async ({
    page,
  }, info) => {
    test.setTimeout(240_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(`error: ${message.text()}`);
    });
    try {
      await run();
    } finally {
      await info.attach("console", { body: errors.join("\n"), contentType: "text/plain" });
    }

    async function run() {
      await openMapboxProject(page, info.project.use.baseURL!, theme);

      // Plugins → Layer Swipe → Activate. The entry was greyed out on this
      // renderer before the plugin declared Mapbox.
      await page.getByRole("button", { name: "Plugins", exact: true }).click();
      const item = page.getByRole("menuitem", { name: "Layer Swipe", exact: true });
      await expect(item).toBeEnabled();
      await item.hover();
      await page.getByRole("menuitem", { name: "Activate", exact: true }).click();

      await expect(page.locator(".swipe-control")).toBeVisible();
      const panel = page.locator(".swipe-control-panel");
      await expect(panel).toHaveClass(/expanded/);

      // The comparison pane is a mapbox-gl map: a MapLibre one cannot be
      // layered over this canvas, and its own canvas would carry the other
      // library's class.
      await expect(page.locator(".swipe-comparison-map .mapboxgl-canvas")).toBeAttached();
      expect(await page.locator(".swipe-comparison-map .maplibregl-canvas").count()).toBe(0);

      // Both project layers are listed; the deck.gl raster provider contributes
      // nothing here (it is MapLibre-only) so every row is a native style layer.
      await expect(panel.getByText("West", { exact: false }).first()).toBeVisible();
      await expect(panel.getByText("East", { exact: false }).first()).toBeVisible();

      // The grouped basemap row is there, which is what `basemapStyle` /
      // `basemapLayerIds` buy: without it every basemap layer would be listed.
      await expect(panel.locator('input[data-layer-id="__basemap__"]').first()).toBeAttached();

      // Put East on the right side only. `selectVisibleByDefault` starts every
      // visible layer on the left, so the left boxes have to come off first —
      // a layer on both sides is not swiped at all.
      await setSide(panel, "East", "left", false);
      await setSide(panel, "East", "right", true);

      // East is right-only, so the control hides it on the main map and draws
      // it on the clipped comparison pane instead. That round trip is the whole
      // feature, and it is what a MapLibre pane could not do here.
      await expect.poll(() => mainMapVisibility(page, "East")).toEqual(["none"]);
      expect(await mainMapVisibility(page, "West")).toEqual(["visible"]);

      // The comparison pane got a copy of the right-side layer.
      await expect
        .poll(async () =>
          page.evaluate(() => {
            const pane = (document.querySelector(".swipe-comparison-map") as HTMLElement) ?? null;
            return pane ? pane.querySelectorAll("canvas").length : 0;
          }),
        )
        .toBeGreaterThan(0);

      // Dragging the slider moves the clip.
      const clip = page.locator(".swipe-clip-container");
      const before = await clip.evaluate((el) => (el as HTMLElement).style.left);
      const slider = page.locator(".swipe-slider");
      const box = (await slider.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 - 150, box.y + box.height / 2, { steps: 10 });
      await page.mouse.up();
      await expect
        .poll(async () => clip.evaluate((el) => (el as HTMLElement).style.left))
        .not.toBe(before);

      await page.screenshot({ path: info.outputPath(`mapbox-swipe-${theme}.png`) });

      // mapbox-gl reads its token from a global the app never sets, so a
      // comparison pane built without one renders nothing and logs every frame.
      // (The `mapbox://` basemap path — where the control cannot fetch the style
      // and takes `basemapLayerIds` instead — is covered by the unit tests; this
      // project uses a third-party style so the spec runs without a real token.)
      expect(
        errors.filter((message) => message.includes("access token")),
        "the comparison pane must get the token mapbox-gl needs per map",
      ).toEqual([]);
    }
  });
}
