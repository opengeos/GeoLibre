import type {
  Feature,
  FeatureCollection,
  GeoJsonProperties,
  LineString,
  Point,
  Position,
} from "geojson";

export interface GpxLayerResult {
  data: FeatureCollection;
  routes: FeatureCollection<LineString>;
  routeCount: number;
  tracks: FeatureCollection<LineString>;
  trackCount: number;
  waypoints: FeatureCollection<Point>;
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

  const features: Feature[] = [
    ...waypointFeatures,
    ...routeFeatures,
    ...trackFeatures,
  ];

  if (features.length === 0) {
    throw new Error("No valid GPX waypoints, routes, or tracks were found.");
  }

  return {
    data: {
      type: "FeatureCollection",
      features,
    },
    routes: {
      type: "FeatureCollection",
      features: routeFeatures,
    },
    routeCount: routes.length,
    tracks: {
      type: "FeatureCollection",
      features: trackFeatures,
    },
    trackCount: tracks.length,
    waypoints: {
      type: "FeatureCollection",
      features: waypointFeatures,
    },
    waypointCount: waypoints.length,
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
    if (value !== undefined) properties[name] = numericValue(value);
  }
  return properties;
}

function containerProperties(container: Element): GeoJsonProperties {
  const properties: GeoJsonProperties = {};
  for (const name of GPX_CONTAINER_PROPERTY_NAMES) {
    const value = childText(container, name);
    if (value !== undefined) properties[name] = numericValue(value);
  }
  return properties;
}

function coordinateFromPoint(point: GpxPointElement): Position | null {
  const latitude = Number(point.getAttribute("lat"));
  const longitude = Number(point.getAttribute("lon"));
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
