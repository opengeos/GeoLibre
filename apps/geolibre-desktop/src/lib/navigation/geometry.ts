/**
 * Small geodesy helpers for the turn-by-turn navigation tool: distances,
 * bearings, and projecting a GPS fix onto a route polyline. Everything works on
 * `[lng, lat]` pairs in degrees and returns metres or degrees, and none of it
 * touches the map, so the navigation engine stays a pure function of its input.
 */

/** Mean Earth radius in metres (the IUGG value the routers also use). */
export const EARTH_RADIUS_M = 6_371_008.8;

const RAD = Math.PI / 180;

/** A `[lng, lat]` coordinate pair in degrees. */
export type LngLat = [number, number];

/**
 * Great-circle distance between two points.
 *
 * @param a - The first point.
 * @param b - The second point.
 * @returns The distance in metres.
 */
export function haversine(a: LngLat, b: LngLat): number {
  const dLat = (b[1] - a[1]) * RAD;
  const dLng = (b[0] - a[0]) * RAD;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Initial bearing from one point to another.
 *
 * @param a - The start point.
 * @param b - The end point.
 * @returns The bearing in degrees clockwise from north, in [0, 360).
 */
export function bearing(a: LngLat, b: LngLat): number {
  const lat1 = a[1] * RAD;
  const lat2 = b[1] * RAD;
  const dLng = (b[0] - a[0]) * RAD;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return normalizeBearing(Math.atan2(y, x) / RAD);
}

/**
 * Wrap an angle into [0, 360).
 *
 * @param degrees - Any angle in degrees.
 * @returns The same direction in [0, 360).
 */
export function normalizeBearing(degrees: number): number {
  const wrapped = degrees % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/**
 * The smallest angle between two bearings.
 *
 * @param a - A bearing in degrees.
 * @param b - Another bearing in degrees.
 * @returns The difference in degrees, in [0, 180].
 */
export function bearingDifference(a: number, b: number): number {
  const diff = Math.abs(normalizeBearing(a) - normalizeBearing(b));
  return diff > 180 ? 360 - diff : diff;
}

/**
 * Running distance along a polyline at each vertex.
 *
 * @param coordinates - The polyline's vertices.
 * @returns One entry per vertex; the first is 0 and the last the line's length.
 */
export function cumulativeDistances(coordinates: LngLat[]): number[] {
  const out: number[] = new Array(coordinates.length);
  let total = 0;
  for (let i = 0; i < coordinates.length; i += 1) {
    if (i > 0) total += haversine(coordinates[i - 1], coordinates[i]);
    out[i] = total;
  }
  return out;
}

/** Where a point lands on a polyline. */
export interface PolylineProjection {
  /** The closest point on the line. */
  point: LngLat;
  /** Distance along the line to {@link point}, in metres. */
  along: number;
  /** Distance from the input point to the line, in metres. */
  offset: number;
  /** Index of the segment's first vertex. */
  segmentIndex: number;
}

/**
 * Project a point onto the segments of a polyline, optionally only those that
 * overlap a window of distance along it.
 *
 * Each segment is measured in a local equirectangular plane centred on the
 * point, which is accurate to well under a metre at the few-hundred-metre
 * scale a GPS fix sits from its road.
 *
 * @param coordinates - The polyline's vertices.
 * @param cumulative - {@link cumulativeDistances} of the same vertices.
 * @param point - The point to project.
 * @param window - Optional `[from, to]` range of distance along the line;
 *   segments entirely outside it are skipped.
 * @returns The closest projection, or null for a line with fewer than two
 *   vertices or a window that covers no segment.
 */
export function projectOntoPolyline(
  coordinates: LngLat[],
  cumulative: number[],
  point: LngLat,
  window?: [number, number],
): PolylineProjection | null {
  if (coordinates.length < 2) return null;
  const cosLat = Math.cos(point[1] * RAD);
  const toLocal = (c: LngLat): [number, number] => [
    (c[0] - point[0]) * RAD * EARTH_RADIUS_M * cosLat,
    (c[1] - point[1]) * RAD * EARTH_RADIUS_M,
  ];
  let best: PolylineProjection | null = null;
  for (let i = 0; i < coordinates.length - 1; i += 1) {
    if (window && (cumulative[i + 1] < window[0] || cumulative[i] > window[1])) continue;
    const [ax, ay] = toLocal(coordinates[i]);
    const [bx, by] = toLocal(coordinates[i + 1]);
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSq = dx * dx + dy * dy;
    const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSq));
    const px = ax + t * dx;
    const py = ay + t * dy;
    const offset = Math.hypot(px, py);
    if (best && offset >= best.offset) continue;
    const a = coordinates[i];
    const b = coordinates[i + 1];
    best = {
      point: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])],
      along: cumulative[i] + t * (cumulative[i + 1] - cumulative[i]),
      offset,
      segmentIndex: i,
    };
  }
  return best;
}

/**
 * Index of the segment that holds a distance along the line (binary search).
 *
 * @param cumulative - {@link cumulativeDistances} of the line.
 * @param along - Distance along the line in metres.
 * @returns The index of the segment's first vertex.
 */
export function segmentAt(cumulative: number[], along: number): number {
  let lo = 0;
  let hi = cumulative.length - 2;
  if (hi < 0) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cumulative[mid] <= along) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * The point at a distance along a polyline.
 *
 * @param coordinates - The polyline's vertices.
 * @param cumulative - {@link cumulativeDistances} of the same vertices.
 * @param along - Distance along the line in metres; clamped to the line.
 * @returns The interpolated point.
 */
export function pointAlong(coordinates: LngLat[], cumulative: number[], along: number): LngLat {
  if (coordinates.length === 0) return [0, 0];
  if (coordinates.length === 1 || along <= 0) return coordinates[0];
  const total = cumulative[cumulative.length - 1];
  if (along >= total) return coordinates[coordinates.length - 1];
  const i = segmentAt(cumulative, along);
  const span = cumulative[i + 1] - cumulative[i];
  const t = span > 0 ? (along - cumulative[i]) / span : 0;
  const a = coordinates[i];
  const b = coordinates[i + 1];
  return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
}

/**
 * The direction of travel at a distance along a polyline, read over a short
 * look-ahead so a tiny kink in the geometry does not swing the camera.
 *
 * @param coordinates - The polyline's vertices.
 * @param cumulative - {@link cumulativeDistances} of the same vertices.
 * @param along - Distance along the line in metres.
 * @param lookAhead - How far ahead to aim, in metres (default 20).
 * @returns The bearing in degrees, or 0 for a degenerate line.
 */
export function bearingAlong(
  coordinates: LngLat[],
  cumulative: number[],
  along: number,
  lookAhead = 20,
): number {
  if (coordinates.length < 2) return 0;
  const total = cumulative[cumulative.length - 1];
  const from = Math.min(along, Math.max(0, total - lookAhead));
  const a = pointAlong(coordinates, cumulative, from);
  const b = pointAlong(coordinates, cumulative, Math.min(total, from + lookAhead));
  if (a[0] === b[0] && a[1] === b[1]) {
    const i = Math.min(segmentAt(cumulative, along), coordinates.length - 2);
    return bearing(coordinates[i], coordinates[i + 1]);
  }
  return bearing(a, b);
}

/**
 * The part of a polyline between two distances along it.
 *
 * @param coordinates - The polyline's vertices.
 * @param cumulative - {@link cumulativeDistances} of the same vertices.
 * @param from - Start distance in metres.
 * @param to - End distance in metres.
 * @returns The sub-line's vertices (at least two when `to > from`).
 */
export function sliceAlong(
  coordinates: LngLat[],
  cumulative: number[],
  from: number,
  to: number,
): LngLat[] {
  if (coordinates.length < 2 || to <= from) return [];
  const out: LngLat[] = [pointAlong(coordinates, cumulative, from)];
  for (let i = 0; i < coordinates.length; i += 1) {
    if (cumulative[i] > from && cumulative[i] < to) out.push(coordinates[i]);
  }
  out.push(pointAlong(coordinates, cumulative, to));
  return out;
}
