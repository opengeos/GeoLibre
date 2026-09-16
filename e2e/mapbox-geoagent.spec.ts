import { expect, test, type Page } from "@playwright/test";
import { DESKTOP_SETTINGS_STORAGE_KEY } from "../apps/geolibre-desktop/src/lib/storage-keys";

// GeoAgent on the Mapbox renderer (issue #2420). Four of its tools could not
// stay on the Style Spec surface both engines share, and each broke differently
// there: the marker tool built MapLibre's `Marker` (which reads
// `map._camera.transform` and throws), `set_projection` wrote `{ type }` where
// Mapbox takes a name string, `get_map_state` read `projection.type`, and
// `run_maplibre_script` handed user code the wrong namespace. An agent run
// therefore broke mid-way, after it had already changed the map.
//
// The tools are driven directly rather than through a model: `runCommand` is
// the same entry point the agent's tool calls land on, so this exercises the
// engine-specific paths without an LLM provider or an API key.
const TOKEN = process.env.MAPBOX_TOKEN ?? "pk.e2e-placeholder.mapbox-token";
const PROJECT_PATH = "/mapbox-geoagent.geolibre.json";
const PROJECT = {
  version: "0.2.0",
  name: "Mapbox GeoAgent",
  mapView: { center: [-100, 40], zoom: 4, bearing: 0, pitch: 0 },
  primaryRenderer: "mapbox",
  preferences: {
    map: { mapboxStyleUrl: "https://tiles.openfreemap.org/styles/liberty" },
  },
};

test.use({ actionTimeout: 30_000 });

/**
 * Whether a console message is the app's own failure rather than a network one.
 *
 * This spec runs against `MAPBOX_TOKEN` when the environment has one and a
 * placeholder otherwise, so on CI every request to `api.mapbox.com` comes back
 * 401/403 and the browser logs a bare "Failed to load resource" for each. That
 * says nothing about the code under test, which is asserted through the map's
 * own state.
 */
function isAppError(message: string): boolean {
  return !/Failed to load resource: the server responded with a status of \d+/.test(message);
}

/**
 * Bind the live Mapbox engine and the GeoAgent control it hosts.
 *
 * The control is a plain `IControl`, and the Mapbox engine wraps it in an
 * adapter before handing it to `map.addControl`, so it is not on `map._controls`
 * under its own name — the engine's own `pluginControls` map is where the
 * original lives.
 */
async function bindAgent(page: Page) {
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
            (window as any).agentMap = engine.getMapboxMap();
            (window as any).mapboxGl = engine.getMapboxGl();
            engine.pluginControls?.forEach?.((_adapter: unknown, control: any) => {
              if (control?.tools) (window as any).agentControl = control;
            });
            return !!(window as any).agentControl?.tools;
          }
          hook = hook.next;
        }
      }
      fiber = fiber.return;
    }
    return false;
  });
}

/** Run one agent tool the way a model's tool call would. */
async function runCommand(page: Page, command: string, args: Record<string, unknown> = {}) {
  return page.evaluate(
    ([name, input]) => (window as any).agentControl.tools.runCommand(name, input),
    [command, args] as const,
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
  test(`runs the engine-specific agent tools against a mapbox-gl map (${theme})`, async ({
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

      // Plugins → GeoAgent → Activate. The entry was greyed out on this
      // renderer before the plugin declared Mapbox.
      await page.getByRole("button", { name: "Plugins", exact: true }).click();
      const item = page.getByRole("menuitem", { name: "GeoAgent", exact: true });
      await expect(item).toBeEnabled();
      await item.hover();
      await page.getByRole("menuitem", { name: "Activate", exact: true }).click();
      await expect(page.locator(".geoagent-control")).toBeVisible();
      await bindAgent(page);

      // The tools were told which engine is drawing the map. Without this the
      // three tools below silently use maplibre-gl and break on the first call.
      expect(await page.evaluate(() => (window as any).agentControl.tools.engine?.kind)).toBe(
        "mapbox",
      );
      expect(
        await page.evaluate(
          () => (window as any).agentControl.tools.engine?.namespace === (window as any).mapboxGl,
        ),
        "the namespace must be the mapbox-gl the engine is drawing with",
      ).toBe(true);

      // add_marker: MapLibre's Marker throws on `addTo` here. The marker must
      // land on the map as a mapbox-gl one.
      await runCommand(page, "add_marker", {
        name: "agent-pin",
        lon: -100,
        lat: 40,
        color: "#ff0000",
        popup: "Agent marker",
      });
      await expect(page.locator(".mapboxgl-marker")).toHaveCount(1);
      expect(await page.locator(".maplibregl-marker").count()).toBe(0);

      // It tracks the map, which is the update path that threw.
      const before = await page
        .locator(".mapboxgl-marker")
        .evaluate((el) => (el as HTMLElement).style.transform);
      await page.evaluate(() => (window as any).agentMap.panBy([160, 90], { duration: 0 }));
      await expect
        .poll(async () =>
          page.locator(".mapboxgl-marker").evaluate((el) => (el as HTMLElement).style.transform),
        )
        .not.toBe(before);

      // set_projection / get_map_state: Mapbox takes a name string and reports
      // `{ name }`, MapLibre takes and reports `{ type }`.
      await runCommand(page, "set_projection", { projection: "globe" });
      await expect
        .poll(async () =>
          page.evaluate(() => {
            const projection = (window as any).agentMap.getProjection();
            return projection?.name ?? projection?.type ?? null;
          }),
        )
        .toBe("globe");
      expect(
        ((await runCommand(page, "get_map_state")) as { projection?: string }).projection,
      ).toBe("globe");
      await runCommand(page, "set_projection", { projection: "mercator" });

      // run_maplibre_script: the script's namespace argument must be the
      // engine's own. Proved by having the script place a marker — MapLibre's
      // throws on `addTo` here, so a wrong namespace fails outright rather than
      // comparing two references that could both be wrong.
      const script = (await runCommand(page, "run_maplibre_script", {
        code: [
          "const marker = new maplibregl.Marker({ color: '#0000ff' })",
          "  .setLngLat([-98, 39])",
          "  .addTo(map);",
          "marker.getElement().dataset.scriptMarker = 'yes';",
          "return { placed: true };",
        ].join("\n"),
        description: "engine check",
      })) as { success?: boolean; result?: { placed?: boolean } };
      expect(script.success).toBe(true);
      expect(script.result?.placed).toBe(true);
      await expect(page.locator(".mapboxgl-marker[data-script-marker='yes']")).toHaveCount(1);
      expect(await page.locator(".maplibregl-marker").count()).toBe(0);

      // A GeoJSON overlay reaches the Layers panel as a plugin-owned row.
      await runCommand(page, "add_geojson_data", {
        name: "agent-points",
        data: {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              properties: {},
              geometry: { type: "Point", coordinates: [-100, 40] },
            },
          ],
        },
      });
      await expect(page.getByText("agent-points", { exact: false }).first()).toBeVisible();

      await page.screenshot({ path: info.outputPath(`mapbox-geoagent-${theme}.png`) });
      expect(errors.filter(isAppError), "no app errors running the agent's tools").toEqual([]);
    }
  });
}
