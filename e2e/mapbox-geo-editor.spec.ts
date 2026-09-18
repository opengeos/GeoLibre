import { expect, test, type Page } from "@playwright/test";
import { layerRow, RENDERER_SWAP_TIMEOUT } from "./helpers";
import { DESKTOP_SETTINGS_STORAGE_KEY } from "../apps/geolibre-desktop/src/lib/storage-keys";

// The Geo Editor on the Mapbox renderer (issue #2420). Geoman and the
// maplibre-gl-geo-editor toolbar draw through GeoJSON sources and style layers,
// so no Mapbox service is needed: the project points the Mapbox pane at a
// third-party style and the token is only what mapbox-gl needs to construct a
// map. What this checks is the part that used to throw: the vertex handles and
// cursor marker (MapLibre `Marker` objects on MapLibre) and the rotate popup
// (a MapLibre `Popup`) now come from mapbox-gl, Geoman's marker image loads
// through mapbox-gl's callback-style `loadImage`, and the drawn features reach
// the store as the Sketches layer.
const TOKEN = process.env.MAPBOX_TOKEN ?? "pk.e2e-placeholder.mapbox-token";
const PROJECT_PATH = "/mapbox-geo-editor.geolibre.json";
const PROJECT = {
  version: "0.2.0",
  name: "Mapbox geo editor",
  mapView: { center: [-122.42, 37.78], zoom: 13, bearing: 0, pitch: 0 },
  primaryRenderer: "mapbox",
  preferences: {
    map: { mapboxStyleUrl: "https://tiles.openfreemap.org/styles/liberty" },
  },
};

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
            (window as any).geoEditorTestRef = ref;
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

/** What the live map holds of the editor: Geoman's sources and marker image. */
async function editorMapState(page: Page) {
  return page.evaluate(() => {
    const engine = (window as any).geoEditorTestRef.current;
    const map = engine.kind === "mapbox" ? engine.getMapboxMap() : engine.getMap();
    const style = map.getStyle();
    return {
      hasMarkerImage: map.hasImage("default-marker") as boolean,
      geomanSources: Object.keys(style?.sources ?? {}).filter((id) => id.startsWith("gm_")),
      geomanLayers: (style?.layers ?? []).filter((layer: { id: string }) =>
        layer.id.startsWith("gm_"),
      ).length,
      sketchesLayers: (style?.layers ?? [])
        .map((layer: { id: string }) => layer.id)
        .filter((id: string) => id.includes("geolibre-mapbox-") || id.startsWith("layer-")),
    };
  });
}

async function switchRenderer(page: Page, name: "MapLibre" | "Mapbox") {
  await page.getByRole("button", { name: "View", exact: true }).click();
  await page.getByRole("menuitem", { name: "Rendering engine", exact: true }).hover();
  // The swap runs inside this click's own handler and is charged against the
  // action budget, which CI's software renderer can outrun. See
  // `RENDERER_SWAP_TIMEOUT` (#2432).
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
  // mapbox-gl reports its failures as map `error` events, not exceptions;
  // surface them in the console this spec attaches to its report.
  await page.evaluate(() => {
    const map = (window as any).geoEditorTestRef.current.getMapboxMap();
    map.on("error", (event: { error?: Error }) =>
      console.warn(`map error: ${event.error?.message}`),
    );
  });
  await expect(page.getByRole("button", { name: "Add Data", exact: true })).toBeEnabled();
}

/** A point inside the map canvas, as a fraction of its box, in page pixels. */
async function canvasPoint(page: Page, fx: number, fy: number) {
  const canvas = page.locator(".mapboxgl-canvas, .maplibregl-canvas").first();
  const box = (await canvas.boundingBox())!;
  return { x: box.x + box.width * fx, y: box.y + box.height * fy };
}

for (const theme of ["light", "dark"] as const) {
  test(`draws, selects and rotates a sketch on Mapbox and survives a renderer swap (${theme})`, async ({
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
    // Whatever happens, keep the console with the report: the failures this
    // spec guards against surface there first. (The map's basemap can go blank
    // partway through when the token cannot bill a map session; nothing here
    // reads pixels.)
    try {
      await run();
    } finally {
      await info.attach("console", { body: errors.join("\n"), contentType: "text/plain" });
    }

    async function run() {
      await openMapboxProject(page, info.project.use.baseURL!, theme);

      // The Layers panel toggle activates the plugin on the Mapbox map; its
      // toolbar mounts in the same corner it uses on MapLibre.
      const toggle = page.getByRole("button", { name: "GeoEditor", exact: true });
      await expect(toggle).toBeEnabled();
      await toggle.click();
      const toolbar = page.locator(".geo-editor-toolbar");
      await expect(toolbar).toBeVisible();
      await expect(page.locator(".mapboxgl-ctrl-top-left .geo-editor-toolbar")).toBeVisible();

      // Geoman finished initializing on the mapbox-gl map: its sources exist and
      // its marker image went through the swapped `loadImage`.
      await expect.poll(async () => (await editorMapState(page)).hasMarkerImage).toBe(true);
      let state = await editorMapState(page);
      expect(state.geomanSources.length).toBeGreaterThan(0);
      expect(state.geomanLayers).toBeGreaterThan(0);

      // Draw a polygon on the right half of the map, away from the side panels.
      await toolbar.locator('button[data-mode="polygon"]').click();
      const a = await canvasPoint(page, 0.55, 0.35);
      const b = await canvasPoint(page, 0.8, 0.35);
      const c = await canvasPoint(page, 0.8, 0.65);
      const d = await canvasPoint(page, 0.55, 0.65);
      await page.mouse.move(a.x, a.y);
      // The cursor marker is a mapbox-gl Marker now (MapLibre's threw here).
      await expect(page.locator(".mapboxgl-marker").first()).toBeAttached();
      await page.mouse.click(a.x, a.y);
      await page.mouse.click(b.x, b.y);
      await page.mouse.click(c.x, c.y);
      await page.mouse.dblclick(d.x, d.y);

      // The feature reaches the store as the Sketches layer, drawn by the engine.
      await expect(layerRow(page, "Sketches")).toBeVisible();
      await expect
        .poll(async () => (await editorMapState(page)).sketchesLayers.length)
        .toBeGreaterThan(0);

      // Select mode opens the attribute form for the sketch (its height field
      // comes from the plugin's massing schema).
      await toolbar.locator('button[data-mode="select"]').click();
      const center = await canvasPoint(page, 0.675, 0.5);
      await page.mouse.click(center.x, center.y);
      const panel = page.locator(".geo-editor-attribute-panel");
      await expect(panel).toBeVisible();
      await expect(panel).not.toHaveClass(/attribute-panel--hidden/);
      await expect(panel.getByText("Height (m)")).toBeVisible();

      // Vertex editing hangs Geoman's handles on the sketch: DOM markers, which
      // are mapbox-gl markers here (the MapLibre ones threw on `addTo`).
      await toolbar.locator('button[data-mode="change"]').click();
      await page.mouse.move(center.x, center.y);
      await page.mouse.move(a.x, a.y);
      await expect.poll(async () => page.locator(".mapboxgl-marker").count()).toBeGreaterThan(0);

      // Rotate mode's numerical form (opened by double-clicking the feature) is
      // a mapbox-gl Popup built through the toolbar's `createPopup` option.
      await toolbar.locator('button[data-mode="rotate"]').click();
      await page.mouse.dblclick(center.x, center.y);
      const rotatePopup = page.locator(".mapboxgl-popup.geo-editor-rotate-popup");
      await expect(rotatePopup).toBeVisible();
      await rotatePopup.getByRole("spinbutton").fill("45");
      await rotatePopup.getByRole("button", { name: "Apply", exact: true }).click();
      await expect(rotatePopup).toBeHidden();

      await page.screenshot({ path: info.outputPath(`mapbox-geo-editor-${theme}.png`) });

      // The plugin declares both 2D engines, so the manager re-activates it on
      // each swap and the sketch persists through the store.
      await switchRenderer(page, "MapLibre");
      await expect(page.locator(".maplibregl-ctrl-top-left .geo-editor-toolbar")).toBeVisible();
      await expect(layerRow(page, "Sketches")).toBeVisible();
      await switchRenderer(page, "Mapbox");
      await expect(page.locator(".mapboxgl-ctrl-top-left .geo-editor-toolbar")).toBeVisible();
      await expect(layerRow(page, "Sketches")).toBeVisible();
      await expect.poll(async () => (await editorMapState(page)).hasMarkerImage).toBe(true);

      // None of the MapLibre-on-Mapbox failures this port removes came back.
      const editorErrors = errors.filter((text) =>
        /_camera|\.transform|Geoman initialization failed|Missing source|updateData/.test(text),
      );
      expect(editorErrors).toEqual([]);
    }
  });
}
