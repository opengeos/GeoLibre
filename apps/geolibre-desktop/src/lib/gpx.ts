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
  tracks: FeatureCollection<LineString>;
  /**
   * Number of track features produced. Each `<trkseg>` becomes its own
   * LineString, so a single `<trk>` with multiple segments contributes more
   * than one to this count.
   */
  trackCount: number;
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

const GPX_CONTAINER_PROPERTY_NAMES = [
  "name",
  "cmt",
  "desc",
  "src",
  "number",
  "type",
];

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

export function parseGpxLayer(text: string): GpxLayerResult {
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
  const trackFeatures: Feature<LineString, GeoJsonProperties>[] = [];
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
    const routePoints = directChildren(route, "rtept");
    const coordinates = coordinatesFromPoints(routePoints);
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
      const trackPoints = directChildren(segment, "trkpt");
      const coordinates = coordinatesFromPoints(trackPoints);
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
    trackFeatures.length === 0
  ) {
    throw new Error("No valid GPX waypoints, routes, or tracks were found.");
  }

  return {
    routes: {
      type: "FeatureCollection",
      features: routeFeatures,
    },
    routeCount: routeFeatures.length,
    tracks: {
      type: "FeatureCollection",
      features: trackFeatures,
    },
    trackCount: trackFeatures.length,
    waypoints: {
      type: "FeatureCollection",
      features: waypointFeatures,
    },
    waypointCount: waypointFeatures.length,
  };
}

function directChildren(parent: Element, localName: string): Element[] {
  return Array.from(parent.children).filter(
    (child) => child.localName.toLowerCase() === localName,
  );
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

function coordinatesFromPoints(points: GpxPointElement[]): Position[] {
  return points
    .map(coordinateFromPoint)
    .filter((coordinate): coordinate is Position => coordinate !== null);
}

function numericValue(value: string): string | number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && value.trim() !== "" ? parsed : value;
}
