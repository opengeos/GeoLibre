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
 * segment meets a much shorter one there ({@link TANGENT_LENGTH_RATIO}) and
 * the short one is a chord of a curve, the next vertex turning the same way
 * onto another short chord: the straight side and the arc are labeled
 * separately, the way a survey lists a line and a curve as two courses. A
 * short jog on a straight boundary is not a curve, so it does not split it.
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
 * other and the shorter one continues as a curve: where a straight side runs
 * into the short chords of an arc.
 */
export const TANGENT_LENGTH_RATIO = 4;

/**
 * Below this turn, in degrees, a vertex is straight whatever its segment
 * lengths, so unevenly spaced vertices along a straight side stay one side.
 */
export const MIN_TANGENT_TURN_DEGREES = 0.5;

/**
 * Vertices closer than this to the previous one, in degrees of latitude
 * (about a millimetre), are dropped before finding corners. Snapped or
 * float-noisy data repeats a vertex almost exactly, and a segment that short
 * has an arbitrary direction that would read as a corner.
 */
const MIN_SEGMENT_DEGREES = 1e-8;

/**
 * Most sides labeled at once. A large selection is skipped rather than
 * labeled partially: thousands of labels would neither fit nor be read, and
 * measuring them would stall every selection change.
 */
export const MAX_EDGE_LABELS = 2000;

/** Bound corner detection and ellipsoidal inverses even for a single dense side. */
export const MAX_EDGE_VERTICES = 50_000;

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
 * The short (one decimal) and long (two decimals) number formats per locale.
 * Building an `Intl.NumberFormat` is far slower than using one, and a large
 * selection formats up to {@link MAX_EDGE_LABELS} lengths at once.
 */
const numberFormats = new Map<string, [Intl.NumberFormat, Intl.NumberFormat]>();

function formatsFor(locale: string | undefined): [Intl.NumberFormat, Intl.NumberFormat] {
  const key = locale ?? "";
  let formats = numberFormats.get(key);
  if (!formats) {
    formats = [
      new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }),
      new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }),
    ];
    numberFormats.set(key, formats);
  }
  return formats;
}

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
  const [short, long] = formatsFor(locale);
  if (unit === "imperial") {
    return meters < METERS_PER_MILE
      ? `${short.format(meters * FEET_PER_METER)} ft`
      : `${long.format(meters / METERS_PER_MILE)} mi`;
  }
  if (unit === "nautical") {
    return meters < METERS_PER_NAUTICAL_MILE
      ? `${short.format(meters)} m`
      : `${long.format(meters / METERS_PER_NAUTICAL_MILE)} nmi`;
  }
  return meters < 1000 ? `${short.format(meters)} m` : `${long.format(meters / 1000)} km`;
}

/**
 * Direction (radians) and relative length (degrees of latitude) of the
 * segment from `a` to `b`, on a local flat approximation (longitude scaled by
 * the cosine of latitude). Only the change in direction and the ratio of
 * lengths between neighboring segments are used, which this measures well at
 * the scale of one feature. The longitude difference takes the short way
 * round, so a side crossing the antimeridian keeps its direction.
 */
function segment(a: Position, b: Position): { heading: number; length: number } {
  const cosLat = Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  let dLon = b[0] - a[0];
  if (dLon > 180) dLon -= 360;
  else if (dLon < -180) dLon += 360;
  const dx = dLon * cosLat;
  const dy = b[1] - a[1];
  return { heading: Math.atan2(dy, dx), length: Math.hypot(dx, dy) };
}

/** Signed turn from one heading to the next, in degrees, in (-180, 180]. */
function turnDegrees(from: number, to: number): number {
  let delta = (to - from) % (2 * Math.PI);
  if (delta > Math.PI) delta -= 2 * Math.PI;
  else if (delta <= -Math.PI) delta += 2 * Math.PI;
  return (delta * 180) / Math.PI;
}

/** Whether `b` is within {@link MIN_SEGMENT_DEGREES} of `a`. */
function samePosition(a: Position, b: Position): boolean {
  return segment(a, b).length < MIN_SEGMENT_DEGREES;
}

/** The longer of two lengths over the shorter. */
function lengthRatio(a: number, b: number): number {
  return Math.max(a, b) / Math.min(a, b);
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
  // Drop the closing position and repeated (or all but repeated) vertices,
  // which have no direction of their own.
  const points: Position[] = [];
  for (const position of ring) {
    if (points.length === 0 || !samePosition(points[points.length - 1], position)) {
      points.push(position);
    }
  }
  if (points.length > 1 && samePosition(points[0], points[points.length - 1])) points.pop();
  const n = points.length;
  if (n < 3) return [];

  const wrap = (k: number) => ((k % n) + n) % n;
  const segments = points.map((point, i) => segment(point, points[(i + 1) % n]));
  // Vertex i joins segment i-1 (arriving) and segment i (leaving).
  const turns = points.map((_, i) =>
    turnDegrees(segments[wrap(i - 1)].heading, segments[i].heading),
  );
  // Whether the short segment `chord` continues as a curve past `vertex`, its
  // far end: the vertex turns the same way as `turn`, onto a segment `beyond`
  // of about the same length.
  const continuesCurve = (chord: number, vertex: number, beyond: number, turn: number) => {
    const next = turns[wrap(vertex)];
    return (
      Math.abs(next) > MIN_TANGENT_TURN_DEGREES &&
      Math.sign(next) === Math.sign(turn) &&
      lengthRatio(segments[wrap(chord)].length, segments[wrap(beyond)].length) <=
        TANGENT_LENGTH_RATIO
    );
  };
  const corners: number[] = [];
  for (let i = 0; i < n; i++) {
    const turn = turns[i];
    const arriving = segments[wrap(i - 1)];
    const leaving = segments[i];
    let corner = Math.abs(turn) > cornerAngle;
    if (
      !corner &&
      Math.abs(turn) > MIN_TANGENT_TURN_DEGREES &&
      lengthRatio(arriving.length, leaving.length) > TANGENT_LENGTH_RATIO
    ) {
      corner =
        leaving.length < arriving.length
          ? continuesCurve(i, i + 1, i + 1, turn)
          : continuesCurve(i - 1, i - 1, i - 2, turn);
    }
    if (corner) corners.push(i);
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
function* featureRings(feature: Feature): Generator<Position[]> {
  const geometry = feature.geometry;
  if (geometry?.type === "Polygon") yield* geometry.coordinates;
  if (geometry?.type === "MultiPolygon") {
    for (const polygon of geometry.coordinates) yield* polygon;
  }
}

/**
 * One labeled line per side of every polygon in `features`. Points, lines, and
 * coordinates that are not longitude/latitude are skipped.
 *
 * @param features - The selected features.
 * @param options - Unit, locale, corner threshold, and label cap.
 * @returns The sides to label, or none when a side or input-work cap is exceeded.
 */
export function edgeLengthLines(
  features: readonly Feature[],
  options: EdgeLengthOptions = {},
): FeatureCollection<LineString, EdgeLengthProperties> {
  const cornerAngle = options.cornerAngle ?? CORNER_ANGLE_DEGREES;
  const maxLabels = options.maxLabels ?? MAX_EDGE_LABELS;
  // Preflight by array lengths before scanning coordinates or measuring sides.
  // A coastline can contain very many vertices yet have only one smooth side.
  if (features.length > MAX_EDGE_VERTICES) return EMPTY;
  let vertices = 0;
  for (const feature of features) {
    for (const ring of featureRings(feature)) {
      vertices += Math.max(1, ring.length);
      if (vertices > MAX_EDGE_VERTICES) return EMPTY;
    }
  }
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
