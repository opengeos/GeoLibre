import { VectorTile } from "@mapbox/vector-tile";
import type { Feature, FeatureCollection, Geometry, Position } from "geojson";
import {
  DEFAULT_TILES_BASE_URL,
  fetchReleases,
  type OvertureTheme,
} from "maplibre-gl-overture-maps";
import Pbf from "pbf";
import { PMTiles } from "pmtiles";
import type {
  GeoLibreOvertureQuery,
  GeoLibreOvertureQueryResult,
} from "../types";

const WEB_MERCATOR_MAX_LAT = 85.05112878;
const DEFAULT_ZOOM = 12;
const DEFAULT_MAX_TILES = 512;
const DEFAULT_MAX_FEATURES = 50_000;
const DEFAULT_CONCURRENCY = 8;
const MAX_TILES = 1024;
const MAX_FEATURES = 250_000;

type BBox = [number, number, number, number];
type AreaGeometry = Extract<Geometry, { type: "Polygon" | "MultiPolygon" }>;

interface TileCoordinate {
  x: number;
  y: number;
  z: number;
}

function assertBBox(value: BBox): void {
  const [west, south, east, north] = value;
  if (
    !value.every(Number.isFinite) ||
    west >= east ||
    south >= north ||
    west < -180 ||
    east > 180 ||
    south < -90 ||
    north > 90
  ) {
    throw new Error(
      "Overture query bbox must be a valid [west, south, east, north] extent."
    );
  }
}

function clampLatitude(value: number): number {
  return Math.max(-WEB_MERCATOR_MAX_LAT, Math.min(WEB_MERCATOR_MAX_LAT, value));
}

function longitudeTileX(longitude: number, zoom: number): number {
  const scale = 2 ** zoom;
  return Math.max(
    0,
    Math.min(scale - 1, Math.floor(((longitude + 180) / 360) * scale))
  );
}

function latitudeTileY(latitude: number, zoom: number): number {
  const radians = (clampLatitude(latitude) * Math.PI) / 180;
  const scale = 2 ** zoom;
  const y = Math.floor(
    ((1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2) * scale
  );
  return Math.max(0, Math.min(scale - 1, y));
}

/** Enumerate XYZ tiles covering a WGS84 bbox at a fixed zoom. */
export function overtureTilesForBBox(
  bbox: BBox,
  zoom: number
): TileCoordinate[] {
  assertBBox(bbox);
  const [west, south, east, north] = bbox;
  const minX = longitudeTileX(west, zoom);
  const maxX = longitudeTileX(east, zoom);
  const minY = latitudeTileY(north, zoom);
  const maxY = latitudeTileY(south, zoom);
  const tiles: TileCoordinate[] = [];
  for (let x = minX; x <= maxX; x += 1) {
    for (let y = minY; y <= maxY; y += 1) {
      tiles.push({ x, y, z: zoom });
    }
  }
  return tiles;
}

function collectPositions(geometry: Geometry, sink: Position[]): void {
  if (geometry.type === "GeometryCollection") {
    for (const child of geometry.geometries) collectPositions(child, sink);
    return;
  }
  const visit = (value: unknown): void => {
    if (
      Array.isArray(value) &&
      value.length >= 2 &&
      typeof value[0] === "number" &&
      typeof value[1] === "number"
    ) {
      sink.push(value as Position);
      return;
    }
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
    }
  };
  visit(geometry.coordinates);
}

function geometryBBox(geometry: Geometry): BBox | null {
  const positions: Position[] = [];
  collectPositions(geometry, positions);
  if (!positions.length) return null;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [longitude, latitude] of positions) {
    west = Math.min(west, longitude);
    south = Math.min(south, latitude);
    east = Math.max(east, longitude);
    north = Math.max(north, latitude);
  }
  return [west, south, east, north];
}

function bboxesIntersect(first: BBox, second: BBox): boolean {
  return !(
    first[2] < second[0] ||
    first[0] > second[2] ||
    first[3] < second[1] ||
    first[1] > second[3]
  );
}

function pointInRing(point: Position, ring: Position[]): boolean {
  const [x, y] = point;
  let inside = false;
  for (
    let index = 0, previous = ring.length - 1;
    index < ring.length;
    previous = index++
  ) {
    const [xi, yi] = ring[index];
    const [xj, yj] = ring[previous];
    if (
      yi > y !== yj > y &&
      x < ((xj - xi) * (y - yi)) / (yj - yi + Number.EPSILON) + xi
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function pointInArea(point: Position, geometry: AreaGeometry): boolean {
  const polygons =
    geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return polygons.some(([outer, ...holes]) => {
    if (!outer || !pointInRing(point, outer)) return false;
    return !holes.some((hole) => pointInRing(point, hole));
  });
}

function cross(first: Position, second: Position, third: Position): number {
  return (
    (second[0] - first[0]) * (third[1] - first[1]) -
    (second[1] - first[1]) * (third[0] - first[0])
  );
}

function onSegment(
  first: Position,
  second: Position,
  point: Position
): boolean {
  return (
    Math.abs(cross(first, second, point)) < 1e-12 &&
    point[0] >= Math.min(first[0], second[0]) &&
    point[0] <= Math.max(first[0], second[0]) &&
    point[1] >= Math.min(first[1], second[1]) &&
    point[1] <= Math.max(first[1], second[1])
  );
}

function segmentsIntersect(
  firstStart: Position,
  firstEnd: Position,
  secondStart: Position,
  secondEnd: Position
): boolean {
  const d1 = cross(firstStart, firstEnd, secondStart);
  const d2 = cross(firstStart, firstEnd, secondEnd);
  const d3 = cross(secondStart, secondEnd, firstStart);
  const d4 = cross(secondStart, secondEnd, firstEnd);
  if (
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  ) {
    return true;
  }
  return (
    onSegment(firstStart, firstEnd, secondStart) ||
    onSegment(firstStart, firstEnd, secondEnd) ||
    onSegment(secondStart, secondEnd, firstStart) ||
    onSegment(secondStart, secondEnd, firstEnd)
  );
}

function areaRings(areas: AreaGeometry[]): Position[][] {
  return areas.flatMap((area) =>
    area.type === "Polygon" ? area.coordinates : area.coordinates.flat()
  );
}

function lineIntersectsAreas(line: Position[], areas: AreaGeometry[]): boolean {
  if (line.some((point) => areas.some((area) => pointInArea(point, area)))) {
    return true;
  }
  const rings = areaRings(areas);
  for (let index = 1; index < line.length; index += 1) {
    for (const ring of rings) {
      for (let edge = 1; edge < ring.length; edge += 1) {
        if (
          segmentsIntersect(
            line[index - 1],
            line[index],
            ring[edge - 1],
            ring[edge]
          )
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

function areaGeometries(filter?: Geometry | FeatureCollection): AreaGeometry[] {
  if (!filter) return [];
  if (filter.type === "FeatureCollection") {
    return filter.features
      .map((feature) => feature.geometry)
      .filter(
        (geometry): geometry is AreaGeometry =>
          geometry?.type === "Polygon" || geometry?.type === "MultiPolygon"
      );
  }
  return filter.type === "Polygon" || filter.type === "MultiPolygon"
    ? [filter]
    : [];
}

function geometryCentroid(geometry: Geometry): Position | null {
  const positions: Position[] = [];
  collectPositions(geometry, positions);
  if (!positions.length) return null;
  const sum = positions.reduce(
    (current, [longitude, latitude]) =>
      [current[0] + longitude, current[1] + latitude] as Position,
    [0, 0] as Position
  );
  return [sum[0] / positions.length, sum[1] / positions.length];
}

/** Test a feature against an optional polygon filter. */
export function overtureFeatureMatchesFilter(
  feature: Feature,
  filter: Geometry | FeatureCollection | undefined,
  mode: "centroid-within" | "intersects" = "intersects"
): boolean {
  if (!feature.geometry || !filter) return true;
  const areas = areaGeometries(filter);
  if (!areas.length) return true;
  if (mode === "centroid-within") {
    const center = geometryCentroid(feature.geometry);
    return !!center && areas.some((area) => pointInArea(center, area));
  }
  const geometry = feature.geometry;
  if (geometry.type === "Point") {
    return areas.some((area) => pointInArea(geometry.coordinates, area));
  }
  if (geometry.type === "MultiPoint") {
    return geometry.coordinates.some((point) =>
      areas.some((area) => pointInArea(point, area))
    );
  }
  if (geometry.type === "LineString") {
    return lineIntersectsAreas(geometry.coordinates, areas);
  }
  if (geometry.type === "MultiLineString") {
    return geometry.coordinates.some((line) =>
      lineIntersectsAreas(line, areas)
    );
  }
  const center = geometryCentroid(geometry);
  return !!center && areas.some((area) => pointInArea(center, area));
}

function overtureArchiveUrl(release: string, theme: OvertureTheme): string {
  return `${DEFAULT_TILES_BASE_URL.replace(
    /\/+$/,
    ""
  )}/${release}/${theme}.pmtiles`;
}

/**
 * Query official Overture PMTiles for a bounded set of MVT features.
 *
 * The preferred zoom is lowered until the tile cap is satisfied. Every matching
 * feature fragment is preserved because long transportation segments and large
 * polygons can span tile boundaries.
 */
export async function queryOvertureFeatures(
  query: GeoLibreOvertureQuery
): Promise<GeoLibreOvertureQueryResult> {
  assertBBox(query.bbox);
  const maxTiles = Math.min(
    MAX_TILES,
    Math.max(1, Math.floor(query.maxTiles ?? DEFAULT_MAX_TILES))
  );
  const maxFeatures = Math.min(
    MAX_FEATURES,
    Math.max(1, Math.floor(query.maxFeatures ?? DEFAULT_MAX_FEATURES))
  );
  let zoom = Math.max(0, Math.min(14, Math.floor(query.zoom ?? DEFAULT_ZOOM)));
  let tiles = overtureTilesForBBox(query.bbox, zoom);
  while (tiles.length > maxTiles && zoom > 0) {
    zoom -= 1;
    tiles = overtureTilesForBBox(query.bbox, zoom);
  }
  if (tiles.length > maxTiles) {
    throw new Error(
      `Overture query covers ${tiles.length} tiles, above the ${maxTiles}-tile limit.`
    );
  }

  const { latest: release } = await fetchReleases();
  const archive = new PMTiles(overtureArchiveUrl(release, query.theme));
  const features: Feature[] = [];
  let matchedFeatureCount = 0;
  let truncated = false;
  let nextTile = 0;

  const workers = Array.from(
    { length: Math.min(DEFAULT_CONCURRENCY, tiles.length) },
    async () => {
      while (nextTile < tiles.length && !truncated) {
        if (query.signal?.aborted)
          throw new DOMException("Aborted", "AbortError");
        const tile = tiles[nextTile];
        nextTile += 1;
        const response = await archive.getZxy(
          tile.z,
          tile.x,
          tile.y,
          query.signal
        );
        if (!response) continue;
        if (truncated) return;
        const vectorTile = new VectorTile(new Pbf(response.data));
        const source = vectorTile.layers[query.sourceLayer];
        if (!source) continue;
        for (let index = 0; index < source.length; index += 1) {
          const vectorFeature = source.feature(index);
          const feature = vectorFeature.toGeoJSON(
            tile.x,
            tile.y,
            tile.z
          ) as Feature;
          if (!feature.geometry) continue;
          const featureBox = geometryBBox(feature.geometry);
          if (!featureBox || !bboxesIntersect(featureBox, query.bbox)) continue;
          if (
            !overtureFeatureMatchesFilter(
              feature,
              query.filterGeometry,
              query.filterMode
            )
          ) {
            continue;
          }
          matchedFeatureCount += 1;
          if (features.length >= maxFeatures) {
            truncated = true;
            break;
          }
          feature.properties = {
            ...(feature.properties ?? {}),
            _overture_id:
              vectorFeature.id === undefined ? null : String(vectorFeature.id),
            _overture_release: release,
            _overture_theme: query.theme,
            _overture_source_layer: query.sourceLayer,
          };
          features.push(feature);
        }
      }
    }
  );
  await Promise.all(workers);

  return {
    data: { type: "FeatureCollection", features },
    release,
    theme: query.theme,
    sourceLayer: query.sourceLayer,
    zoom,
    tilesRead: tiles.length,
    matchedFeatureCount,
    truncated,
  };
}
