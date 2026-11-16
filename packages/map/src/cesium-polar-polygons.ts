import type { Feature, MultiPolygon, Position } from "geojson";

/**
 * Widest longitude span (degrees) of one slice. Cesium triangulates a polygon
 * on a tangent plane, which works for a quarter of the globe around a pole but
 * not for half of it (a 180-degree slice of Antarctica still fails).
 */
const SLICE_DEGREES = 90;

/** Tolerance (degrees) for a ring's total longitude winding to count as a full turn. */
const WINDING_TOLERANCE = 1;

/** The signed longitude step from `a` to `b`, taking the short way round. */
function lonStep(a: number, b: number): number {
  let d = b - a;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

/** A ring without the repeated closing vertex GeoJSON puts at its end. */
function openRing(ring: Position[]): Position[] {
  if (ring.length < 2) return ring;
  const first = ring[0];
  const last = ring[ring.length - 1];
  return first[0] === last[0] && first[1] === last[1] ? ring.slice(0, -1) : ring;
}

/**
 * The ring's total longitude turn in degrees: about ±360 for a ring that
 * goes round a pole (Antarctica's outline), about 0 for any other ring.
 */
function ringWinding(ring: Position[]): number {
  let total = 0;
  for (let i = 0; i < ring.length; i++)
    total += lonStep(ring[i][0], ring[(i + 1) % ring.length][0]);
  return total;
}

/** Whether a ring goes all the way round a pole. */
function wrapsPole(ring: Position[]): boolean {
  return Math.abs(Math.abs(ringWinding(openRing(ring))) - 360) < WINDING_TOLERANCE;
}

/**
 * The ring with continuous longitudes (no ±180 jump), so it is a simple
 * polygon in the plane. A pole-wrapping ring is closed along the pole it goes
 * round, which turns the band it encloses into an ordinary planar shape.
 */
function unrollRing(ring: Position[]): Position[] {
  const open = openRing(ring);
  if (open.length === 0) return [];
  const out: Position[] = [[...open[0]]];
  for (let i = 1; i < open.length; i++) {
    const lon = out[i - 1][0] + lonStep(open[i - 1][0], open[i][0]);
    out.push([lon, ...open[i].slice(1)]);
  }
  const winding = ringWinding(open);
  if (Math.abs(Math.abs(winding) - 360) < WINDING_TOLERANCE) {
    const meanLat = open.reduce((sum, p) => sum + p[1], 0) / open.length;
    const pole = meanLat < 0 ? -90 : 90;
    const turn = winding > 0 ? 360 : -360;
    const first = open[0];
    const closeLon = out[0][0] + turn;
    out.push([closeLon, ...first.slice(1)]);
    out.push([closeLon, pole, ...first.slice(2)]);
    out.push([out[0][0], pole, ...first.slice(2)]);
  }
  return out;
}

/**
 * Clip a planar ring to one side of a meridian (Sutherland-Hodgman).
 * Coordinates beyond longitude/latitude (a height) are interpolated too.
 */
function clipRing(ring: Position[], lon: number, keepEast: boolean): Position[] {
  const out: Position[] = [];
  const inside = (p: Position) => (keepEast ? p[0] >= lon : p[0] <= lon);
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const aIn = inside(a);
    if (aIn) out.push(a);
    if (aIn !== inside(b)) {
      const t = (lon - a[0]) / (b[0] - a[0]);
      out.push(a.map((v, k) => (k === 0 ? lon : v + t * ((b[k] ?? v) - v))));
    }
  }
  return out;
}

/** Twice the signed planar area of a ring (0 for a degenerate sliver). */
function ringArea(ring: Position[]): number {
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  return area;
}

/** A closed GeoJSON ring from an open one. */
function closeRing(ring: Position[]): Position[] {
  return [...ring, [...ring[0]]];
}

/**
 * Cut one polygon whose outer ring goes round a pole into slices at most
 * {@link SLICE_DEGREES} wide.
 *
 * @param rings - The polygon's rings, outer first.
 * @returns The slices as polygon coordinate arrays.
 */
function slicePolarPolygon(rings: Position[][]): Position[][][] {
  const outer = unrollRing(rings[0]);
  // A loop, not Math.min(...lons): a dense ring would overflow the argument limit.
  let west = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  for (const p of outer) {
    west = Math.min(west, p[0]);
    east = Math.max(east, p[0]);
  }
  // Holes keep their own longitudes. A hole near the unrolling seam can sit
  // partly at each end of the outer ring's range, so each is offered to the
  // clip a whole turn either side as well; the copies outside the range clip
  // away.
  const holes = rings.slice(1).flatMap((hole) => {
    const unrolled = unrollRing(hole);
    if (unrolled.length === 0) return [];
    return [-360, 0, 360].map((shift) =>
      shift === 0 ? unrolled : unrolled.map((p) => [p[0] + shift, ...p.slice(1)]),
    );
  });
  const slices: Position[][][] = [];
  for (let start = west; start < east; start += SLICE_DEGREES) {
    const end = Math.min(start + SLICE_DEGREES, east);
    const clip = (ring: Position[]) => clipRing(clipRing(ring, start, true), end, false);
    const shell = clip(outer);
    if (shell.length < 3 || Math.abs(ringArea(shell)) < 1e-12) continue;
    const slice = [closeRing(shell)];
    for (const hole of holes) {
      const part = clip(hole);
      if (part.length >= 3 && Math.abs(ringArea(part)) >= 1e-12) slice.push(closeRing(part));
    }
    slices.push(slice);
  }
  return slices;
}

/**
 * Furthest latitude (degrees) a polygon vertex is given to Cesium. A vertex
 * exactly on a pole has no rhumb heading, so the shadow-volume walls of a
 * ground polygon through it throw `RangeError: Invalid array length`; 0.001
 * degrees (about 110 m) short of the pole draws the same.
 */
const MAX_POLYGON_LATITUDE = 89.999;

/** Whether any vertex of the rings sits beyond {@link MAX_POLYGON_LATITUDE}. */
function touchesPole(rings: Position[][]): boolean {
  return rings.some((ring) => ring.some((p) => Math.abs(p[1]) > MAX_POLYGON_LATITUDE));
}

/** The rings with every vertex held to {@link MAX_POLYGON_LATITUDE}. */
function clampPolarRings(rings: Position[][]): Position[][] {
  return rings.map((ring) =>
    ring.map((p) =>
      Math.abs(p[1]) > MAX_POLYGON_LATITUDE
        ? [p[0], Math.sign(p[1]) * MAX_POLYGON_LATITUDE, ...p.slice(2)]
        : p,
    ),
  );
}

/**
 * Make polygons that reach or go round a pole drawable on the Cesium globe
 * (#3476).
 *
 * Cesium triangulates a polygon on a plane tangent to the globe, which cannot
 * hold a ring that circles a pole. Antarctica in Natural Earth's countries
 * (closed along the South Pole across the antimeridian) made the polygon
 * worker throw `RangeError: Too many properties to enumerate`; the globe's
 * render loop stopped with Cesium's error panel, and the countries batched
 * with it (Canada, Mexico, ...) never drew. Such a polygon is cut into
 * quarter-globe slices of one MultiPolygon, which Cesium draws as separate
 * pieces of one fill, and vertices on a pole are pulled just short of it.
 * Every other geometry is returned unchanged.
 *
 * @param feature - A GeoJSON feature.
 * @returns The feature itself when no polygon reaches or wraps a pole, else a
 *   copy with those polygons sliced and clamped.
 */
export function slicePoleWrappingPolygons(feature: Feature): Feature {
  const geometry = feature.geometry;
  if (!geometry) return feature;
  let polygons: Position[][][];
  if (geometry.type === "Polygon") polygons = [geometry.coordinates];
  else if (geometry.type === "MultiPolygon") polygons = geometry.coordinates;
  else return feature;
  // One pass over the rings per polygon: this runs on every globe feature.
  const flags = polygons.map((rings) => ({
    wraps: rings.length > 0 && wrapsPole(rings[0]),
    touches: touchesPole(rings),
  }));
  if (!flags.some((f) => f.wraps || f.touches)) return feature;
  const coordinates = polygons.flatMap((rings, i) => {
    const pieces = flags[i].wraps ? slicePolarPolygon(rings) : [rings];
    return pieces.map((piece) =>
      flags[i].wraps || flags[i].touches ? clampPolarRings(piece) : piece,
    );
  });
  // Nothing drawable came out (a degenerate ring): leave the feature as it was.
  if (coordinates.length === 0) return feature;
  if (geometry.type === "Polygon" && coordinates.length === 1)
    return { ...feature, geometry: { type: "Polygon", coordinates: coordinates[0] } };
  const sliced: MultiPolygon = { type: "MultiPolygon", coordinates };
  return { ...feature, geometry: sliced };
}
