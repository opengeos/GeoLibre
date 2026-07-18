/**
 * Pure geometry helpers for turning a drawn polyline into an elevation profile.
 *
 * Everything here operates on plain `[lng, lat]` tuples and numbers, with no DOM
 * or MapLibre imports, so the math can be unit-tested in isolation.
 */

/** A geographic coordinate as a `[longitude, latitude]` tuple (degrees). */
export type LngLat = [number, number];

/** Mean Earth radius in meters (IUGG), used for haversine distances. */
const EARTH_RADIUS_M = 6371008.8;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/**
 * Great-circle distance between two coordinates using the haversine formula.
 *
 * @param a - Start coordinate as `[lng, lat]`
 * @param b - End coordinate as `[lng, lat]`
 * @returns The distance between the points in meters
 */
export function haversineMeters(a: LngLat, b: LngLat): number {
  const lat1 = toRadians(a[1]);
  const lat2 = toRadians(b[1]);
  const dLat = toRadians(b[1] - a[1]);
  const dLng = toRadians(b[0] - a[0]);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Running distance from the first coordinate to each coordinate along the line.
 *
 * @param coords - Ordered polyline vertices as `[lng, lat]`
 * @returns An array the same length as `coords` where entry `i` is the cumulative
 *   distance in meters from `coords[0]` to `coords[i]` (entry `0` is always `0`)
 */
export function cumulativeDistances(coords: LngLat[]): number[] {
  const distances: number[] = [];
  let total = 0;
  for (let i = 0; i < coords.length; i += 1) {
    if (i > 0) total += haversineMeters(coords[i - 1], coords[i]);
    distances.push(total);
  }
  return distances;
}

/** A polyline resampled to evenly spaced points with their along-line distances. */
export interface ResampledLine {
  /** Sampled coordinates as `[lng, lat]`, including both original endpoints. */
  coords: LngLat[];
  /** Distance in meters from the start to each sampled coordinate. */
  distances: number[];
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * Resample a polyline into `maxPoints` points spaced evenly by distance.
 *
 * The first and last points always coincide with the original endpoints. This
 * keeps the elevation request within a provider's per-call point limit while
 * producing a smooth profile regardless of how many vertices the user drew.
 *
 * @param coords - Ordered polyline vertices as `[lng, lat]`
 * @param maxPoints - Maximum number of samples to produce (coerced to at least 2)
 * @returns The resampled coordinates and their cumulative distances
 */
export function resampleLine(coords: LngLat[], maxPoints: number): ResampledLine {
  if (coords.length === 0) return { coords: [], distances: [] };
  if (coords.length === 1) return { coords: [coords[0]], distances: [0] };

  const target = Math.max(2, Math.floor(maxPoints));
  const cumulative = cumulativeDistances(coords);
  const total = cumulative[cumulative.length - 1];

  // Degenerate line (all vertices identical): return the endpoints at distance 0.
  if (total === 0) {
    return {
      coords: [coords[0], coords[coords.length - 1]],
      distances: [0, 0],
    };
  }

  const sampledCoords: LngLat[] = [];
  const sampledDistances: number[] = [];
  let segment = 1;

  for (let i = 0; i < target; i += 1) {
    const distance = (total * i) / (target - 1);

    // Advance to the segment that contains this along-line distance.
    while (segment < coords.length - 1 && cumulative[segment] < distance) {
      segment += 1;
    }

    const segStart = cumulative[segment - 1];
    const segEnd = cumulative[segment];
    const segLength = segEnd - segStart;
    const t = segLength === 0 ? 0 : (distance - segStart) / segLength;

    const start = coords[segment - 1];
    const end = coords[segment];
    sampledCoords.push([lerp(start[0], end[0], t), lerp(start[1], end[1], t)]);
    sampledDistances.push(distance);
  }

  // Snap the endpoints exactly onto the originals to avoid float drift.
  sampledCoords[0] = coords[0];
  sampledCoords[sampledCoords.length - 1] = coords[coords.length - 1];

  return { coords: sampledCoords, distances: sampledDistances };
}

/** Summary statistics for an elevation profile. */
export interface ProfileStats {
  /** Lowest sampled elevation in meters. */
  min: number;
  /** Highest sampled elevation in meters. */
  max: number;
  /** Total ascent (sum of positive elevation deltas) in meters. */
  gain: number;
  /** Total descent (sum of negative elevation deltas, as a positive value) in meters. */
  loss: number;
  /** Total length of the profiled line in meters. */
  totalDistance: number;
}

/**
 * Compute min/max elevation, cumulative ascent/descent, and total distance.
 *
 * @param elevations - Sampled elevations in meters, in along-line order
 * @param distances - Cumulative distances in meters matching `elevations`
 * @returns The aggregated {@link ProfileStats}
 */
export function computeStats(elevations: number[], distances: number[]): ProfileStats {
  const totalDistance = distances.length ? distances[distances.length - 1] : 0;

  if (elevations.length === 0) {
    return { min: 0, max: 0, gain: 0, loss: 0, totalDistance };
  }

  let min = elevations[0];
  let max = elevations[0];
  let gain = 0;
  let loss = 0;

  for (let i = 0; i < elevations.length; i += 1) {
    const elevation = elevations[i];
    if (elevation < min) min = elevation;
    if (elevation > max) max = elevation;
    if (i > 0) {
      const delta = elevation - elevations[i - 1];
      if (delta > 0) gain += delta;
      else loss += -delta;
    }
  }

  return { min, max, gain, loss, totalDistance };
}
