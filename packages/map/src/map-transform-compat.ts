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
 * - `@deck.gl/mapbox` — `getViewport()` reads `map.transform.height` on EVERY
 *   deck render, so with `transform` gone it throws
 *   `Cannot read properties of undefined (reading 'height')` per frame and no
 *   deck.gl overlay draws anything: the maplibre-gl-raster GPU engine, point
 *   clouds, 3D Tiles, the deck.gl-viz layers. Current as of 9.3.10.
 * - `maplibre-gl-components` (ControlGrid)
 * - `maplibre-gl-splat` (GaussianSplatControl)
 *
 * The prototype getter below hands them the camera's transform, which carries
 * every property they read. It is installed only when `Map` genuinely has no
 * `transform`, so it is inert on v5 and self-disabling if MapLibre restores it.
 *
 * `_nearZ`/`_farZ` need the alias too: v6 renamed them to the public `nearZ`
 * and `farZ` getters. deck.gl treats a non-finite value as "unknown" and falls
 * back to its own near/far multipliers, so a missing alias would not crash, it
 * would quietly cost depth precision on pitched/terrain views. They are defined
 * on each transform instance the first time it is seen rather than by wrapping
 * it in a Proxy, because this sits on the per-frame render path.
 */

interface CameraHost {
  _camera?: { transform?: object };
}

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
      const transform = this._camera?.transform;
      return transform ? aliasNearFarZ(transform) : undefined;
    },
  });
  return true;
}
