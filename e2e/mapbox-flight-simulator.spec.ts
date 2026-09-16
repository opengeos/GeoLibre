import { expect, test, type Page } from "@playwright/test";
import { DESKTOP_SETTINGS_STORAGE_KEY } from "../apps/geolibre-desktop/src/lib/storage-keys";

// Flight Simulator on the Mapbox renderer (issue #2420). MapLibre's
// `calculateCameraOptionsFromCameraLngLatAltRotation` does not exist on a
// mapbox-gl map; mapbox-gl kept the free camera it replaced, so the plugin's
// Mapbox adapter writes `setFreeCameraOptions` with a `MercatorCoordinate`
// carrying the aircraft's altitude. The project points the Mapbox pane at a
// third-party style, so the token is only what mapbox-gl needs to construct a
// map — the DEM the simulator flies over is Mapbox's, which the token also
// serves.
const TOKEN = process.env.MAPBOX_TOKEN ?? "pk.e2e-placeholder.mapbox-token";
const PROJECT_PATH = "/mapbox-flight.geolibre.json";
// Mount Rainier: real relief, so the terrain clearance readout is meaningful.
const PROJECT = {
  version: "0.2.0",
  name: "Mapbox Flight",
  mapView: { center: [-121.76, 46.8], zoom: 12, bearing: 0, pitch: 0 },
  primaryRenderer: "mapbox",
  preferences: {
    map: { mapboxStyleUrl: "https://tiles.openfreemap.org/styles/liberty" },
  },
};

test.use({ actionTimeout: 30_000 });

/**
 * The browser's own echo of a failed request. It carries no URL, so it says
 * nothing a response listener does not say better — {@link watchFailedRequests}
 * records those with their URL and status, and the assertions read that.
 */
const RESOURCE_FAILURE_ECHO = /Failed to load resource: the server responded with a status of \d+/;

/**
 * Record every failed request except the ones a tokenless run is expected to
 * produce.
 *
 * This spec uses `MAPBOX_TOKEN` when the environment has one and a placeholder
 * otherwise, so on CI every Mapbox API request — the DEM the simulator flies
 * over among them — comes back 401 or 403. Those say nothing about the code
 * under test, which is asserted through the map's own camera and state. Any
 * other failure is a real one and reaches the assertion with its URL.
 */
function watchFailedRequests(page: Page, failures: string[]): void {
  page.on("response", (response) => {
    const status = response.status();
    if (status < 400) return;
    const { hostname } = new URL(response.url());
    const mapboxAuth =
      (hostname === "api.mapbox.com" || hostname === "events.mapbox.com") &&
      (status === 401 || status === 403);
    if (mapboxAuth) return;
    failures.push(`http ${status}: ${response.url()}`);
  });
  page.on("requestfailed", (request) => {
    // A cancelled tile is the camera changing its mind, not a failure: every
    // pan and projection switch abandons the requests for the view it left.
    const errorText = request.failure()?.errorText ?? "";
    if (errorText.includes("ERR_ABORTED")) return;
    const { hostname } = new URL(request.url());
    if (hostname === "api.mapbox.com" || hostname === "events.mapbox.com") return;
    failures.push(`request failed: ${request.url()} (${errorText})`);
  });
}

/**
 * Bind the live Mapbox engine without adding a production global: walk the
 * header's fiber tree to the ref the React shell holds it in.
 */
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
            (window as any).flightTestRef = hook.memoizedState;
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

/** What the live Mapbox map holds of the flight: camera, limits, interaction. */
async function mapState(page: Page) {
  return page.evaluate(() => {
    const engine = (window as any).flightTestRef.current;
    const map = engine.getMapboxMap();
    const camera = map.getFreeCameraOptions();
    return {
      cameraAltitude: camera.position ? camera.position.toAltitude() : null,
      pitch: map.getPitch(),
      bearing: map.getBearing(),
      center: map.getCenter().toArray() as [number, number],
      maxPitch: map.getMaxPitch(),
      terrain: engine.isTerrainEnabled() as boolean,
      dragPan: map.dragPan.isEnabled() as boolean,
      keyboard: map.keyboard.isEnabled() as boolean,
    };
  });
}

/**
 * Count the `moveend` events the flight fires, split by whether they carry the
 * token the app's store sync skips on. An untagged one during flight would
 * overwrite the project's saved view ~60 times a second.
 */
async function watchMoveEnd(page: Page) {
  await page.evaluate(() => {
    const map = (window as any).flightTestRef.current.getMapboxMap();
    const counts = { tagged: 0, untagged: 0 };
    (window as any).flightMoveCounts = counts;
    map.on("moveend", (event: { flightCameraToken?: number }) => {
      if (event?.flightCameraToken !== undefined) counts.tagged += 1;
      else counts.untagged += 1;
    });
  });
}

async function moveEndCounts(page: Page) {
  return page.evaluate(
    () => (window as any).flightMoveCounts as { tagged: number; untagged: number },
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
  await bindEngine(page);
  await expect(page.getByRole("button", { name: "Add Data", exact: true })).toBeEnabled();
}

for (const theme of ["light", "dark"] as const) {
  test(`flies the Mapbox free camera and hands the map back on exit (${theme})`, async ({
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
      const before = await mapState(page);
      expect(before.terrain, "terrain starts off").toBe(false);

      // Controls → Flight Simulator opens the panel on the Mapbox renderer; it
      // was hidden there until the plugin declared the engine.
      await page.getByRole("button", { name: "Controls", exact: true }).click();
      await page.getByRole("menuitem", { name: "Flight Simulator" }).click();
      const panel = page.getByRole("dialog", { name: "Flight Simulator" });
      await expect(panel).toBeVisible();

      // mapbox-gl 3 has no camera roll, so the bank setting cannot tilt the
      // horizon here and the panel says so.
      await expect(panel.getByText("Mapbox GL has no camera roll", { exact: false })).toBeVisible();

      await watchMoveEnd(page);
      await panel.getByRole("button", { name: "Start flying" }).click();

      // Taking the map over: terrain on, interaction suspended, the pitch
      // ceiling widened, and the camera placed at the aircraft — above the
      // ground, at the level-flight pitch.
      await expect.poll(async () => (await mapState(page)).terrain).toBe(true);
      const flying = await mapState(page);
      expect(flying.dragPan, "dragging must not fight the flight model").toBe(false);
      expect(flying.keyboard, "MapLibre-style key panning must be suspended").toBe(false);
      expect(flying.maxPitch).toBe(85);
      expect(flying.pitch).toBeGreaterThan(70);
      expect(flying.pitch).toBeLessThanOrEqual(85);
      expect(flying.cameraAltitude, "the free camera carries the aircraft altitude").not.toBeNull();
      expect(flying.cameraAltitude!).toBeGreaterThan(200);

      // The aircraft flies: the camera moves, and every move it makes is tagged
      // so the store sync skips it.
      // Generous timeouts throughout: the flight is integrated per animation
      // frame, and a software-WebGL runner draws far fewer of them than a GPU.
      await expect
        .poll(
          async () => {
            const now = await mapState(page);
            return (
              Math.abs(now.center[1] - flying.center[1]) +
              Math.abs(now.center[0] - flying.center[0])
            );
          },
          { timeout: 30_000 },
        )
        .toBeGreaterThan(0.001);
      await expect
        .poll(async () => (await moveEndCounts(page)).tagged, { timeout: 30_000 })
        .toBeGreaterThan(2);
      expect((await moveEndCounts(page)).untagged, "no flight frame may reach the store sync").toBe(
        0,
      );

      // Arrow Right banks the aircraft, and a bank turns it. The turn is
      // integrated per animation frame, and a software-WebGL runner draws far
      // fewer of them than a real GPU, so hold the key until the heading has
      // actually moved rather than asserting a fixed angle after a fixed wait.
      await page.locator(".mapboxgl-canvas").click({ position: { x: 10, y: 10 } });
      const heading = flying.bearing;
      await page.keyboard.down("ArrowRight");
      try {
        await expect
          .poll(async () => (await mapState(page)).bearing, { timeout: 30_000 })
          .toBeGreaterThan(heading + 1);
      } finally {
        await page.keyboard.up("ArrowRight");
      }

      await page.screenshot({ path: info.outputPath(`mapbox-flight-${theme}.png`) });

      // Esc lands: the map comes back with the tilt, ceiling, terrain state and
      // interaction it had before, keeping where the flight ended.
      await page.keyboard.press("Escape");
      await expect.poll(async () => (await mapState(page)).dragPan).toBe(true);
      const after = await mapState(page);
      expect(after.keyboard).toBe(true);
      expect(after.pitch).toBeCloseTo(before.pitch, 1);
      expect(after.maxPitch).toBe(before.maxPitch);
      expect(after.terrain, "terrain must go back to how it was").toBe(false);

      expect(errors, "no app errors while flying").toEqual([]);
      expect(failures, "nothing but the tokenless Mapbox API may fail to load").toEqual([]);
    }
  });
}
