import type {
  Feature,
  FeatureCollection,
  GeoJsonProperties,
  LineString,
  Point,
  Position,
} from "geojson";

export interface GpxLayerResult {
  routes: FeatureCollection<LineString>;
  /** Number of route features produced (routes with at least 2 valid points). */
  routeCount: number;
  routePoints: FeatureCollection<Point>;
  /**
   * Number of individual route-point features produced (one per `<rtept>` with
   * valid coordinates; points with missing/invalid lat/lon are skipped).
   */
  routePointCount: number;
  tracks: FeatureCollection<LineString>;
  /**
   * Number of track features produced. Each `<trkseg>` becomes its own
   * LineString, so a single `<trk>` with multiple segments contributes more
   * than one to this count.
   */
  trackCount: number;
  trackPoints: FeatureCollection<Point>;
  /**
   * Number of individual track-point features produced (one per `<trkpt>` with
   * valid coordinates; points with missing/invalid lat/lon are skipped).
   */
  trackPointCount: number;
  waypoints: FeatureCollection<Point>;
  /** Number of waypoint features produced (waypoints with valid coordinates). */
  waypointCount: number;
}

type GpxPointElement = Element;

const GPX_POINT_PROPERTY_NAMES = [
  "ele",
  "time",
  "name",
  "cmt",
  "desc",
  "src",
  "sym",
  "type",
  "fix",
  "sat",
  "hdop",
  "vdop",
  "pdop",
  "ageofdgpsdata",
  "dgpsid",
];

const GPX_CONTAINER_PROPERTY_NAMES = ["name", "cmt", "desc", "src", "number", "type"];

// GPX fields defined as numeric types in the schema. Every other tag (name,
// cmt, desc, src, sym, type, fix, time, ...) is textual and must stay a string
// so values like a name of "0012" are not coerced into the number 12.
const GPX_NUMERIC_PROPERTY_NAMES = new Set([
  "ele",
  "sat",
  "hdop",
  "vdop",
  "pdop",
  "ageofdgpsdata",
  "dgpsid",
  "number",
]);

export interface GpxParseOptions {
  /**
   * Build the per-`<rtept>` route-point features. Defaults to `false` so the
   * (potentially large) collection is only built when the caller opts in; the
   * line/waypoint/route outputs are always produced regardless.
   */
  includeRoutePoints?: boolean;
  /**
   * Build the per-`<trkpt>` track-point features. Defaults to `false` so the
   * (potentially large) collection is only built when the caller opts in; the
   * line/waypoint/route outputs are always produced regardless.
   */
  includeTrackPoints?: boolean;
}

export function parseGpxLayer(text: string, options: GpxParseOptions = {}): GpxLayerResult {
  const { includeRoutePoints = false, includeTrackPoints = false } = options;
  const document = new DOMParser().parseFromString(text, "application/xml");
  const parserError = document.querySelector("parsererror");
  if (parserError) {
    throw new Error("The GPX file is not valid XML.");
  }

  const gpx = document.documentElement;
  if (!gpx || gpx.localName.toLowerCase() !== "gpx") {
    throw new Error("The file does not contain a GPX document.");
  }

  const waypointFeatures: Feature<Point, GeoJsonProperties>[] = [];
  const routeFeatures: Feature<LineString, GeoJsonProperties>[] = [];
  const routePointFeatures: Feature<Point, GeoJsonProperties>[] = [];
  const trackFeatures: Feature<LineString, GeoJsonProperties>[] = [];
  const trackPointFeatures: Feature<Point, GeoJsonProperties>[] = [];
  // Valid points seen while building the line coordinates, tracked even when the
  // point-feature collections are not built, so the "no valid content" guard
  // below does not reject a file whose only geometry is a single-point track or
  // route (which never forms a >= 2 point LineString).
  let validRoutePointCount = 0;
  let validTrackPointCount = 0;
  const waypoints = directChildren(gpx, "wpt");
  const routes = directChildren(gpx, "rte");
  const tracks = directChildren(gpx, "trk");

  for (const [index, waypoint] of waypoints.entries()) {
    const coordinate = coordinateFromPoint(waypoint);
    if (!coordinate) continue;
    waypointFeatures.push({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: coordinate,
      },
      properties: {
        ...pointProperties(waypoint),
        gpx_index: index + 1,
        gpx_kind: "waypoint",
      },
    } satisfies Feature<Point, GeoJsonProperties>);
  }

  for (const [index, route] of routes.entries()) {
    const routePointElements = directChildren(route, "rtept");
    const { coordinates, pointFeatures } = collectLinePoints(
      routePointElements,
      includeRoutePoints,
      (point, pointIndex) => ({
        ...pointProperties(point),
        gpx_index: pointIndex + 1,
        gpx_kind: "route_point",
        route_index: index + 1,
      }),
    );
    routePointFeatures.push(...pointFeatures);
    validRoutePointCount += coordinates.length;
    if (coordinates.length < 2) continue;
    routeFeatures.push({
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates,
      },
      properties: {
        ...containerProperties(route),
        gpx_index: index + 1,
        gpx_kind: "route",
        point_count: coordinates.length,
      },
    } satisfies Feature<LineString, GeoJsonProperties>);
  }

  for (const [trackIndex, track] of tracks.entries()) {
    const segments = directChildren(track, "trkseg");
    for (const [segmentIndex, segment] of segments.entries()) {
      const trackPointElements = directChildren(segment, "trkpt");
      const { coordinates, pointFeatures } = collectLinePoints(
        trackPointElements,
        includeTrackPoints,
        (point, pointIndex) => ({
          ...pointProperties(point),
          gpx_index: pointIndex + 1,
          gpx_kind: "track_point",
          track_index: trackIndex + 1,
          segment_index: segmentIndex + 1,
        }),
      );
      trackPointFeatures.push(...pointFeatures);
      validTrackPointCount += coordinates.length;
      if (coordinates.length < 2) continue;
      trackFeatures.push({
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates,
        },
        properties: {
          ...containerProperties(track),
          gpx_index: trackIndex + 1,
          gpx_kind: "track",
          point_count: coordinates.length,
          segment_count: segments.length,
          segment_index: segmentIndex + 1,
        },
      } satisfies Feature<LineString, GeoJsonProperties>);
    }
  }

  if (
    waypointFeatures.length === 0 &&
    routeFeatures.length === 0 &&
    trackFeatures.length === 0 &&
    validRoutePointCount === 0 &&
    validTrackPointCount === 0
  ) {
    throw new Error("No valid GPX waypoints, routes, tracks, or track/route points were found.");
  }

  return {
    routes: {
      type: "FeatureCollection",
      features: routeFeatures,
    },
    routeCount: routeFeatures.length,
    routePoints: {
      type: "FeatureCollection",
      features: routePointFeatures,
    },
    routePointCount: routePointFeatures.length,
    tracks: {
      type: "FeatureCollection",
      features: trackFeatures,
    },
    trackCount: trackFeatures.length,
    trackPoints: {
      type: "FeatureCollection",
      features: trackPointFeatures,
    },
    trackPointCount: trackPointFeatures.length,
    waypoints: {
      type: "FeatureCollection",
      features: waypointFeatures,
    },
    waypointCount: waypointFeatures.length,
  };
}

function directChildren(parent: Element, localName: string): Element[] {
  return Array.from(parent.children).filter((child) => child.localName.toLowerCase() === localName);
}

function childText(parent: Element, localName: string): string | undefined {
  const child = directChildren(parent, localName)[0];
  const value = child?.textContent?.trim();
  return value || undefined;
}

function pointProperties(point: Element): GeoJsonProperties {
  const properties: GeoJsonProperties = {};
  for (const name of GPX_POINT_PROPERTY_NAMES) {
    const value = childText(point, name);
    if (value !== undefined) properties[name] = propertyValue(name, value);
  }
  return properties;
}

function containerProperties(container: Element): GeoJsonProperties {
  const properties: GeoJsonProperties = {};
  for (const name of GPX_CONTAINER_PROPERTY_NAMES) {
    const value = childText(container, name);
    if (value !== undefined) properties[name] = propertyValue(name, value);
  }
  return properties;
}

function propertyValue(name: string, value: string): string | number {
  return GPX_NUMERIC_PROPERTY_NAMES.has(name) ? numericValue(value) : value;
}

function coordinateFromPoint(point: GpxPointElement): Position | null {
  const latitudeAttribute = point.getAttribute("lat");
  const longitudeAttribute = point.getAttribute("lon");
  if (!latitudeAttribute?.trim() || !longitudeAttribute?.trim()) return null;
  const latitude = Number(latitudeAttribute);
  const longitude = Number(longitudeAttribute);
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    return null;
  }

  const elevation = Number(childText(point, "ele"));
  if (Number.isFinite(elevation)) return [longitude, latitude, elevation];
  return [longitude, latitude];
}

/**
 * Walk a list of GPX point elements (`<rtept>` or `<trkpt>`) once, collecting
 * the valid coordinates for the line geometry and, when `includePoints` is set,
 * a Point feature per valid element. `pointIndex` passed to `makeProperties` is
 * the element's original position in the list (0-based), so callers can mirror
 * the source ordering (gaps included) the way waypoints do.
 */
function collectLinePoints(
  elements: Element[],
  includePoints: boolean,
  makeProperties: (point: Element, pointIndex: number) => GeoJsonProperties,
): {
  coordinates: Position[];
  pointFeatures: Feature<Point, GeoJsonProperties>[];
} {
  const coordinates: Position[] = [];
  const pointFeatures: Feature<Point, GeoJsonProperties>[] = [];
  for (const [pointIndex, point] of elements.entries()) {
    const coordinate = coordinateFromPoint(point);
    if (!coordinate) continue;
    coordinates.push(coordinate);
    if (!includePoints) continue;
    pointFeatures.push({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: coordinate,
      },
      properties: makeProperties(point, pointIndex),
    } satisfies Feature<Point, GeoJsonProperties>);
  }
  return { coordinates, pointFeatures };
}

function numericValue(value: string): string | number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && value.trim() !== "" ? parsed : value;
}
