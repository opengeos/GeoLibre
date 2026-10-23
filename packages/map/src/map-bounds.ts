import type { MapPreferences } from "@geolibre/core";

/**
 * Web Mercator helpers for the project's navigation bounds, shared by the
 * MapLibre and ArcGIS engines so a restricted project behaves the same on
 * both. Mercator coordinates are fractions of the world: x from 0 (180° W) to
 * 1 (180° E), y from 0 (north) to 1 (south).
 */

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function mercatorXFromLng(lng: number): number {
  return (lng + 180) / 360;
}

export function lngFromMercatorX(x: number): number {
  return x * 360 - 180;
}

export function mercatorYFromLat(lat: number): number {
  const radians = (clamp(lat, -85, 85) * Math.PI) / 180;
  return (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2;
}

export function latFromMercatorY(y: number): number {
  return (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
}

export function mercatorBoundsForLngLatBounds(bounds: MapPreferences["bounds"]): {
  west: number;
  south: number;
  east: number;
  north: number;
} {
  return {
    west: mercatorXFromLng(bounds[0]),
    south: mercatorYFromLat(bounds[1]),
    east: mercatorXFromLng(bounds[2]),
    north: mercatorYFromLat(bounds[3]),
  };
}

/**
 * The project's `[west, south, east, north]` bounds clamped to the Web
 * Mercator world, or `null` when they are not finite or not a real box.
 *
 * @param bounds - The preference bounds.
 * @returns The usable bounds, or `null`.
 */
export function normalizeMapBounds(
  bounds: MapPreferences["bounds"],
): MapPreferences["bounds"] | null {
  const [west, south, east, north] = bounds;
  if (![west, south, east, north].every(Number.isFinite)) return null;
  const normalized: MapPreferences["bounds"] = [
    clamp(west, -180, 180),
    clamp(south, -85, 85),
    clamp(east, -180, 180),
    clamp(north, -85, 85),
  ];
  if (normalized[0] >= normalized[2] || normalized[1] >= normalized[3]) {
    return null;
  }

  return normalized;
}

/**
 * The minimum zoom at which restricted bounds fill a `width` × `height` pixel
 * view, so the user cannot zoom out past them (MapLibre zoom levels, 512 px
 * world at zoom 0). Returns the requested minimum when bounds are not
 * restricted.
 *
 * @param preferences - The project's map preferences.
 * @param width - The view width in CSS pixels.
 * @param height - The view height in CSS pixels.
 * @param requestedMinZoom - The project's own minimum zoom.
 * @returns The effective minimum zoom, clamped to 0–24.
 */
export function boundsFillMinZoom(
  preferences: MapPreferences,
  width: number,
  height: number,
  requestedMinZoom: number,
): number {
  const bounds = preferences.restrictBounds && normalizeMapBounds(preferences.bounds);
  if (!bounds) return requestedMinZoom;

  const mercatorBounds = mercatorBoundsForLngLatBounds(bounds);
  const widthRatio = Math.abs(mercatorBounds.east - mercatorBounds.west);
  const heightRatio = Math.abs(mercatorBounds.south - mercatorBounds.north);
  if (widthRatio <= 0 || heightRatio <= 0) return requestedMinZoom;

  const minZoomForWidth = Math.log2(width / (512 * widthRatio));
  const minZoomForHeight = Math.log2(height / (512 * heightRatio));

  return clamp(Math.max(requestedMinZoom, minZoomForWidth, minZoomForHeight), 0, 24);
}
