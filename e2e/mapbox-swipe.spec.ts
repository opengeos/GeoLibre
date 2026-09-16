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

/**
 * The browser's own echo of a failed request. It carries no URL, so it says
 * nothing a response listener does not say better — {@link watchFailedRequests}
 * records those with their URL and status, and the assertion reads that.
 */
const RESOURCE_FAILURE_ECHO = /Failed to load resource: the server responded with a status of \d+/;

/**
 * The telemetry and session-tracking calls mapbox-gl makes on its own, for
 * every map it constructs — two of them here. They carry no map content and
 * answer 401 or 403 without a real token, which CI does not have.
 */
function isMapboxBookkeeping(url: string): boolean {
  const { hostname, pathname } = new URL(url);
  return hostname === "events.mapbox.com" || pathname.startsWith("/map-sessions/");
}

/**
 * Record every failed request except the ones this run is expected to produce.
 *
 * Only Mapbox's bookkeeping endpoints are forgiven, and only by URL — never by
 * host alone, which would also swallow a DNS or connection failure, and never
 * on the strength of whether a token happens to be configured. Both maps point
 * at a third-party style, so no map content is fetched from Mapbox at all and a
 * content request that failed would be a genuine surprise. Everything else
 * reaches the assertion with its URL.
 */
function watchFailedRequests(page: Page, failures: string[]): void {
  page.on("response", (response) => {
    const status = response.status();
    if (status < 400) return;
    if (isMapboxBookkeeping(response.url())) return;
    failures.push(`http ${status}: ${response.url()}`);
  });
  page.on("requestfailed", (request) => {
    // A cancelled tile is the camera changing its mind, not a failure: every
    // pan and projection switch abandons the requests for the view it left.
    const errorText = request.failure()?.errorText ?? "";
    if (errorText.includes("ERR_ABORTED")) return;
    if (isMapboxBookkeeping(request.url())) return;
    failures.push(`request failed: ${request.url()} (${errorText})`);
  });
}

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
 * one row per geometry its data has (a fill and a line for these squares), so a
 * per-layer assignment means every one of them.
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

/**
 * The access token the swipe's comparison pane was constructed with.
 *
 * The control is a plain `IControl` that the Mapbox engine wraps in an adapter,
 * so the original lives in the engine's `pluginControls` map rather than on
 * `map._controls`; `getComparisonMap()` then hands out the pane it built.
 */
async function comparisonPaneToken(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const engine = (window as any).swipeTestRef.current;
    let pane: any = null;
    engine.pluginControls?.forEach?.((_adapter: unknown, control: any) => {
      if (typeof control?.getComparisonMap === "function") pane = control.getComparisonMap();
    });
    return pane?._requestManager?._customAccessToken ?? null;
  });
}

/**
 * The distinct visibilities one project layer's style layers carry on the
 * comparison pane.
 *
 * The pane is built from the main map's whole style and then has everything but
 * the right side hidden, so presence alone proves nothing — the visibility is
 * the assignment.
 */
async function comparisonPaneVisibility(page: Page, layerId: string): Promise<string[]> {
  return page.evaluate((id) => {
    const engine = (window as any).swipeTestRef.current;
    let pane: any = null;
    engine.pluginControls?.forEach?.((_adapter: unknown, control: any) => {
      if (typeof control?.getComparisonMap === "function") pane = control.getComparisonMap();
    });
    if (!pane) return ["<no pane>"];
    let layers: { id: string }[] = [];
    try {
      layers = pane.getStyle()?.layers ?? [];
    } catch {
      return ["<style not ready>"];
    }
    const visibilities = layers
      .filter((layer) => layer.id.startsWith(`geolibre-mapbox-${id}-`))
      .map((layer) => pane.getLayoutProperty(layer.id, "visibility") ?? "visible");
    return visibilities.length === 0 ? ["<absent>"] : ([...new Set(visibilities)] as string[]);
  }, layerId);
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
    const failures: string[] = [];
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      // Skip the bare resource echo; watchFailedRequests has the URL.
      if (RESOURCE_FAILURE_ECHO.test(message.text())) return;
      errors.push(`error: ${message.text()}`);
    });
    watchFailedRequests(page, failures);
    try {
      await run();
    } finally {
      await info.attach("console", {
        body: [...errors, ...failures].join("\n"),
        contentType: "text/plain",
      });
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

      // Both project layers are listed by the name the Layers panel shows, not
      // by the style layer id the control actually drives
      // (`geolibre-mapbox-West-geojson-fill`). The engine publishes that
      // mapping; without it every row read as a raw id on this renderer while
      // MapLibre showed friendly names.
      //
      // Polled, because the rename is asynchronous by design: the control
      // builds its rows from style layer ids, and the app rewrites them from
      // the published names on the animation frame after the panel mutates.
      // Reading once races that frame, and a slow runner loses.
      // Wait for the engine to have published the names before reading the
      // panel. `syncLayers` returns early while the style is still loading and
      // publishes only on the pass that completes, so the panel can be built
      // from style layer ids before any name exists for them.
      await page.waitForFunction(
        () =>
          Object.keys(
            (window as unknown as { __GEOLIBRE_LAYER_LABELS__?: Record<string, string> })
              .__GEOLIBRE_LAYER_LABELS__ ?? {},
          ).length > 1,
        undefined,
        { timeout: 30_000 },
      );
      const leftLabels = () =>
        panel.locator(".swipe-layer-list").first().locator("label").allTextContents();
      await expect
        .poll(leftLabels, { timeout: 30_000 })
        .toEqual(expect.arrayContaining(["West Polygons", "East Polygons"]));
      expect(
        (await leftLabels()).filter((text) => text.includes("geolibre-mapbox-")),
        "no row may show a raw style layer id",
      ).toEqual([]);
      // Both squares are polygons, so neither has a Points row to offer (#2431).
      // The engine used to compile a circle layer for every GeoJSON layer
      // whatever its data held, and the panel listed it.
      expect(
        (await leftLabels()).filter((text) => text.endsWith(" Points")),
        "a polygon-only layer must not list a Points row",
      ).toEqual([]);

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

      // And the comparison pane draws it — the other half of the dual-map clip.
      // A canvas alone would pass with an empty pane, so check the assignment
      // the control applied there: the right-side layer shown, the left-side one
      // hidden. Exactly inverted from the main map above.
      await expect
        .poll(() => comparisonPaneVisibility(page, "East"), { timeout: 30_000 })
        .toEqual(["visible"]);
      expect(
        await comparisonPaneVisibility(page, "West"),
        "a left-only layer must not draw on the comparison side",
      ).toEqual(["none"]);

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

      // mapbox-gl reads its token from the global `mapboxgl.accessToken` unless
      // the constructor is handed one, and the app sets it per map — so the
      // comparison pane must carry the same token as the main map or it renders
      // nothing. Asserted on the pane's own token rather than on console text,
      // which cannot tell "no token" from "the placeholder CI runs with".
      expect(await comparisonPaneToken(page), "the pane must carry the main map's token").toBe(
        await page.evaluate(
          () =>
            ((window as any).swipeTestRef.current.getMapboxMap() as any)._requestManager
              ?._customAccessToken ?? null,
        ),
      );

      // The `mapbox://` basemap path — where the control cannot fetch the style
      // and takes `basemapLayerIds` instead — is covered by the unit tests; this
      // project points at a third-party style so the spec needs no real token.
      expect(failures, "nothing but the tokenless Mapbox API may fail to load").toEqual([]);
    }
  });
}

/**
 * The swipe control the plugin currently has mounted, identified by a token
 * stamped on the instance.
 *
 * The plugin builds a **new** `SwipeControl` on every basemap change, so a
 * changed token is the signal that the rebuild has happened — the DOM alone
 * cannot say, since the elements it replaces carry the same classes.
 */
async function swipeControlToken(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const engine = (window as any).swipeTestRef.current;
    let control: any = null;
    engine.pluginControls?.forEach?.((_adapter: unknown, candidate: any) => {
      if (typeof candidate?.getComparisonMap === "function") control = candidate;
    });
    if (!control) return null;
    control.__swipeToken ??= Math.random().toString(36).slice(2);
    return control.__swipeToken as string;
  });
}

/**
 * The layer ids the control currently has on each side.
 *
 * Read off the control rather than the panel's checkboxes: the panel is
 * collapsed while the basemap is being changed, and this is the state the
 * rebuild actually carries from one control to the next.
 */
async function swipeSides(page: Page): Promise<{ left: string[]; right: string[] }> {
  return page.evaluate(() => {
    const engine = (window as any).swipeTestRef.current;
    let control: any = null;
    engine.pluginControls?.forEach?.((_adapter: unknown, candidate: any) => {
      if (typeof candidate?.getComparisonMap === "function") control = candidate;
    });
    const state = control?.getState?.();
    return { left: state?.leftLayers ?? [], right: state?.rightLayers ?? [] };
  });
}

// Changing the basemap on this renderer used to leave the previous comparison
// pane on the map (#2430). The control is rebuilt on the new style's
// `style.load`, and `maplibre-gl-swipe` read `map.getStyle()` during `onAdd`
// the way MapLibre answers it — `undefined` until the style is loaded. mapbox-gl
// throws `Style is not done loading` there instead, and that throw escaped
// halfway through `onAdd`: the clipped pane and its comparison map (a live
// WebGL context) were already on the map, the control never mounted, and every
// further basemap change stacked another pane. Fixed upstream in 0.13.2.
test("keeps one comparison pane across basemap changes", async ({ page }, info) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

  await openMapboxProject(page, info.project.use.baseURL!, "light");

  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  const item = page.getByRole("menuitem", { name: "Layer Swipe", exact: true });
  await item.hover();
  await page.getByRole("menuitem", { name: "Activate", exact: true }).click();
  await expect(page.locator(".swipe-comparison-map .mapboxgl-canvas")).toBeAttached();

  // Put East on the right side only, so each rebuild has a non-default
  // assignment to carry over. Counts alone would pass on a control that came
  // back with everything reset. The panel is built from the engine's published
  // layer names, which land after the first completed sync.
  const panel = page.locator(".swipe-control-panel");
  await page.waitForFunction(
    () =>
      Object.keys(
        (window as unknown as { __GEOLIBRE_LAYER_LABELS__?: Record<string, string> })
          .__GEOLIBRE_LAYER_LABELS__ ?? {},
      ).length > 1,
    undefined,
    { timeout: 30_000 },
  );
  await setSide(panel, "East", "left", false);
  await setSide(panel, "East", "right", true);
  await expect.poll(() => mainMapVisibility(page, "East")).toEqual(["none"]);
  const sides = await swipeSides(page);
  expect(sides.right, "East must be on the right side before the first change").toContain(
    "geolibre-mapbox-East-geojson-fill",
  );

  // Collapse the swipe panel: it and the Basemaps panel share the top-left
  // corner, and the picker has to be clickable.
  await page.locator(".swipe-control-close").click();
  await page.getByRole("button", { name: "Basemaps", exact: true }).click();

  // Only a `STYLE` basemap replaces the map's style; a raster one is added as
  // a layer and never reaches `setStyle`, so it cannot reproduce this.
  // Three changes, back to one already visited: the sides stopped reaching the
  // pane after the first and the main map after the third (#2434).
  for (const name of ["OpenFreeMap Positron", "OpenFreeMap Bright", "OpenFreeMap Positron"]) {
    const before = await swipeControlToken(page);
    await page.getByPlaceholder("Search basemaps").fill(name.replace("OpenFreeMap ", ""));
    await page.getByText(name, { exact: true }).click();

    // The rebuild waits for `style.load`, and the pane it builds waits for the
    // `styledata` after that. Both orphans were queued on that same event, so
    // once any pane is up the count is final.
    await expect.poll(() => swipeControlToken(page), { timeout: 60_000 }).not.toBe(before);
    await expect
      .poll(() => page.locator(".swipe-comparison-map").count(), { timeout: 60_000 })
      .toBeGreaterThan(0);

    await expect(page.locator(".swipe-comparison-map")).toHaveCount(1);
    await expect(page.locator(".swipe-clip-container")).toHaveCount(1);
    await expect(page.locator(".swipe-slider")).toHaveCount(1);
    // The throw left the control unmounted, so its button went missing too.
    await expect(page.locator(".swipe-control")).toHaveCount(1);

    // And the rebuilt control carries the old one's sides. Counts alone would
    // pass on a control that came back with everything reset, which is the
    // other way this could go wrong: the rebuild reads `getState()` off the
    // outgoing control and hands it to the new one's options.
    expect(await swipeSides(page), `sides must survive the change to ${name}`).toEqual(sides);

    // And the carried-over sides still reach both maps (#2434). The rebuilt
    // control mounts on `style.load`, before the engine has re-added the
    // project layers, so its first pass has nothing to assign; the assignment
    // has to land once those layers arrive, on the main map and on the pane.
    // `maplibre-gl-swipe` 0.13.3 re-applies the sides when assigned layers
    // come or go.
    await expect.poll(() => mainMapVisibility(page, "East"), { timeout: 30_000 }).toEqual(["none"]);
    await expect
      .poll(() => comparisonPaneVisibility(page, "East"), { timeout: 30_000 })
      .toEqual(["visible"]);
    expect(await mainMapVisibility(page, "West")).toEqual(["visible"]);
    // The pane only copies right-side layers, so a pane built before the
    // project layers returned never has West at all; either way it must not draw.
    expect([["none"], ["<absent>"]]).toContainEqual(await comparisonPaneVisibility(page, "West"));
  }

  // Every rebuild constructs and removes a comparison map, and mapbox-gl's
  // `map.load` telemetry answers after the map that queued it is gone — its
  // error callback has been nulled by then, so it throws `this.errorCb is not
  // a function`. Bookkeeping that only fires because CI has no real token, and
  // the same calls this file already forgives at the network level.
  expect(
    errors.filter((error) => !error.includes("errorCb is not a function")),
    "the rebuild must not throw",
  ).toEqual([]);
});
