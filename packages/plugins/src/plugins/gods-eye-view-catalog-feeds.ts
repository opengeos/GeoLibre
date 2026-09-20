import type { CzmlPacket } from "@geolibre/core";
import type { Feature, FeatureCollection, Geometry, Point, Position } from "geojson";
import { downloadOsmGeoJson } from "./osm-downloader-api";

export const RADIO_BROWSER_STATIONS_URL =
  "https://all.api.radio-browser.info/json/stations/search?has_geo_info=true&is_https=true&hidebroken=true&order=clickcount&reverse=true&limit=750";
export const DATACENTERS_URL =
  "https://data.source.coop/opengeos/geolibre/gods-eye-view-data/datacenters/datacenters.geojsonl";
export const DAMS_URL =
  "https://data.source.coop/opengeos/geolibre/gods-eye-view-data/dams/dams.geojson";
export const SUBMARINE_CABLES_URL =
  "https://data.source.coop/opengeos/geolibre/gods-eye-view-data/telegeography_submarine_cables/cable-geo.json";

export interface GodsEyeViewFeedPayload {
  packets: CzmlPacket[];
  attributes: FeatureCollection;
}

interface RadioBrowserStation {
  stationuuid?: unknown;
  name?: unknown;
  url_resolved?: unknown;
  homepage?: unknown;
  country?: unknown;
  countrycode?: unknown;
  state?: unknown;
  language?: unknown;
  tags?: unknown;
  codec?: unknown;
  bitrate?: unknown;
  clickcount?: unknown;
  geo_lat?: unknown;
  geo_long?: unknown;
}

interface StaticFeedStyle {
  color: [number, number, number, number];
  pixelSize: number;
  prefix: string;
}

function documentPacket(name: string): CzmlPacket {
  return { id: "document", name, version: "1.0" };
}

function cleanProperties(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const properties: Record<string, unknown> = {};
  const entries = Object.entries(value);
  // Flatten nested `tags` first so a top-level key always wins over a tag of
  // the same name, whatever order the upstream JSON happened to list them in.
  for (const [key, item] of entries) {
    if (key === "tags" && item && typeof item === "object" && !Array.isArray(item)) {
      Object.assign(properties, cleanProperties(item));
    }
  }
  for (const [key, item] of entries) {
    if (
      typeof item === "string" ||
      typeof item === "boolean" ||
      (typeof item === "number" && Number.isFinite(item))
    ) {
      properties[key] = item;
    }
  }
  return properties;
}

function validPosition(value: unknown): value is Position {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1]) &&
    (value[0] as number) >= -180 &&
    (value[0] as number) <= 180 &&
    (value[1] as number) >= -90 &&
    (value[1] as number) <= 90
  );
}

function geometryPositions(geometry: Geometry | null): Position[] {
  if (!geometry) return [];
  if (geometry.type === "Point")
    return validPosition(geometry.coordinates) ? [geometry.coordinates] : [];
  if (geometry.type === "MultiPoint" || geometry.type === "LineString") {
    return geometry.coordinates.filter(validPosition);
  }
  if (geometry.type === "MultiLineString" || geometry.type === "Polygon") {
    return geometry.coordinates.flat().filter(validPosition);
  }
  if (geometry.type === "MultiPolygon") return geometry.coordinates.flat(2).filter(validPosition);
  if (geometry.type === "GeometryCollection") {
    return geometry.geometries.flatMap((item) => geometryPositions(item));
  }
  return [];
}

interface WeightedCenter {
  center: Position;
  weight: number;
}

function ringCenter(ring: Position[]): WeightedCenter | null {
  const positions = ring.filter(validPosition);
  if (positions.length < 3) return null;
  const origin = positions[0][0];
  const unwrapped = positions.map(([longitude, latitude]) => {
    let adjusted = longitude;
    while (adjusted - origin > 180) adjusted -= 360;
    while (adjusted - origin < -180) adjusted += 360;
    return [adjusted, latitude] as Position;
  });
  if (unwrapped[0][0] !== unwrapped.at(-1)?.[0] || unwrapped[0][1] !== unwrapped.at(-1)?.[1]) {
    unwrapped.push(unwrapped[0]);
  }
  let twiceArea = 0;
  let longitudeSum = 0;
  let latitudeSum = 0;
  for (let index = 0; index < unwrapped.length - 1; index += 1) {
    const [x1, y1] = unwrapped[index];
    const [x2, y2] = unwrapped[index + 1];
    const cross = x1 * y2 - x2 * y1;
    twiceArea += cross;
    longitudeSum += (x1 + x2) * cross;
    latitudeSum += (y1 + y2) * cross;
  }
  if (Math.abs(twiceArea) < Number.EPSILON) return null;
  let longitude = longitudeSum / (3 * twiceArea);
  while (longitude > 180) longitude -= 360;
  while (longitude < -180) longitude += 360;
  return {
    center: [longitude, latitudeSum / (3 * twiceArea)],
    weight: Math.abs(twiceArea),
  };
}

function polygonCenter(rings: Position[][]): WeightedCenter | null {
  const exterior = ringCenter(rings[0] ?? []);
  if (!exterior) return null;
  let longitudeSum = exterior.center[0] * exterior.weight;
  let latitudeSum = exterior.center[1] * exterior.weight;
  let weight = exterior.weight;
  for (const ring of rings.slice(1)) {
    const hole = ringCenter(ring);
    if (!hole) continue;
    let longitude = hole.center[0];
    while (longitude - exterior.center[0] > 180) longitude -= 360;
    while (longitude - exterior.center[0] < -180) longitude += 360;
    longitudeSum -= longitude * hole.weight;
    latitudeSum -= hole.center[1] * hole.weight;
    weight -= hole.weight;
  }
  if (weight <= Number.EPSILON) return exterior;
  let longitude = longitudeSum / weight;
  while (longitude > 180) longitude -= 360;
  while (longitude < -180) longitude += 360;
  return { center: [longitude, latitudeSum / weight], weight };
}

function featureCenter(feature: Feature): Position | null {
  if (feature.geometry?.type === "Point" && validPosition(feature.geometry.coordinates)) {
    return feature.geometry.coordinates.slice(0, 2);
  }
  if (feature.geometry?.type === "Polygon") {
    return polygonCenter(feature.geometry.coordinates)?.center ?? null;
  }
  if (feature.geometry?.type === "MultiPolygon") {
    const centers = feature.geometry.coordinates
      .map((polygon) => polygonCenter(polygon))
      .filter((item): item is WeightedCenter => item !== null);
    return centers.sort((left, right) => right.weight - left.weight)[0]?.center ?? null;
  }
  const rawPositions = geometryPositions(feature.geometry);
  const positions =
    rawPositions.length > 1 &&
    rawPositions[0][0] === rawPositions.at(-1)?.[0] &&
    rawPositions[0][1] === rawPositions.at(-1)?.[1]
      ? rawPositions.slice(0, -1)
      : rawPositions;
  if (!positions.length) return null;
  let x = 0;
  let y = 0;
  let z = 0;
  for (const [longitude, latitude] of positions) {
    const lon = (longitude * Math.PI) / 180;
    const lat = (latitude * Math.PI) / 180;
    const cosLat = Math.cos(lat);
    x += cosLat * Math.cos(lon);
    y += cosLat * Math.sin(lon);
    z += Math.sin(lat);
  }
  const longitude = (Math.atan2(y, x) * 180) / Math.PI;
  const latitude = (Math.atan2(z, Math.hypot(x, y)) * 180) / Math.PI;
  return Number.isFinite(longitude) && Number.isFinite(latitude) ? [longitude, latitude] : null;
}

function pointCatalogToCzml(
  name: string,
  collection: FeatureCollection,
  style: StaticFeedStyle,
): GodsEyeViewFeedPayload {
  const packets: CzmlPacket[] = [documentPacket(name)];
  const features: Feature[] = [];
  for (const [index, feature] of collection.features.entries()) {
    const center = featureCenter(feature);
    if (!center) continue;
    const properties = cleanProperties(feature.properties);
    const displayName =
      typeof properties.name === "string" && properties.name.trim()
        ? properties.name.trim()
        : `${name} ${index + 1}`;
    const id = `${style.prefix}-${String(feature.id ?? index)}`;
    packets.push({
      id,
      name: displayName,
      position: { cartographicDegrees: [center[0], center[1], 0] },
      properties,
      point: {
        pixelSize: style.pixelSize,
        color: { rgba: style.color },
        outlineColor: { rgba: [255, 255, 255, 190] },
        outlineWidth: 1,
      },
    });
    features.push({
      type: "Feature",
      id,
      geometry: { type: "Point", coordinates: center } satisfies Point,
      properties,
    });
  }
  return { packets, attributes: { type: "FeatureCollection", features } };
}

function geoJsonLines(value: string): FeatureCollection {
  const features: Feature[] = [];
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // One truncated row in a large mirrored file shouldn't cost the whole feed.
    let parsed: Feature;
    try {
      parsed = JSON.parse(trimmed) as Feature;
    } catch {
      continue;
    }
    if (parsed?.type === "Feature") features.push(parsed);
  }
  return { type: "FeatureCollection", features };
}

async function readFeed(
  url: string,
  options: { fetch?: typeof fetch; signal?: AbortSignal },
): Promise<Response> {
  const response = await (options.fetch ?? fetch)(url, {
    signal: options.signal,
  });
  if (!response.ok) throw new Error(`${new URL(url).hostname} feed failed (${response.status})`);
  return response;
}

async function readJson(
  url: string,
  options: { fetch?: typeof fetch; signal?: AbortSignal },
): Promise<unknown> {
  return (await readFeed(url, options)).json();
}

export async function fetchDatacentersCzml(
  options: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<GodsEyeViewFeedPayload> {
  const text = await (await readFeed(DATACENTERS_URL, options)).text();
  return pointCatalogToCzml("Datacenters", geoJsonLines(text), {
    prefix: "datacenter",
    color: [96, 165, 250, 235],
    pixelSize: 6,
  });
}

export async function fetchDamsCzml(
  options: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<GodsEyeViewFeedPayload> {
  return pointCatalogToCzml("Dams", (await readJson(DAMS_URL, options)) as FeatureCollection, {
    prefix: "dam",
    color: [45, 212, 191, 235],
    pixelSize: 7,
  });
}

export function radioBrowserStationsToCzml(value: unknown): GodsEyeViewFeedPayload {
  const features: Feature[] = [];
  for (const [index, item] of (Array.isArray(value) ? value : []).entries()) {
    const station = item as RadioBrowserStation;
    if (!Number.isFinite(station.geo_long) || !Number.isFinite(station.geo_lat)) continue;
    const longitude = station.geo_long as number;
    const latitude = station.geo_lat as number;
    if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) continue;
    const name =
      typeof station.name === "string" && station.name.trim() ? station.name.trim() : "Radio";
    features.push({
      type: "Feature",
      id: typeof station.stationuuid === "string" ? station.stationuuid : index,
      geometry: { type: "Point", coordinates: [longitude, latitude] },
      properties: {
        name,
        streamUrl: typeof station.url_resolved === "string" ? station.url_resolved : "",
        homepage: typeof station.homepage === "string" ? station.homepage : "",
        country: typeof station.country === "string" ? station.country : "",
        countryCode: typeof station.countrycode === "string" ? station.countrycode : "",
        state: typeof station.state === "string" ? station.state : "",
        language: typeof station.language === "string" ? station.language : "",
        tags: typeof station.tags === "string" ? station.tags : "",
        codec: typeof station.codec === "string" ? station.codec : "",
        bitrate: Number.isFinite(station.bitrate) ? station.bitrate : 0,
        clickCount: Number.isFinite(station.clickcount) ? station.clickcount : 0,
      },
    });
  }
  return pointCatalogToCzml(
    "Radio Stations",
    { type: "FeatureCollection", features },
    {
      prefix: "radio",
      color: [244, 114, 182, 235],
      pixelSize: 7,
    },
  );
}

export async function fetchRadioBrowserCzml(
  options: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<GodsEyeViewFeedPayload> {
  return radioBrowserStationsToCzml(await readJson(RADIO_BROWSER_STATIONS_URL, options));
}

function cssHexColor(value: unknown): [number, number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(typeof value === "string" ? value : "");
  return match
    ? [
        Number.parseInt(match[1].slice(0, 2), 16),
        Number.parseInt(match[1].slice(2, 4), 16),
        Number.parseInt(match[1].slice(4, 6), 16),
        215,
      ]
    : [56, 189, 248, 215];
}

export function submarineCablesToCzml(collection: FeatureCollection): GodsEyeViewFeedPayload {
  const packets: CzmlPacket[] = [documentPacket("Submarine Cables")];
  const features: Feature[] = [];
  for (const [featureIndex, feature] of collection.features.entries()) {
    const geometry = feature.geometry;
    const lines =
      geometry?.type === "LineString"
        ? [geometry.coordinates]
        : geometry?.type === "MultiLineString"
          ? geometry.coordinates
          : [];
    const properties = cleanProperties(feature.properties);
    const name =
      typeof properties.name === "string" && properties.name.trim()
        ? properties.name.trim()
        : `Cable ${featureIndex + 1}`;
    for (const [lineIndex, line] of lines.entries()) {
      const positions = line.filter(validPosition);
      if (positions.length < 2) continue;
      const id = `cable-${String(properties.id ?? feature.id ?? featureIndex)}-${lineIndex}`;
      packets.push({
        id,
        name,
        properties,
        polyline: {
          positions: {
            cartographicDegrees: positions.flatMap(([lon, lat]) => [lon, lat, 0]),
          },
          // Not `clampToGround`: draping every segment onto terrain sends the
          // whole feed (1,913 segments, 13,902 vertices) through Cesium's
          // ground-primitive pipeline, which measured ~14x the per-frame cost
          // of the same geometry drawn geodesically at sea level. Cables are
          // submarine, so there is no terrain to drape onto, and the globe
          // leaves `depthTestAgainstTerrain` off, so height 0 draws cleanly.
          arcType: "GEODESIC",
          width: 2,
          material: {
            solidColor: { color: { rgba: cssHexColor(properties.color) } },
          },
        },
      });
      features.push({
        type: "Feature",
        id,
        geometry: { type: "LineString", coordinates: positions },
        properties,
      });
    }
  }
  return { packets, attributes: { type: "FeatureCollection", features } };
}

export async function fetchSubmarineCablesCzml(
  options: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<GodsEyeViewFeedPayload> {
  return submarineCablesToCzml(
    (await readJson(SUBMARINE_CABLES_URL, options)) as FeatureCollection,
  );
}

/** Limit a global globe view to the Overpass relay's bounded-query policy. */
export function infrastructureQueryBounds(
  bounds: [number, number, number, number] | null,
): [number, number, number, number] {
  if (!bounds) throw new Error("The current map extent is not available yet.");
  let [west, south, east, north] = bounds;
  const centerLongitude = (west + east) / 2;
  const centerLatitude = Math.max(-89, Math.min(89, (south + north) / 2));
  const width = Math.min(2, Math.max(0.01, east - west));
  const height = Math.min(2, Math.max(0.01, north - south));
  let center = centerLongitude;
  while (center - width / 2 < -180) center += 360;
  while (center - width / 2 > 180) center -= 360;
  west = center - width / 2;
  east = center + width / 2;
  south = Math.max(-90, centerLatitude - height / 2);
  north = Math.min(90, centerLatitude + height / 2);
  return [west, south, east, north];
}

function geometryLines(geometry: Geometry | null): Position[][] {
  if (!geometry) return [];
  if (geometry.type === "LineString") return [geometry.coordinates];
  if (geometry.type === "MultiLineString" || geometry.type === "Polygon")
    return geometry.coordinates;
  if (geometry.type === "MultiPolygon") return geometry.coordinates.flat();
  return [];
}

export function osmInfrastructureToCzml(collection: FeatureCollection): GodsEyeViewFeedPayload {
  const packets: CzmlPacket[] = [documentPacket("OSM Infrastructure")];
  const features: Feature[] = [];
  for (const [index, feature] of collection.features.entries()) {
    const properties = cleanProperties(feature.properties);
    const name =
      typeof properties.name === "string" && properties.name.trim()
        ? properties.name.trim()
        : typeof properties.man_made === "string" && properties.man_made.trim()
          ? properties.man_made.trim().replaceAll("_", " ")
          : `Infrastructure ${index + 1}`;
    const id = `osm-infrastructure-${String(feature.id ?? index)}`;
    if (feature.geometry?.type === "Point") {
      if (!validPosition(feature.geometry.coordinates)) continue;
      packets.push({
        id,
        name,
        position: {
          cartographicDegrees: [...feature.geometry.coordinates.slice(0, 2), 0],
        },
        properties,
        point: {
          pixelSize: 7,
          color: { rgba: [251, 146, 60, 235] },
          outlineColor: { rgba: [255, 255, 255, 190] },
          outlineWidth: 1,
        },
      });
      features.push({
        type: "Feature",
        id,
        geometry: { type: "Point", coordinates: feature.geometry.coordinates.slice(0, 2) },
        properties,
      });
      continue;
    }
    for (const [lineIndex, rawLine] of geometryLines(feature.geometry).entries()) {
      const line = rawLine.filter(validPosition);
      if (line.length < 2) continue;
      const packetId = `${id}-${lineIndex}`;
      packets.push({
        id: packetId,
        name,
        properties,
        polyline: {
          positions: {
            cartographicDegrees: line.flatMap(([lon, lat]) => [lon, lat, 0]),
          },
          clampToGround: true,
          width: 2,
          material: { solidColor: { color: { rgba: [251, 146, 60, 225] } } },
        },
      });
      features.push({
        type: "Feature",
        id: packetId,
        geometry: { type: "LineString", coordinates: line },
        properties,
      });
    }
  }
  return { packets, attributes: { type: "FeatureCollection", features } };
}

export async function fetchOsmInfrastructureCzml(
  bounds: [number, number, number, number] | null,
  options: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<GodsEyeViewFeedPayload> {
  const data = await downloadOsmGeoJson(
    infrastructureQueryBounds(bounds),
    { preset: "custom", key: "man_made" },
    { fetchImpl: options.fetch as never, signal: options.signal },
  );
  return osmInfrastructureToCzml(data);
}
