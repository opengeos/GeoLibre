/**
 * Keep client-side buffers whole across the antimeridian.
 *
 * `@turf/buffer` projects each feature onto an azimuthal plane centred on the
 * centre of its plain bounding box, buffers it there, and projects back with
 * d3, which wraps every longitude into ±180. Two things go wrong near the
 * antimeridian (GeoLibre#3469):
 *
 * - A buffer that reaches across it comes back as one ring jumping from 179°
 *   to -179° and back, which renders as a band across the whole map.
 * - A feature already split at the antimeridian (Fiji, Russia, an Aleutian
 *   MultiPolygon) has a plain bounding box near 360° wide, so its "centre" lands
 *   on the far side of the planet and the projection distorts the buffer.
 *
 * {@link prepareAntimeridianInput} shifts such a feature onto one continuous
 * side before buffering, and {@link splitPolygonalAtAntimeridian} makes the
 * returned rings continuous again, closes a ring that went round a pole through
 * that pole, and cuts the result at ±180 into the parts RFC 7946 asks for.
 */

import intersect from "@turf/intersect";
import { featureCollection, polygon as turfPolygon } from "@turf/helpers";
import type { Feature, Geometry, MultiPolygon, Polygon, Position } from "geojson";
import { shortestLongitudeExtent } from "@geolibre/core/worker-safe";

/** A longitude step larger than this between neighbours is read as a wrap. */
const WRAP_JUMP = 180;

/**
 * Map every position of a coordinate array through `fn`, keeping its shape.
 *
 * @param coordinates - Any GeoJSON coordinate array.
 * @param fn - Rewrites one position.
 */
function mapPositions<T>(coordinates: T, fn: (position: Position) => Position): T {
  if (!Array.isArray(coordinates)) return coordinates;
  if (typeof coordinates[0] === "number") return fn(coordinates as Position) as T;
  return coordinates.map((member) => mapPositions(member, fn)) as T;
}

/**
 * Rewrite every position of a geometry, descending into collections.
 *
 * @param geometry - The geometry to rewrite.
 * @param fn - Rewrites one position.
 */
function mapGeometry(geometry: Geometry, fn: (position: Position) => Position): Geometry {
  if (geometry.type === "GeometryCollection") {
    return { ...geometry, geometries: geometry.geometries.map((g) => mapGeometry(g, fn)) };
  }
  return { ...geometry, coordinates: mapPositions(geometry.coordinates, fn) } as Geometry;
}

/** The `[min, max]` longitude of every contiguous part of a geometry. */
function partIntervals(geometry: Geometry, out: Array<[number, number]>): void {
  const add = (positions: readonly Position[] | undefined) => {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const position of positions ?? []) {
      const lon = position?.[0];
      if (!Number.isFinite(lon)) continue;
      if (lon < min) min = lon;
      if (lon > max) max = lon;
    }
    if (min <= max) out.push([min, max]);
  };
  switch (geometry.type) {
    case "Point":
      add([geometry.coordinates]);
      break;
    case "MultiPoint":
      for (const position of geometry.coordinates) add([position]);
      break;
    case "LineString":
      add(geometry.coordinates);
      break;
    case "MultiLineString":
      for (const line of geometry.coordinates) add(line);
      break;
    case "Polygon":
      add(geometry.coordinates[0]);
      break;
    case "MultiPolygon":
      for (const polygon of geometry.coordinates) add(polygon[0]);
      break;
    case "GeometryCollection":
      for (const member of geometry.geometries) partIntervals(member, out);
      break;
  }
}

/**
 * Shift the parts of a feature that sit just east of the antimeridian a full
 * turn east, so a feature split there (`[177, 180]` and `[-180, -178]`) becomes
 * one continuous shape (`[177, 182]`) whose bounding-box centre is where the
 * feature really is.
 *
 * @param feature - The feature about to be buffered.
 * @returns The feature to buffer (the input itself when nothing needed moving)
 *   and the longitude of its centre, which may exceed 180 once shifted.
 */
export function prepareAntimeridianInput(feature: Feature): {
  feature: Feature;
  referenceLon: number;
} {
  if (!feature.geometry) return { feature, referenceLon: 0 };
  const intervals: Array<[number, number]> = [];
  partIntervals(feature.geometry, intervals);
  const extent = shortestLongitudeExtent(intervals);
  if (!extent) return { feature, referenceLon: 0 };
  const referenceLon = (extent[0] + extent[1]) / 2;
  if (extent[1] <= 180) return { feature, referenceLon };
  const west = extent[0];
  const geometry = mapGeometry(feature.geometry, (position) =>
    position[0] < west ? [position[0] + 360, ...position.slice(1)] : position,
  );
  return { feature: { ...feature, geometry }, referenceLon };
}

/**
 * Make a ring's longitudes continuous: each step to the next position takes the
 * short way round, so a ring that crosses the antimeridian runs past ±180
 * instead of jumping to the other side. The first position is placed within
 * half a turn of `referenceLon`, so every ring of one buffer lands on the same
 * side.
 *
 * @param ring - A closed linear ring.
 * @param referenceLon - Longitude the ring should sit near.
 */
function unwrapRing(ring: readonly Position[], referenceLon: number): Position[] {
  const out: Position[] = [];
  let previous = Number.NaN;
  for (const position of ring) {
    let lon = position[0];
    if (Number.isNaN(previous)) {
      lon += Math.round((referenceLon - lon) / 360) * 360;
    } else {
      lon += Math.round((previous - lon) / 360) * 360;
    }
    previous = lon;
    out.push([lon, ...position.slice(1)]);
  }
  return out;
}

/**
 * Close a ring that went once round a pole. Unwrapped, such a ring ends a full
 * turn east or west of where it started; it bounds the cap around the pole, so
 * it is closed by running down to the pole, back along it, and up to the start.
 *
 * @param ring - An unwrapped ring.
 * @returns The ring, closed through a pole when it needed to be.
 */
function closeAroundPole(ring: Position[]): Position[] {
  if (ring.length < 2) return ring;
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (Math.abs(last[0] - first[0]) < WRAP_JUMP) return ring;
  let latitudeSum = 0;
  for (const position of ring) latitudeSum += position[1];
  const pole = latitudeSum < 0 ? -90 : 90;
  return [...ring, [last[0], pole], [first[0], pole], [first[0], first[1]]];
}

/**
 * Whether an edge runs along a pole, where its longitudes are arbitrary: a cap
 * around a pole is closed by such an edge, and it is not a wrap.
 */
function alongPole(a: Position, b: Position): boolean {
  return Math.abs(a[1]) === 90 && a[1] === b[1];
}

/** Whether any ring of a polygonal geometry needs unwrapping or cutting. */
function crossesAntimeridian(polygons: readonly Position[][][]): boolean {
  for (const rings of polygons) {
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const lon = ring[i][0];
        if (lon < -180 || lon > 180) return true;
        if (
          i > 0 &&
          Math.abs(lon - ring[i - 1][0]) > WRAP_JUMP &&
          !alongPole(ring[i - 1], ring[i])
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Cut an unwrapped polygon into the world copies it overlaps and shift each
 * piece back into ±180.
 *
 * @param rings - The polygon's rings, continuous and possibly past ±180.
 * @param out - Receives the resulting polygons.
 */
function cutIntoWorld(rings: Position[][], out: Position[][][]): void {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const position of rings[0]) {
    if (position[0] < min) min = position[0];
    if (position[0] > max) max = position[0];
  }
  if (min >= -180 && max <= 180) {
    out.push(rings);
    return;
  }
  const subject = turfPolygon(rings);
  for (let copy = Math.floor((min + 180) / 360); copy <= Math.floor((max + 180) / 360); copy++) {
    const offset = copy * 360;
    const box = turfPolygon([
      [
        [offset - 180, -90],
        [offset + 180, -90],
        [offset + 180, 90],
        [offset - 180, 90],
        [offset - 180, -90],
      ],
    ]);
    const piece = intersect(featureCollection([subject, box]))?.geometry;
    if (!piece) continue;
    const pieces = piece.type === "Polygon" ? [piece.coordinates] : piece.coordinates;
    for (const part of pieces) {
      out.push(
        part.map((ring) =>
          ring.map((position) => [
            // Clamp the cut edge exactly onto ±180 after shifting back.
            Math.max(-180, Math.min(180, position[0] - offset)),
            ...position.slice(1),
          ]),
        ),
      );
    }
  }
}

/**
 * Make a buffered polygon continuous across the antimeridian. The result is
 * still unwrapped (it may run past ±180), so two buffers of one feature, such
 * as the grown and eroded shapes of a two-sided buffer, can be combined in the
 * plane before {@link splitPolygonalAtAntimeridian} cuts them.
 *
 * @param geometry - A buffer result.
 * @param referenceLon - Longitude the buffered feature sits near.
 * @returns The continuous geometry, or the input when it needs no change.
 */
export function unwrapPolygonal(
  geometry: Polygon | MultiPolygon,
  referenceLon: number,
): Polygon | MultiPolygon {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  if (!crossesAntimeridian(polygons) && Math.abs(referenceLon) <= 180) return geometry;
  const unwrapped = polygons.map((rings) =>
    rings.map((ring) => closeAroundPole(unwrapRing(ring, referenceLon))),
  );
  return geometry.type === "Polygon"
    ? { type: "Polygon", coordinates: unwrapped[0] }
    : { type: "MultiPolygon", coordinates: unwrapped };
}

/**
 * Cut a polygonal geometry whose rings run past ±180 (or jump across it) into
 * parts that each stay within ±180, the RFC 7946 form every renderer and tool
 * draws correctly. Geometry that already stays within ±180 without a jump is
 * returned unchanged.
 *
 * @param geometry - A buffer result, wrapped or unwrapped.
 * @param referenceLon - Longitude the buffered feature sits near; it decides
 *   which side a wrapped ring is unwrapped onto.
 */
export function splitPolygonalAtAntimeridian(
  geometry: Polygon | MultiPolygon,
  referenceLon: number,
): Polygon | MultiPolygon {
  const continuous = unwrapPolygonal(geometry, referenceLon);
  if (continuous === geometry) return geometry;
  const polygons =
    continuous.type === "Polygon" ? [continuous.coordinates] : continuous.coordinates;
  const out: Position[][][] = [];
  for (const rings of polygons) {
    // A ring needs four positions; anything shorter is a degenerate leftover.
    const kept = rings.filter((ring) => ring.length >= 4);
    if (kept.length && kept[0] === rings[0]) cutIntoWorld(kept, out);
  }
  if (out.length === 1) return { type: "Polygon", coordinates: out[0] };
  return { type: "MultiPolygon", coordinates: out };
}
