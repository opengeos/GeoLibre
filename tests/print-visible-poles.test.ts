import assert from "node:assert/strict";
import { it } from "node:test";
// Exercise the installed engine's projection, including its occluded-pole
// behavior. MapLibre 6.19 replaced the transform classes with a camera view
// state, a projected camera derived from it, and per-projection camera math.
import { createCameraContext } from "../node_modules/maplibre-gl/src/camera/camera_context.ts";
import { getCameraMath } from "../node_modules/maplibre-gl/src/camera/camera_math_factory.ts";
import {
  resize,
  setBearing,
  setCenter,
  setMaxPitch,
  setPitch,
  setZoom,
} from "../node_modules/maplibre-gl/src/camera/camera_updates.ts";
import { createCameraViewState } from "../node_modules/maplibre-gl/src/camera/camera_view_state.ts";
import { projectCamera } from "../node_modules/maplibre-gl/src/camera/project_camera.ts";
import { LngLat } from "../node_modules/maplibre-gl/src/geo/lng_lat.ts";
import Point from "../node_modules/maplibre-gl/node_modules/@mapbox/point-geometry/index.js";
import {
  captureVisiblePoles,
  capturePolesInRect,
  gridLngLat,
  sampleCaptureLngLatGrid,
} from "../apps/geolibre-desktop/src/lib/print-capture-grid";
import { capturedBounds } from "../apps/geolibre-desktop/src/lib/print-capture-bounds";
import {
  insetFootprint,
  mercatorViewPx,
} from "../apps/geolibre-desktop/src/lib/print-layout-cartography";
import type { CapturedMap } from "../apps/geolibre-desktop/src/lib/print-layout-export";

/** A fully globe-shaped 1000 x 600 camera, pitched and turned to face south. */
function pitchedGlobe() {
  const context = createCameraContext({ projection: "globe", projectionTransition: 1 });
  let view = setMaxPitch(createCameraViewState(), 85);
  view = resize(view, context, 1000, 600);
  view = setCenter(view, context, new LngLat(0, -30));
  view = setZoom(view, context, 0);
  view = setPitch(view, 40);
  view = setBearing(view, 180);
  const camera = projectCamera(view, context);
  const math = getCameraMath(camera);
  const helper = context.worldCoordinateHelper;
  return {
    screenPointToLocation: (point: Point) => math.screenPointToLocation(camera, helper, point),
    locationToScreenPoint: (lngLat: LngLat) => math.locationToScreenPoint(camera, helper, lngLat),
    isLocationOccluded: (lngLat: LngLat) => math.isLocationOccluded(camera, helper, lngLat),
  };
}

it("uses the visible North Pole when a pitched globe's center lies south of the equator", () => {
  const transform = pitchedGlobe();
  const locate = (x: number, y: number) => transform.screenPointToLocation(new Point(x, y));
  const project = (location: [number, number]) =>
    transform.locationToScreenPoint(new LngLat(...location));
  const hidden = project([0, -90]);
  assert.ok(hidden.x > 0 && hidden.x < 1000 && hidden.y > 0 && hidden.y < 600);
  assert.equal(transform.isLocationOccluded(new LngLat(0, -90)), true);
  assert.equal(transform.isLocationOccluded(new LngLat(0, 90)), false);
  assert.ok(locate(500, 300).lat < 0, "center hemisphere is not a pole visibility test");
  const grid = sampleCaptureLngLatGrid(1000, 600, locate, undefined, project)!;
  assert.deepEqual(
    grid.poles?.map((pole) => pole.latitude),
    [90],
  );
  const capture = { width: 1000, height: 600, georef: null, lngLatGrid: grid } as CapturedMap;
  const bounds = capturedBounds(capture)!;
  assert.equal(bounds[3], 90);
  assert.ok(bounds[1] > -90, "hidden South Pole is not added to the bounds");
  const boundary: [number, number][] = [];
  for (const [x, y, u, v] of [
    [0, 0, 1000, 0],
    [1000, 0, 1000, 600],
    [1000, 600, 0, 600],
    [0, 600, 0, 0],
  ]) {
    for (let step = 0; step < 12; step++)
      boundary.push(gridLngLat(grid, x + ((u - x) * step) / 12, y + ((v - y) * step) / 12));
  }
  const view = { center: [0, 0] as [number, number], zoom: 0, width: 360, height: 180 };
  const ring = insetFootprint(view, boundary, -30, 90);
  const north = mercatorViewPx(view, 0, 90).y;
  const south = mercatorViewPx(view, 0, -90).y;
  assert.ok(ring.some((point) => Math.abs(point.y - north) < 1e-5));
  assert.ok(ring.every((point) => point.y < south - 1e-5));
  assert.deepEqual(
    capturePolesInRect(grid, 0, 0, 1000, 350),
    [],
    "a layout crop can exclude the visible pole",
  );
});

it("records pole pixels in a cropped high-DPI image and round-trips them on the original surface", () => {
  const transform = pitchedGlobe();
  const project = (location: [number, number]) => {
    const point = transform.locationToScreenPoint(new LngLat(...location));
    return { x: point.x * 2 - 100, y: point.y * 2 - 50 };
  };
  const locate = (x: number, y: number) =>
    transform.screenPointToLocation(new Point((x + 100) / 2, (y + 50) / 2));
  const poles = captureVisiblePoles(1800, 1000, project, locate);
  assert.equal(poles.length, 1);
  assert.equal(poles[0].latitude, 90);
  assert.ok(Math.abs(poles[0].x - 900) < 1e-5);
  assert.ok(poles[0].y > 830 && poles[0].y < 850);
  assert.deepEqual(captureVisiblePoles(1800, 500, project, locate), []);
});

it("does not invent a polar cap from grid winding when explicit visibility finds none", () => {
  const boundary: [number, number][] = [];
  for (let lng = -180; lng < 180; lng += 10) boundary.push([lng, 30]);
  const view = { center: [0, 0] as [number, number], zoom: 0, width: 360, height: 180 };
  const ring = insetFootprint(view, boundary, -30, null);
  const latitudeLine = mercatorViewPx(view, 0, 30).y;
  assert.ok(ring.every((point) => Math.abs(point.y - latitudeLine) < 1e-5));
});

it("includes a verified visible pole even when the sampled boundary has no longitude winding", () => {
  const capture = {
    width: 100,
    height: 100,
    georef: null,
    lngLatGrid: {
      cols: 1,
      rows: 1,
      width: 100,
      height: 100,
      lngs: [10, 20, 10, 20],
      lats: [70, 70, 60, 60],
      poles: [{ x: 50, y: 50, latitude: 90 }],
    },
  } as CapturedMap;
  assert.deepEqual(capturedBounds(capture), [10, 60, 20, 90]);
});
