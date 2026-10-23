/**
 * Interactive line of sight between two clicked map points (issue #2858).
 *
 * The question is the one-dimensional cousin of the viewshed in
 * `terrain-viewshed.ts`: can an observer standing at A see a target at B, and
 * if not, where does the terrain get in the way? It is answered against the
 * same Terrarium terrain tiles the viewshed and the map's terrain control use,
 * so no DEM has to be found and loaded first.
 *
 * The module splits along the same seam as the viewshed:
 *
 *  1. {@link sampleGreatCircleProfile} walks the great-circle path and reads an
 *     elevation at each step from any `(lng, lat) => metres` function.
 *  2. {@link computeLineOfSight} is pure: it takes that profile and the two
 *     heights and decides what is visible.
 *  3. {@link fetchLineOfSightProfile} is the browser half: it picks a tile zoom
 *     for the path's length, fetches only the tiles the path crosses, and
 *     samples them bilinearly.
 *
 * Unlike the viewshed, the computation models Earth curvature and atmospheric
 * refraction by default. A line of sight is cheap (one ray, not one per cell),
 * and it is the tool people reach for at exactly the ranges -- a summit to a
 * distant peak, a mast to a mast -- where a 50 km curvature drop of ~170 m
 * decides the answer.
 */

import {
  decodeTile,
  mercatorY,
  TERRARIUM_MAX_ZOOM,
  TERRARIUM_TILE_SIZE,
  TERRARIUM_TILE_URL,
} from "./terrain-viewshed";

/** Mean Earth radius in metres (IUGG). */
export const EARTH_RADIUS_METERS = 6_371_008.8;

/**
 * Standard coefficient of atmospheric refraction for visible light. Refraction
 * bends a sight line back toward the ground, so it offsets part of the
 * curvature drop; 0.13 is the value most GIS viewshed tools default to.
 */
export const DEFAULT_REFRACTION_COEFFICIENT = 0.13;

/** Default observer eye height above the ground -- a standing person. */
export const DEFAULT_LOS_OBSERVER_HEIGHT_METERS = 1.7;
/** Default target height above the ground -- a point on the ground. */
export const DEFAULT_LOS_TARGET_HEIGHT_METERS = 0;

/** Shortest path a line of sight takes; anything shorter has no profile to read. */
export const MIN_LINE_OF_SIGHT_METERS = 1;
/** Longest path one line of sight may span, so one click cannot fetch a continent. */
export const MAX_LINE_OF_SIGHT_METERS = 300_000;
/** Most profile samples one line of sight takes. */
export const MAX_LINE_OF_SIGHT_SAMPLES = 4096;
/** Fewest profile samples, so a short line still draws a readable chart. */
export const MIN_LINE_OF_SIGHT_SAMPLES = 64;
/** Most terrain tiles one line of sight fetches. */
export const MAX_LINE_OF_SIGHT_TILES = 48;

/** A geographic position in degrees. */
export interface LngLat {
  lng: number;
  lat: number;
}

/** One step along the path. */
export interface ProfileSample extends LngLat {
  /** Distance from the observer along the great circle, in metres. */
  distance: number;
  /** Ground elevation in metres, or NaN where no terrain could be read. */
  elevation: number;
}

/** A profile sample with its visibility worked out. */
export interface LineOfSightSample extends ProfileSample {
  /** Whether the ground at this sample is visible from the observer's eye. */
  visible: boolean;
  /**
   * Height of the observer-to-target sight line above this sample's point, in
   * the same (uncurved) metres as `elevation`, so a chart can draw both on one
   * axis. With curvature on, the line sags toward the ground midway, as a
   * straight chord between two points on a sphere does.
   */
  sightline: number;
}

/** A run of consecutive samples that share one visibility. */
export interface LineOfSightSegment {
  visible: boolean;
  /** `[lng, lat]` vertices; adjacent segments share their boundary vertex. */
  coordinates: [number, number][];
  startDistance: number;
  endDistance: number;
}

export interface LineOfSightOptions {
  /** Observer eye height above the ground, in metres. */
  observerHeightMeters?: number;
  /** Target height above the ground, in metres. */
  targetHeightMeters?: number;
  /** Model Earth curvature and refraction (default true). */
  curvature?: boolean;
  /** Refraction coefficient used with curvature (default 0.13). */
  refractionCoefficient?: number;
}

export interface LineOfSightResult {
  samples: LineOfSightSample[];
  segments: LineOfSightSegment[];
  /** Great-circle length of the path, in metres. */
  totalDistance: number;
  observer: LngLat & { groundMeters: number; eyeMeters: number };
  target: LngLat & { groundMeters: number; topMeters: number };
  /** Whether the target's top can be seen from the observer's eye. */
  targetVisible: boolean;
  /**
   * The first sample, walking from the observer, whose terrain rises above the
   * sight line to the target; null when the target is visible.
   */
  firstObstruction: ProfileSample | null;
  /** The highest ground sample along the path. */
  highestPoint: ProfileSample;
  /** Share of the path's ground that is visible from the observer, 0-1. */
  visibleFraction: number;
}

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
const toDegrees = (radians: number) => (radians * 180) / Math.PI;

/**
 * Great-circle (haversine) distance between two points, in metres.
 *
 * @param a - The first point.
 * @param b - The second point.
 * @returns The distance along the sphere's surface.
 */
export function greatCircleDistance(a: LngLat, b: LngLat): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The point a fraction of the way along the great circle from `a` to `b`.
 *
 * Spherical linear interpolation of the two unit vectors; falls back to the
 * start point when the two coincide.
 *
 * @param a - The start point.
 * @param b - The end point.
 * @param fraction - 0 at `a`, 1 at `b`.
 * @returns The interpolated point, its longitude normalised to [-180, 180].
 */
export function interpolateGreatCircle(a: LngLat, b: LngLat, fraction: number): LngLat {
  const lat1 = toRadians(a.lat);
  const lng1 = toRadians(a.lng);
  const lat2 = toRadians(b.lat);
  const lng2 = toRadians(b.lng);
  const angle = greatCircleDistance(a, b) / EARTH_RADIUS_METERS;
  if (angle < 1e-12) return { lng: a.lng, lat: a.lat };
  const sinAngle = Math.sin(angle);
  const wa = Math.sin((1 - fraction) * angle) / sinAngle;
  const wb = Math.sin(fraction * angle) / sinAngle;
  const x = wa * Math.cos(lat1) * Math.cos(lng1) + wb * Math.cos(lat2) * Math.cos(lng2);
  const y = wa * Math.cos(lat1) * Math.sin(lng1) + wb * Math.cos(lat2) * Math.sin(lng2);
  const z = wa * Math.sin(lat1) + wb * Math.sin(lat2);
  return {
    lng: toDegrees(Math.atan2(y, x)),
    lat: toDegrees(Math.atan2(z, Math.hypot(x, y))),
  };
}

/**
 * Sample ground elevations at evenly spaced steps along the great circle.
 *
 * @param from - The observer.
 * @param to - The target.
 * @param sampleCount - Number of samples, both endpoints included (at least 2).
 * @param elevationAt - Ground elevation in metres at a point; NaN when unknown.
 * @returns The samples in order from observer to target.
 */
export function sampleGreatCircleProfile(
  from: LngLat,
  to: LngLat,
  sampleCount: number,
  elevationAt: (lng: number, lat: number) => number,
): ProfileSample[] {
  const count = Math.max(2, Math.floor(sampleCount));
  const total = greatCircleDistance(from, to);
  const samples: ProfileSample[] = [];
  for (let i = 0; i < count; i += 1) {
    const fraction = i / (count - 1);
    // The endpoints are the clicked points exactly, not a round trip through
    // the interpolation, so the drawn line meets the markers.
    const point =
      i === 0
        ? { ...from }
        : i === count - 1
          ? { ...to }
          : interpolateGreatCircle(from, to, fraction);
    samples.push({
      ...point,
      distance: total * fraction,
      elevation: elevationAt(point.lng, point.lat),
    });
  }
  return samples;
}

/**
 * How far below the observer's tangent plane the ground at `distance` appears
 * to sit, once curvature and refraction are combined: `d²(1 - k) / 2R`.
 *
 * @param distance - Ground distance from the observer, in metres.
 * @param refractionCoefficient - The refraction coefficient `k`.
 * @returns The apparent drop, in metres.
 */
export function curvatureDrop(
  distance: number,
  refractionCoefficient = DEFAULT_REFRACTION_COEFFICIENT,
): number {
  return ((distance * distance) / (2 * EARTH_RADIUS_METERS)) * (1 - refractionCoefficient);
}

/**
 * Work out what an observer can see along a terrain profile.
 *
 * Two related answers come out of one walk:
 *
 *  - **Ground visibility**, per sample: the ground at a sample is visible when
 *    the slope from the eye down (or up) to it is steeper than every slope to
 *    the samples before it -- the same horizon test the viewshed applies per
 *    ray. Runs of equal visibility become the green and red segments.
 *  - **Target visibility**: the target's top is visible when no intermediate
 *    sample rises above the straight sight line from the eye to it. The first
 *    sample that does is the first obstruction.
 *
 * With curvature on, every elevation is lowered by {@link curvatureDrop} before
 * the comparison, which is equivalent to bending the sight line up over a
 * curved Earth. A sample with no elevation (NaN) never blocks and inherits the
 * visibility of the sample before it.
 *
 * @param profile - Samples from observer to target, as from
 *   {@link sampleGreatCircleProfile}.
 * @param options - Heights and the curvature model.
 * @returns The visibility result.
 * @throws When the profile has fewer than two samples or no ground elevation
 *   under the observer or the target.
 */
export function computeLineOfSight(
  profile: ProfileSample[],
  options: LineOfSightOptions = {},
): LineOfSightResult {
  if (profile.length < 2) throw new Error("A line of sight needs at least two samples.");
  const observerHeight = options.observerHeightMeters ?? DEFAULT_LOS_OBSERVER_HEIGHT_METERS;
  const targetHeight = options.targetHeightMeters ?? DEFAULT_LOS_TARGET_HEIGHT_METERS;
  const curvature = options.curvature ?? true;
  const k = options.refractionCoefficient ?? DEFAULT_REFRACTION_COEFFICIENT;
  const drop = (distance: number) => (curvature ? curvatureDrop(distance, k) : 0);

  const first = profile[0];
  const last = profile[profile.length - 1];
  if (!Number.isFinite(first.elevation) || !Number.isFinite(last.elevation)) {
    throw new Error("No terrain elevation under the observer or the target.");
  }
  const totalDistance = last.distance;
  const eye = first.elevation + observerHeight;
  const targetTop = last.elevation + targetHeight;
  // The target top in the curvature-corrected frame the comparisons run in.
  const targetTopApparent = targetTop - drop(totalDistance);

  /** The sight line's height at `distance`, in the uncorrected frame. */
  const sightlineAt = (distance: number) =>
    totalDistance > 0
      ? eye + ((targetTopApparent - eye) * distance) / totalDistance + drop(distance)
      : eye;

  const samples: LineOfSightSample[] = [];
  let maxSlope = -Infinity;
  let firstObstruction: ProfileSample | null = null;
  let highest: ProfileSample = first;
  let visibleLength = 0;

  for (let i = 0; i < profile.length; i += 1) {
    const sample = profile[i];
    const known = Number.isFinite(sample.elevation);
    if (known && (!Number.isFinite(highest.elevation) || sample.elevation > highest.elevation)) {
      highest = sample;
    }
    let visible: boolean;
    if (i === 0 || sample.distance <= 0) {
      visible = true;
    } else if (!known) {
      visible = samples[i - 1].visible;
    } else {
      const apparent = sample.elevation - drop(sample.distance);
      const slope = (apparent - eye) / sample.distance;
      // At least as steep as the horizon so far: a run of flat ground at a
      // constant slope is not hidden by itself.
      visible = slope >= maxSlope;
      if (slope > maxSlope) maxSlope = slope;
      // Strictly above the line obstructs; grazing it does not, so a flat
      // plane with a zero-height target still reads as visible.
      if (
        firstObstruction === null &&
        i < profile.length - 1 &&
        apparent > sightlineAt(sample.distance) - drop(sample.distance) + 1e-9
      ) {
        firstObstruction = sample;
      }
    }
    if (i > 0) {
      // A step between a visible and a hidden sample counts half: the
      // boundary lies somewhere inside it.
      const ends = Number(visible) + Number(samples[i - 1].visible);
      visibleLength += ((sample.distance - samples[i - 1].distance) * ends) / 2;
    }
    samples.push({ ...sample, visible, sightline: sightlineAt(sample.distance) });
  }

  return {
    samples,
    segments: buildSegments(samples),
    totalDistance,
    observer: { lng: first.lng, lat: first.lat, groundMeters: first.elevation, eyeMeters: eye },
    target: { lng: last.lng, lat: last.lat, groundMeters: last.elevation, topMeters: targetTop },
    targetVisible: firstObstruction === null,
    firstObstruction,
    highestPoint: highest,
    visibleFraction: totalDistance > 0 ? visibleLength / totalDistance : 1,
  };
}

/** Group samples into runs of equal visibility that share boundary vertices. */
function buildSegments(samples: LineOfSightSample[]): LineOfSightSegment[] {
  const segments: LineOfSightSegment[] = [];
  let current: LineOfSightSegment | null = null;
  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i];
    const vertex: [number, number] = [sample.lng, sample.lat];
    // The very first sample is the observer, always "visible"; let it join the
    // segment the next sample starts instead of becoming a zero-length run.
    const visible = i === 0 && samples.length > 1 ? samples[1].visible : sample.visible;
    if (!current || current.visible !== visible) {
      const previous = samples[i - 1];
      current = {
        visible,
        // Start at the previous sample, so the line has no gap between runs.
        coordinates: previous ? [[previous.lng, previous.lat], vertex] : [vertex],
        startDistance: previous ? previous.distance : sample.distance,
        endDistance: sample.distance,
      };
      segments.push(current);
    } else {
      current.coordinates.push(vertex);
      current.endDistance = sample.distance;
    }
  }
  return segments;
}

// --- Terrain sampling --------------------------------------------------------

/** Ground resolution of one Terrarium pixel at a zoom and latitude, in metres. */
export function terrariumResolution(zoom: number, lat: number): number {
  return (156543.03392 * Math.cos(toRadians(lat))) / Math.pow(2, zoom);
}

/** World pixel coordinates of a point at a zoom (256px tiles). */
function worldPixel(lng: number, lat: number, zoom: number): { x: number; y: number } {
  const size = TERRARIUM_TILE_SIZE * Math.pow(2, zoom);
  return { x: ((lng + 180) / 360) * size, y: mercatorY(lat) * size };
}

/** Wrap a tile column into range, so a path across the antimeridian still resolves. */
function wrapTileX(x: number, zoom: number): number {
  const n = Math.pow(2, zoom);
  return ((x % n) + n) % n;
}

const tileKey = (x: number, y: number) => `${x}/${y}`;

/**
 * The tile keys (`"x/y"`) bilinear sampling at these points reads at a zoom,
 * including the neighbour a sample near a tile edge interpolates into.
 *
 * @param points - Where elevations will be read.
 * @param zoom - The tile zoom.
 * @returns The distinct tile keys.
 */
export function tilesForSamples(points: LngLat[], zoom: number): Set<string> {
  const keys = new Set<string>();
  const n = Math.pow(2, zoom);
  for (const point of points) {
    const { x, y } = worldPixel(point.lng, point.lat, zoom);
    const px = Math.floor(x - 0.5);
    const py = Math.floor(y - 0.5);
    for (const [dx, dy] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ]) {
      const ty = Math.floor((py + dy) / TERRARIUM_TILE_SIZE);
      if (ty < 0 || ty >= n) continue;
      keys.add(tileKey(wrapTileX(Math.floor((px + dx) / TERRARIUM_TILE_SIZE), zoom), ty));
    }
  }
  return keys;
}

/**
 * An elevation lookup over decoded tiles at one zoom, bilinear between pixel
 * centres. Reads NaN where a needed tile is missing.
 *
 * @param zoom - The zoom the tiles were fetched at.
 * @param tiles - Decoded elevations keyed `"x/y"`, each 256x256 row-major.
 * @returns A `(lng, lat) => metres` function.
 */
export function createTileElevationSampler(
  zoom: number,
  tiles: Map<string, Float32Array>,
): (lng: number, lat: number) => number {
  const size = TERRARIUM_TILE_SIZE;
  const n = Math.pow(2, zoom);
  const pixel = (px: number, py: number): number => {
    const ty = Math.floor(py / size);
    if (ty < 0 || ty >= n) return Number.NaN;
    const tx = Math.floor(px / size);
    const tile = tiles.get(tileKey(wrapTileX(tx, zoom), ty));
    if (!tile) return Number.NaN;
    const col = px - tx * size;
    const row = py - ty * size;
    return tile[row * size + col];
  };
  return (lng, lat) => {
    const { x, y } = worldPixel(lng, lat, zoom);
    // Pixel i covers [i, i + 1); its value sits at the centre, i + 0.5.
    const fx = x - 0.5;
    const fy = y - 0.5;
    const px = Math.floor(fx);
    const py = Math.floor(fy);
    const tx = fx - px;
    const ty = fy - py;
    const top = pixel(px, py) * (1 - tx) + pixel(px + 1, py) * tx;
    const bottom = pixel(px, py + 1) * (1 - tx) + pixel(px + 1, py + 1) * tx;
    return top * (1 - ty) + bottom * ty;
  };
}

/** The tile zoom and sample points chosen for a path. */
export interface LineOfSightSamplingPlan {
  zoom: number;
  /** Ground resolution of the chosen zoom at the path's mid-latitude, in metres. */
  resolutionMeters: number;
  points: LngLat[];
  tiles: Set<string>;
}

/**
 * Choose a tile zoom and sample spacing for a path.
 *
 * The resolution adapts to the path's length: the finest zoom whose pixels are
 * no smaller than the sample spacing (sampling finer terrain than that would
 * skip ridges between samples rather than resolve them), backed off until the
 * tiles the path crosses fit {@link MAX_LINE_OF_SIGHT_TILES}. A short line on a
 * ridge gets zoom-15 terrain, a 100 km line gets coarser tiles, and only the
 * tiles along the path are fetched, not its whole bounding box.
 *
 * @param from - The observer.
 * @param to - The target.
 * @param maxTiles - The tile budget.
 * @returns The plan.
 */
export function planLineOfSightSampling(
  from: LngLat,
  to: LngLat,
  maxTiles = MAX_LINE_OF_SIGHT_TILES,
): LineOfSightSamplingPlan {
  const total = greatCircleDistance(from, to);
  const midLat = interpolateGreatCircle(from, to, 0.5).lat;
  let plan: LineOfSightSamplingPlan | null = null;
  for (let zoom = TERRARIUM_MAX_ZOOM; zoom >= 0; zoom -= 1) {
    const resolutionMeters = terrariumResolution(zoom, midLat);
    const wanted = Math.ceil(total / resolutionMeters) + 1;
    // Pixels finer than the spacing the sample cap allows: use a coarser zoom.
    if (wanted > MAX_LINE_OF_SIGHT_SAMPLES && zoom > 0) continue;
    const count = Math.min(MAX_LINE_OF_SIGHT_SAMPLES, Math.max(MIN_LINE_OF_SIGHT_SAMPLES, wanted));
    const points: LngLat[] = [];
    for (let i = 0; i < count; i += 1) {
      points.push(interpolateGreatCircle(from, to, i / (count - 1)));
    }
    const tiles = tilesForSamples(points, zoom);
    plan = { zoom, resolutionMeters, points, tiles };
    if (tiles.size <= maxTiles) break;
  }
  // Zoom 0 is a single tile, so the loop always ends with a plan.
  return plan!;
}

export interface FetchLineOfSightProfileOptions {
  from: LngLat;
  to: LngLat;
  signal?: AbortSignal;
  /** Override the tile template (tests, or a self-hosted terrain source). */
  tileUrl?: string;
  maxTiles?: number;
}

export interface LineOfSightProfile {
  samples: ProfileSample[];
  zoom: number;
  resolutionMeters: number;
}

/**
 * Fetch terrain along a path and sample it into a profile.
 *
 * Tiles that fail to load leave their samples as NaN rather than aborting, as
 * the viewshed's assembly does; {@link computeLineOfSight} skips them.
 *
 * @param options - The two points and fetch options.
 * @returns The profile, or null when the path is degenerate, too long, or no
 *   terrain could be read under its endpoints.
 */
export async function fetchLineOfSightProfile(
  options: FetchLineOfSightProfileOptions,
): Promise<LineOfSightProfile | null> {
  const { from, to, signal, tileUrl = TERRARIUM_TILE_URL } = options;
  const total = greatCircleDistance(from, to);
  if (
    !Number.isFinite(total) ||
    total < MIN_LINE_OF_SIGHT_METERS ||
    total > MAX_LINE_OF_SIGHT_METERS
  )
    return null;
  // Web Mercator tiles stop at ~85 degrees.
  if (Math.abs(from.lat) > 85 || Math.abs(to.lat) > 85) return null;

  const plan = planLineOfSightSampling(from, to, options.maxTiles);
  const tiles = new Map<string, Float32Array>();
  await Promise.all(
    [...plan.tiles].map(async (key) => {
      const [x, y] = key.split("/");
      const url = tileUrl.replace("{z}", String(plan.zoom)).replace("{x}", x).replace("{y}", y);
      const tile = await decodeTile(url, signal);
      if (!tile || tile.width !== TERRARIUM_TILE_SIZE || tile.height !== TERRARIUM_TILE_SIZE) {
        return;
      }
      tiles.set(key, tile.values);
    }),
  );
  if (signal?.aborted || tiles.size === 0) return null;

  const elevationAt = createTileElevationSampler(plan.zoom, tiles);
  const samples = sampleGreatCircleProfile(from, to, plan.points.length, elevationAt);
  if (!Number.isFinite(samples[0].elevation) || !Number.isFinite(samples.at(-1)!.elevation)) {
    return null;
  }
  return { samples, zoom: plan.zoom, resolutionMeters: plan.resolutionMeters };
}
