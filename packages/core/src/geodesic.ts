/**
 * Distances and areas on the active body's ellipsoid, for the Field Calculator
 * and the processing tools.
 *
 * The geodesic math is Charles Karney's GeographicLib (`geographiclib-geodesic`,
 * MIT, no dependencies), the same algorithms PROJ's `geod` and pyproj use, with
 * errors of a few nanometres. This is the only module that imports it, so
 * replacing the package (for example with a vendored copy) touches this file
 * alone.
 *
 * Each helper takes an optional ellipsoid and defaults to the active one
 * (`ellipsoids.ts`), so the Moon and Mars are measured on their own figure
 * rather than on Earth scaled by a radius ratio. Positions are GeoJSON
 * `[lon, lat]` degrees; any Z is ignored.
 *
 * Workers import it as `@geolibre/core/geodesic` rather than through
 * `worker-safe`, so the workers that need no measurements don't bundle
 * GeographicLib.
 */
import geographiclib from "geographiclib-geodesic";
import type { Position } from "geojson";
import { getActiveEllipsoid, type Ellipsoid } from "./ellipsoids";

type GeodesicSolver = InstanceType<typeof geographiclib.Geodesic.Geodesic>;

// One solver per ellipsoid: construction precomputes series coefficients that
// every later call reuses.
const solvers = new WeakMap<Ellipsoid, GeodesicSolver>();

function solverFor(ellipsoid: Ellipsoid): GeodesicSolver {
  let solver = solvers.get(ellipsoid);
  if (!solver) {
    // `inverseFlattening: 0` marks a sphere, which GeographicLib takes as f = 0.
    const f = ellipsoid.inverseFlattening ? 1 / ellipsoid.inverseFlattening : 0;
    solver = new geographiclib.Geodesic.Geodesic(ellipsoid.semiMajorAxisMeters, f);
    solvers.set(ellipsoid, solver);
  }
  return solver;
}

/** Geodesic (shortest-path) distance in metres between two positions. */
export function geodesicDistance(
  from: Position,
  to: Position,
  ellipsoid: Ellipsoid = getActiveEllipsoid(),
): number {
  return solverFor(ellipsoid).Inverse(
    from[1],
    from[0],
    to[1],
    to[0],
    geographiclib.Geodesic.DISTANCE,
  ).s12!;
}

const DEG_TO_RAD = Math.PI / 180;

/**
 * Central angle in radians between two positions, taking their geodetic
 * latitude and longitude as coordinates on a sphere. Much cheaper than
 * {@link geodesicDistance}; with {@link geodesicRadiusBounds} it bounds a
 * geodesic distance without computing it, which lets the O(n²) loops skip most
 * pairs.
 */
export function centralAngle(from: Position, to: Position): number {
  const lat1 = from[1] * DEG_TO_RAD;
  const lat2 = to[1] * DEG_TO_RAD;
  const dLon = (to[0] - from[0]) * DEG_TO_RAD;
  const h =
    Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  // The haversine is well conditioned up to 90° (h <= 0.5), the common case
  // in the neighbour searches. Beyond, asin loses precision towards the
  // antipode, so the atan2 form takes over.
  if (h <= 0.5) return 2 * Math.asin(Math.sqrt(h));
  const sinLat1 = Math.sin(lat1);
  const cosLat1 = Math.cos(lat1);
  const sinLat2 = Math.sin(lat2);
  const cosLat2 = Math.cos(lat2);
  const cosDLon = Math.cos(dLon);
  const x = cosLat2 * Math.sin(dLon);
  const y = cosLat1 * sinLat2 - sinLat1 * cosLat2 * cosDLon;
  const z = sinLat1 * sinLat2 + cosLat1 * cosLat2 * cosDLon;
  return Math.atan2(Math.hypot(x, y), z);
}

/**
 * Radii in metres such that, for any two positions,
 * `min * centralAngle(p, q) <= geodesicDistance(p, q) <= max * centralAngle(p, q)`.
 *
 * Why it holds: send each point of the ellipsoid to the point of the unit
 * sphere with the same latitude and longitude. The line element is
 * ds² = M² dφ² + N² cos²φ dλ² on the ellipsoid and dφ² + cos²φ dλ² on the
 * sphere, and both radii of curvature M and N lie between b²/a (M at the
 * equator) and a²/b (both at the poles). Every curve on one surface is
 * therefore between b²/a and a²/b times as long as its image on the other, and
 * so are the shortest paths. On Earth that is 6,335,439 m to 6,399,594 m, within
 * 0.6 % of the mean radius; on a sphere both radii equal its radius. On a
 * prolate figure (b > a, a negative inverse flattening) the two swap, hence the
 * min and max. The 1e-9 margin covers rounding in the central angle and in
 * GeographicLib.
 */
export function geodesicRadiusBounds(ellipsoid: Ellipsoid = getActiveEllipsoid()): {
  min: number;
  max: number;
} {
  const a = ellipsoid.semiMajorAxisMeters;
  const b = ellipsoid.inverseFlattening ? a * (1 - 1 / ellipsoid.inverseFlattening) : a;
  const meridianAtEquator = (b * b) / a;
  const atPole = (a * a) / b;
  return {
    min: Math.min(meridianAtEquator, atPole) * (1 - 1e-9),
    max: Math.max(meridianAtEquator, atPole) * (1 + 1e-9),
  };
}

/**
 * Whether two positions are at most `meters` apart along the geodesic. The
 * answer is the same as comparing {@link geodesicDistance}, which is only
 * computed when the {@link geodesicRadiusBounds} cannot decide.
 */
export function withinGeodesicDistance(
  from: Position,
  to: Position,
  meters: number,
  ellipsoid: Ellipsoid = getActiveEllipsoid(),
): boolean {
  const bounds = geodesicRadiusBounds(ellipsoid);
  const angle = centralAngle(from, to);
  if (angle * bounds.max <= meters) return true;
  if (angle * bounds.min > meters) return false;
  return geodesicDistance(from, to, ellipsoid) <= meters;
}

/** Summed geodesic length in metres along a run of positions. */
export function geodesicLength(
  positions: readonly Position[],
  ellipsoid: Ellipsoid = getActiveEllipsoid(),
): number {
  let total = 0;
  for (let i = 1; i < positions.length; i += 1) {
    total += geodesicDistance(positions[i - 1], positions[i], ellipsoid);
  }
  return total;
}

/**
 * Area in square metres enclosed by one ring, whatever its winding order. The
 * ring may be open or closed. Edges are geodesics, so a ring that crosses the
 * antimeridian or encircles a pole is measured correctly.
 */
export function geodesicRingArea(
  ring: readonly Position[],
  ellipsoid: Ellipsoid = getActiveEllipsoid(),
): number {
  if (ring.length < 3) return 0;
  const polygon = solverFor(ellipsoid).Polygon(false);
  for (const position of ring) polygon.AddPoint(position[1], position[0]);
  // `sign = true` reports a signed area, counter-clockwise positive, in
  // (-half, +half] of the body. Its absolute value is the area the ring
  // encloses for either winding, including a ring around a pole; a ring that
  // bounds more than half the body is measured as the smaller side.
  return Math.abs(polygon.Compute(false, true).area ?? 0);
}

/**
 * Area in square metres of the box bounded by the meridians `west` and `east`
 * and the parallels `south` and `north` (degrees). `east - west` may span up
 * to 360°; latitudes are clamped to ±90°.
 *
 * Its edges along parallels are not geodesics, so this is the closed form for
 * a zone of the ellipsoid, b² Δλ [F(φ₂) − F(φ₁)] with
 * F(φ) = sin φ / (2 (1 − e² sin² φ)) + atanh(e sin φ) / (2e), which reduces to
 * R² Δλ (sin φ₂ − sin φ₁) on a sphere and uses atan for a prolate figure
 * (e² < 0). It holds up to the whole body, unlike a ring of geodesics, which
 * would go the short way round a box wider than 180°.
 */
export function latLonBoxArea(
  west: number,
  south: number,
  east: number,
  north: number,
  ellipsoid: Ellipsoid = getActiveEllipsoid(),
): number {
  const a = ellipsoid.semiMajorAxisMeters;
  const f = ellipsoid.inverseFlattening ? 1 / ellipsoid.inverseFlattening : 0;
  const b = a * (1 - f);
  const e2 = f * (2 - f);
  const e = Math.sqrt(Math.abs(e2));
  const zone = (lat: number): number => {
    const s = Math.sin(Math.max(-90, Math.min(90, lat)) * DEG_TO_RAD);
    if (e === 0) return s;
    const tail = e2 > 0 ? Math.atanh(e * s) : Math.atan(e * s);
    return s / (2 * (1 - e2 * s * s)) + tail / (2 * e);
  };
  const dLon = Math.max(0, Math.min(360, east - west)) * DEG_TO_RAD;
  return b * b * dLon * Math.abs(zone(north) - zone(south));
}

/**
 * Whether a position is a usable lon/lat: both finite and |lat| <= 90°.
 * GeographicLib returns NaN for latitudes beyond the poles.
 */
export function isLonLat(position: Position): boolean {
  const [lon, lat] = position;
  return Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lat) <= 90;
}
