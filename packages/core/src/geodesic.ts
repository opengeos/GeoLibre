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
  // Signed result (counter-clockwise positive), so a clockwise ring gives the
  // negative of its own area rather than the area of the rest of the body.
  return Math.abs(polygon.Compute(false, true).area ?? 0);
}
