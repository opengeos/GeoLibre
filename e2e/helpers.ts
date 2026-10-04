import { expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Shared E2E helpers for driving the built web app. */

/** Reads a fixture file from `e2e/fixtures/` as UTF-8 text. */
export function readFixture(name: string): string {
  return readFileSync(join(__dirname, "fixtures", name), "utf8");
}

/**
 * A 1,065-point COPC from PDAL's test data — small enough to stream in
 * seconds, which is why the LiDAR specs use it.
 *
 * Pinned to a commit rather than `master`: those specs assert the exact point
 * count, so an upstream edit would fail them with no product regression. It is
 * fetched over the network like the other remote data the `features` suite
 * loads, rather than vendored, so no binary lives in the repository.
 */
export const COPC_URL =
  "https://raw.githubusercontent.com/PDAL/PDAL/3b2942bf5874070bd00f4de2907c90dade2c0a20/test/data/copc/1.2-with-color.copc.laz";

/** Waits for MapLibre to mount its WebGL canvas — the app's "map ready" signal. */
export async function waitForMap(page: Page, path = "/"): Promise<void> {
  await page.goto(path);
  await expect(page.getByTestId("map-canvas")).toBeVisible();
  await expect(page.locator(".maplibregl-canvas")).toBeVisible({
    timeout: 30_000,
  });
}

/**
 * Dispatches a real browser drag-and-drop of a file onto the map surface,
 * exercising the `handleDrop` -> parse -> `addGeoJsonLayer` path. A `.geojson`
 * file is parsed in-browser with no DuckDB/CDN dependency, so this stays
 * hermetic. Does not assert — the caller decides whether a layer should appear
 * (valid input) or not (malformed input).
 *
 * `name` is test-controlled and assumed simple/ASCII: it is the dropped file's
 * base name and, after the drop pipeline strips the extension, the layer name.
 */
export async function dropGeoJson(page: Page, name: string, text: string): Promise<void> {
  const dataTransfer = await page.evaluateHandle(
    ({ contents, fileName }) => {
      const dt = new DataTransfer();
      dt.items.add(new File([contents], fileName, { type: "application/geo+json" }));
      return dt;
    },
    { contents: text, fileName: `${name}.geojson` },
  );
  for (const type of ["dragenter", "dragover", "drop"]) {
    await page.dispatchEvent('[data-testid="map-canvas"]', type, {
      dataTransfer,
    });
  }
  await dataTransfer.dispose();
}

/** The layer-panel row for a dropped GeoJSON layer, keyed by its base name. */
export function layerRow(page: Page, name: string) {
  return page.locator(`[data-testid="layer-row"][data-layer-name="${name}"]`);
}

/**
 * What one rendering-engine swap is allowed to cost, click and repaint alike.
 *
 * `setPrimaryRenderer` is a discrete React update, so the entire swap runs
 * inside the menu radio item's own click handler: the outgoing engine's
 * `map.remove()` drops its WebGL context, taking any deck overlay's buffers
 * with it, and on the way back to MapLibre `new maplibregl.Map()` builds the
 * replacement before the click event returns. Playwright does not resolve
 * `click` until the browser acknowledges that event, so the whole swap is
 * charged against `actionTimeout`. On CI's software renderer it outran the 30 s
 * the mapbox specs set, and `retries: 1` was what made them green (#2432).
 */
export const RENDERER_SWAP_TIMEOUT = 90_000;

/** The slice of the MapLibre `Map` API these specs drive. */
export interface TestMapHandle {
  getCenter(): { lng: number; lat: number };
  getZoom(): number;
  isMoving(): boolean;
  isZooming(): boolean;
  isRotating(): boolean;
  project(lngLat: [number, number]): { x: number; y: number };
  getCanvas(): HTMLCanvasElement;
  on(type: "movestart", listener: () => void): unknown;
  /** True once the style and every visible source's tiles have loaded. */
  loaded(): boolean;
  queryRenderedFeatures(point: [number, number]): { properties: Record<string, unknown> | null }[];
}

/**
 * Every method of `TestMapHandle`, checked before a candidate is accepted.
 *
 * The walk below meets many hook values, so the probe is what tells a map from
 * anything else. Check the whole interface rather than a sample of it: a value
 * carrying only the sampled methods would be stashed and then throw from
 * whichever spec first reached for one of the others.
 */
const TEST_MAP_METHODS = [
  "getCenter",
  "getZoom",
  "isMoving",
  "isZooming",
  "isRotating",
  "project",
  "getCanvas",
  "on",
  "loaded",
  "queryRenderedFeatures",
] as const satisfies readonly (keyof TestMapHandle)[];

declare global {
  interface Window {
    /** The primary canvas's live map, once `bindMapLibreMap` has run. */
    __geolibreTestMap?: TestMapHandle;
  }
}

/** The shapes walked to reach the map: a React fiber and one of its hooks. */
interface FiberLike {
  return?: FiberLike;
  alternate?: FiberLike;
  memoizedState?: HookLike;
}
interface HookLike {
  memoizedState?: { current?: unknown };
  next?: HookLike;
}

/**
 * Binds the live MapLibre `Map` to `window.__geolibreTestMap` on the page.
 *
 * GeoLibre exposes no global for the map, so a spec that needs the camera or a
 * geographic-to-screen projection has to reach the instance the only way it
 * can: the map container is a React-rendered element, so its fiber chain
 * carries `MapCanvas`'s controller ref. Walk up from the container and scan
 * each fiber's hook chain for the `MapController`, then take its `getMap()`.
 *
 * Resolves once the handle is stashed. The Mapbox specs do the same thing
 * against their own engine (`bindMapboxMap`, defined locally in each).
 */
export async function bindMapLibreMap(page: Page): Promise<void> {
  await page.waitForFunction(
    (methods: readonly string[]) => {
      const container = document.querySelector(".maplibregl-map");
      if (!container) return false;
      const fiberKey = Object.keys(container).find((key) => key.startsWith("__reactFiber"));
      if (!fiberKey) return false;
      const asMap = (value: unknown): TestMapHandle | null => {
        if (typeof value !== "object" || value === null) return null;
        const candidate = value as Record<string, unknown>;
        return methods.every((method) => typeof candidate[method] === "function")
          ? (candidate as unknown as TestMapHandle)
          : null;
      };
      let fiber: FiberLike | undefined = (container as unknown as Record<string, FiberLike>)[
        fiberKey
      ];
      while (fiber) {
        for (const side of [fiber, fiber.alternate]) {
          let hook = side?.memoizedState;
          while (hook) {
            const held = hook.memoizedState?.current as { getMap?: () => unknown } | undefined;
            const map = asMap(typeof held?.getMap === "function" ? held.getMap() : held);
            if (map) {
              window.__geolibreTestMap = map;
              return true;
            }
            hook = hook.next;
          }
        }
        fiber = fiber.return;
      }
      return false;
    },
    TEST_MAP_METHODS as readonly string[],
  );
}

/**
 * Waits until the primary map has drawn a feature at a canvas point and has
 * nothing left to load or animate, then returns.
 *
 * A layer appearing in the Layers panel says nothing about the canvas: the drop
 * flies the camera to the new layer, and the basemap tiles for the zoom it lands
 * on stream in for a second or more afterwards. A pixel read in that window is
 * a frame the map is about to replace. Requiring the feature under the point
 * pins the wait to *after* the fly started (the layer's source is added with
 * it), and `loaded()` with no camera movement is MapLibre's own "idle" state.
 *
 * @param page - The page whose MapLibre map to wait on.
 * @param name - The `name` property of the feature that must be rendered.
 * @param at - The point as fractions of the canvas size; defaults to the centre.
 */
export async function waitForRenderedFeature(
  page: Page,
  name: string,
  at: [number, number] = [0.5, 0.5],
): Promise<void> {
  await bindMapLibreMap(page);
  await page.waitForFunction(
    ({ featureName, fx, fy }) => {
      const map = window.__geolibreTestMap;
      if (!map || map.isMoving() || !map.loaded()) return false;
      const canvas = map.getCanvas();
      const rect = canvas.getBoundingClientRect();
      return map
        .queryRenderedFeatures([rect.width * fx, rect.height * fy])
        .some((feature) => feature.properties?.name === featureName);
    },
    { featureName: name, fx: at[0], fy: at[1] },
    { timeout: 30_000 },
  );
}

/**
 * Drops a GeoJSON file on the desktop shell, the drop target every rendering
 * engine shares. `dropGeoJson` targets MapLibre's `map-canvas`, which the
 * Cesium and ArcGIS engines unmount.
 *
 * @param page - The page to drop onto.
 * @param name - The file's base name, which becomes the layer name.
 * @param text - The GeoJSON document.
 */
export async function dropGeoJsonOnShell(page: Page, name: string, text: string): Promise<void> {
  await page.evaluate(
    ({ contents, fileName }) => {
      const dt = new DataTransfer();
      dt.items.add(new File([contents], fileName, { type: "application/geo+json" }));
      const target = document.querySelector('[data-testid="desktop-shell"]');
      if (!target) throw new Error("desktop shell drop target not found");
      for (const type of ["dragenter", "dragover", "drop"])
        target.dispatchEvent(
          new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }),
        );
    },
    { contents: text, fileName: `${name}.geojson` },
  );
}

/** The status bar's zoom readout as a number, or NaN. Every engine publishes it. */
export async function readStatusZoom(page: Page): Promise<number> {
  const text = await page.getByText(/^Zoom:/).textContent();
  return Number(text?.match(/-?\d+(\.\d+)?/)?.[0] ?? NaN);
}

/**
 * Waits until the status bar reports a settled camera within half a zoom level
 * of `zoom`, and returns that zoom.
 *
 * The status bar zoom changes only per settled camera, so it is waited on *by
 * value*: "two equal reads" alone also holds before a flight starts. Half a
 * level, not an exact match, because a view handed to the Cesium or ArcGIS
 * camera round-trips through a lossy zoom conversion.
 *
 * @param page - The page whose status bar to read.
 * @param zoom - The zoom the camera is expected to settle near.
 * @returns The settled zoom.
 */
export async function waitForSettledZoomNear(page: Page, zoom: number): Promise<number> {
  return waitForSettledZoom(page, (now) => Math.abs(now - zoom) < 0.5);
}

/**
 * Waits until the status bar reports a settled camera whose zoom satisfies
 * `accept`, and returns that zoom. Settled means two equal reads in a row.
 *
 * @param page - The page whose status bar to read.
 * @param accept - Whether a zoom is the one being waited for.
 * @returns The settled zoom.
 */
export async function waitForSettledZoom(
  page: Page,
  accept: (zoom: number) => boolean,
): Promise<number> {
  let previous = NaN;
  await expect
    .poll(
      async () => {
        const now = await readStatusZoom(page);
        const settled = accept(now) && now === previous;
        previous = now;
        return settled;
      },
      { timeout: 60_000, intervals: [500] },
    )
    .toBe(true);
  return previous;
}

/**
 * Moves the camera with View -> Set View and waits until it is at rest there.
 *
 * @param page - The page to drive.
 * @param lng - Target longitude in degrees.
 * @param lat - Target latitude in degrees.
 * @param zoom - Target zoom level.
 * @returns The settled zoom the status bar reports.
 */
export async function setViewAndSettle(
  page: Page,
  lng: number,
  lat: number,
  zoom: number,
): Promise<number> {
  await page.getByRole("button", { name: "View", exact: true }).click();
  await page.getByRole("menuitem", { name: /Set View/ }).click();
  const dialog = page.getByRole("dialog", { name: "Set View" });
  await dialog.locator("#set-view-longitude").fill(String(lng));
  await dialog.locator("#set-view-latitude").fill(String(lat));
  await dialog.locator("#set-view-zoom").fill(String(zoom));
  await dialog.getByRole("button", { name: "Go", exact: true }).click();
  await expect(dialog).toBeHidden();
  return waitForSettledZoomNear(page, zoom);
}

/**
 * Records everything that would put an error in the browser console while a
 * page boots: `console.error` messages, uncaught page errors, and same-origin
 * responses of 400 and above (the browser logs each of those as "Failed to load
 * resource", which no app code can suppress — see #2916). Read `problems` once
 * the page has settled; an empty list means a clean console.
 *
 * Cross-origin failures are left out: a basemap or CDN outage is not the build's
 * fault. Their console lines are still caught when the browser logs them.
 */
export function collectPageProblems(page: Page): { problems: string[] } {
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const where = message.location().url;
    problems.push(`console.error: ${message.text()}${where ? ` (${where})` : ""}`);
  });
  page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
  page.on("response", (response) => {
    if (response.status() < 400) return;
    const request = response.request();
    // The page's own document always counts. Its response can arrive before the
    // frame commits the new URL, while page.url() still reads about:blank.
    const isDocument = request.isNavigationRequest() && request.frame() === page.mainFrame();
    if (!isDocument) {
      const pageUrl = page.url();
      if (!pageUrl.startsWith("http")) return;
      if (new URL(response.url()).origin !== new URL(pageUrl).origin) return;
    }
    problems.push(`HTTP ${response.status()}: ${response.url()}`);
  });
  return { problems };
}

/**
 * Waits until the primary MapLibre map reports its style and every visible
 * tile loaded, which is the closest thing to "the map has rendered" the app
 * exposes.
 */
export async function waitForMapLoaded(page: Page, timeout = 60_000): Promise<void> {
  await bindMapLibreMap(page);
  await page.waitForFunction(() => window.__geolibreTestMap?.loaded(), undefined, { timeout });
}
