import { expect, test, type Page } from "@playwright/test";
import { layerRow } from "./helpers";
import { DESKTOP_SETTINGS_STORAGE_KEY } from "../apps/geolibre-desktop/src/lib/storage-keys";

// Overture Maps on the Mapbox renderer (issue #2420). The upstream control used
// to load its archives through `maplibregl.addProtocol("pmtiles", ...)`, which
// a mapbox-gl map never sees, and opened MapLibre popups, which throw there.
// On a Mapbox host the plugin now asks `maplibre-gl-overture-maps` for plain
// https archive URLs (mapbox-gl 3.30+ reads `.pmtiles` through its own tile
// provider) and for popups built from mapbox-gl's `Popup`. The project points
// the Mapbox pane at a third-party style, so the token is only what mapbox-gl
// needs to construct a map; the Overture tiles come from Overture's public S3
// bucket and the PMTiles provider from api.mapbox.com.
const TOKEN = process.env.MAPBOX_TOKEN ?? "pk.e2e-placeholder.mapbox-token";
const PROJECT_PATH = "/mapbox-overture.geolibre.json";
const PROJECT = {
  version: "0.2.0",
  name: "Mapbox Overture",
  mapView: { center: [-73.985, 40.748], zoom: 15, bearing: 0, pitch: 0 },
  primaryRenderer: "mapbox",
  preferences: {
    map: { mapboxStyleUrl: "https://tiles.openfreemap.org/styles/liberty" },
  },
};
const BUILDINGS_SOURCE = "overture-buildings";
const BUILDINGS_FILL = "overture-buildings-building-fill";

test.use({ actionTimeout: 30_000 });

type EngineKind = "mapbox" | "maplibre";

// Inspect the real engine held by the React shell without adding a production
// global: walk the header's fiber tree to the ref that holds the live engine.
async function bindEngine(page: Page, kind: EngineKind) {
  await page.waitForFunction((wanted) => {
    const header = document.querySelector("header") as unknown as Record<string, unknown>;
    if (!header) return false;
    let fiber = header[Object.keys(header).find((key) => key.startsWith("__reactFiber"))!] as any;
    while (fiber) {
      for (const side of [fiber, fiber.alternate]) {
        let hook = side?.memoizedState;
        while (hook) {
          const ref = hook.memoizedState;
          const engine = ref?.current;
          if (
            engine?.kind === wanted &&
            (wanted === "mapbox" ? engine.getMapboxMap?.() : engine.getMap?.())
          ) {
            (window as any).overtureTestRef = ref;
            return true;
          }
          hook = hook.next;
        }
      }
      fiber = fiber.return;
    }
    return false;
  }, kind);
}

/** What the live map holds of the Overture control: its buildings source and layers. */
async function overtureMapState(page: Page) {
  return page.evaluate(
    ({ sourceId, fillId }) => {
      const engine = (window as any).overtureTestRef.current;
      const map = engine.kind === "mapbox" ? engine.getMapboxMap() : engine.getMap();
      const style = map.getStyle();
      const source = style?.sources?.[sourceId] as { url?: string } | undefined;
      let features = 0;
      try {
        features = map.getSource(sourceId)
          ? map.querySourceFeatures(sourceId, { sourceLayer: "building" }).length
          : 0;
      } catch {
        features = 0;
      }
      return {
        sourceUrl: source?.url ?? null,
        hasFill: !!map.getLayer(fillId),
        overtureLayers: (style?.layers ?? [])
          .map((layer: { id: string }) => layer.id)
          .filter((id: string) => id.startsWith("overture-")),
        features,
        fillColor: map.getLayer(fillId) ? map.getPaintProperty(fillId, "fill-color") : null,
      };
    },
    { sourceId: BUILDINGS_SOURCE, fillId: BUILDINGS_FILL },
  );
}

/** A page point over bare map canvas where a building is rendered. */
async function renderedBuildingPoint(page: Page) {
  return page.evaluate((fillId) => {
    const engine = (window as any).overtureTestRef.current;
    const map = engine.getMapboxMap();
    const canvas = map.getCanvas() as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    for (let dx = 200; dx >= -300; dx -= 20) {
      for (let dy = -150; dy <= 150; dy += 20) {
        const x = rect.width / 2 + dx;
        const y = rect.height / 2 + dy;
        const element = document.elementFromPoint(rect.left + x, rect.top + y);
        if (element !== canvas) continue;
        if (map.queryRenderedFeatures([x, y], { layers: [fillId] }).length)
          return { x: rect.left + x, y: rect.top + y };
      }
    }
    return null;
  }, BUILDINGS_FILL);
}

async function switchRenderer(page: Page, name: "MapLibre" | "Mapbox") {
  await page.getByRole("button", { name: "View", exact: true }).click();
  await page.getByRole("menuitem", { name: "Rendering engine", exact: true }).hover();
  await page.getByRole("menuitemradio", { name, exact: true }).click();
  await expect(
    page.locator(name === "Mapbox" ? ".mapboxgl-canvas" : ".maplibregl-canvas"),
  ).toBeVisible();
  await bindEngine(page, name === "Mapbox" ? "mapbox" : "maplibre");
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
  // Match on the pathname: a `**${PROJECT_PATH}` glob also matches the app URL,
  // whose `?project=` query ends with the same file name.
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
  await bindEngine(page, "mapbox");
  // mapbox-gl reports its failures as map `error` events, not exceptions;
  // surface them in the console this spec attaches to its report.
  await page.evaluate(() => {
    const map = (window as any).overtureTestRef.current.getMapboxMap();
    map.on("error", (event: { error?: Error }) =>
      console.warn(`map error: ${event.error?.message}`),
    );
  });
  await expect(page.getByRole("button", { name: "Add Data", exact: true })).toBeEnabled();
}

for (const theme of ["light", "dark"] as const) {
  test(`loads Overture buildings on Mapbox, inspects one, and survives a renderer swap (${theme})`, async ({
    page,
  }, info) => {
    test.setTimeout(240_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning")
        errors.push(`${message.type()}: ${message.text()}`);
    });
    page.on("response", (response) => {
      if (response.status() >= 400) errors.push(`http ${response.status()}: ${response.url()}`);
    });
    try {
      await run();
    } finally {
      await info.attach("console", { body: errors.join("\n"), contentType: "text/plain" });
    }

    async function run() {
      await openMapboxProject(page, info.project.use.baseURL!, theme);

      // Plugins → Overture Maps → Activate mounts the control on the Mapbox
      // map, in the same corner it uses on MapLibre, with its panel open.
      await page.getByRole("button", { name: "Plugins", exact: true }).click();
      const item = page.getByRole("menuitem", { name: "Overture Maps", exact: true });
      await expect(item).toBeEnabled();
      await item.hover();
      await page.getByRole("menuitem", { name: "Activate", exact: true }).click();
      await expect(page.locator(".mapboxgl-ctrl-top-left .overture-control")).toBeVisible();
      const panel = page.locator(".overture-control-panel");
      await expect(panel).toHaveClass(/expanded/);

      // The buildings theme is added as a plain https archive URL (no
      // `pmtiles://` prefix) that mapbox-gl reads through its own provider.
      await expect.poll(async () => (await overtureMapState(page)).hasFill).toBe(true);
      let state = await overtureMapState(page);
      expect(state.sourceUrl).toMatch(/^https:\/\/.+\/buildings\.pmtiles$/);
      expect(state.overtureLayers).toContain(BUILDINGS_FILL);
      await expect.poll(async () => (await overtureMapState(page)).features).toBeGreaterThan(0);

      // The Layers panel mirrors each source layer; the engine leaves the
      // control's own paint alone (the buildings theme keeps its x-ray color).
      await expect(layerRow(page, "Overture Building")).toBeVisible();
      await expect(layerRow(page, "Overture Building part")).toBeVisible();
      state = await overtureMapState(page);
      expect(state.fillColor).toBe("#f58231");

      // Clicking a rendered building opens the inspection popup, which is a
      // mapbox-gl popup built through the control's `createPopup` option.
      await panel.locator(".overture-control-close, .overture-control-toggle").first().click();
      await expect(panel).not.toHaveClass(/expanded/);
      const point = await renderedBuildingPoint(page);
      expect(point, "a rendered building under bare canvas").not.toBeNull();
      await page.mouse.click(point!.x, point!.y);
      const popup = page.locator(".mapboxgl-popup.overture-popup");
      await expect(popup).toBeVisible();
      await expect(popup).toContainText("building");
      expect(await page.locator(".maplibregl-popup").count()).toBe(0);

      await page.screenshot({ path: info.outputPath(`mapbox-overture-${theme}.png`) });

      // Hiding the mirror from the Layers panel reaches the control, which
      // drops its native layers; showing it puts them back.
      const row = layerRow(page, "Overture Building");
      await row.getByRole("button", { name: "Hide layer" }).click();
      await expect.poll(async () => (await overtureMapState(page)).hasFill).toBe(false);
      await row.getByRole("button", { name: "Show layer" }).click();
      await expect.poll(async () => (await overtureMapState(page)).hasFill).toBe(true);

      // The plugin declares both 2D engines, so the manager re-activates it on
      // each swap and the control switches between the protocol URL MapLibre
      // needs and the plain archive URL Mapbox reads.
      await switchRenderer(page, "MapLibre");
      await expect(page.locator(".maplibregl-ctrl-top-left .overture-control")).toBeVisible();
      await expect
        .poll(async () => (await overtureMapState(page)).sourceUrl)
        .toMatch(/^pmtiles:\/\/https:\/\//);
      await switchRenderer(page, "Mapbox");
      await expect(page.locator(".mapboxgl-ctrl-top-left .overture-control")).toBeVisible();
      await expect
        .poll(async () => (await overtureMapState(page)).sourceUrl)
        .toMatch(/^https:\/\/.+\/buildings\.pmtiles$/);
      await expect.poll(async () => (await overtureMapState(page)).features).toBeGreaterThan(0);

      // None of the MapLibre-on-Mapbox failures this port removes came back.
      const overtureErrors = errors.filter((text) =>
        /addProtocol|_camera|\.transform|There is no source with ID 'overture|TileProvider/.test(
          text,
        ),
      );
      expect(overtureErrors).toEqual([]);
    }
  });
}
