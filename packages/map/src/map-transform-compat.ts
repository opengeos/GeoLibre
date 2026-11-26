import { Map as MapLibreMap } from "maplibre-gl";

/**
 * Re-expose `map.transform` for third-party code that still reads it.
 *
 * MapLibre v6 split `Camera` out of `Map`: the transform now lives at
 * `map._camera.transform` and `Map` has no `transform` of its own. GeoLibre's
 * own call sites were migrated to read through `_camera` (see
 * `resolveOccludableTransform` in `globe-popup-occlusion.ts` and
 * `readCameraAltitude` in `map-controller.ts`), but three packages we do not
 * control still reach for `map.transform` on the map object we hand them:
 *
 * - `@deck.gl/mapbox` — `getViewport()` reads `map.transform.height`,
 *   `_nearZ` and `_farZ` whenever MapLibre's render parameters do not carry
 *   near/far planes, and `getViewState()` reads `map.transform.elevation` on
 *   every deck render while terrain is on. With `transform` gone those throw
 *   `Cannot read properties of undefined` per frame and the deck.gl overlay
 *   stops drawing: the maplibre-gl-raster GPU engine, point clouds, 3D Tiles,
 *   the deck.gl-viz layers. Current as of 9.4.1.
 *
 * The prototype getter below hands them the camera's transform, which carries
 * every property they read. It is installed only when `Map` genuinely has no
 * `transform`, so it is inert on v5 and self-disabling if MapLibre restores it.
 *
 * MapLibre 6.19 removed the `Transform` classes too: the camera keeps its state
 * in a store and derives a read-only `projectedCamera` (`height`, `width`,
 * `elevation`, `nearZ`, `farZ`, the matrices) from it. When `_camera.transform`
 * is missing, the getter returns a view that reads each property from the
 * camera's current `projectedCamera`, so a reader always sees the frame being
 * drawn rather than a copy taken when it first asked.
 *
 * `_nearZ`/`_farZ` need the alias too: v6 renamed them to the public `nearZ`
 * and `farZ` getters. deck.gl treats a non-finite value as "unknown" and falls
 * back to its own near/far multipliers, so a missing alias would not crash, it
 * would quietly cost depth precision on pitched/terrain views. They are defined
 * on each transform instance the first time it is seen rather than by wrapping
 * it in a Proxy, because this sits on the per-frame render path.
 */

/** The slice of MapLibre's (internal) projected camera GeoLibre reads. */
export interface ProjectedCameraLike {
  projection?: string;
  elevation?: number;
  pitchInRadians?: number;
  cameraToCenterDistance?: number;
  pixelsPerMeter?: number;
  cameraPosition?: ArrayLike<number>;
  globeness?: number;
  mercator?: ProjectedCameraLike;
  verticalPerspective?: ProjectedCameraLike;
}

interface CameraLike {
  transform?: object;
  projectedCamera?: ProjectedCameraLike;
}

interface CameraHost {
  _camera?: CameraLike;
}

/** MapLibre's Earth radius in metres (`earthRadius` in `geo/lng_lat.ts`). */
const EARTH_RADIUS = 6371008.8;

const aliased = new WeakSet<object>();

/** Add the v5 `_nearZ`/`_farZ` spellings to a v6 transform, once per instance. */
function aliasNearFarZ(transform: object): object {
  if (aliased.has(transform)) return transform;
  aliased.add(transform);
  for (const [alias, source] of [
    ["_nearZ", "nearZ"],
    ["_farZ", "farZ"],
  ] as const) {
    if (alias in transform || !(source in transform)) continue;
    Object.defineProperty(transform, alias, {
      configurable: true,
      get(this: Record<string, unknown>) {
        return this[source];
      },
    });
  }
  return transform;
}

/**
 * Install the compatibility getter. Idempotent, and a no-op on any MapLibre
 * that still exposes `Map#transform`. Must run before the first `Map` is
 * constructed; `map-controller.ts` calls it at module load for that reason.
 */
export function installMapTransformCompat(): boolean {
  const prototype = MapLibreMap.prototype as object;
  if ("transform" in prototype) return false;

  Object.defineProperty(prototype, "transform", {
    configurable: true,
    get(this: CameraHost) {
      const camera = this._camera;
      if (!camera) return undefined;
      if (camera.transform) return aliasNearFarZ(camera.transform);
      return "projectedCamera" in camera ? projectedCameraView(camera) : undefined;
    },
  });
  return true;
}

const cameraViews = new WeakMap<CameraLike, object>();

/**
 * A stand-in transform for MapLibre 6.19+, one per camera, that reads every
 * property from the camera's current `projectedCamera`. `_nearZ`/`_farZ` map to
 * `nearZ`/`farZ` as on 6.18.
 *
 * Unlike the per-instance aliases above, this is a Proxy: `projectedCamera` is
 * a fresh object whenever the camera moves, so there is no stable instance to
 * define properties on. It stays cheap on the render path because deck.gl reads
 * at most four properties a frame and MapLibre memoizes the getter (its
 * rendered state and projected camera are cached per view state), so each read
 * is a lookup, not a recomputation.
 */
function projectedCameraView(camera: CameraLike): object {
  let view = cameraViews.get(camera);
  if (view) return view;
  const read = (property: string | symbol): unknown => {
    const projected = camera.projectedCamera as Record<string | symbol, unknown> | undefined;
    if (!projected) return undefined;
    if (property === "_nearZ") return projected.nearZ;
    if (property === "_farZ") return projected.farZ;
    return projected[property];
  };
  view = new Proxy(
    {},
    {
      get: (_target, property) => read(property),
      has: (_target, property) => read(property) !== undefined,
    },
  );
  cameraViews.set(camera, view);
  return view;
}

/**
 * The camera's height above sea level in metres from a MapLibre 6.19+
 * projected camera, mirroring the unexported `getCameraAltitude` of its camera
 * math: a globe uses whichever camera it currently draws with, the vertical
 * perspective measures from the unit sphere, and Mercator lifts the center
 * elevation by the camera distance. Returns `null` for a shape it cannot read.
 */
export function cameraAltitudeFromProjectedCamera(
  projectedCamera: ProjectedCameraLike | undefined,
): number | null {
  let camera = projectedCamera;
  if (camera?.projection === "globe") {
    camera = (camera.globeness ?? 0) > 0 ? camera.verticalPerspective : camera.mercator;
  }
  if (!camera) return null;
  if (camera.projection === "vertical-perspective") {
    const position = camera.cameraPosition;
    if (!position || position.length < 3) return null;
    const altitude = (Math.hypot(position[0], position[1], position[2]) - 1) * EARTH_RADIUS;
    return Number.isFinite(altitude) ? altitude : null;
  }
  if (camera.projection !== "mercator") return null;
  const { pitchInRadians, cameraToCenterDistance, pixelsPerMeter, elevation } = camera;
  if (
    typeof pitchInRadians !== "number" ||
    typeof cameraToCenterDistance !== "number" ||
    typeof pixelsPerMeter !== "number" ||
    typeof elevation !== "number" ||
    pixelsPerMeter === 0
  ) {
    return null;
  }
  const altitude = (Math.cos(pitchInRadians) * cameraToCenterDistance) / pixelsPerMeter + elevation;
  return Number.isFinite(altitude) ? altitude : null;
}
