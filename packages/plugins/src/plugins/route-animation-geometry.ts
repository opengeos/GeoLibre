/**
 * Pure geometry helpers for animating a marker along a polyline.
 *
 * Everything here operates on plain `[lng, lat]` tuples and numbers, with no DOM
 * or MapLibre imports, so the math can be unit-tested in isolation. It reuses the
 * haversine/cumulative-distance helpers already written for elevation profiles.
 */

import type { Feature, FeatureCollection, Geometry } from "geojson";

import {
  cumulativeDistances,
  haversineMeters,
  type LngLat,
} from "./elevation-profile/elevation/geometry";

export type { LngLat };

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;
const toDegrees = (radians: number): number => (radians * 180) / Math.PI;

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** A point sampled along a line, with the heading of the segment it sits on. */
export interface PointOnLine {
  /** Interpolated coordinate as `[lng, lat]`. */
  coord: LngLat;
  /** Compass bearing of travel in degrees (0 = north, 90 = east). */
  bearing: number;
}

/**
 * Initial great-circle bearing from `a` to `b` in degrees within `[0, 360)`.
 *
 * @param a - Start coordinate as `[lng, lat]`
 * @param b - End coordinate as `[lng, lat]`
 * @returns The forward azimuth in degrees (0 = north, clockwise)
 */
export function bearingBetween(a: LngLat, b: LngLat): number {
  const lat1 = toRadians(a[1]);
  const lat2 = toRadians(b[1]);
  const dLng = toRadians(b[0] - a[0]);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  const bearing = toDegrees(Math.atan2(y, x));
  return (bearing + 360) % 360;
}

/**
 * Flatten a set of features into a single ordered list of coordinates.
 *
 * The first `LineString` or `MultiLineString` encountered wins; a
 * `MultiLineString`'s segments are concatenated end to end. Point/polygon
 * features are ignored. Returns an empty array when no line geometry is present.
 *
 * @param features - The features (or a FeatureCollection) to search
 * @returns The line's vertices as `[lng, lat]`, or `[]` when there is no line
 */
export function flattenToLine(
  features: FeatureCollection | Feature[] | null | undefined,
): LngLat[] {
  if (!features) return [];
  const list = Array.isArray(features) ? features : features.features;
  if (!Array.isArray(list)) return [];

  for (const feature of list) {
    const coords = coordsFromGeometry(feature?.geometry);
    if (coords.length >= 2) return coords;
  }
  return [];
}

function coordsFromGeometry(
  geometry: Geometry | null | undefined,
): LngLat[] {
  if (!geometry) return [];
  if (geometry.type === "LineString") {
    return geometry.coordinates.map(toLngLat);
  }
  if (geometry.type === "MultiLineString") {
    return geometry.coordinates.flat().map(toLngLat);
  }
  return [];
}

const toLngLat = (position: number[]): LngLat => [position[0], position[1]];

/**
 * Locate the coordinate a given distance along a polyline, with its heading.
 *
 * Distances are clamped to `[0, totalLength]`, so `0` returns the first vertex
 * and any distance at or beyond the end returns the last vertex. The bearing is
 * taken from the segment the point falls on (the final segment at the very end).
 *
 * @param coords - Ordered polyline vertices as `[lng, lat]`
 * @param cumulative - Cumulative distances from {@link cumulativeDistances}
 * @param distanceMeters - Target distance along the line, in meters
 * @returns The interpolated {@link PointOnLine}
 */
export function pointAlongLine(
  coords: LngLat[],
  cumulative: number[],
  distanceMeters: number,
): PointOnLine {
  if (coords.length === 0) return { coord: [0, 0], bearing: 0 };
  if (coords.length === 1) return { coord: coords[0], bearing: 0 };

  const total = cumulative[cumulative.length - 1];
  const distance = Math.max(0, Math.min(distanceMeters, total));

  // Find the segment [segment-1, segment] that contains `distance`.
  let segment = 1;
  while (segment < coords.length - 1 && cumulative[segment] < distance) {
    segment += 1;
  }

  const segStart = cumulative[segment - 1];
  const segEnd = cumulative[segment];
  const segLength = segEnd - segStart;
  const t = segLength === 0 ? 0 : (distance - segStart) / segLength;

  const start = coords[segment - 1];
  const end = coords[segment];
  return {
    coord: [lerp(start[0], end[0], t), lerp(start[1], end[1], t)],
    bearing: bearingBetween(start, end),
  };
}

/**
 * The traveled portion of a polyline up to a given along-line distance.
 *
 * Returns the original vertices strictly before `distanceMeters` followed by the
 * exact interpolated point at `distanceMeters`, so a trail line rendered from it
 * ends precisely under the moving marker. Fewer than two points (distance `0`)
 * yields an empty array, which MapLibre renders as nothing.
 *
 * @param coords - Ordered polyline vertices as `[lng, lat]`
 * @param cumulative - Cumulative distances from {@link cumulativeDistances}
 * @param distanceMeters - How far along the line the trail extends, in meters
 * @returns The traveled coordinates as `[lng, lat]`
 */
export function sliceLineAtDistance(
  coords: LngLat[],
  cumulative: number[],
  distanceMeters: number,
): LngLat[] {
  if (coords.length < 2) return [];
  const total = cumulative[cumulative.length - 1];
  const distance = Math.max(0, Math.min(distanceMeters, total));
  if (distance <= 0) return [];

  const traveled: LngLat[] = [coords[0]];
  for (let i = 1; i < coords.length; i += 1) {
    if (cumulative[i] < distance) {
      traveled.push(coords[i]);
    } else {
      break;
    }
  }

  const head = pointAlongLine(coords, cumulative, distance).coord;
  traveled.push(head);
  return traveled;
}

/**
 * Convenience: cumulative distances plus the total length for a polyline.
 *
 * @param coords - Ordered polyline vertices as `[lng, lat]`
 * @returns `{ cumulative, totalMeters }`; `totalMeters` is `0` for < 2 vertices
 */
export function measureLine(coords: LngLat[]): {
  cumulative: number[];
  totalMeters: number;
} {
  const cumulative = cumulativeDistances(coords);
  const totalMeters = cumulative.length ? cumulative[cumulative.length - 1] : 0;
  return { cumulative, totalMeters };
}

// Re-exported so callers get the whole geometry toolkit from one module.
export { cumulativeDistances, haversineMeters };
