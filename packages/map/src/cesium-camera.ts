import type { MapViewState } from "@geolibre/core";
import type { Viewer } from "cesium";

// Camera conversion between MapLibre's `MapViewState` (Web-Mercator zoom + a
// nadir-referenced pitch) and Cesium's camera (a metric range + a
// horizon-referenced pitch). Keeping the math in pure, Cesium-free functions
// makes it unit-testable (see the M5 test plan) and keeps the type-only Cesium
// import erased at runtime so this module never pulls the engine into the graph.

/** WGS84 semi-major axis (m) — matches Cesium's default ellipsoid. */
const EARTH_RADIUS = 6378137;
const EARTH_CIRCUMFERENCE = 2 * Math.PI * EARTH_RADIUS;
/** MapLibre tile size in px; a zoom level spans `TILE_SIZE * 2**zoom` px. */
const TILE_SIZE = 512;
/** Cesium's default perspective vertical FOV, used when the frustum has none. */
const DEFAULT_FOVY = Math.PI / 3;
/** MapLibre never tilts past 85°; clamp so a synced globe stays in range. */
const MAX_PITCH = 85;
/** Web Mercator is undefined past ~85.05°; clamp latitude in the scale math. */
const MAX_MERCATOR_LAT = 85.051129;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Ground resolution (metres per screen pixel) at a MapLibre `zoom` and
 * latitude. This is the Web-Mercator definition and is independent of any
 * field-of-view, so it is the stable quantity to match across the two engines.
 */
export function groundResolution(zoom: number, latDeg: number): number {
  const latRad =
    (clamp(latDeg, -MAX_MERCATOR_LAT, MAX_MERCATOR_LAT) * Math.PI) / 180;
  return (Math.cos(latRad) * EARTH_CIRCUMFERENCE) / (TILE_SIZE * 2 ** zoom);
}

/**
 * Camera-to-target distance (metres) that makes a Cesium view — over a canvas
 * `heightPx` tall with vertical field of view `fovy` — show the same vertical
 * ground extent as a MapLibre pane at `zoom`. Matching the extent this way keeps
 * the on-screen scale in step even when the two panes differ in pixel height.
 */
export function zoomToRange(
  zoom: number,
  latDeg: number,
  heightPx: number,
  fovy: number,
): number {
  const extent = groundResolution(zoom, latDeg) * heightPx;
  return extent / (2 * Math.tan(fovy / 2));
}

/** Inverse of {@link zoomToRange}: recover the MapLibre zoom from a range. */
export function rangeToZoom(
  range: number,
  latDeg: number,
  heightPx: number,
  fovy: number,
): number {
  const extent = 2 * range * Math.tan(fovy / 2);
  const gr = extent / heightPx;
  const latRad =
    (clamp(latDeg, -MAX_MERCATOR_LAT, MAX_MERCATOR_LAT) * Math.PI) / 180;
  return Math.log2(
    (Math.cos(latRad) * EARTH_CIRCUMFERENCE) / (TILE_SIZE * gr),
  );
}

/** MapLibre pitch (0 = nadir) → Cesium pitch (−90° = nadir), in degrees. */
export function mapLibrePitchToCesiumDeg(pitchDeg: number): number {
  return clamp(pitchDeg, 0, MAX_PITCH) - 90;
}

/** Cesium pitch (degrees, ≤ 0 looking down) → MapLibre pitch (0 = nadir). */
export function cesiumPitchToMapLibreDeg(pitchDeg: number): number {
  return clamp(pitchDeg + 90, 0, MAX_PITCH);
}

/** Normalise a heading in degrees to MapLibre's [−180, 180] bearing range. */
export function normalizeBearing(deg: number): number {
  let bearing = deg % 360;
  if (bearing > 180) bearing -= 360;
  if (bearing < -180) bearing += 360;
  return bearing;
}

/** The vertical field of view of a viewer's camera, with a safe fallback. */
function cameraFovy(viewer: Viewer): number {
  const frustum = viewer.camera.frustum as { fovy?: number };
  return frustum.fovy && frustum.fovy > 0 ? frustum.fovy : DEFAULT_FOVY;
}

/** The viewer canvas height in CSS pixels, guarding against a 0 during layout. */
function canvasHeight(viewer: Viewer): number {
  const canvas = viewer.scene.canvas;
  return canvas.clientHeight || canvas.height || 1;
}

/**
 * Point a viewer's camera at the map center described by `view`, matching
 * MapLibre's scale, bearing, and pitch. Requires the Cesium namespace so this
 * module stays free of a runtime Cesium import.
 */
export function applyMapViewToCamera(
  Cesium: typeof import("cesium"),
  viewer: Viewer,
  view: MapViewState,
): void {
  const [lng, lat] = view.center;
  const range = Math.max(
    zoomToRange(view.zoom, lat, canvasHeight(viewer), cameraFovy(viewer)),
    1,
  );
  const heading = Cesium.Math.toRadians(normalizeBearing(view.bearing));
  const pitch = Cesium.Math.toRadians(mapLibrePitchToCesiumDeg(view.pitch));
  const target = Cesium.Cartesian3.fromDegrees(lng, lat);
  // lookAt orients the camera in the target's local frame; resetting the
  // transform to identity hands control back for free user navigation.
  viewer.camera.lookAt(
    target,
    new Cesium.HeadingPitchRange(heading, pitch, range),
  );
  viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
}

/**
 * Read a viewer's camera back into a `MapViewState`. The center is the ground
 * point under the screen center (so a tilted camera reports the map center, not
 * the camera's sub-point); when the horizon is in view (the globe's edge shows)
 * it falls back to the camera's sub-point.
 */
export function readMapViewFromCamera(
  Cesium: typeof import("cesium"),
  viewer: Viewer,
): MapViewState {
  const { scene, camera } = viewer;
  const canvas = scene.canvas;
  const width = canvas.clientWidth || canvas.width || 1;
  const height = canvas.clientHeight || canvas.height || 1;
  const ellipsoid = scene.globe?.ellipsoid ?? Cesium.Ellipsoid.WGS84;

  const centerPx = new Cesium.Cartesian2(width / 2, height / 2);
  const groundPoint = camera.pickEllipsoid(centerPx, ellipsoid);

  let lng: number;
  let lat: number;
  let range: number;
  if (groundPoint) {
    const carto = Cesium.Cartographic.fromCartesian(
      groundPoint,
      ellipsoid,
    );
    lng = Cesium.Math.toDegrees(carto.longitude);
    lat = Cesium.Math.toDegrees(carto.latitude);
    range = Cesium.Cartesian3.distance(camera.positionWC, groundPoint);
  } else {
    const carto = camera.positionCartographic;
    lng = Cesium.Math.toDegrees(carto.longitude);
    lat = Cesium.Math.toDegrees(carto.latitude);
    range = carto.height;
  }

  const zoom = clamp(
    rangeToZoom(range, lat, height, cameraFovy(viewer)),
    0,
    24,
  );
  return {
    center: [lng, lat],
    zoom,
    bearing: normalizeBearing(Cesium.Math.toDegrees(camera.heading)),
    pitch: cesiumPitchToMapLibreDeg(Cesium.Math.toDegrees(camera.pitch)),
  };
}

/**
 * True when two views are close enough to treat as the same camera. Used to
 * suppress the echo: applying a view programmatically fires Cesium's `moveEnd`,
 * and a round-trip through the conversion never returns bit-identical values, so
 * an exact check would feed a jitter loop back into the shared store camera.
 */
export function isSameView(a: MapViewState, b: MapViewState): boolean {
  return (
    // Wrap the longitude delta so a pair straddling the antimeridian (e.g.
    // 179.9999 vs -179.9999) compares by true angular distance, not ~360.
    Math.abs(normalizeBearing(a.center[0] - b.center[0])) < 1e-5 &&
    Math.abs(a.center[1] - b.center[1]) < 1e-5 &&
    Math.abs(a.zoom - b.zoom) < 0.02 &&
    Math.abs(normalizeBearing(a.bearing - b.bearing)) < 0.1 &&
    Math.abs(a.pitch - b.pitch) < 0.1
  );
}
