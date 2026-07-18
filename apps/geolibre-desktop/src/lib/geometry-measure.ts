/**
 * Geodesic length, perimeter, and area of GeoJSON geometries for the attribute
 * table's Field Calculator. These mirror the units the Measure tool offers so a
 * "compute Area in hectares" column and a measured area agree.
 *
 * Distances use the great-circle (haversine) length between consecutive
 * vertices; areas use the spherical-excess formula. Both are evaluated on a
 * sphere whose radius is the active body's mean radius (Earth / Moon / Mars),
 * read from `@geolibre/core`, so measurements stay consistent with the rest of
 * the app when a non-Earth ellipsoid is active. Coordinates are assumed to be
 * lon/lat degrees (EPSG:4326), which is what every layer in the store carries.
 */
import { getActiveMeanRadiusMeters } from "@geolibre/core";
import type { Feature, Geometry, Position } from "geojson";

/** Length units, matching the Measure tool's `DistanceUnit` set. */
export type DistanceUnit = "meters" | "kilometers" | "miles" | "feet" | "yards" | "nautical-miles";

/** Area units, matching the Measure tool's `AreaUnit` set. */
export type AreaUnit =
  | "square-meters"
  | "square-kilometers"
  | "square-miles"
  | "hectares"
  | "acres"
  | "square-feet";

/** Multipliers from meters to each distance unit. */
const DISTANCE_FACTORS: Record<DistanceUnit, number> = {
  meters: 1,
  kilometers: 1 / 1000,
  miles: 1 / 1609.344,
  feet: 1 / 0.3048,
  yards: 1 / 0.9144,
  "nautical-miles": 1 / 1852,
};

/** Multipliers from square meters to each area unit. */
const AREA_FACTORS: Record<AreaUnit, number> = {
  "square-meters": 1,
  "square-kilometers": 1 / 1_000_000,
  "square-miles": 1 / 2_589_988.110336,
  hectares: 1 / 10_000,
  acres: 1 / 4046.8564224,
  "square-feet": 1 / 0.09290304,
};

/** Distance units in menu order (meters first, as the sensible default). */
export const DISTANCE_UNITS: readonly DistanceUnit[] = [
  "meters",
  "kilometers",
  "feet",
  "yards",
  "miles",
  "nautical-miles",
];

/** Area units in menu order (square meters first, as the sensible default). */
export const AREA_UNITS: readonly AreaUnit[] = [
  "square-meters",
  "square-kilometers",
  "hectares",
  "square-feet",
  "acres",
  "square-miles",
];

/** Short, language-neutral symbols for the unit dropdown (e.g. "km²", "ha"). */
export const UNIT_SYMBOLS: Record<DistanceUnit | AreaUnit, string> = {
  meters: "m",
  kilometers: "km",
  feet: "ft",
  yards: "yd",
  miles: "mi",
  "nautical-miles": "nmi",
  "square-meters": "m²",
  "square-kilometers": "km²",
  hectares: "ha",
  "square-feet": "ft²",
  acres: "ac",
  "square-miles": "mi²",
};

/** A geometry measurement the Field Calculator can insert. */
export type GeometryMetric = "length" | "perimeter" | "area";

/** A base geometry family a feature can contribute to a layer. */
export type GeometryFamily = "point" | "line" | "polygon";

/** Add every base family reachable from `geometry` (flattening collections). */
function collectBaseFamilies(
  geometry: Geometry | null | undefined,
  into: Set<GeometryFamily>,
): void {
  switch (geometry?.type) {
    case "Point":
    case "MultiPoint":
      into.add("point");
      break;
    case "LineString":
    case "MultiLineString":
      into.add("line");
      break;
    case "Polygon":
    case "MultiPolygon":
      into.add("polygon");
      break;
    case "GeometryCollection":
      // Collections are measurable (measure* recurse into them), so report the
      // families they actually contain.
      for (const member of geometry.geometries) {
        collectBaseFamilies(member, into);
      }
      break;
    default:
      break;
  }
}

/**
 * The set of geometry families actually present across a layer's features,
 * flattening GeometryCollections. An empty set means no measurable geometry
 * (e.g. a DuckDB query layer whose rows have no geometry); a set larger than one
 * is a mixed layer. Reporting the concrete families (rather than collapsing to a
 * single "mixed") lets the Field Calculator offer only the metrics that apply —
 * a point+line layer gets Length, not a no-op Area.
 */
export function detectGeometryFamilies(features: Feature[]): Set<GeometryFamily> {
  const families = new Set<GeometryFamily>();
  for (const feature of features) {
    collectBaseFamilies(feature.geometry, families);
  }
  return families;
}

/**
 * Look up a unit's conversion factor, throwing on an unrecognized unit. The
 * geometry helpers are called from free-text expressions, so a typo like
 * `$area("hectare")` or `$length("km")` must surface as a per-feature error
 * (null cell, counted in `errors`) rather than silently returning the base unit
 * — a mistake that can be off by orders of magnitude.
 */
function distanceFactor(unit: DistanceUnit): number {
  const factor = DISTANCE_FACTORS[unit];
  if (factor === undefined) throw new Error(`Unknown distance unit: "${unit}"`);
  return factor;
}

function areaFactor(unit: AreaUnit): number {
  const factor = AREA_FACTORS[unit];
  if (factor === undefined) throw new Error(`Unknown area unit: "${unit}"`);
  return factor;
}

const DEG_TO_RAD = Math.PI / 180;

/** Great-circle distance in meters between two [lon, lat] positions. */
function haversineMeters(a: Position, b: Position, radius: number): number {
  const lat1 = a[1] * DEG_TO_RAD;
  const lat2 = b[1] * DEG_TO_RAD;
  const dLat = lat2 - lat1;
  const dLon = (b[0] - a[0]) * DEG_TO_RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Summed great-circle length in meters along a run of positions. */
function lineLengthMeters(coords: Position[], radius: number): number {
  let total = 0;
  for (let i = 1; i < coords.length; i += 1) {
    total += haversineMeters(coords[i - 1], coords[i], radius);
  }
  return total;
}

/**
 * Spherical area in square meters of a single ring (its coordinates as a closed
 * or open loop). Signed by winding order; callers take the absolute value and
 * subtract holes as needed. The longitude delta is normalized to [-180, 180) so
 * a ring edge that crosses the antimeridian (e.g. 179° → -179°) counts as the
 * short 2° step, not a 358° one, keeping areas correct near ±180°.
 */
function ringAreaMeters(ring: Position[], radius: number): number {
  const n = ring.length;
  if (n < 3) return 0;
  let total = 0;
  for (let i = 0; i < n; i += 1) {
    const p1 = ring[i];
    const p2 = ring[(i + 1) % n];
    const dLon = ((p2[0] - p1[0] + 540) % 360) - 180;
    total += dLon * DEG_TO_RAD * (2 + Math.sin(p1[1] * DEG_TO_RAD) + Math.sin(p2[1] * DEG_TO_RAD));
  }
  return (total * radius * radius) / 2;
}

/** Absolute polygon area (outer ring minus holes) in square meters. */
function polygonAreaMeters(rings: Position[][], radius: number): number {
  if (rings.length === 0) return 0;
  let area = Math.abs(ringAreaMeters(rings[0], radius));
  for (let i = 1; i < rings.length; i += 1) {
    area -= Math.abs(ringAreaMeters(rings[i], radius));
  }
  return Math.max(0, area);
}

/** Summed perimeter in meters of a polygon's rings (outer + holes). */
function polygonPerimeterMeters(rings: Position[][], radius: number): number {
  let total = 0;
  for (const ring of rings) {
    // Close the ring so the final vertex→first vertex segment is counted even
    // when the source coordinates are not explicitly closed. Compare endpoints
    // by coordinate value, not array identity — GeoJSON rings never reuse the
    // same Position instance for their first and last point.
    const first = ring[0];
    const last = ring.at(-1);
    const isClosed = !!last && first[0] === last[0] && first[1] === last[1];
    const closed = ring.length > 0 && !isClosed ? [...ring, first] : ring;
    total += lineLengthMeters(closed, radius);
  }
  return total;
}

/**
 * Length in the given unit of a line geometry (meters by default). Returns 0 for
 * geometries that have no linear extent (points, polygons — use `measurePerimeter`
 * for a polygon's boundary). GeometryCollections sum their members.
 */
export function measureLength(
  geometry: Geometry | null | undefined,
  unit: DistanceUnit = "meters",
): number {
  const factor = distanceFactor(unit);
  if (!geometry) return 0;
  return lengthMeters(geometry, getActiveMeanRadiusMeters()) * factor;
}

function lengthMeters(geometry: Geometry, radius: number): number {
  switch (geometry.type) {
    case "LineString":
      return lineLengthMeters(geometry.coordinates, radius);
    case "MultiLineString":
      return geometry.coordinates.reduce((sum, line) => sum + lineLengthMeters(line, radius), 0);
    case "GeometryCollection":
      return geometry.geometries.reduce((sum, g) => sum + lengthMeters(g, radius), 0);
    default:
      return 0;
  }
}

/**
 * Perimeter in the given unit of a polygon geometry (meters by default). Returns
 * 0 for non-polygon geometries. GeometryCollections sum their members.
 */
export function measurePerimeter(
  geometry: Geometry | null | undefined,
  unit: DistanceUnit = "meters",
): number {
  const factor = distanceFactor(unit);
  if (!geometry) return 0;
  return perimeterMeters(geometry, getActiveMeanRadiusMeters()) * factor;
}

function perimeterMeters(geometry: Geometry, radius: number): number {
  switch (geometry.type) {
    case "Polygon":
      return polygonPerimeterMeters(geometry.coordinates, radius);
    case "MultiPolygon":
      return geometry.coordinates.reduce(
        (sum, rings) => sum + polygonPerimeterMeters(rings, radius),
        0,
      );
    case "GeometryCollection":
      return geometry.geometries.reduce((sum, g) => sum + perimeterMeters(g, radius), 0);
    default:
      return 0;
  }
}

/**
 * Area in the given unit of a polygon geometry (square meters by default).
 * Returns 0 for non-polygon geometries. GeometryCollections sum their members.
 */
export function measureArea(
  geometry: Geometry | null | undefined,
  unit: AreaUnit = "square-meters",
): number {
  const factor = areaFactor(unit);
  if (!geometry) return 0;
  return areaMeters(geometry, getActiveMeanRadiusMeters()) * factor;
}

function areaMeters(geometry: Geometry, radius: number): number {
  switch (geometry.type) {
    case "Polygon":
      return polygonAreaMeters(geometry.coordinates, radius);
    case "MultiPolygon":
      return geometry.coordinates.reduce((sum, rings) => sum + polygonAreaMeters(rings, radius), 0);
    case "GeometryCollection":
      return geometry.geometries.reduce((sum, g) => sum + areaMeters(g, radius), 0);
    default:
      return 0;
  }
}
