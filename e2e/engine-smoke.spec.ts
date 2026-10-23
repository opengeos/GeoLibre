import { expect, test, type Page } from "./test";
import {
  dropGeoJsonOnShell,
  layerRow,
  setViewAndSettle,
  waitForSettledZoom,
  waitForSettledZoomNear,
} from "./helpers";

/**
 * The per-commit smoke check for each alternate rendering engine: switch the
 * primary renderer, add a GeoJSON layer to it, and identify a feature on it.
 *
 * The deep engine specs (`cesium-primary-renderer`, `cesium-globe`, the
 * `arcgis-*` pair) run nightly or opt-in; this is the slice of them that would
 * break for every user of that engine, kept small enough to gate a pull
 * request.
 *
 * - **Cesium** runs keyless and asserts nothing about imagery, so it passes on
 *   a runner with no egress: picking needs only the globe's own geometry.
 * - **ArcGIS** runs keyless too (no Esri basemap service), but the app loads
 *   the Maps SDK itself from Esri's CDN (`js.arcgis.com`) on first use, so it
 *   is the one core check that needs that host. `arcgis-offline.spec.ts`
 *   covers the CDN-unreachable path.
 *
 * This file is the whole `core-engines` project, which runs after `core` on a
 * single worker (see `playwright.config.ts`): each software-rendered 3D view
 * saturates the CPU on its own, and run beside other specs on a 4-vCPU runner
 * it starved them and itself. `default` mode is pinned against a future
 * `fullyParallel`; unlike `serial`, a failure in the first engine still runs
 * the second.
 */
test.describe.configure({ mode: "default" });

/**
 * One polygon spanning the contiguous US, centred where the spec flies the
 * camera, and large enough that a pick at the view's centre lands on it.
 */
function area(name: string): string {
  return JSON.stringify({
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { name, kind: "polygon" },
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [-125, 25],
              [-70, 25],
              [-70, 50],
              [-125, 50],
              [-125, 25],
            ],
          ],
        },
      },
    ],
  });
}

interface Engine {
  /** The radio item under View -> Rendering engine. */
  label: "Cesium" | "ArcGIS";
  /** The test id of the element the engine mounts its view in. */
  container: string;
  /** Where clicks land and the Identify cursor shows, inside `container`. */
  surface: string;
  /** The Identify popup the engine draws, inside `container`. */
  popup: string;
  /** Engine-specific setup before the swap. */
  prepare?: (page: Page) => Promise<void>;
  /** Waits for the engine to finish mounting after the swap. */
  ready: (page: Page) => Promise<void>;
}

const ENGINES: Engine[] = [
  {
    label: "Cesium",
    container: "primary-cesium",
    surface: "canvas",
    popup: ".geolibre-identify-popup",
    ready: async (page) => {
      await expect(page.getByTestId("primary-cesium").locator("canvas").first()).toBeVisible({
        timeout: 60_000,
      });
    },
  },
  {
    label: "ArcGIS",
    container: "arcgis-canvas",
    surface: ".esri-view-surface",
    popup: ".geolibre-arcgis-popup",
    // An empty device setting falls back to build-time credentials, so blank
    // the runtime names too: this must take the keyless path on a keyed build.
    prepare: async (page) => {
      await page.evaluate(() => {
        window.__GEOLIBRE_RUNTIME_ENV__ = {
          ...window.__GEOLIBRE_RUNTIME_ENV__,
          VITE_ARCGIS_API_KEY: "",
          ARCGIS_API_KEY: "",
        };
        window.dispatchEvent(new CustomEvent("geolibre:runtime-env-change"));
      });
    },
    ready: async (page) => {
      const canvas = page.getByTestId("arcgis-canvas");
      await expect(canvas.locator(".esri-view")).toBeVisible({ timeout: 60_000 });
      await expect(canvas).toHaveAttribute("aria-busy", "false", { timeout: 60_000 });
    },
  },
];

for (const engine of ENGINES) {
  test(`${engine.label}: switches the primary renderer, adds GeoJSON, and identifies a feature`, async ({
    page,
  }) => {
    // Both engines are lazily loaded multi-megabyte modules (ArcGIS from its
    // CDN), and both views are software-rendered on CI.
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const layerName = `${engine.label.toLowerCase()}-smoke`;
    const featureName = `${engine.label} smoke area`;

    await page.goto("/");
    await expect(page.locator(".maplibregl-canvas")).toBeVisible({ timeout: 30_000 });
    await engine.prepare?.(page);

    await page.getByRole("button", { name: "View", exact: true }).click();
    await page.getByRole("menuitem", { name: "Rendering engine", exact: true }).hover();
    await page.getByRole("menuitemradio", { name: engine.label, exact: true }).click();
    await engine.ready(page);
    // The engine replaces the MapLibre map rather than joining it.
    await expect(page.getByTestId("map-canvas")).toHaveCount(0);
    // ...and seeded its camera from the shared (default, world-scale) view.
    const seeded = await waitForSettledZoomNear(page, 2);

    await dropGeoJsonOnShell(page, layerName, area(featureName));
    const row = layerRow(page, layerName);
    await expect(row).toBeVisible({ timeout: 30_000 });
    // The engine compiled the layer instead of flagging it unsupported.
    await expect(row).not.toContainText(/No (ArcGIS|Cesium)/);
    // Adding the layer flies to it, and the camera comes to rest there rather
    // than back at the seed view. The globe's terrain correction used to pull
    // the flight back to the seed mid-air (#2878).
    await waitForSettledZoom(page, (zoom) => zoom > seeded + 1);
    // Then a Set View to the layer's centre lands too: the same pull-back
    // refused it on the globe (#2878).
    await setViewAndSettle(page, -97.5, 37.5, 4);

    await row.getByRole("button", { name: "Identify features", exact: true }).click();
    const container = page.getByTestId(engine.container);
    const surface = container.locator(engine.surface).first();
    await expect(surface).toHaveCSS("cursor", "crosshair");
    const box = await surface.boundingBox();
    expect(box).not.toBeNull();
    const popup = container.locator(engine.popup);
    // A pick resolves only once the engine has built and drawn the layer's
    // geometry, which neither the layer row nor the camera waits for. Retry the
    // click until the popup answers rather than guess how long that takes; the
    // camera is at rest, so a repeated click cannot move it.
    await expect(async () => {
      await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
      await expect(popup).toContainText(layerName, { timeout: 5_000 });
      await expect(popup).toContainText(featureName, { timeout: 1_000 });
    }).toPass({ timeout: 60_000 });

    await expect(container.getByRole("alert")).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
