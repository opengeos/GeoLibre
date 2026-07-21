import type { MapViewState } from "@geolibre/core";
import { normalizeArcGISRotation } from "./arcgis-camera";

/** The public SceneView state needed to round-trip the shared project camera. */
export interface ArcGISSceneViewSnapshot {
  readonly center: {
    readonly longitude?: number;
    readonly latitude?: number;
    readonly x?: number;
    readonly y?: number;
  };
  readonly zoom: number;
  readonly camera: {
    readonly heading?: number;
    readonly tilt?: number;
  };
}

/** Public SceneView `goTo` properties derived from the store-owned camera. */
export interface ArcGISSceneViewProperties {
  readonly center: readonly [number, number];
  readonly zoom: number;
  readonly heading: number;
  readonly tilt: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * SceneView's documented `zoom`, `heading`, and camera `tilt` match the
 * shared camera's scale, bearing, and nadir-referenced pitch closely enough
 * to avoid adapter-private distance math.  Keep the translation pure so the
 * scene adapter remains lazy and deterministic under test.
 */
export function mapViewStateToArcGISSceneView(view: MapViewState): ArcGISSceneViewProperties {
  return {
    center: view.center,
    zoom: view.zoom,
    heading: normalizeArcGISRotation(view.bearing),
    tilt: clamp(view.pitch, 0, 85),
  };
}

/** Read public SceneView camera state back into the store representation. */
export function arcGISSceneViewToMapViewState(
  view: ArcGISSceneViewSnapshot,
  fallback: MapViewState,
): MapViewState {
  const longitude = view.center.longitude ?? view.center.x;
  const latitude = view.center.latitude ?? view.center.y;
  return {
    center:
      typeof longitude === "number" &&
      Number.isFinite(longitude) &&
      typeof latitude === "number" &&
      Number.isFinite(latitude)
        ? [longitude, latitude]
        : fallback.center,
    zoom: Number.isFinite(view.zoom) ? view.zoom : fallback.zoom,
    bearing: typeof view.camera.heading === "number" && Number.isFinite(view.camera.heading)
      ? normalizeArcGISRotation(view.camera.heading)
      : fallback.bearing,
    pitch:
      typeof view.camera.tilt === "number" && Number.isFinite(view.camera.tilt)
        ? clamp(view.camera.tilt, 0, 85)
        : fallback.pitch,
  };
}

/** Ignore ArcGIS floating-point camera echoes, but preserve visible navigation. */
export function isSameArcGISSceneView(a: MapViewState, b: MapViewState): boolean {
  return (
    Math.abs(normalizeArcGISRotation(a.center[0] - b.center[0])) < 1e-7 &&
    Math.abs(a.center[1] - b.center[1]) < 1e-7 &&
    Math.abs(a.zoom - b.zoom) < 1e-7 &&
    Math.abs(normalizeArcGISRotation(a.bearing - b.bearing)) < 1e-7 &&
    Math.abs(a.pitch - b.pitch) < 1e-7
  );
}
