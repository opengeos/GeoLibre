import type { MapViewState } from "@geolibre/core";

export function normalizeBearing(deg: number): number {
  let bearing = deg % 360;
  if (bearing > 180) bearing -= 360;
  if (bearing < -180) bearing += 360;
  return bearing;
}

export function isSameView(a: MapViewState, b: MapViewState): boolean {
  return (
    Math.abs(normalizeBearing(a.center[0] - b.center[0])) < 1e-5 &&
    Math.abs(a.center[1] - b.center[1]) < 1e-5 &&
    Math.abs(a.zoom - b.zoom) < 0.02 &&
    Math.abs(normalizeBearing(a.bearing - b.bearing)) < 0.1 &&
    Math.abs(a.pitch - b.pitch) < 0.1
  );
}
