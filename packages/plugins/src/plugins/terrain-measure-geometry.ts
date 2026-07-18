/**
 * Pure math for terrain-aware (3D) measurements.
 *
 * Given elevations sampled along a measured line or across a measured polygon,
 * these helpers compute the surface (terrain-draped) distance and area that
 * augment the Measure tool's planar readouts. Everything operates on plain
 * numbers and `[lng, lat]` tuples with no DOM or MapLibre imports so it can be
 * unit-tested in isolation.
 *
 * Distances take the active body's mean radius as a parameter (rather than
 * hardcoding Earth) so 3D measurements stay consistent with the planar Measure
 * tool and the Field Calculator when a planetary ellipsoid is active.
 */

import type { LngLat } from "./elevation-profile/elevation/geometry";

export type { LngLat };

const DEG_TO_RAD = Math.PI / 180;

/** Great-circle distance in meters between two `[lng, lat]` points. */
export function haversineMeters(a: LngLat, b: LngLat, radius: number): number {
  const lat1 = a[1] * DEG_TO_RAD;
  const lat2 = b[1] * DEG_TO_RAD;
  const dLat = lat2 - lat1;
  const dLng = (b[0] - a[0]) * DEG_TO_RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Resample a polyline to roughly one sample every `spacingMeters`, capped at
 * `maxPoints` (both endpoints always included). Returns the sampled coordinates
 * and each sample's cumulative along-line distance in meters.
 */
export function densifyLine(
  coords: LngLat[],
  spacingMeters: number,
  maxPoints: number,
  radius: number,
): { coords: LngLat[]; distances: number[] } {
  if (coords.length < 2) {
    return { coords: [...coords], distances: coords.map(() => 0) };
  }

  const cumulative: number[] = [0];
  for (let i = 1; i < coords.length; i += 1) {
    cumulative.push(cumulative[i - 1] + haversineMeters(coords[i - 1], coords[i], radius));
  }
  const total = cumulative[cumulative.length - 1];
  if (total === 0) {
    return { coords: [coords[0], coords[coords.length - 1]], distances: [0, 0] };
  }

  const target = Math.min(
    Math.max(2, Math.floor(maxPoints)),
    Math.max(2, Math.ceil(total / Math.max(1, spacingMeters)) + 1),
  );

  const sampledCoords: LngLat[] = [];
  const sampledDistances: number[] = [];
  let segment = 1;
  for (let i = 0; i < target; i += 1) {
    const distance = (total * i) / (target - 1);
    while (segment < coords.length - 1 && cumulative[segment] < distance) {
      segment += 1;
    }
    const segStart = cumulative[segment - 1];
    const segLength = cumulative[segment] - segStart;
    const t = segLength === 0 ? 0 : (distance - segStart) / segLength;
    const a = coords[segment - 1];
    const b = coords[segment];
    sampledCoords.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    sampledDistances.push(distance);
  }
  // Snap endpoints exactly onto the originals to avoid float drift.
  sampledCoords[0] = coords[0];
  sampledCoords[sampledCoords.length - 1] = coords[coords.length - 1];
  return { coords: sampledCoords, distances: sampledDistances };
}

/** Terrain-aware statistics for a measured line. */
export interface SurfaceDistanceResult {
  /** Terrain-draped 3D length in meters (planar for segments missing data). */
  surfaceMeters: number;
  /** Planar (great-circle) length in meters over the same samples. */
  planarMeters: number;
  /** Total ascent in meters across samples with known elevation. */
  gainMeters: number;
  /** Total descent in meters (positive) across samples with known elevation. */
  lossMeters: number;
  /** Lowest sampled elevation in meters, or null if nothing was sampled. */
  minElevationMeters: number | null;
  /** Highest sampled elevation in meters, or null if nothing was sampled. */
  maxElevationMeters: number | null;
  /** Number of samples with a usable elevation. */
  sampledCount: number;
  /** Number of samples with no elevation (their segments fall back to planar). */
  missingCount: number;
}

/**
 * Compute the terrain-draped length of a sampled line. `distances` is the
 * cumulative along-line distance per sample; `elevations` is the elevation per
 * sample (null/NaN where unknown). Segments with an unknown endpoint elevation
 * contribute their planar length, so a few missing DEM tiles degrade gracefully
 * toward the planar measurement instead of dropping distance.
 */
export function surfaceDistance(
  distances: number[],
  elevations: (number | null)[],
): SurfaceDistanceResult {
  const planarMeters = distances.length ? distances[distances.length - 1] - distances[0] : 0;
  let surfaceMeters = 0;
  let gainMeters = 0;
  let lossMeters = 0;
  let minElevationMeters: number | null = null;
  let maxElevationMeters: number | null = null;
  let sampledCount = 0;
  let missingCount = 0;
  let previousKnown: number | null = null;

  for (let i = 0; i < distances.length; i += 1) {
    const raw = elevations[i];
    const elevation = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
    if (elevation === null) {
      missingCount += 1;
    } else {
      sampledCount += 1;
      if (minElevationMeters === null || elevation < minElevationMeters) {
        minElevationMeters = elevation;
      }
      if (maxElevationMeters === null || elevation > maxElevationMeters) {
        maxElevationMeters = elevation;
      }
      if (previousKnown !== null) {
        const delta = elevation - previousKnown;
        if (delta > 0) gainMeters += delta;
        else lossMeters += -delta;
      }
      previousKnown = elevation;
    }

    if (i === 0) continue;
    const run = distances[i] - distances[i - 1];
    const prev = elevations[i - 1];
    const prevElevation = typeof prev === "number" && Number.isFinite(prev) ? prev : null;
    if (elevation !== null && prevElevation !== null) {
      surfaceMeters += Math.hypot(run, elevation - prevElevation);
    } else {
      surfaceMeters += run;
    }
  }

  return {
    surfaceMeters,
    planarMeters,
    gainMeters,
    lossMeters,
    minElevationMeters,
    maxElevationMeters,
    sampledCount,
    missingCount,
  };
}

/** Ray-casting point-in-ring test on `[lng, lat]` coordinates. */
export function pointInRing(point: LngLat, ring: LngLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects =
      yi > point[1] !== yj > point[1] && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** A regular sampling grid laid over a polygon's bounding box. */
export interface AreaGrid {
  /** All grid coordinates, row-major (row 0 = south), `cols * rows` entries. */
  coords: LngLat[];
  /** Whether each grid coordinate falls inside the polygon ring. */
  inside: boolean[];
  cols: number;
  rows: number;
  /** East–west spacing between grid columns in meters (at the bbox center). */
  cellWidthMeters: number;
  /** North–south spacing between grid rows in meters. */
  cellHeightMeters: number;
}

/**
 * Lay a roughly square sampling grid over a polygon ring's bounding box. The
 * grid has at most `maxSamples` points (and at least 2x2), sized so cells are
 * approximately square in meters. Degenerate rings return a null grid.
 */
export function buildAreaGrid(ring: LngLat[], maxSamples: number, radius: number): AreaGrid | null {
  if (ring.length < 3) return null;
  let minLng = Infinity;
  let maxLng = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const [lng, lat] of ring) {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  if (!(maxLng > minLng) || !(maxLat > minLat)) return null;

  const centerLat = (minLat + maxLat) / 2;
  const metersPerDegLat = (Math.PI * radius) / 180;
  const metersPerDegLng = metersPerDegLat * Math.cos(centerLat * DEG_TO_RAD);
  const widthMeters = (maxLng - minLng) * metersPerDegLng;
  const heightMeters = (maxLat - minLat) * metersPerDegLat;
  if (!(widthMeters > 0) || !(heightMeters > 0)) return null;

  // Pick cols/rows proportional to the bbox aspect so cells come out roughly
  // square, while keeping cols * rows <= maxSamples. Cap rows so that cols'
  // floor of 2 cannot push the product past maxSamples on very skinny
  // polygons (a tall sliver would otherwise blow rows up unbounded).
  const aspect = widthMeters / heightMeters;
  const budget = Math.max(4, maxSamples);
  const rawRows = Math.sqrt(budget / aspect);
  const rowCap = Math.max(2, Math.floor(budget / 2));
  const rows = Math.max(2, Math.min(Math.round(rawRows), rowCap));
  const cols = Math.max(2, Math.floor(budget / rows));

  const coords: LngLat[] = [];
  const inside: boolean[] = [];
  for (let r = 0; r < rows; r += 1) {
    const lat = minLat + ((maxLat - minLat) * r) / (rows - 1);
    for (let c = 0; c < cols; c += 1) {
      const lng = minLng + ((maxLng - minLng) * c) / (cols - 1);
      const point: LngLat = [lng, lat];
      coords.push(point);
      inside.push(pointInRing(point, ring));
    }
  }

  return {
    coords,
    inside,
    cols,
    rows,
    cellWidthMeters: widthMeters / (cols - 1),
    cellHeightMeters: heightMeters / (rows - 1),
  };
}

/** Terrain-aware statistics for a measured polygon. */
export interface SurfaceAreaResult {
  /** Terrain-draped 3D surface area in square meters. */
  surfaceSquareMeters: number;
  /** Area-weighted mean slope across sampled cells, in degrees. */
  meanSlopeDegrees: number;
  /** Number of interior grid samples with a usable elevation. */
  sampledCount: number;
  /** Number of interior grid samples missing an elevation. */
  missingCount: number;
}

/** Steeper cells are clamped to this slope so one bad sample can't explode the area. */
const MAX_SLOPE_DEG = 85;

/**
 * Estimate the terrain-draped surface area of a polygon from grid-sampled
 * elevations. Each interior sample gets a slope from central differences of
 * its neighbors; the polygon's exact planar area is then scaled by the mean
 * secant of those slopes (the standard slope-correction `A / cos(s)`), so the
 * grid only has to approximate the *slope distribution*, not the outline.
 * Returns null when fewer than half the interior samples have elevations.
 */
export function surfaceArea(
  grid: AreaGrid,
  elevations: (number | null)[],
  planarSquareMeters: number,
): SurfaceAreaResult | null {
  const { cols, rows, inside, cellWidthMeters, cellHeightMeters } = grid;
  const at = (r: number, c: number): number | null => {
    if (r < 0 || c < 0 || r >= rows || c >= cols) return null;
    const value = elevations[r * cols + c];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };

  const maxSecant = 1 / Math.cos(MAX_SLOPE_DEG * DEG_TO_RAD);
  let secantSum = 0;
  let slopeSum = 0;
  let sampledCount = 0;
  let missingCount = 0;

  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      if (!inside[r * cols + c]) continue;
      const here = at(r, c);
      if (here === null) {
        missingCount += 1;
        continue;
      }
      // Central differences where both neighbors exist, one-sided otherwise.
      const west = at(r, c - 1);
      const east = at(r, c + 1);
      const south = at(r - 1, c);
      const north = at(r + 1, c);
      const dzdx = gradient(west, here, east, cellWidthMeters);
      const dzdy = gradient(south, here, north, cellHeightMeters);
      if (dzdx === null || dzdy === null) {
        missingCount += 1;
        continue;
      }
      const secant = Math.min(Math.hypot(1, dzdx, dzdy), maxSecant);
      secantSum += secant;
      // Clamp like the secant so a spiky DEM sample can't report a mean slope
      // the area contribution was already protected against.
      slopeSum += Math.min(Math.atan(Math.hypot(dzdx, dzdy)) / DEG_TO_RAD, MAX_SLOPE_DEG);
      sampledCount += 1;
    }
  }

  if (sampledCount === 0 || sampledCount < missingCount) return null;

  return {
    surfaceSquareMeters: planarSquareMeters * (secantSum / sampledCount),
    meanSlopeDegrees: slopeSum / sampledCount,
    sampledCount,
    missingCount,
  };
}

/**
 * Slope of the elevation across one axis: central difference when both
 * neighbors are known, one-sided when only one is, null when neither is.
 */
function gradient(
  before: number | null,
  here: number,
  after: number | null,
  spacingMeters: number,
): number | null {
  if (before !== null && after !== null) {
    return (after - before) / (2 * spacingMeters);
  }
  if (after !== null) return (after - here) / spacingMeters;
  if (before !== null) return (here - before) / spacingMeters;
  return null;
}
