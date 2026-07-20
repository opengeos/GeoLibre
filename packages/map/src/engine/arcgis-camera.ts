import type { MapViewState } from "@geolibre/core";

/** The serializable subset of an ArcGIS 2D `MapView` used by the adapter. */
export interface ArcGISMapViewSnapshot {
  readonly center: {
    readonly longitude?: number;
    readonly latitude?: number;
    readonly x?: number;
    readonly y?: number;
  };
  readonly zoom: number;
  readonly rotation: number;
}

/** MapView constructor/goTo properties derived from the engine-neutral camera. */
export interface ArcGISMapViewProperties {
  readonly center: readonly [number, number];
  readonly zoom: number;
  readonly rotation: number;
}

/** Normalize degrees into MapLibre's and GeoLibre's [-180, 180] bearing range. */
export function normalizeArcGISRotation(degrees: number): number {
  let rotation = degrees % 360;
  if (rotation > 180) rotation -= 360;
  if (rotation < -180) rotation += 360;
  return rotation;
}

/** Translate a store camera to ArcGIS MapView's documented 2D view properties. */
export function mapViewStateToArcGISView(view: MapViewState): ArcGISMapViewProperties {
  return {
    center: view.center,
    zoom: view.zoom,
    rotation: normalizeArcGISRotation(view.bearing),
  };
}

/**
 * Read an ArcGIS 2D view back into the shared store camera.
 *
 * A MapView has no pitch dimension. Retaining the prior pitch is intentional:
 * switching an ArcGIS pane off must not overwrite a project camera's pitch
 * solely because the selected 2D renderer cannot display it.
 */
export function arcGISViewToMapViewState(
  view: ArcGISMapViewSnapshot,
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
    bearing: Number.isFinite(view.rotation)
      ? normalizeArcGISRotation(view.rotation)
      : fallback.bearing,
    pitch: fallback.pitch,
  };
}

/**
 * MapView round trips can vary by tiny floating-point amounts. This tolerance
 * distinguishes a programmatic store echo from a real user navigation without
 * flattening visible map movement.
 */
export function isSameArcGISMapView(a: MapViewState, b: MapViewState): boolean {
  return (
    Math.abs(normalizeArcGISRotation(a.center[0] - b.center[0])) < 1e-7 &&
    Math.abs(a.center[1] - b.center[1]) < 1e-7 &&
    Math.abs(a.zoom - b.zoom) < 1e-7 &&
    Math.abs(normalizeArcGISRotation(a.bearing - b.bearing)) < 1e-7 &&
    a.pitch === b.pitch
  );
}
