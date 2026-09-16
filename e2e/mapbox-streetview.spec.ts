import { expect, test, type Page } from "@playwright/test";
import { DESKTOP_SETTINGS_STORAGE_KEY } from "../apps/geolibre-desktop/src/lib/storage-keys";

// Street View on the Mapbox renderer (issue #2420). The upstream control used
// to drop a `maplibre-gl` `Marker` on the map, whose position update reads
// `map._camera.transform` — a mapbox-gl map has no such thing, so the first map
// click threw. maplibre-gl-streetview 0.8.0 takes a `createMarker` factory, and
// the plugin feeds it mapbox-gl's own `Marker` on a Mapbox host.
//
// Credentials stay out of this: the control's Keys tab accepts a key at
// runtime, and the Google metadata endpoint is mocked, so the spec exercises
// the marker path without a real Street View account.
const TOKEN = process.env.MAPBOX_TOKEN ?? "pk.e2e-placeholder.mapbox-token";
const PROJECT_PATH = "/mapbox-streetview.geolibre.json";
const PANO = { lat: 37.7749, lng: -122.4194 };
const PROJECT = {
  version: "0.2.0",
  name: "Mapbox Street View",
  mapView: { center: [PANO.lng, PANO.lat], zoom: 16, bearing: 0, pitch: 0 },
  primaryRenderer: "mapbox",
  preferences: {
    map: { mapboxStyleUrl: "https://tiles.openfreemap.org/styles/liberty" },
  },
};

test.use({ actionTimeout: 30_000 });

/** Stand in for Google's metadata and embed endpoints so no key is needed. */
async function mockStreetViewProvider(page: Page) {
  await page.route("**/maps/api/streetview/metadata**", (route) =>
    route.fulfill({
      json: { status: "OK", pano_id: "e2e-pano", location: PANO },
    }),
  );
  await page.route("**/maps/embed/v1/streetview**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<html><body>pano</body></html>" }),
  );
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
  await expect(page.getByRole("button", { name: "Add Data", exact: true })).toBeEnabled();
}

for (const theme of ["light", "dark"] as const) {
  test(`places the Street View marker with mapbox-gl's own Marker (${theme})`, async ({
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
      await mockStreetViewProvider(page);
      await openMapboxProject(page, info.project.use.baseURL!, theme);

      // Plugins → Street View → Activate. The menu item was greyed out on this
      // renderer before the plugin declared Mapbox.
      await page.getByRole("button", { name: "Plugins", exact: true }).click();
      const item = page.getByRole("menuitem", { name: "Street View", exact: true });
      await expect(item).toBeEnabled();
      await item.hover();
      await page.getByRole("menuitem", { name: "Activate", exact: true }).click();

      // The control mounts in the Mapbox control corner with its panel open.
      const control = page.locator(".mapboxgl-ctrl-top-right .streetview-control");
      await expect(control).toBeVisible();
      const panel = page.locator(".streetview-panel");
      await expect(panel).toHaveClass(/expanded/);

      // Give the control a key through its own Keys tab, so the spec needs no
      // Street View account of its own.
      await panel.getByRole("button", { name: "Keys", exact: true }).click();
      await panel.getByLabel("Google Maps API key").fill("e2e-google-key");
      await panel.getByRole("button", { name: "Apply keys", exact: true }).click();
      await panel.getByRole("button", { name: "Google", exact: true }).click();

      // Clicking the map is what used to throw: MapLibre's Marker reads
      // `map._camera.transform` on `addTo`. The marker must now be mapbox-gl's.
      const canvas = page.locator(".mapboxgl-canvas");
      const box = (await canvas.boundingBox())!;
      await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.55);

      const marker = page.locator(".mapboxgl-marker.streetview-marker");
      await expect(marker).toBeVisible();
      expect(await page.locator(".maplibregl-marker").count()).toBe(0);

      // And it tracks the map, which is the update path that threw.
      const before = await marker.evaluate((el) => (el as HTMLElement).style.transform);
      await page.evaluate(() => {
        const el = document.querySelector(".mapboxgl-canvas") as HTMLCanvasElement;
        el.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }));
      });
      await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.5 - 120, box.y + box.height * 0.5 - 80, {
        steps: 8,
      });
      await page.mouse.up();
      await expect
        .poll(async () => marker.evaluate((el) => (el as HTMLElement).style.transform))
        .not.toBe(before);

      await page.screenshot({ path: info.outputPath(`mapbox-streetview-${theme}.png`) });
      expect(errors, "no console errors placing the marker").toEqual([]);
    }
  });
}
