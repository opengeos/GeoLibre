/**
 * Antimeridian-aware extents.
 *
 * A plain min/max over longitudes reads a layer with features at 179° and
 * -179° as spanning 358°, so zooming to it frames the whole globe instead of
 * the two-degree cluster it really covers (Alaska's Aleutians, Fiji, a run of
 * Pacific earthquakes). The helpers here take the short way round instead: the
 * longitude extent is the circle minus its widest stretch with no data in it.
 *
 * Results use the unwrapped form MapLibre's `getBounds()` reports (see
 * `MapExtent` in `@geolibre/map`): `west` in `[-180, 180]` and `west <= east`
 * always, with an extent that crosses the antimeridian carrying `east > 180`
 * rather than inverting the pair. MapLibre and Mapbox fit such a box directly;
 * a consumer that needs the RFC 7946 form (`west > east`) subtracts 360 from
 * `east` (see {@link toRfc7946Bbox}).
 */

import type { Geometry, GeoJSON, Position } from "geojson";

import { horizontalBbox } from "./geojson-z";

/** A `[west, south, east, north]` box; `east` may exceed 180 (see the module doc). */
export type LonLatExtent = [west: number, south: number, east: number, north: number];

/**
 * The shortest longitude arc covering every interval, as `[west, east]`.
 *
 * Each interval is a `[min, max]` pair of longitudes in degrees (a point is
 * `[x, x]`). One whose `max` exceeds 180 is read as crossing the antimeridian,
 * the way {@link LonLatExtent} writes it, and an RFC 7946 pair with
 * `min > max` is read the same way. An interval 360° or wider covers the
 * whole circle.
 *
 * The arc is the complement of the widest gap between the intervals. When the
 * gap that contains the antimeridian is at least as wide as any other, the
 * answer is the plain `[min, max]`, so data that does not benefit from wrapping
 * keeps exactly the extent it always had.
 *
 * @param intervals - Longitude intervals in degrees.
 * @returns `[west, east]` with `west <= east` and `east` possibly above 180,
 *   or `null` when no interval has finite bounds.
 */
export function shortestLongitudeExtent(
  intervals: Iterable<readonly [number, number]>,
): [number, number] | null {
  const pieces: Array<[number, number]> = [];
  let plainMin = Number.POSITIVE_INFINITY;
  let plainMax = Number.NEGATIVE_INFINITY;
  let simple = true;
  for (const [rawMin, rawMax] of intervals) {
    if (!Number.isFinite(rawMin) || !Number.isFinite(rawMax)) continue;
    // RFC 7946: a box whose west exceeds its east crosses the antimeridian.
    const min = rawMin;
    const max = rawMax < rawMin ? rawMax + 360 : rawMax;
    if (max - min >= 360) return [-180, 180];
    if (min < plainMin) plainMin = min;
    if (max > plainMax) plainMax = max;
    if (min < -180 || max > 180) simple = false;
    pieces.push([min, max]);
  }
  if (pieces.length === 0) return null;
  // Gaps sum to 360 minus the covered length, so when the plain extent is at
  // most a hemisphere, the gap across the antimeridian (at least 180°) is the
  // widest one and the plain extent is already the answer. This keeps the
  // common case free of the sort below.
  if (simple && plainMax - plainMin <= 180) return [plainMin, plainMax];

  // Bring every interval onto the circle [-180, 180), splitting one that
  // crosses the antimeridian into its two sides.
  const onCircle: Array<[number, number]> = [];
  for (const [min, max] of pieces) {
    const start = ((((min + 180) % 360) + 360) % 360) - 180;
    const end = start + (max - min);
    if (end <= 180) {
      onCircle.push([start, end]);
    } else {
      onCircle.push([start, 180], [-180, end - 360]);
    }
  }
  onCircle.sort((a, b) => a[0] - b[0]);

  // Merge overlapping intervals.
  const merged: Array<[number, number]> = [];
  for (const [start, end] of onCircle) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) {
      if (end > last[1]) last[1] = end;
    } else {
      merged.push([start, end]);
    }
  }

  const first = merged[0];
  const last = merged[merged.length - 1];
  // The gap across the antimeridian, from the last interval round to the first.
  const wrapGap = first[0] + 360 - last[1];
  let widest = wrapGap;
  let before = -1;
  for (let i = 0; i < merged.length - 1; i++) {
    const gap = merged[i + 1][0] - merged[i][1];
    if (gap > widest) {
      widest = gap;
      before = i;
    }
  }
  if (before === -1) return [first[0], last[1]];
  // The arc runs from the interval just after the widest gap round to the one
  // just before it, which sits a full turn further east.
  return [merged[before + 1][0], merged[before][1] + 360];
}

/** The outer longitude interval and latitude range of one geometry part. */
interface PartExtent {
  minLon: number;
  maxLon: number;
  minLat: number;
  maxLat: number;
}

/**
 * Extent of a run of positions, or null when none is finite.
 *
 * @param positions - The positions to measure.
 */
function positionsExtent(positions: readonly Position[]): PartExtent | null {
  let minLon = Number.POSITIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  for (const position of positions) {
    const lon = position?.[0];
    const lat = position?.[1];
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return minLon === Number.POSITIVE_INFINITY ? null : { minLon, maxLon, minLat, maxLat };
}

/**
 * The `[min, max]` longitude of every contiguous part of a geometry (each
 * point, each line, each polygon's outer ring), the intervals
 * {@link shortestLongitudeExtent} combines.
 *
 * @param geometry - The geometry to walk; null yields no intervals.
 */
export function partLongitudeIntervals(
  geometry: Geometry | null | undefined,
): Array<[number, number]> {
  const parts: PartExtent[] = [];
  collectParts(geometry, parts);
  return parts.map((part) => [part.minLon, part.maxLon]);
}

/**
 * Collect the parts of a geometry whose longitudes are contiguous: each point,
 * each line, and each polygon's outer ring (its holes lie inside it). RFC 7946
 * asks for a geometry that crosses the antimeridian to be split into such parts,
 * so these are the pieces the extent is assembled from. An unsplit part that
 * jumps across 180° reads as near-global, as MapLibre also draws it.
 *
 * @param geometry - The geometry to walk; null and malformed members are skipped.
 * @param out - Receives one extent per part.
 */
function collectParts(geometry: Geometry | null | undefined, out: PartExtent[]): void {
  if (!geometry || typeof geometry !== "object") return;
  const push = (positions: unknown) => {
    if (!Array.isArray(positions)) return;
    const part = positionsExtent(positions as Position[]);
    if (part) out.push(part);
  };
  switch (geometry.type) {
    case "Point":
      push([geometry.coordinates]);
      break;
    case "MultiPoint":
      for (const position of geometry.coordinates ?? []) push([position]);
      break;
    case "LineString":
      push(geometry.coordinates);
      break;
    case "MultiLineString":
      for (const line of geometry.coordinates ?? []) push(line);
      break;
    case "Polygon":
      push(geometry.coordinates?.[0]);
      break;
    case "MultiPolygon":
      for (const polygon of geometry.coordinates ?? []) push(polygon?.[0]);
      break;
    case "GeometryCollection":
      for (const member of geometry.geometries ?? []) collectParts(member, out);
      break;
    default:
      break;
  }
}

/**
 * The extent of a GeoJSON object, taking the short way round the antimeridian.
 *
 * Like `@turf/bbox` it honours an object's own `bbox` member (an RFC 7946 box
 * with `west > east` is unwrapped to `east > 180`), and otherwise walks the
 * coordinates. Unlike it, a layer whose parts sit on both sides of the
 * antimeridian gets the narrow extent across it rather than a near-global one.
 *
 * @param geojson - A FeatureCollection, Feature, or bare geometry.
 * @returns The extent as `[west, south, east, north]` with `east` possibly
 *   above 180, or null when nothing in it has finite coordinates.
 */
export function antimeridianAwareBbox(geojson: GeoJSON | null | undefined): LonLatExtent | null {
  if (!geojson || typeof geojson !== "object") return null;
  const own = horizontalBbox(geojson.bbox);
  if (own) {
    const [west, south, east, north] = own;
    // An RFC 7946 box across the antimeridian, or one no wider than a
    // hemisphere, is already the short extent. A wider conventional box may be
    // a plain min/max over data split at 180°, so measure the coordinates.
    if (west > east) return [west, south, east + 360, north];
    if (east - west <= 180) return own;
  }
  const measured = measureParts(geojson);
  return measured ?? own;
}

/**
 * The short-way-round extent of a GeoJSON object's coordinates, ignoring any
 * `bbox` member.
 *
 * @param geojson - A FeatureCollection, Feature, or bare geometry.
 */
function measureParts(geojson: GeoJSON): LonLatExtent | null {
  const parts: PartExtent[] = [];
  if (geojson.type === "FeatureCollection") {
    for (const feature of geojson.features ?? []) collectParts(feature?.geometry, parts);
  } else if (geojson.type === "Feature") {
    collectParts(geojson.geometry, parts);
  } else {
    collectParts(geojson, parts);
  }
  if (parts.length === 0) return null;
  let south = Number.POSITIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  for (const part of parts) {
    if (part.minLat < south) south = part.minLat;
    if (part.maxLat > north) north = part.maxLat;
  }
  const lon = shortestLongitudeExtent(parts.map((part) => [part.minLon, part.maxLon]));
  return lon ? [lon[0], south, lon[1], north] : null;
}

/**
 * Combine several extents into the smallest one covering them all, taking the
 * short way round the antimeridian. Each input may be in either the unwrapped
 * (`east > 180`) or the RFC 7946 (`west > east`) form.
 *
 * @param boxes - The extents to combine; non-finite ones are skipped.
 * @returns The combined extent, or null when there is none.
 */
export function unionLonLatExtents(
  boxes: Iterable<readonly [number, number, number, number]>,
): LonLatExtent | null {
  const intervals: Array<[number, number]> = [];
  let south = Number.POSITIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  for (const box of boxes) {
    if (!box || !box.every((value) => Number.isFinite(value))) continue;
    intervals.push([box[0], box[2]]);
    south = Math.min(south, box[1], box[3]);
    north = Math.max(north, box[1], box[3]);
  }
  const lon = shortestLongitudeExtent(intervals);
  return lon ? [lon[0], south, lon[1], north] : null;
}

/**
 * Rewrite an unwrapped extent (`east > 180`) in the RFC 7946 / STAC form, where
 * longitudes stay within ±180 and a box crossing the antimeridian has
 * `west > east`. A box that does not cross it, or covers the whole circle, is
 * returned unchanged.
 *
 * @param box - The extent to rewrite.
 */
export function toRfc7946Bbox(box: readonly [number, number, number, number]): LonLatExtent {
  const [west, south, east, north] = box;
  if (east > 180 && east - west < 360) return [west, south, east - 360, north];
  return [west, south, east, north];
}
