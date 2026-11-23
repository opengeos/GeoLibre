import type { Feature, FeatureCollection, Geometry, Position } from "geojson";

/**
 * Geometry for precision digitizing (#3530): COGO traverses (vertices placed
 * by bearing and distance from the previous vertex), snapping a clicked pixel
 * to the nearest vertex or segment within a pixel tolerance, and tracing an
 * existing feature's boundary between two snapped points.
 *
 * Everything here is pure: screen projection is passed in, so the functions
 * are testable without a map.
 */

/** Earth radius in metres, the WGS84 mean radius Turf uses. */
const EARTH_RADIUS_M = 6371008.8;

/** Distance units a COGO leg can be entered in, as metres per unit. */
export const COGO_DISTANCE_UNITS = {
  meters: 1,
  kilometers: 1000,
  feet: 0.3048,
  usSurveyFeet: 1200 / 3937,
  miles: 1609.344,
} as const;

export type CogoDistanceUnit = keyof typeof COGO_DISTANCE_UNITS;

/**
 * Parse an angle written as decimal degrees or degrees/minutes/seconds:
 * `45.5`, `45°30'`, `45 30 0`, `45-30-00`, `45d30m15s`.
 *
 * @param text - The angle text.
 * @returns Decimal degrees, or null when the text is not an angle.
 */
export function parseAngle(text: string): number | null {
  const parts = text
    .trim()
    .split(/[^0-9.]+/)
    .filter((part) => part.length > 0);
  if (parts.length === 0 || parts.length > 3) return null;
  if (/[^0-9.\s°'"′″dms:-]/i.test(text.trim())) return null;
  const numbers = parts.map(Number);
  if (numbers.some((n) => !Number.isFinite(n))) return null;
  const [degrees, minutes = 0, seconds = 0] = numbers;
  // Only the last component may carry decimals, and minutes/seconds stay below 60.
  if (parts.slice(0, -1).some((part) => part.includes("."))) return null;
  if (minutes >= 60 || seconds >= 60) return null;
  return degrees + minutes / 60 + seconds / 3600;
}

/**
 * Parse a bearing into an azimuth (degrees clockwise from north, in [0, 360)).
 * Accepts a plain azimuth (`135`, `135°30'`) or a quadrant bearing
 * (`S45°E`, `N 12 30 W`, `s45.5e`), whose angle must not exceed 90°.
 *
 * @param text - The bearing as typed.
 * @returns The azimuth, or null when the text is not a valid bearing.
 */
export function parseBearing(text: string): number | null {
  const trimmed = text.trim();
  const quadrant = /^([NS])\s*(.*?)\s*([EW])$/i.exec(trimmed);
  if (quadrant) {
    const angle = parseAngle(quadrant[2]);
    if (angle === null || angle > 90) return null;
    const ns = quadrant[1].toUpperCase();
    const ew = quadrant[3].toUpperCase();
    let azimuth: number;
    if (ns === "N" && ew === "E") azimuth = angle;
    else if (ns === "S" && ew === "E") azimuth = 180 - angle;
    else if (ns === "S" && ew === "W") azimuth = 180 + angle;
    else azimuth = 360 - angle;
    return azimuth % 360;
  }
  const angle = parseAngle(trimmed);
  if (angle === null || angle > 360) return null;
  return angle % 360;
}

/**
 * Format an azimuth as a quadrant bearing, e.g. `S 45°00'00" E`.
 *
 * @param azimuth - Degrees clockwise from north.
 * @returns The quadrant bearing text.
 */
export function formatQuadrantBearing(azimuth: number): string {
  const a = ((azimuth % 360) + 360) % 360;
  let ns: "N" | "S";
  let ew: "E" | "W";
  let angle: number;
  if (a <= 90) [ns, ew, angle] = ["N", "E", a];
  else if (a <= 180) [ns, ew, angle] = ["S", "E", 180 - a];
  else if (a <= 270) [ns, ew, angle] = ["S", "W", a - 180];
  else [ns, ew, angle] = ["N", "W", 360 - a];
  let totalSeconds = Math.round(angle * 3600);
  const degrees = Math.floor(totalSeconds / 3600);
  totalSeconds -= degrees * 3600;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${ns} ${degrees}°${pad(minutes)}'${pad(seconds)}" ${ew}`;
}

/**
 * The point `distance` metres from `from` along the great circle leaving at
 * `azimuth` (the same spherical model as `@turf/destination`).
 *
 * @param from - Start `[lng, lat]`.
 * @param azimuth - Degrees clockwise from north.
 * @param distance - Metres.
 * @returns The destination `[lng, lat]`.
 */
export function destinationPoint(from: Position, azimuth: number, distance: number): Position {
  const toRad = Math.PI / 180;
  const lat1 = from[1] * toRad;
  const lng1 = from[0] * toRad;
  const theta = azimuth * toRad;
  const delta = distance / EARTH_RADIUS_M;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(delta) + Math.cos(lat1) * Math.sin(delta) * Math.cos(theta),
  );
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(theta) * Math.sin(delta) * Math.cos(lat1),
      Math.cos(delta) - Math.sin(lat1) * Math.sin(lat2),
    );
  const lng = ((((lng2 / toRad + 540) % 360) + 360) % 360) - 180;
  return [lng, lat2 / toRad];
}

/** Great-circle distance in metres (haversine). */
export function distanceMeters(a: Position, b: Position): number {
  const toRad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toRad;
  const dLng = (b[0] - a[0]) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial great-circle azimuth from `a` to `b`, in [0, 360). */
export function azimuthBetween(a: Position, b: Position): number {
  const toRad = Math.PI / 180;
  const lat1 = a[1] * toRad;
  const lat2 = b[1] * toRad;
  const dLng = (b[0] - a[0]) * toRad;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (((Math.atan2(y, x) / toRad) % 360) + 360) % 360;
}

/** One COGO leg: a course and a length. */
export interface CogoLeg {
  /** Azimuth in degrees clockwise from north. */
  azimuth: number;
  /** Length in metres. */
  distance: number;
}

/**
 * Run a traverse: each leg starts at the previous vertex.
 *
 * @param start - The first vertex.
 * @param legs - Courses and lengths, in order.
 * @returns Every vertex, starting with `start`.
 */
export function traverse(start: Position, legs: CogoLeg[]): Position[] {
  const vertices = [start];
  for (const leg of legs) {
    vertices.push(destinationPoint(vertices[vertices.length - 1], leg.azimuth, leg.distance));
  }
  return vertices;
}

/**
 * How far a closed traverse misses its start (the misclosure), in metres.
 *
 * @param vertices - The traverse vertices.
 * @returns The gap between the last and first vertex.
 */
export function misclosure(vertices: Position[]): number {
  if (vertices.length < 2) return 0;
  return distanceMeters(vertices[vertices.length - 1], vertices[0]);
}

// ---------------------------------------------------------------------------
// Snapping and tracing
// ---------------------------------------------------------------------------

/** Projects `[lng, lat]` to screen pixels. */
export type Project = (position: Position) => { x: number; y: number };

/**
 * A location on one path of a feature: `path` indexes {@link geometryPaths},
 * the point lies on segment `segment` at fraction `t` (0 at its start vertex).
 */
export interface PathLocation {
  path: number;
  segment: number;
  t: number;
}

export interface SnapResult {
  /** Snapped `[lng, lat]`. */
  position: Position;
  kind: "vertex" | "segment";
  /** Index of the candidate feature that was snapped to. */
  feature: number;
  location: PathLocation;
  /** Screen distance from the click, in pixels. */
  pixels: number;
}

/**
 * The traceable paths of a geometry: line parts and polygon rings (rings stay
 * closed, first vertex repeated at the end). Point geometry yields one-vertex
 * paths, which can be snapped to but not traced.
 *
 * @param geometry - Any GeoJSON geometry.
 * @returns The paths, in a stable order.
 */
export function geometryPaths(geometry: Geometry | null): Position[][] {
  if (!geometry) return [];
  switch (geometry.type) {
    case "Point":
      return [[geometry.coordinates]];
    case "MultiPoint":
      return geometry.coordinates.map((p) => [p]);
    case "LineString":
      return [geometry.coordinates];
    case "MultiLineString":
      return geometry.coordinates;
    case "Polygon":
      return geometry.coordinates;
    case "MultiPolygon":
      return geometry.coordinates.flat();
    case "GeometryCollection":
      return geometry.geometries.flatMap((member) => geometryPaths(member));
  }
}

/** Whether a path is a closed ring. */
export function isClosedPath(path: Position[]): boolean {
  if (path.length < 4) return false;
  const first = path[0];
  const last = path[path.length - 1];
  return first[0] === last[0] && first[1] === last[1];
}

/**
 * Snap a screen point to the nearest vertex or segment of the candidate
 * features within `vertexTolerance` / `segmentTolerance` pixels. A vertex in
 * range always wins over a segment, like Geoman's own snapping.
 *
 * @param click - The clicked screen point.
 * @param geometries - Candidate geometries.
 * @param project - `[lng, lat]` to screen pixels.
 * @param vertexTolerance - Pixel radius for vertex snapping.
 * @param segmentTolerance - Pixel radius for segment snapping.
 * @returns The snap, or null when nothing is in range.
 */
export function snapToGeometries(
  click: { x: number; y: number },
  geometries: (Geometry | null)[],
  project: Project,
  vertexTolerance: number,
  segmentTolerance = vertexTolerance,
): SnapResult | null {
  let vertex: SnapResult | null = null;
  let segment: SnapResult | null = null;
  geometries.forEach((geometry, feature) => {
    geometryPaths(geometry).forEach((path, pathIndex) => {
      const screen = path.map(project);
      for (let i = 0; i < path.length; i++) {
        const d = Math.hypot(screen[i].x - click.x, screen[i].y - click.y);
        if (d <= vertexTolerance && (!vertex || d < vertex.pixels)) {
          // A ring's closing vertex is its first; report it as such.
          const atEnd = i === path.length - 1 && i > 0;
          vertex = {
            position: path[i],
            kind: "vertex",
            feature,
            location: atEnd
              ? { path: pathIndex, segment: i - 1, t: 1 }
              : { path: pathIndex, segment: i, t: 0 },
            pixels: d,
          };
        }
        if (i + 1 >= path.length) continue;
        const a = screen[i];
        const b = screen[i + 1];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const lengthSq = dx * dx + dy * dy;
        const t =
          lengthSq === 0
            ? 0
            : Math.max(0, Math.min(1, ((click.x - a.x) * dx + (click.y - a.y) * dy) / lengthSq));
        const sd = Math.hypot(a.x + t * dx - click.x, a.y + t * dy - click.y);
        if (sd <= segmentTolerance && (!segment || sd < segment.pixels)) {
          const p = path[i];
          const q = path[i + 1];
          segment = {
            position: [p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])],
            kind: "segment",
            feature,
            location: { path: pathIndex, segment: i, t },
            pixels: sd,
          };
        }
      }
    });
  });
  return vertex ?? segment;
}

function pointAt(path: Position[], location: PathLocation): Position {
  const a = path[location.segment];
  const b = path[Math.min(location.segment + 1, path.length - 1)];
  if (location.t <= 0) return a;
  if (location.t >= 1) return b;
  return [a[0] + location.t * (b[0] - a[0]), a[1] + location.t * (b[1] - a[1])];
}

function pathLength(points: Position[]): number {
  let total = 0;
  for (let i = 0; i + 1 < points.length; i++) total += distanceMeters(points[i], points[i + 1]);
  return total;
}

function withoutRepeats(points: Position[]): Position[] {
  const out: Position[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  return out;
}

/**
 * Walk forward along an open path's vertex indices from `from` to `to`.
 * Positions along the path are `segment + t`.
 */
function walkForward(path: Position[], from: PathLocation, to: PathLocation): Position[] {
  const points = [pointAt(path, from)];
  const start = from.segment + from.t;
  const end = to.segment + to.t;
  for (let i = Math.floor(start) + 1; i < end; i++) points.push(path[i]);
  points.push(pointAt(path, to));
  return withoutRepeats(points);
}

/**
 * Trace a path between two locations on it. On an open line this is the
 * stretch between them; on a closed ring there are two ways round, and the
 * shorter one is taken unless `longWay` is set.
 *
 * @param path - A line part or ring from {@link geometryPaths}.
 * @param from - Where the trace starts.
 * @param to - Where it ends.
 * @param longWay - On a ring, take the longer way round.
 * @returns The traced vertices from `from` to `to`.
 */
export function tracePath(
  path: Position[],
  from: PathLocation,
  to: PathLocation,
  longWay = false,
): Position[] {
  const s = from.segment + from.t;
  const e = to.segment + to.t;
  if (!isClosedPath(path)) {
    if (s <= e) return walkForward(path, from, to);
    return walkForward(path, to, from).reverse();
  }
  // A ring with n segments: walk forward from s to e, wrapping once.
  const n = path.length - 1;
  const locationOf = (position: number): PathLocation => {
    const wrapped = ((position % n) + n) % n;
    const segment = Math.min(Math.floor(wrapped), n - 1);
    return { path: from.path, segment, t: wrapped - segment };
  };
  const forward = (a: number, b: number): Position[] => {
    const end = b < a ? b + n : b;
    const points: Position[] = [pointAt(path, locationOf(a))];
    for (let i = Math.floor(a) + 1; i < end; i++) points.push(path[i % n]);
    points.push(pointAt(path, locationOf(b)));
    return withoutRepeats(points);
  };
  const ahead = forward(s, e);
  const behind = forward(e, s).reverse();
  const aheadShorter = pathLength(ahead) <= pathLength(behind);
  return aheadShorter !== longWay ? ahead : behind;
}

/**
 * Close a traverse into a polygon ring, or keep it a line.
 *
 * @param vertices - The constructed vertices.
 * @param kind - The geometry to build.
 * @param properties - Properties for the feature.
 * @returns The feature, or null when there are too few vertices.
 */
export function constructedFeature(
  vertices: Position[],
  kind: "line" | "polygon",
  properties: Record<string, unknown> = {},
): Feature | null {
  const unique = withoutRepeats(vertices);
  if (kind === "line") {
    if (unique.length < 2) return null;
    return { type: "Feature", properties, geometry: { type: "LineString", coordinates: unique } };
  }
  const ring = isClosedPath(unique) ? unique.slice(0, -1) : unique;
  if (ring.length < 3) return null;
  return {
    type: "Feature",
    properties,
    geometry: { type: "Polygon", coordinates: [[...ring, ring[0]]] },
  };
}

/**
 * Preview drawing for the panel: the path so far, the closing edge of a
 * polygon (dashed), each vertex, and an optional pending trace start.
 *
 * @param vertices - The constructed vertices.
 * @param kind - The geometry being built.
 * @param traceStart - The first trace point, while waiting for the second.
 * @returns A collection for the overlay source.
 */
export function cogoPreviewCollection(
  vertices: Position[],
  kind: "line" | "polygon",
  traceStart: Position | null,
): FeatureCollection {
  const features: Feature[] = [];
  if (vertices.length >= 2) {
    features.push({
      type: "Feature",
      properties: { role: "path" },
      geometry: { type: "LineString", coordinates: vertices },
    });
  }
  if (kind === "polygon" && vertices.length >= 3) {
    features.push({
      type: "Feature",
      properties: { role: "closing" },
      geometry: { type: "LineString", coordinates: [vertices[vertices.length - 1], vertices[0]] },
    });
  }
  vertices.forEach((position, index) => {
    features.push({
      type: "Feature",
      properties: { role: index === vertices.length - 1 ? "last" : "vertex" },
      geometry: { type: "Point", coordinates: position },
    });
  });
  if (traceStart) {
    features.push({
      type: "Feature",
      properties: { role: "trace" },
      geometry: { type: "Point", coordinates: traceStart },
    });
  }
  return { type: "FeatureCollection", features };
}
