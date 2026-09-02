import type { MapViewState } from "@geolibre/core";
import type { CesiumWidget } from "@cesium/engine";

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
  const latRad = (clamp(latDeg, -MAX_MERCATOR_LAT, MAX_MERCATOR_LAT) * Math.PI) / 180;
  return (Math.cos(latRad) * EARTH_CIRCUMFERENCE) / (TILE_SIZE * 2 ** zoom);
}

/**
 * Camera-to-target distance (metres) that makes a Cesium view — over a canvas
 * `heightPx` tall with vertical field of view `fovy` — show the same vertical
 * ground extent as a MapLibre pane at `zoom`. Matching the extent this way keeps
 * the on-screen scale in step even when the two panes differ in pixel height.
 */
export function zoomToRange(zoom: number, latDeg: number, heightPx: number, fovy: number): number {
  const extent = groundResolution(zoom, latDeg) * heightPx;
  return extent / (2 * Math.tan(fovy / 2));
}

/** Inverse of {@link zoomToRange}: recover the MapLibre zoom from a range. */
export function rangeToZoom(range: number, latDeg: number, heightPx: number, fovy: number): number {
  const extent = 2 * range * Math.tan(fovy / 2);
  const gr = extent / heightPx;
  const latRad = (clamp(latDeg, -MAX_MERCATOR_LAT, MAX_MERCATOR_LAT) * Math.PI) / 180;
  return Math.log2((Math.cos(latRad) * EARTH_CIRCUMFERENCE) / (TILE_SIZE * gr));
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
function cameraFovy(viewer: CesiumWidget): number {
  const frustum = viewer.camera.frustum as { fovy?: number };
  return frustum.fovy && frustum.fovy > 0 ? frustum.fovy : DEFAULT_FOVY;
}

/** The viewer canvas height in CSS pixels, guarding against a 0 during layout. */
function canvasHeight(viewer: CesiumWidget): number {
  const canvas = viewer.scene.canvas;
  return canvas.clientHeight || canvas.height || 1;
}

/**
 * Height (metres) of the rendered ground at a position — the terrain surface
 * when terrain is on and its tiles have loaded, otherwise 0 (the ellipsoid).
 *
 * This is what makes the scale match on a terrain globe. Zoom is encoded as the
 * camera's distance from the ground, so measuring that distance to the
 * *ellipsoid* while the ground is 600 m higher puts the camera 600 m closer to
 * what the user actually sees than intended. The error is the ratio
 * `range / (range - groundHeight)`: invisible when the camera is far out, and
 * runaway as `range` approaches the terrain height — over Las Vegas (~640 m) it
 * passes 2× at around zoom 15.
 *
 * `Globe.getHeight` reads already-loaded tiles and is synchronous, so this stays
 * cheap enough for the camera path; it returns undefined until the tiles for the
 * area arrive, which is why {@link CesiumCanvas} re-applies once terrain settles.
 */
export function groundHeightAt(
  Cesium: typeof import("@cesium/engine"),
  viewer: CesiumWidget,
  lngDeg: number,
  latDeg: number,
): number {
  const globe = viewer.scene.globe;
  if (!globe) return 0;
  const height = globe.getHeight(Cesium.Cartographic.fromDegrees(lngDeg, latDeg));
  return typeof height === "number" && Number.isFinite(height) ? height : 0;
}

/**
 * The point on the globe under a screen position: the terrain surface when
 * terrain is loaded, else the ellipsoid, else undefined when the ray misses the
 * globe entirely (the horizon is in view). Mirrors {@link groundHeightAt} on the
 * readback side so a view survives the apply → read round trip unchanged.
 */
function pickGlobe(
  Cesium: typeof import("@cesium/engine"),
  viewer: CesiumWidget,
  position: { x: number; y: number },
) {
  const { scene, camera } = viewer;
  const ray = camera.getPickRay(position as Parameters<typeof camera.getPickRay>[0]);
  const onTerrain = ray && scene.globe ? scene.globe.pick(ray, scene) : undefined;
  if (onTerrain) return onTerrain;
  return camera.pickEllipsoid(
    position as Parameters<typeof camera.pickEllipsoid>[0],
    scene.globe?.ellipsoid ?? Cesium.Ellipsoid.WGS84,
  );
}

/**
 * Point a viewer's camera at the map center described by `view`, matching
 * MapLibre's scale, bearing, and pitch. Requires the Cesium namespace so this
 * module stays free of a runtime Cesium import.
 */
export function applyMapViewToCamera(
  Cesium: typeof import("@cesium/engine"),
  viewer: CesiumWidget,
  view: MapViewState,
): void {
  const [lng, lat] = view.center;
  const range = Math.max(zoomToRange(view.zoom, lat, canvasHeight(viewer), cameraFovy(viewer)), 1);
  const heading = Cesium.Math.toRadians(normalizeBearing(view.bearing));
  const pitch = Cesium.Math.toRadians(mapLibrePitchToCesiumDeg(view.pitch));
  // Aim at the ground, not the ellipsoid beneath it: `range` is the distance
  // that encodes MapLibre's zoom, so on a terrain globe the target has to sit on
  // the terrain or the pane renders far more zoomed in than its 2D twin.
  const target = Cesium.Cartesian3.fromDegrees(lng, lat, groundHeightAt(Cesium, viewer, lng, lat));
  // lookAt orients the camera in the target's local frame; resetting the
  // transform to identity hands control back for free user navigation.
  viewer.camera.lookAt(target, new Cesium.HeadingPitchRange(heading, pitch, range));
  viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
}

/**
 * Read a viewer's camera back into a `MapViewState`. The center is the ground
 * point under the screen center (so a tilted camera reports the map center, not
 * the camera's sub-point); when the horizon is in view (the globe's edge shows)
 * it falls back to the camera's sub-point.
 */
export function readMapViewFromCamera(
  Cesium: typeof import("@cesium/engine"),
  viewer: CesiumWidget,
): MapViewState {
  const { scene, camera } = viewer;
  const canvas = scene.canvas;
  const width = canvas.clientWidth || canvas.width || 1;
  const height = canvas.clientHeight || canvas.height || 1;
  const ellipsoid = scene.globe?.ellipsoid ?? Cesium.Ellipsoid.WGS84;

  const centerPx = new Cesium.Cartesian2(width / 2, height / 2);
  // Pick the terrain, not the ellipsoid, so the range read back is the same
  // ground distance applyMapViewToCamera set — otherwise a terrain globe reads
  // back a zoom that disagrees with the one just applied and the panes drift.
  const groundPoint = pickGlobe(Cesium, viewer, centerPx);

  let lng: number;
  let lat: number;
  let range: number;
  if (groundPoint) {
    const carto = Cesium.Cartographic.fromCartesian(groundPoint, ellipsoid);
    lng = Cesium.Math.toDegrees(carto.longitude);
    lat = Cesium.Math.toDegrees(carto.latitude);
    range = Cesium.Cartesian3.distance(camera.positionWC, groundPoint);
  } else {
    // Horizon in view. The camera is thousands of kilometres out here, so the
    // ellipsoid height is close enough and terrain is not worth sampling.
    const carto = camera.positionCartographic;
    lng = Cesium.Math.toDegrees(carto.longitude);
    lat = Cesium.Math.toDegrees(carto.latitude);
    range = carto.height;
  }

  const zoom = clamp(rangeToZoom(range, lat, height, cameraFovy(viewer)), 0, 24);
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
