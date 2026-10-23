import type { CallbackProperty, CesiumWidget } from "@cesium/engine";

/** The Cesium module namespace, injected so this file never imports the engine. */
type CesiumNs = typeof import("@cesium/engine");

/**
 * The horizon depth distance for one globe: how far from the camera a ground
 * marker can be and still be on the visible side of the Earth.
 *
 * Ground points and labels draw through terrain (`disableDepthTestDistance`)
 * so a hill does not hide the half of each one that dips into it. With an
 * infinite distance they also draw through the Earth itself, so a city on the
 * far side shows over the near one. On a sphere every visible surface point is
 * at most the horizon distance `sqrt(h (2R + h))` from a camera at height `h`,
 * and every far-side point is farther, so a depth-test distance equal to it
 * keeps the near side drawing over terrain while the globe hides the far side.
 * The distance is extended by how far past the horizon the highest terrain is
 * still visible, so a marker on a distant ridge is not clipped by its own hill;
 * a marker that far past the limb on the far side is a sliver of the view.
 */
export interface HorizonDepthDistance {
  /** One shared property for entity graphics, read every frame by Cesium. */
  readonly property: CallbackProperty | number;
  /** The current distance in metres (infinite in 2D, Columbus, or underground). */
  distance(): number;
  /**
   * Call `listener` when the distance changes, for primitives that hold a
   * plain number. It stops listening when `listener` returns false.
   */
  subscribe(listener: (distance: number) => boolean): void;
}

/** Relative change below which the distance is not republished to primitives. */
const REPUBLISH_FRACTION = 0.005;

/**
 * Margin over the geometric horizon, so a marker sitting right on the limb does
 * not flicker between the two depth modes as the camera breathes.
 */
const HORIZON_MARGIN = 1.01;

/**
 * The highest terrain a marker can sit on (Everest, in metres). A peak of
 * height `H` stays in view `sqrt(H (2R + H))` past the smooth horizon, so a
 * marker on a ridge beyond it must still skip the depth test, or the terrain
 * it sits on would clip it.
 */
const MAX_TERRAIN_HEIGHT = 8849;

const horizons = new WeakMap<object, HorizonDepthDistance>();

/**
 * The {@link HorizonDepthDistance} for a globe, created on first use and
 * updated once per frame from the scene's `preRender`. A widget without a
 * scene event (a test double) answers an infinite distance.
 *
 * @param C - The Cesium namespace.
 * @param viewer - The globe.
 */
export function horizonDepthDistance(C: CesiumNs, viewer: CesiumWidget): HorizonDepthDistance {
  const existing = horizons.get(viewer);
  if (existing) return existing;
  const preRender = viewer.scene?.preRender;
  if (!preRender || typeof C.CallbackProperty !== "function") {
    const infinite: HorizonDepthDistance = {
      property: Number.POSITIVE_INFINITY,
      distance: () => Number.POSITIVE_INFINITY,
      subscribe: () => {},
    };
    horizons.set(viewer, infinite);
    return infinite;
  }
  let value = Number.POSITIVE_INFINITY;
  let published = value;
  const listeners = new Set<(distance: number) => boolean>();
  const update = () => {
    value = horizonDistance(C, viewer);
    const changed =
      value !== published &&
      !(Number.isFinite(value) && Number.isFinite(published)
        ? Math.abs(value - published) <= published * REPUBLISH_FRACTION
        : false);
    if (!changed) return;
    published = value;
    for (const listener of [...listeners]) if (!listener(value)) listeners.delete(listener);
  };
  preRender.addEventListener(update);
  update();
  const horizon: HorizonDepthDistance = {
    property: new C.CallbackProperty(() => value, false),
    distance: () => value,
    subscribe: (listener) => {
      if (listener(value)) listeners.add(listener);
    },
  };
  horizons.set(viewer, horizon);
  return horizon;
}

/**
 * The camera's horizon distance in metres, or infinity where there is no
 * horizon to hide behind: the flat scene modes, and a camera at or below the
 * ellipsoid.
 *
 * @param C - The Cesium namespace.
 * @param viewer - The globe.
 * @returns The distance.
 */
export function horizonDistance(C: CesiumNs, viewer: CesiumWidget): number {
  const scene = viewer.scene;
  if (!scene || scene.mode !== C.SceneMode.SCENE3D) return Number.POSITIVE_INFINITY;
  const ellipsoid = scene.globe?.ellipsoid ?? C.Ellipsoid.WGS84;
  const height = ellipsoid.cartesianToCartographic(viewer.camera.positionWC)?.height;
  if (!(typeof height === "number" && height > 0)) return Number.POSITIVE_INFINITY;
  const radius = ellipsoid.maximumRadius;
  const beyond = Math.sqrt(MAX_TERRAIN_HEIGHT * (2 * radius + MAX_TERRAIN_HEIGHT));
  return (Math.sqrt(height * (2 * radius + height)) + beyond) * HORIZON_MARGIN;
}
