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
}

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
  await page.waitForFunction(() => {
    const container = document.querySelector(".maplibregl-map");
    if (!container) return false;
    const fiberKey = Object.keys(container).find((key) => key.startsWith("__reactFiber"));
    if (!fiberKey) return false;
    const asMap = (value: unknown): TestMapHandle | null => {
      const candidate = value as Partial<TestMapHandle> | null | undefined;
      return typeof candidate?.project === "function" &&
        typeof candidate.getZoom === "function" &&
        typeof candidate.getCenter === "function"
        ? (candidate as TestMapHandle)
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
  });
}
