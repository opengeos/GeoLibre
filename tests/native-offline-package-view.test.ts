import { it } from "node:test";
import assert from "node:assert/strict";
import type { MapEngine } from "@geolibre/map";
import { frameNativeOfflinePackage } from "../apps/geolibre-desktop/src/lib/native-offline-package-view";

const bbox: [number, number, number, number] = [-122.2614, 37.8698, -122.258, 37.8729];

function camera(width = 360, height = 580) {
  const flights: Parameters<MapEngine["flyTo"]>[0][] = [];
  const fits: (typeof bbox)[] = [];
  const canvas = { clientWidth: width, clientHeight: height } as HTMLCanvasElement;
  const engine = {
    getRenderSurface: () =>
      ({ getCanvas: () => canvas }) as ReturnType<MapEngine["getRenderSurface"]>,
    flyTo: (view: Parameters<MapEngine["flyTo"]>[0]) => flights.push(view),
    fitBounds: (bounds: typeof bbox) => fits.push(bounds),
  };
  return { engine, flights, fits };
}

it("shows detailed raster tiles when fitting their extent would fall below the archive minimum", () => {
  const { engine, flights, fits } = camera();
  frameNativeOfflinePackage(engine, { bbox, minZoom: 19 });
  assert.deepEqual(fits, []);
  assert.equal(flights.length, 1);
  assert.equal(flights[0].zoom, 19);
  assert.equal(flights[0].center?.[0], -122.2597);
  assert.ok(Math.abs((flights[0].center?.[1] ?? 0) - 37.87135) < 1e-6);
  assert.equal(flights[0].bearing, 0);
  assert.equal(flights[0].pitch, 0);
});

it("keeps detailed framing when the available pyramid starts below the fitting zoom", () => {
  const { engine, flights } = camera();
  frameNativeOfflinePackage(engine, { bbox, minZoom: 1 });
  assert.ok(flights[0].zoom != null && flights[0].zoom > 15);
});

it("centers a tall extent in Mercator coordinates when all of it fits above the minimum", () => {
  const { engine, flights } = camera(1000, 1000);
  frameNativeOfflinePackage(engine, { bbox: [-10, 0, 10, 80], minZoom: 1 });
  assert.ok(flights[0].zoom != null && flights[0].zoom > 1);
  assert.ok(Math.abs((flights[0].center?.[1] ?? 0) - 57.04516467328689) < 1e-8);
});

it("uses the engine's geographic fit for a complete pyramid and handles an unmeasured canvas", () => {
  const { engine, flights, fits } = camera(0, 0);
  frameNativeOfflinePackage(engine, { bbox, minZoom: 0 });
  assert.deepEqual(fits, [bbox]);
  frameNativeOfflinePackage(engine, { bbox, minZoom: 19 });
  assert.equal(flights[0].zoom, 19);
  frameNativeOfflinePackage(null, { bbox, minZoom: 19 });
});
