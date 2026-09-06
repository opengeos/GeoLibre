import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MapViewState } from "../packages/core/src/types";
import {
  applyMapViewToCamera,
  cesiumPitchToMapLibreDeg,
  groundHeightAt,
  groundResolution,
  isSameView,
  mapLibrePitchToCesiumDeg,
  normalizeBearing,
  orthoWidthToZoom,
  rangeToZoom,
  readMapViewFromCamera,
  zoomToOrthoWidth,
  zoomToRange,
  zoomToSceneRange,
} from "../packages/map/src/cesium-camera";

// The pure camera math that keeps the Cesium 3D-globe view in step with the 2D
// MapLibre panes. These functions run without loading Cesium (its import is
// type-only), so they can be exercised directly.

const FOVY = Math.PI / 3; // Cesium's default vertical field of view.
const HEIGHT = 800; // a representative canvas height in px.
const WIDTH = 600; // and its width, which the 2D (orthographic) math reads.
const EARTH_CIRCUMFERENCE = 2 * Math.PI * 6378137;

describe("groundResolution", () => {
  it("matches the Web Mercator metres-per-pixel at the equator", () => {
    // Zoom 0 spans the world in one 512 px tile: circumference / 512.
    const expected = EARTH_CIRCUMFERENCE / 512;
    assert.ok(Math.abs(groundResolution(0, 0) - expected) < 1e-6);
  });

  it("halves for each zoom level", () => {
    assert.ok(Math.abs(groundResolution(1, 0) - groundResolution(0, 0) / 2) < 1e-6);
    assert.ok(Math.abs(groundResolution(5, 0) - groundResolution(4, 0) / 2) < 1e-6);
  });

  it("shrinks with latitude by cos(lat)", () => {
    const atEquator = groundResolution(4, 0);
    const at60 = groundResolution(4, 60);
    assert.ok(Math.abs(at60 - atEquator * Math.cos((60 * Math.PI) / 180)) < 1e-6);
  });

  it("clamps beyond the Mercator limit rather than returning 0 or NaN", () => {
    const r = groundResolution(4, 89);
    assert.ok(Number.isFinite(r) && r > 0);
  });
});

describe("zoomToRange / rangeToZoom", () => {
  it("round-trips zoom through range within tight tolerance", () => {
    for (const zoom of [0, 2, 4.5, 7, 10, 14, 18]) {
      for (const lat of [0, 23.5, 45, -60]) {
        const range = zoomToRange(zoom, lat, HEIGHT, FOVY);
        const back = rangeToZoom(range, lat, HEIGHT, FOVY);
        assert.ok(
          Math.abs(back - zoom) < 1e-9,
          `zoom ${zoom} @ lat ${lat} round-tripped to ${back}`,
        );
      }
    }
  });

  it("gives a larger range for a lower zoom (further out)", () => {
    assert.ok(zoomToRange(2, 0, HEIGHT, FOVY) > zoomToRange(8, 0, HEIGHT, FOVY));
  });

  it("keeps ground scale constant across canvas heights", () => {
    // A taller canvas needs a proportionally larger range to hold the same
    // metres-per-pixel, so range / height is invariant.
    const short = zoomToRange(10, 30, 400, FOVY) / 400;
    const tall = zoomToRange(10, 30, 1200, FOVY) / 1200;
    assert.ok(Math.abs(short - tall) < 1e-6);
  });
});

describe("pitch conversion", () => {
  it("maps MapLibre nadir (0) to Cesium nadir (-90)", () => {
    assert.equal(mapLibrePitchToCesiumDeg(0), -90);
    assert.equal(cesiumPitchToMapLibreDeg(-90), 0);
  });

  it("round-trips a tilted pitch", () => {
    assert.equal(mapLibrePitchToCesiumDeg(60), -30);
    assert.equal(cesiumPitchToMapLibreDeg(-30), 60);
  });

  it("clamps to MapLibre's 0..85 range", () => {
    assert.equal(mapLibrePitchToCesiumDeg(120), 85 - 90);
    assert.equal(cesiumPitchToMapLibreDeg(45), 85); // 45 + 90 clamps to 85
    assert.equal(cesiumPitchToMapLibreDeg(-200), 0);
  });
});

describe("normalizeBearing", () => {
  it("keeps in-range bearings untouched", () => {
    assert.equal(normalizeBearing(0), 0);
    assert.equal(normalizeBearing(45), 45);
    assert.equal(normalizeBearing(-120), -120);
  });

  it("wraps to [-180, 180]", () => {
    assert.equal(normalizeBearing(190), -170);
    assert.equal(normalizeBearing(-190), 170);
    assert.equal(normalizeBearing(360), 0);
    assert.equal(normalizeBearing(540), 180);
  });
});

describe("isSameView", () => {
  const base: MapViewState = {
    center: [-100, 40],
    zoom: 5,
    bearing: 0,
    pitch: 0,
  };

  it("treats a tiny rounding drift as the same view (echo suppression)", () => {
    const echo: MapViewState = {
      center: [-100.000005, 40.000004],
      zoom: 5.005,
      bearing: 0.05,
      pitch: 0.02,
    };
    assert.equal(isSameView(base, echo), true);
  });

  it("treats a real move as a different view", () => {
    assert.equal(isSameView(base, { ...base, zoom: 6 }), false);
    assert.equal(isSameView(base, { ...base, center: [-100.5, 40] }), false);
  });

  it("handles bearing wraparound near 0/360", () => {
    assert.equal(isSameView({ ...base, bearing: 359.95 }, { ...base, bearing: 0.02 }), true);
    assert.equal(isSameView({ ...base, bearing: 355 }, { ...base, bearing: 5 }), false);
  });

  it("handles longitude wraparound across the antimeridian", () => {
    // Two points ~2e-6° apart straddling ±180°: same view despite a ~360 raw diff.
    assert.equal(
      isSameView({ ...base, center: [179.999999, 40] }, { ...base, center: [-179.999999, 40] }),
      true,
    );
    // A genuine move near the antimeridian is still a different view.
    assert.equal(
      isSameView({ ...base, center: [179.9, 40] }, { ...base, center: [-179.9, 40] }),
      false,
    );
  });
});

// --- terrain-aware camera placement -----------------------------------------
// Zoom is encoded as the camera's distance from the ground, so on a terrain
// globe the look-at target has to sit on the terrain. Aiming at the ellipsoid
// under 640 m of Las Vegas put the camera 640 m closer to the surface than the
// zoom asked for — a >2x scale mismatch against the 2D pane at zoom 15.

/** Cesium's own `SceneMode` numbering, which the camera math branches on. */
const SCENE_MODE = { MORPHING: 0, COLUMBUS_VIEW: 1, SCENE2D: 2, SCENE3D: 3 };

/** A fake Cesium namespace + viewer recording what the camera was told to do. */
function makeCameraFakes(terrainHeight: number | undefined, mode = SCENE_MODE.SCENE3D) {
  const calls = {
    target: null as { lng: number; lat: number; height?: number } | null,
    range: 0,
    heading: 0,
    pitch: 0,
  };

  const viewer = {
    scene: {
      mode,
      canvas: { clientWidth: WIDTH, clientHeight: HEIGHT, width: WIDTH, height: HEIGHT },
      globe: {
        // Cesium returns undefined until the tiles for the position have loaded.
        getHeight: () => terrainHeight,
      },
    },
    camera: {
      frustum: { fovy: FOVY },
      lookAt: (_target: unknown, hpr: { heading: number; pitch: number; range: number }) => {
        calls.range = hpr.range;
        calls.heading = hpr.heading;
        calls.pitch = hpr.pitch;
      },
      lookAtTransform: () => {},
    },
  };

  const Cesium = {
    Math: { toRadians: (d: number) => (d * Math.PI) / 180, toDegrees: (r: number) => r },
    Cartesian3: {
      fromDegrees: (lng: number, lat: number, height?: number) => {
        calls.target = { lng, lat, height };
        return { lng, lat, height };
      },
    },
    Cartographic: { fromDegrees: (lng: number, lat: number) => ({ lng, lat }) },
    HeadingPitchRange: class {
      constructor(
        public heading: number,
        public pitch: number,
        public range: number,
      ) {}
    },
    Matrix4: { IDENTITY: {} },
    SceneMode: SCENE_MODE,
  };

  return {
    calls,
    viewer: viewer as unknown as Parameters<typeof applyMapViewToCamera>[1],
    Cesium: Cesium as unknown as Parameters<typeof applyMapViewToCamera>[0],
  };
}

const LAS_VEGAS: MapViewState = {
  center: [-115.2037, 36.1207],
  zoom: 14.86,
  bearing: 0,
  pitch: 0,
};

describe("groundHeightAt", () => {
  it("reports the loaded terrain height", () => {
    const { Cesium, viewer } = makeCameraFakes(640);
    assert.equal(groundHeightAt(Cesium, viewer, -115.2, 36.12), 640);
  });

  it("falls back to the ellipsoid before the terrain tiles load", () => {
    // Globe.getHeight returns undefined for a position with no loaded tile.
    const { Cesium, viewer } = makeCameraFakes(undefined);
    assert.equal(groundHeightAt(Cesium, viewer, -115.2, 36.12), 0);
  });

  it("falls back to the ellipsoid when the scene has no globe", () => {
    const { Cesium, viewer } = makeCameraFakes(0);
    const noGlobe = { ...viewer, scene: { ...viewer.scene, globe: undefined } };
    assert.equal(groundHeightAt(Cesium, noGlobe as unknown as typeof viewer, -115.2, 36.12), 0);
  });
});

describe("applyMapViewToCamera on terrain", () => {
  it("aims at the terrain surface, not the ellipsoid beneath it", () => {
    const { Cesium, viewer, calls } = makeCameraFakes(640);
    applyMapViewToCamera(Cesium, viewer, LAS_VEGAS);
    assert.equal(calls.target?.height, 640);
  });

  it("keeps the range the zoom asks for regardless of terrain height", () => {
    // The range is the distance from the target; raising the target is what
    // keeps the camera that far above the *ground* rather than the ellipsoid.
    const flat = makeCameraFakes(0);
    applyMapViewToCamera(flat.Cesium, flat.viewer, LAS_VEGAS);
    const high = makeCameraFakes(640);
    applyMapViewToCamera(high.Cesium, high.viewer, LAS_VEGAS);

    assert.equal(high.calls.range, flat.calls.range);
    assert.equal(high.calls.range, zoomToRange(LAS_VEGAS.zoom, LAS_VEGAS.center[1], HEIGHT, FOVY));
  });

  it("targets height 0 when terrain has not loaded yet", () => {
    const { Cesium, viewer, calls } = makeCameraFakes(undefined);
    applyMapViewToCamera(Cesium, viewer, LAS_VEGAS);
    assert.equal(calls.target?.height, 0);
  });
});

// --- scene modes ------------------------------------------------------------
// Cesium's scene-mode picker (the globe's 2D/3D/Columbus button) swaps the
// frustum out from under the camera, and with it the meaning of every number
// the camera sync exchanges with the store. 2D is the sharp edge: the camera
// stops having a usable distance at all — Cesium parks it at a fixed altitude
// and expresses the view through the width of an orthographic box — so the
// distance-based conversion above silently reports a constant zoom there.

describe("zoomToOrthoWidth / orthoWidthToZoom", () => {
  it("spans the whole world across the canvas at zoom 0", () => {
    // MapLibre's definition: at zoom 0 the world is TILE_SIZE (512) px wide, so
    // a 512 px canvas shows exactly one circumference.
    assert.ok(Math.abs(zoomToOrthoWidth(0, 512) - EARTH_CIRCUMFERENCE) < 1e-6);
  });

  it("halves the extent for each zoom level", () => {
    assert.ok(Math.abs(zoomToOrthoWidth(5, WIDTH) - zoomToOrthoWidth(4, WIDTH) / 2) < 1e-6);
  });

  it("is latitude-independent, unlike the 3D conversion", () => {
    // The projected plane is what MapLibre's zoom is defined on; the cos(lat)
    // correction belongs to ground distance, which 2D never measures.
    assert.equal(zoomToOrthoWidth(8, WIDTH), zoomToOrthoWidth(8, WIDTH));
    assert.notEqual(zoomToRange(8, 0, HEIGHT, FOVY), zoomToRange(8, 60, HEIGHT, FOVY));
  });

  it("round-trips zoom through the ortho width", () => {
    for (const zoom of [0, 3.5, 7, 12, 18]) {
      const back = orthoWidthToZoom(zoomToOrthoWidth(zoom, WIDTH), WIDTH);
      assert.ok(Math.abs(back - zoom) < 1e-9, `zoom ${zoom} round-tripped to ${back}`);
    }
  });
});

describe("zoomToSceneRange", () => {
  const view: MapViewState = { center: [0, 45], zoom: 8, bearing: 0, pitch: 0 };

  it("is the perspective camera distance on the 3D globe", () => {
    const { Cesium, viewer } = makeCameraFakes(0, SCENE_MODE.SCENE3D);
    assert.equal(zoomToSceneRange(Cesium, viewer, view), zoomToRange(8, 45, HEIGHT, FOVY));
  });

  it("is the orthographic box width in 2D", () => {
    // The whole point: the same stored zoom must resolve to a different number
    // here, because Cesium reinterprets `range` as a width once the frustum is
    // orthographic. Feeding it the 3D distance would render at the wrong scale.
    const { Cesium, viewer } = makeCameraFakes(0, SCENE_MODE.SCENE2D);
    assert.equal(zoomToSceneRange(Cesium, viewer, view), zoomToOrthoWidth(8, WIDTH));
  });

  it("treats Columbus view like 3D — it keeps the perspective frustum", () => {
    const { Cesium, viewer } = makeCameraFakes(0, SCENE_MODE.COLUMBUS_VIEW);
    assert.equal(zoomToSceneRange(Cesium, viewer, view), zoomToRange(8, 45, HEIGHT, FOVY));
  });

  it("never returns a range below 1 metre", () => {
    // A degenerate canvas (0 px during layout) or an extreme zoom would
    // otherwise hand Cesium a zero distance and put the camera in the ground.
    const { Cesium, viewer } = makeCameraFakes(0, SCENE_MODE.SCENE2D);
    const absurd: MapViewState = { ...view, zoom: 40 };
    assert.ok(zoomToSceneRange(Cesium, viewer, absurd) >= 1);
  });
});

/**
 * A fake viewer for the *readback* direction, parameterised by scene mode.
 *
 * `makeCameraFakes` above only records what the camera was told; this one
 * answers the questions `readMapViewFromCamera` asks — the frustum, the camera's
 * cartographic position, and the globe pick under the screen centre.
 */
function makeReadbackFakes(options: {
  mode: number;
  /** Camera altitude, and in 2D the width of the orthographic box. */
  height: number;
  /** Cesium pitch in radians (−π/2 is nadir). */
  pitch?: number;
  lng?: number;
  lat?: number;
}) {
  const { mode, height, pitch = -Math.PI / 2, lng = 0, lat = 0 } = options;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const viewer = {
    scene: {
      mode,
      canvas: { clientWidth: WIDTH, clientHeight: HEIGHT, width: WIDTH, height: HEIGHT },
      globe: {
        ellipsoid: { name: "wgs84" },
        // The ground under the screen centre, at height 0.
        pick: () => ({ x: lng, y: lat, z: 0 }),
      },
    },
    camera: {
      frustum:
        mode === SCENE_MODE.SCENE2D ? { left: -height / 2, right: height / 2 } : { fovy: FOVY },
      positionWC: { x: lng, y: lat, z: height },
      positionCartographic: { longitude: toRad(lng), latitude: toRad(lat), height },
      heading: 0,
      pitch,
      getPickRay: () => ({ ray: true }),
      pickEllipsoid: () => ({ x: lng, y: lat, z: 0 }),
    },
  };
  const Cesium = {
    Math: { toRadians: toRad, toDegrees: (rad: number) => (rad * 180) / Math.PI },
    Cartesian2: class {
      constructor(
        public x: number,
        public y: number,
      ) {}
    },
    Cartesian3: {
      distance: (a: { z: number }, b: { z: number }) => Math.abs(a.z - b.z),
    },
    Cartographic: {
      fromCartesian: (c: { x: number; y: number; z: number }) => ({
        longitude: toRad(c.x),
        latitude: toRad(c.y),
        height: c.z,
      }),
    },
    Ellipsoid: { WGS84: { name: "wgs84" } },
    SceneMode: SCENE_MODE,
  };
  return {
    viewer: viewer as unknown as Parameters<typeof readMapViewFromCamera>[1],
    Cesium: Cesium as unknown as Parameters<typeof readMapViewFromCamera>[0],
  };
}

describe("readMapViewFromCamera across scene modes", () => {
  it("reads the 2D zoom from the frustum width, not the camera distance", () => {
    // Cesium holds the 2D camera at a fixed ~12,700 km whatever the view, so a
    // distance-derived zoom would be pinned to one value; the frustum is the
    // only thing that actually changes.
    const width = zoomToOrthoWidth(9, WIDTH);
    const { Cesium, viewer } = makeReadbackFakes({ mode: SCENE_MODE.SCENE2D, height: width });
    const view = readMapViewFromCamera(Cesium, viewer);
    assert.ok(Math.abs(view.zoom - 9) < 1e-6, `read back zoom ${view.zoom}`);
  });

  it("round-trips a 2D view through apply and read", () => {
    const original: MapViewState = { center: [0, 0], zoom: 6, bearing: 0, pitch: 0 };
    const applied = makeCameraFakes(0, SCENE_MODE.SCENE2D);
    applyMapViewToCamera(applied.Cesium, applied.viewer, original);
    const { Cesium, viewer } = makeReadbackFakes({
      mode: SCENE_MODE.SCENE2D,
      height: applied.calls.range,
    });
    assert.ok(isSameView(readMapViewFromCamera(Cesium, viewer), original));
  });

  it("reports 2D as north-up and untilted", () => {
    // Cesium's default 2D map mode has no rotation, and `camera.heading` is
    // derived by treating the camera position as Earth-centred — true in 3D,
    // meaningless once the world is the flattened map.
    const { Cesium, viewer } = makeReadbackFakes({
      mode: SCENE_MODE.SCENE2D,
      height: zoomToOrthoWidth(6, WIDTH),
      pitch: -0.3,
    });
    const view = readMapViewFromCamera(Cesium, viewer);
    assert.equal(view.bearing, 0);
    assert.equal(view.pitch, 0);
  });

  it("derives the Columbus-view range from the camera's height and pitch", () => {
    // Looking straight down, the drop to the ground *is* the range — so this
    // must agree with what the same zoom would place in 3D.
    const range = zoomToRange(10, 0, HEIGHT, FOVY);
    const { Cesium, viewer } = makeReadbackFakes({
      mode: SCENE_MODE.COLUMBUS_VIEW,
      height: range,
      pitch: -Math.PI / 2,
    });
    assert.ok(Math.abs(readMapViewFromCamera(Cesium, viewer).zoom - 10) < 1e-6);
  });

  it("round-trips a Columbus-view zoom at high latitude", () => {
    // The latitude correction is the part of the 3D formula Columbus view
    // inherits, and 60°+ is where `cos(lat)` diverges most from 1 (#2270
    // review) — so if the apply and read sides disagreed about whether it
    // belongs, the drift would show here first and nowhere at the equator.
    for (const lat of [0, 60, -75]) {
      const applied = makeCameraFakes(0, SCENE_MODE.COLUMBUS_VIEW);
      const original: MapViewState = { center: [0, lat], zoom: 11, bearing: 0, pitch: 0 };
      applyMapViewToCamera(applied.Cesium, applied.viewer, original);
      const { Cesium, viewer } = makeReadbackFakes({
        mode: SCENE_MODE.COLUMBUS_VIEW,
        height: applied.calls.range,
        pitch: -Math.PI / 2,
        lat,
      });
      const back = readMapViewFromCamera(Cesium, viewer);
      assert.ok(Math.abs(back.zoom - 11) < 1e-6, `lat ${lat} round-tripped to ${back.zoom}`);
    }
  });

  it("falls back to the camera altitude near the horizon in Columbus view", () => {
    // Dividing by sin(pitch) blows up as the camera levels off, so below the
    // guard the altitude is used instead of a range several times too large.
    const height = zoomToRange(10, 0, HEIGHT, FOVY);
    const { Cesium, viewer } = makeReadbackFakes({
      mode: SCENE_MODE.COLUMBUS_VIEW,
      height,
      pitch: -0.01,
    });
    const view = readMapViewFromCamera(Cesium, viewer);
    assert.ok(Math.abs(view.zoom - 10) < 1e-6, `read back zoom ${view.zoom}`);
  });
});

describe("applyMapViewToCamera in 2D", () => {
  const rotated: MapViewState = { center: [0, 0], zoom: 6, bearing: 45, pitch: 60 };

  it("flattens the camera to north-up and nadir", () => {
    // The readback reports 2D as bearing 0 / pitch 0 because Cesium's heading
    // getter is meaningless there. Applying the stored bearing anyway would
    // leave a visibly rotated map under a status bar insisting it is north-up.
    const { Cesium, viewer, calls } = makeCameraFakes(0, SCENE_MODE.SCENE2D);
    applyMapViewToCamera(Cesium, viewer, rotated);
    assert.equal(calls.heading, 0);
    assert.equal(calls.pitch, mapLibrePitchToCesiumDeg(0) * (Math.PI / 180));
  });

  it("still carries bearing and pitch on the 3D globe", () => {
    const { Cesium, viewer, calls } = makeCameraFakes(0, SCENE_MODE.SCENE3D);
    applyMapViewToCamera(Cesium, viewer, rotated);
    assert.ok(Math.abs(calls.heading - (45 * Math.PI) / 180) < 1e-12);
    assert.ok(Math.abs(calls.pitch - (mapLibrePitchToCesiumDeg(60) * Math.PI) / 180) < 1e-12);
  });
});

// Flat Web Mercator scenes measure projected metres, not ground metres.
class WebMercatorProjection {}
function useMercator({ Cesium, viewer }: ReturnType<typeof makeCameraFakes>) {
  Object.assign(Cesium, { WebMercatorProjection });
  Object.assign(viewer.scene, { mapProjection: new WebMercatorProjection() });
}

describe("Web Mercator Columbus camera", () => {
  it("matches the projected map scale at high latitude", () => {
    const fakes = makeCameraFakes(0, SCENE_MODE.COLUMBUS_VIEW);
    useMercator(fakes);
    const view: MapViewState = { center: [12, 60], zoom: 2, bearing: 0, pitch: 0 };
    assert.equal(
      zoomToSceneRange(fakes.Cesium, fakes.viewer, view),
      zoomToRange(2, 0, HEIGHT, FOVY),
    );
  });

  it("reads projected scale without a latitude-dependent zoom jump", () => {
    const fakes = makeReadbackFakes({
      mode: SCENE_MODE.COLUMBUS_VIEW,
      height: zoomToRange(2, 0, HEIGHT, FOVY),
      lat: 60,
    });
    Object.assign(fakes.Cesium, { WebMercatorProjection });
    Object.assign(fakes.viewer.scene, { mapProjection: new WebMercatorProjection() });
    assert.ok(Math.abs(readMapViewFromCamera(fakes.Cesium, fakes.viewer).zoom - 2) < 1e-6);
  });
});
