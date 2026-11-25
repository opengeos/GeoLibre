/**
 * Side lengths of selected polygons, drawn as labels along each side.
 *
 * A side runs from one corner of a ring to the next. A vertex is a corner when
 * the boundary turns there by more than {@link CORNER_ANGLE_DEGREES}, so the
 * extra vertices of a densified straight side, or the many short segments of a
 * curved frontage, are measured as one side rather than labeled one by one.
 * A ring with no corner at all (a circle) is one side: its perimeter.
 *
 * A curve that meets a straight side tangentially (a cul-de-sac frontage)
 * barely turns at the joint, so the joint is also a corner when a long
 * segment meets a much shorter one there ({@link TANGENT_LENGTH_RATIO}): the
 * straight side and the arc's short chords are labeled separately, the way a
 * survey lists a line and a curve as two courses.
 *
 * Lengths are geodesic, on the active body's ellipsoid, like the measure tool
 * and the Field Calculator. The result is a collection of LineStrings, one per
 * side, which the engines draw with `symbol-placement: line-center`: the label
 * sits at the middle of the side, follows its direction, stays upright, and is
 * left out when the side is too short on screen to hold it.
 */

import { geodesicDistance, isLonLat } from "@geolibre/core/geodesic";
import type { MapScaleUnit } from "@geolibre/core";
import type { Feature, FeatureCollection, LineString, Position } from "geojson";

/** A turn sharper than this, in degrees, makes a vertex a corner. */
export const CORNER_ANGLE_DEGREES = 12;

/**
 * A vertex that turns at all (more than {@link MIN_TANGENT_TURN_DEGREES}) is
 * also a corner when one of its segments is this many times longer than the
 * other: where a straight side runs into the short chords of a curve.
 */
export const TANGENT_LENGTH_RATIO = 4;

/**
 * Below this turn, in degrees, a vertex is straight whatever its segment
 * lengths, so unevenly spaced vertices along a straight side stay one side.
 */
export const MIN_TANGENT_TURN_DEGREES = 0.5;

/**
 * Most sides labeled at once. A large selection is skipped rather than
 * labeled partially: thousands of labels would neither fit nor be read, and
 * measuring them would stall every selection change.
 */
export const MAX_EDGE_LABELS = 2000;

/** Properties of each side in {@link edgeLengthLines}. */
export interface EdgeLengthProperties {
  /** The side's length in metres. */
  meters: number;
  /** The formatted length, as drawn. */
  label: string;
}

export interface EdgeLengthOptions {
  /** Unit system of the labels, the map's scale bar setting. */
  unit?: MapScaleUnit;
  /** Locale of the numbers; defaults to the runtime's. */
  locale?: string;
  /** Corner threshold in degrees; see {@link CORNER_ANGLE_DEGREES}. */
  cornerAngle?: number;
  /** Most sides to label; see {@link MAX_EDGE_LABELS}. */
  maxLabels?: number;
}

const EMPTY: FeatureCollection<LineString, EdgeLengthProperties> = {
  type: "FeatureCollection",
  features: [],
};

const FEET_PER_METER = 1 / 0.3048;
const METERS_PER_MILE = 1609.344;
const METERS_PER_NAUTICAL_MILE = 1852;

/**
 * Format a length for a side label in the scale bar's unit system: metres
 * below a kilometre then kilometres, feet below a mile then miles, or metres
 * below a nautical mile then nautical miles.
 */
export function formatEdgeLength(
  meters: number,
  unit: MapScaleUnit = "metric",
  locale?: string,
): string {
  const short = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const long = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
  if (unit === "imperial") {
    return meters < METERS_PER_MILE
      ? `${short.format(meters * FEET_PER_METER)} ft`
      : `${long.format(meters / METERS_PER_MILE)} mi`;
  }
  if (unit === "nautical" && meters >= METERS_PER_NAUTICAL_MILE) {
    return `${long.format(meters / METERS_PER_NAUTICAL_MILE)} nmi`;
  }
  return meters < 1000 ? `${short.format(meters)} m` : `${long.format(meters / 1000)} km`;
}

/**
 * Direction (radians) and relative length of the segment from `a` to `b`, on
 * a local flat approximation (longitude scaled by the cosine of latitude).
 * Only the change in direction and the ratio of lengths between neighboring
 * segments are used, which this measures well at the scale of one feature.
 */
function segment(a: Position, b: Position): { heading: number; length: number } {
  const cosLat = Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  const dx = (b[0] - a[0]) * cosLat;
  const dy = b[1] - a[1];
  return { heading: Math.atan2(dy, dx), length: Math.hypot(dx, dy) };
}

/** Absolute turn between two headings, in degrees, in [0, 180]. */
function turnDegrees(from: number, to: number): number {
  let delta = Math.abs(to - from) % (2 * Math.PI);
  if (delta > Math.PI) delta = 2 * Math.PI - delta;
  return (delta * 180) / Math.PI;
}

/** Whether two positions are the same point. */
function samePosition(a: Position, b: Position): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

/**
 * Split one ring into its sides: the vertex runs between corners.
 *
 * @param ring - A closed GeoJSON ring (first position repeated last).
 * @param cornerAngle - Turn in degrees above which a vertex is a corner.
 * @returns Each side's positions, first corner to next corner inclusive. A
 *   ring with no corner gives one side covering the whole closed ring.
 */
export function ringSides(
  ring: readonly Position[],
  cornerAngle = CORNER_ANGLE_DEGREES,
): Position[][] {
  // Drop the closing position and repeated vertices, which have no direction.
  const points: Position[] = [];
  for (const position of ring) {
    if (points.length === 0 || !samePosition(points[points.length - 1], position)) {
      points.push(position);
    }
  }
  if (points.length > 1 && samePosition(points[0], points[points.length - 1])) points.pop();
  const n = points.length;
  if (n < 3) return [];

  const segments = points.map((point, i) => segment(point, points[(i + 1) % n]));
  // Vertex i joins segment i-1 (arriving) and segment i (leaving).
  const corners: number[] = [];
  for (let i = 0; i < n; i++) {
    const arriving = segments[(i - 1 + n) % n];
    const leaving = segments[i];
    const turn = turnDegrees(arriving.heading, leaving.heading);
    const ratio =
      Math.max(arriving.length, leaving.length) / Math.min(arriving.length, leaving.length);
    if (turn > cornerAngle || (turn > MIN_TANGENT_TURN_DEGREES && ratio > TANGENT_LENGTH_RATIO)) {
      corners.push(i);
    }
  }
  if (corners.length === 0) return [[...points, points[0]]];

  return corners.map((start, k) => {
    const end = corners[(k + 1) % corners.length];
    const side: Position[] = [points[start]];
    let i = start;
    do {
      i = (i + 1) % n;
      side.push(points[i]);
    } while (i !== end);
    return side;
  });
}

/** Geodesic length of a path, in metres. */
function pathLength(path: readonly Position[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) total += geodesicDistance(path[i - 1], path[i]);
  return total;
}

/** The rings of a polygon or multipolygon feature, outer and inner alike. */
function featureRings(feature: Feature): Position[][] {
  const geometry = feature.geometry;
  if (geometry?.type === "Polygon") return geometry.coordinates;
  if (geometry?.type === "MultiPolygon") return geometry.coordinates.flat();
  return [];
}

/**
 * One labeled line per side of every polygon in `features`. Points, lines, and
 * coordinates that are not longitude/latitude are skipped.
 *
 * @param features - The selected features.
 * @param options - Unit, locale, corner threshold, and label cap.
 * @returns The sides to label, or none when there are more than the cap.
 */
export function edgeLengthLines(
  features: readonly Feature[],
  options: EdgeLengthOptions = {},
): FeatureCollection<LineString, EdgeLengthProperties> {
  const cornerAngle = options.cornerAngle ?? CORNER_ANGLE_DEGREES;
  const maxLabels = options.maxLabels ?? MAX_EDGE_LABELS;
  const sides: Position[][] = [];
  for (const feature of features) {
    for (const ring of featureRings(feature)) {
      if (!ring.every(isLonLat)) continue;
      for (const side of ringSides(ring, cornerAngle)) {
        sides.push(side);
        if (sides.length > maxLabels) return EMPTY;
      }
    }
  }
  if (sides.length === 0) return EMPTY;
  return {
    type: "FeatureCollection",
    features: sides.map((side) => {
      const meters = pathLength(side);
      return {
        type: "Feature",
        properties: { meters, label: formatEdgeLength(meters, options.unit, options.locale) },
        geometry: { type: "LineString", coordinates: side },
      };
    }),
  };
}

/**
 * Source and layer ids of the side labels, shared by both 2D engines. Under
 * the `geolibre-highlight-` prefix, so the layer lists that hide the selection
 * highlight (`INTERNAL_HELPER_LAYER_PATTERNS`) hide these too.
 */
export const EDGE_LENGTH_SOURCE_ID = "geolibre-highlight-edge-lengths-source";
export const EDGE_LENGTH_LAYER_ID = "geolibre-highlight-edge-lengths";

/**
 * The symbol layer that draws the side labels: dark text with a light halo,
 * centered on each side and kept upright. It is drawn above the selection
 * highlight and placed before other labels, so on a crowded basemap the
 * basemap's labels give way rather than the measurements.
 *
 * @param textFont - A font stack the active style serves glyphs for.
 */
export function edgeLengthLayer(textFont: string[]) {
  return {
    id: EDGE_LENGTH_LAYER_ID,
    type: "symbol" as const,
    source: EDGE_LENGTH_SOURCE_ID,
    layout: {
      "symbol-placement": "line-center" as const,
      "text-field": ["get", "label"],
      "text-font": textFont,
      "text-size": 12,
      "text-keep-upright": true,
      "text-max-angle": 30,
      "text-padding": 2,
    },
    paint: {
      "text-color": "#111827",
      "text-halo-color": "#ffffff",
      "text-halo-width": 2,
    },
  };
}
