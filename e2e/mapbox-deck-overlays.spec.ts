import { expect, test, type Page } from "@playwright/test";
import { layerRow, RENDERER_SWAP_TIMEOUT } from "./helpers";
import { DESKTOP_SETTINGS_STORAGE_KEY } from "../apps/geolibre-desktop/src/lib/storage-keys";

// Deck.gl Layer, 3D Model and DuckDB on the Mapbox renderer. These draw through
// deck.gl overlays (`@deck.gl/mapbox`), so they need no Mapbox service at all:
// the project below points the Mapbox pane at a third-party style, and the
// token is only what mapbox-gl needs to construct a map. Without a valid token
// Mapbox GL JS paints nothing and shows its own banner, but the engine, store,
// layer panel and overlay bindings are all live, which is what this checks. A
// real MAPBOX_TOKEN is used when present, so the same spec also covers the
// authenticated path.
const TOKEN = process.env.MAPBOX_TOKEN ?? "pk.e2e-placeholder.mapbox-token";
const PROJECT_PATH = "/mapbox-deck-overlays.geolibre.json";
const PROJECT = {
  version: "0.2.0",
  name: "Mapbox deck overlays",
  // Globe on purpose: the deck overlays force Mercator while shown.
  mapView: { center: [-74, 40.7], zoom: 9, bearing: 0, pitch: 0 },
  primaryRenderer: "mapbox",
  preferences: {
    map: { mapboxStyleUrl: "https://tiles.openfreemap.org/styles/liberty" },
  },
};
const DUCKDB = "https://data.source.coop/giswqs/opengeos/nyc_data.db";

test.use({ actionTimeout: 30_000 });

async function openSource(page: Page, name: string) {
  await page.getByRole("button", { name: "Add Data", exact: true }).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}

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
            (window as any).mapboxDeckTestRef = ref;
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

/** Deck layers on the engine's map, by deck layer class name → data row count. */
async function deckLayers(page: Page) {
  return page.evaluate(() => {
    const engine = (window as any).mapboxDeckTestRef.current;
    const map = engine.kind === "mapbox" ? engine.getMapboxMap() : engine.getMap();
    const out: Record<string, number> = {};
    for (const layer of map.__deck?.props.layers ?? []) {
      const data = layer.props.data;
      out[layer.constructor.layerName] = Array.isArray(data) ? data.length : 1;
    }
    return {
      projection: map.getProjection()?.name ?? map.getProjection()?.type,
      layers: out,
    };
  });
}

async function waitForDeckLayer(page: Page, layerName: string) {
  await page.waitForFunction(
    (wanted) => {
      const engine = (window as any).mapboxDeckTestRef.current;
      const map = engine.kind === "mapbox" ? engine.getMapboxMap() : engine.getMap();
      return (map.__deck?.props.layers ?? []).some(
        (layer: any) => layer.constructor.layerName === wanted && layer.isLoaded,
      );
    },
    layerName,
    { timeout: 60_000 },
  );
}

async function switchRenderer(page: Page, name: "MapLibre" | "Mapbox") {
  await page.getByRole("button", { name: "View", exact: true }).click();
  await page.getByRole("menuitem", { name: "Rendering engine", exact: true }).hover();
  // The swap runs inside this click's own handler and is charged against the
  // action budget, which the DuckDB spec outran on CI every first attempt until
  // `retries: 1` covered for it. See `RENDERER_SWAP_TIMEOUT` (#2432).
  await page
    .getByRole("menuitemradio", { name, exact: true })
    .click({ timeout: RENDERER_SWAP_TIMEOUT });
  await expect(
    page.locator(name === "Mapbox" ? ".mapboxgl-canvas" : ".maplibregl-canvas"),
  ).toBeVisible({ timeout: RENDERER_SWAP_TIMEOUT });
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
  // The menu waits for the engine to finish loading before accepting imports.
  await expect(page.getByRole("button", { name: "Add Data", exact: true })).toBeEnabled();
}

for (const theme of ["light", "dark"] as const) {
  test(`Deck.gl Layer and 3D Model render on Mapbox and survive a renderer swap (${theme})`, async ({
    page,
  }, info) => {
    test.setTimeout(240_000);
    await openMapboxProject(page, info.project.use.baseURL!, theme);

    // The menu offers the deck.gl-drawn sources and still withholds the ones
    // that need a MapLibre protocol or custom render pass.
    await page.getByRole("button", { name: "Add Data", exact: true }).click();
    for (const name of ["Deck.gl Layer", "3D Model (glTF)", "DuckDB Layer", "Zarr Layer"]) {
      await expect(page.getByRole("menuitem", { name, exact: true })).toBeEnabled();
    }
    for (const name of ["MBTiles Layer", "Gaussian Splatting"]) {
      await expect(page.getByRole("menuitem", { name, exact: true })).toBeDisabled();
    }
    await page.keyboard.press("Escape");

    await openSource(page, "Deck.gl Layer");
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Use example data", exact: true }).click();
    await dialog.getByRole("button", { name: "Load data", exact: true }).click();
    await expect(dialog.getByText(/Loaded \d[\d,]* rows/)).toBeVisible({
      timeout: 60_000,
    });
    await dialog.getByRole("button", { name: "Add layer", exact: true }).click();
    await expect(layerRow(page, "Scatterplot")).toBeVisible();
    await expect(layerRow(page, "Scatterplot")).not.toContainText("No Mapbox");
    await waitForDeckLayer(page, "ScatterplotLayer");
    let state = await deckLayers(page);
    expect(state.layers.ScatterplotLayer).toBeGreaterThan(1000);
    // The project opened on the globe; the overlay holds the map in Mercator.
    expect(state.projection).toBe("mercator");

    await openSource(page, "3D Model (glTF)");
    // The scenegraph builder opens on the bundled airplane sample.
    await page.getByRole("dialog").getByRole("button", { name: "Add layer", exact: true }).click();
    await expect(layerRow(page, "3D model (glTF)")).toBeVisible();
    await expect(layerRow(page, "3D model (glTF)")).not.toContainText("No Mapbox");
    await waitForDeckLayer(page, "ScenegraphLayer");
    await page.screenshot({
      path: info.outputPath(`mapbox-deck-viz-${theme}.png`),
    });

    // Visibility flows through the store to the overlay.
    await layerRow(page, "Scatterplot")
      .getByRole("button", { name: "Hide layer", exact: true })
      .click();
    await expect.poll(async () => (await deckLayers(page)).layers.ScatterplotLayer).toBeUndefined();
    await layerRow(page, "Scatterplot")
      .getByRole("button", { name: "Show layer", exact: true })
      .click();
    await waitForDeckLayer(page, "ScatterplotLayer");

    // The overlay plugin stays active across engines: the same store layers
    // rebind to MapLibre's map and then to a fresh Mapbox map.
    await switchRenderer(page, "MapLibre");
    await waitForDeckLayer(page, "ScatterplotLayer");
    await waitForDeckLayer(page, "ScenegraphLayer");
    await switchRenderer(page, "Mapbox");
    await waitForDeckLayer(page, "ScatterplotLayer");
    await waitForDeckLayer(page, "ScenegraphLayer");
    state = await deckLayers(page);
    expect(state.layers.ScatterplotLayer).toBeGreaterThan(1000);
    expect(state.projection).toBe("mercator");
    await expect(layerRow(page, "Scatterplot")).not.toContainText("No Mapbox");
    // Engine load errors surface as "Error: …" banners; the token banner is
    // mapbox-gl's own and expected without a valid token.
    await expect(page.getByRole("alert").filter({ hasText: /^Error:/ })).toHaveCount(0);
  });
}

test("DuckDB query layers render on Mapbox and the panel remounts after a renderer swap", async ({
  page,
}, info) => {
  test.setTimeout(300_000);
  await openMapboxProject(page, info.project.use.baseURL!, "light");

  await openSource(page, "DuckDB Layer");
  // The control's panel is appended to the map container, not to the control
  // element, so locate its fields at page level.
  const panel = page.getByText("Add DuckDB Layer", { exact: true });
  await page.getByRole("textbox", { name: "https://example.com/data.duckdb" }).fill(DUCKDB);
  await page.getByRole("button", { name: "Load", exact: true }).click();
  // The sample database is ~20 MB and DuckDB-WASM plus its spatial extension
  // load on first use.
  await expect(page.getByRole("button", { name: "Run query", exact: true })).toBeEnabled({
    timeout: 120_000,
  });
  await page.getByRole("button", { name: "Run query", exact: true }).click();
  await expect(layerRow(page, "nyc_census_blocks")).toBeVisible({
    timeout: 60_000,
  });
  await expect(layerRow(page, "nyc_census_blocks")).not.toContainText("No Mapbox");
  const duckdbDrawn = async () =>
    page.evaluate(() => {
      const engine = (window as any).mapboxDeckTestRef.current;
      const map = engine.kind === "mapbox" ? engine.getMapboxMap() : engine.getMap();
      return (map.__deck?.props.layers ?? []).some(
        (layer: any) => layer.id.startsWith("duckdb-layer") && layer.isLoaded,
      );
    });
  await expect.poll(duckdbDrawn, { timeout: 60_000 }).toBe(true);
  expect((await deckLayers(page)).projection).toBe("mercator");
  await page.getByRole("button", { name: "Close panel", exact: true }).click();
  await page.screenshot({ path: info.outputPath("mapbox-duckdb.png") });

  // The map tears the panel down with the old engine; reopening it must mount
  // on the new map and redraw the cached results, in both directions.
  await switchRenderer(page, "MapLibre");
  await openSource(page, "DuckDB Layer");
  await expect(panel).toBeVisible();
  await expect.poll(duckdbDrawn, { timeout: 60_000 }).toBe(true);
  await page.getByRole("button", { name: "Close panel", exact: true }).click();
  await switchRenderer(page, "Mapbox");
  await openSource(page, "DuckDB Layer");
  await expect(panel).toBeVisible();
  await expect.poll(duckdbDrawn, { timeout: 60_000 }).toBe(true);
  await expect(layerRow(page, "nyc_census_blocks")).not.toContainText("No Mapbox");
  await expect(page.getByRole("alert").filter({ hasText: /^Error:/ })).toHaveCount(0);
});
