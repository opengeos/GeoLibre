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
  /**
   * Interpolated raw Z (elevation) of the point, in the source data's units
   * (meters for GPX). `0` when no `elevations` array is supplied. This is the
   * untransformed value; vertical exaggeration / offset are applied by the
   * caller so the marker rides the same 3D line the deck.gl overlay draws.
   */
  elevation: number;
}

/**
 * The line's `[lng, lat]` vertices plus a parallel array of their raw Z values.
 * Kept as two arrays (not `[lng, lat, z]` tuples) so the 2D distance/bearing
 * math stays untouched and the elevations ride alongside for the 3D render.
 */
export interface RouteWithElevation {
  /** The line vertices as `[lng, lat]`. */
  coords: LngLat[];
  /** Raw Z (elevation) per vertex, aligned with {@link coords}. */
  elevations: number[];
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
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
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
  return flattenToRoute(features).coords;
}

/**
 * Like {@link flattenToLine}, but also returns the raw Z (elevation) of every
 * vertex in a parallel array. The first line geometry with at least two
 * vertices wins; vertices with no Z contribute `0`. Used by the 3D render path
 * so the animated marker/trail can be lifted onto the same elevated line the
 * deck.gl overlay draws (see opengeos/GeoLibre#1210).
 *
 * @param features - The features (or a FeatureCollection) to search
 * @returns The `[lng, lat]` vertices and their aligned raw Z values
 */
export function flattenToRoute(
  features: FeatureCollection | Feature[] | null | undefined,
): RouteWithElevation {
  const empty: RouteWithElevation = { coords: [], elevations: [] };
  if (!features) return empty;
  const list = Array.isArray(features) ? features : features.features;
  if (!Array.isArray(list)) return empty;

  for (const feature of list) {
    const route = routeFromGeometry(feature?.geometry);
    if (route.coords.length >= 2) return route;
  }
  return empty;
}

function routeFromGeometry(geometry: Geometry | null | undefined): RouteWithElevation {
  if (!geometry) return { coords: [], elevations: [] };
  if (geometry.type === "LineString") {
    return splitPositions(geometry.coordinates);
  }
  if (geometry.type === "MultiLineString") {
    return splitPositions(geometry.coordinates.flat());
  }
  return { coords: [], elevations: [] };
}

function splitPositions(positions: number[][]): RouteWithElevation {
  const coords: LngLat[] = [];
  const elevations: number[] = [];
  for (const position of positions) {
    coords.push([position[0], position[1]]);
    elevations.push(
      typeof position[2] === "number" && Number.isFinite(position[2]) ? position[2] : 0,
    );
  }
  return { coords, elevations };
}

/**
 * Index of the segment `[segment-1, segment]` that contains `distance`, i.e. the
 * smallest `i` in `[1, n-1]` with `cumulative[i] >= distance` (the last segment
 * when `distance` is at/beyond the end). `cumulative` is monotonically
 * non-decreasing, so this is a binary search — O(log n) instead of an O(n) scan
 * on every animation frame, which matters for densely-sampled tracks.
 */
function segmentAtDistance(cumulative: number[], distance: number): number {
  let lo = 1;
  let hi = cumulative.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cumulative[mid] < distance) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

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
  elevations?: number[],
): PointOnLine {
  if (coords.length === 0) return { coord: [0, 0], bearing: 0, elevation: 0 };
  if (coords.length === 1) {
    return { coord: coords[0], bearing: 0, elevation: elevations?.[0] ?? 0 };
  }

  const total = cumulative[cumulative.length - 1];
  const distance = Math.max(0, Math.min(distanceMeters, total));

  const segment = segmentAtDistance(cumulative, distance);

  const segStart = cumulative[segment - 1];
  const segEnd = cumulative[segment];
  const segLength = segEnd - segStart;
  const t = segLength === 0 ? 0 : (distance - segStart) / segLength;

  const start = coords[segment - 1];
  const end = coords[segment];
  const elevation = elevations
    ? lerp(elevations[segment - 1] ?? 0, elevations[segment] ?? 0, t)
    : 0;
  return {
    coord: [lerp(start[0], end[0], t), lerp(start[1], end[1], t)],
    bearing: bearingBetween(start, end),
    elevation,
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

  // Original vertices strictly before `distance` are coords[0..segment-1]; the
  // interpolated point at `distance` caps the trail exactly under the marker.
  const segment = segmentAtDistance(cumulative, distance);
  const traveled = coords.slice(0, segment);
  traveled.push(pointAlongLine(coords, cumulative, distance).coord);
  return traveled;
}

/**
 * The traveled portion of a polyline up to a given along-line distance, with the
 * raw Z (elevation) of every returned vertex in a parallel array. This is the
 * 3D-aware companion to {@link sliceLineAtDistance}: it feeds the elevated
 * deck.gl trail so the trail rides the same line the marker does. Fewer than
 * two vertices (distance `0`) yields empty arrays.
 *
 * @param coords - Ordered polyline vertices as `[lng, lat]`
 * @param cumulative - Cumulative distances from {@link cumulativeDistances}
 * @param distanceMeters - How far along the line the trail extends, in meters
 * @param elevations - Raw Z per vertex, aligned with {@link coords}
 * @returns The traveled `[lng, lat]` vertices and their aligned raw Z values
 */
export function sliceRouteAtDistance(
  coords: LngLat[],
  cumulative: number[],
  distanceMeters: number,
  elevations: number[],
): RouteWithElevation {
  if (coords.length < 2) return { coords: [], elevations: [] };
  const total = cumulative[cumulative.length - 1];
  const distance = Math.max(0, Math.min(distanceMeters, total));
  if (distance <= 0) return { coords: [], elevations: [] };

  const segment = segmentAtDistance(cumulative, distance);
  const traveledCoords = coords.slice(0, segment);
  // Build elevations aligned 1:1 with the returned coords, defaulting missing
  // entries to 0 (mirrors pointAlongLine's `elevations[i] ?? 0`) so a shorter
  // elevations array can never leave the two arrays out of sync.
  const traveledElevations = traveledCoords.map((_, i) => elevations[i] ?? 0);
  const end = pointAlongLine(coords, cumulative, distance, elevations);
  traveledCoords.push(end.coord);
  traveledElevations.push(end.elevation);
  return { coords: traveledCoords, elevations: traveledElevations };
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
