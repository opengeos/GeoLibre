import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Map as MapLibreMap } from "maplibre-gl";
import {
  cameraAltitudeFromProjectedCamera,
  installMapTransformCompat,
} from "../packages/map/src/map-transform-compat";
// The installed engine's own camera math, to hold the altitude mirror to it.
import { createCameraContext } from "../node_modules/maplibre-gl/src/camera/camera_context.ts";
import { getCameraMath } from "../node_modules/maplibre-gl/src/camera/camera_math_factory.ts";
import {
  resize,
  setCenter,
  setPitch,
  setZoom,
} from "../node_modules/maplibre-gl/src/camera/camera_updates.ts";
import { createCameraViewState } from "../node_modules/maplibre-gl/src/camera/camera_view_state.ts";
import { projectCamera } from "../node_modules/maplibre-gl/src/camera/project_camera.ts";
import { LngLat } from "../node_modules/maplibre-gl/src/geo/lng_lat.ts";

/**
 * MapLibre v6 moved the transform to `map._camera.transform` (and 6.19 replaced
 * it with a derived `projectedCamera`), but deck.gl still reads `map.transform`
 * on every render. The shim re-exposes it. These assert the two things that would fail silently: a
 * map with no `_camera` must not throw, and the `_nearZ`/`_farZ` aliases must
 * resolve to v6's public `nearZ`/`farZ` so deck.gl keeps its depth precision.
 */
describe("installMapTransformCompat", () => {
  it("exposes the camera transform as map.transform", () => {
    installMapTransformCompat();

    const transform = { height: 720, width: 1280, elevation: 12, nearZ: 3, farZ: 4000 };
    const map = Object.create(MapLibreMap.prototype) as {
      _camera?: unknown;
      transform?: typeof transform;
    };
    map._camera = { transform };

    assert.equal(map.transform, transform);
    assert.equal(map.transform?.height, 720);
    assert.equal(map.transform?.elevation, 12);
  });

  it("aliases the v5 _nearZ/_farZ spellings onto the v6 transform", () => {
    installMapTransformCompat();

    const transform: Record<string, unknown> = { height: 720, nearZ: 3, farZ: 4000 };
    const map = Object.create(MapLibreMap.prototype) as {
      _camera?: unknown;
      transform?: Record<string, unknown>;
    };
    map._camera = { transform };

    assert.equal(map.transform?._nearZ, 3);
    assert.equal(map.transform?._farZ, 4000);

    // Live getters, not a one-time copy: deck.gl reads them every frame.
    transform.nearZ = 7;
    assert.equal(map.transform?._nearZ, 7);
  });

  it("leaves a transform that already spells them itself alone", () => {
    installMapTransformCompat();

    const transform = { height: 720, _nearZ: 1, nearZ: 99 };
    const map = Object.create(MapLibreMap.prototype) as {
      _camera?: unknown;
      transform?: typeof transform;
    };
    map._camera = { transform };

    assert.equal(map.transform?._nearZ, 1);
  });

  it("returns undefined rather than throwing when there is no camera yet", () => {
    installMapTransformCompat();

    const map = Object.create(MapLibreMap.prototype) as { transform?: unknown };
    assert.equal(map.transform, undefined);
  });

  it("reads a 6.19 camera's live projectedCamera when it has no transform", () => {
    installMapTransformCompat();

    let projectedCamera: Record<string, number> = {
      height: 720,
      elevation: 12,
      nearZ: 3,
      farZ: 4000,
    };
    const camera = {
      get projectedCamera() {
        return projectedCamera;
      },
    };
    const map = Object.create(MapLibreMap.prototype) as {
      _camera?: unknown;
      transform?: Record<string, unknown>;
    };
    map._camera = camera;

    const transform = map.transform!;
    assert.equal(transform.height, 720);
    assert.equal(transform.elevation, 12);
    assert.equal(transform._nearZ, 3);
    assert.equal(transform._farZ, 4000);
    assert.equal(typeof transform.elevation, "number");
    assert.ok("height" in transform);

    // deck.gl reads it every frame: the next frame's camera, not a copy.
    projectedCamera = { height: 480, elevation: 0, nearZ: 5, farZ: 900 };
    assert.equal(map.transform, transform, "one view per camera");
    assert.equal(transform.height, 480);
    assert.equal(transform._nearZ, 5);
  });

  it("is idempotent and reports that it did nothing the second time", () => {
    installMapTransformCompat();
    assert.equal(installMapTransformCompat(), false, "Map#transform should already be defined");
  });
});

describe("cameraAltitudeFromProjectedCamera", () => {
  const mercator = {
    projection: "mercator",
    pitchInRadians: Math.PI / 3,
    cameraToCenterDistance: 1000,
    pixelsPerMeter: 0.5,
    elevation: 100,
  };

  it("lifts the center elevation by the camera distance on Mercator", () => {
    // cos(60°) * 1000 px / 0.5 px/m + 100 m
    assert.ok(Math.abs(cameraAltitudeFromProjectedCamera(mercator)! - 1100) < 1e-9);
  });

  it("measures from the unit sphere in the vertical perspective", () => {
    const altitude = cameraAltitudeFromProjectedCamera({
      projection: "vertical-perspective",
      cameraPosition: [0, 0, 1.5],
    });
    assert.ok(Math.abs(altitude! - 0.5 * 6371008.8) < 1e-6);
  });

  it("uses whichever camera a globe draws with", () => {
    const verticalPerspective = { projection: "vertical-perspective", cameraPosition: [2, 0, 0] };
    const globe = { projection: "globe", mercator, verticalPerspective };
    assert.ok(
      Math.abs(cameraAltitudeFromProjectedCamera({ ...globe, globeness: 0 })! - 1100) < 1e-9,
    );
    assert.ok(
      Math.abs(cameraAltitudeFromProjectedCamera({ ...globe, globeness: 1 })! - 6371008.8) < 1e-6,
    );
  });

  it("matches the installed MapLibre's own camera altitude", () => {
    for (const [projection, transition, zoom, pitch] of [
      ["mercator", 0, 12, 50],
      ["globe", 1, 2, 30],
      ["globe", 0, 14, 60],
    ] as const) {
      const context = createCameraContext({ projection, projectionTransition: transition });
      let view = resize(createCameraViewState(), context, 1000, 600);
      view = setCenter(view, context, new LngLat(10, 45));
      view = setZoom(view, context, zoom);
      view = setPitch(view, pitch);
      const camera = projectCamera(view, context);
      const expected = getCameraMath(camera).getCameraAltitude(camera);
      const actual = cameraAltitudeFromProjectedCamera(camera as never);
      assert.ok(actual !== null, `${projection} z${zoom}: no altitude`);
      assert.ok(
        Math.abs(actual - expected) <= 1e-6 * Math.max(1, Math.abs(expected)),
        `${projection} z${zoom}: ${actual} vs MapLibre's ${expected}`,
      );
    }
  });

  it("returns null for a shape it cannot read", () => {
    assert.equal(cameraAltitudeFromProjectedCamera(undefined), null);
    assert.equal(cameraAltitudeFromProjectedCamera({ projection: "mercator" }), null);
    assert.equal(cameraAltitudeFromProjectedCamera({ projection: "something-new" }), null);
  });
});
