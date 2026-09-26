import type { Feature, FeatureCollection, Geometry, Position } from "geojson";

/**
 * Generalized ("quantized") ArcGIS feature queries for zoomed-out views.
 *
 * A viewport query at a low zoom asks for every vertex of every feature in a
 * continent-sized extent, which for detailed polygons (congressional districts,
 * coastlines, parcels) is tens of megabytes per hundred features. Hosted
 * feature services ignore `maxAllowableOffset`, so the only generalization they
 * honor is `quantizationParameters`: the server snaps vertices to a grid of the
 * requested tolerance, drops the ones that collapse together, and delta-encodes
 * the rest as integers. It only does so for `f=json` (not `f=geojson`), so the
 * Esri JSON it returns is decoded here. Measured on Esri's 119th Congressional
 * Districts layer: 100 districts fell from 37 MB in 22 s to 370 KB in 1.8 s.
 */

/** Half the Web Mercator world width, in meters. */
const WEB_MERCATOR_HALF_WORLD = 20037508.342789244;
const EARTH_RADIUS = 6378137;
/** MapLibre's tile size: at zoom z the world is `512 * 2^z` pixels wide. */
const TILE_SIZE = 512;

/**
 * Zoom at and above which features load at full resolution. Below it a pixel is
 * wider than ~20 m, so detail the grid drops cannot be seen, and the geometry
 * held for the view is too coarse to edit (see `geometryGeneralized`).
 */
export const ARCGIS_GENERALIZE_MAX_ZOOM = 12;

/** Esri geometry types whose vertices quantization can thin out. */
const GENERALIZABLE_GEOMETRY_TYPES = new Set(["esriGeometryPolygon", "esriGeometryPolyline"]);

/**
 * The query parameters that request geometry generalized for a zoom level, or
 * `null` when the layer should load at full resolution.
 *
 * Args:
 *   zoom: The map's current zoom.
 *   layerInfo: The layer's `?f=json` metadata.
 *
 * Returns:
 *   Params to merge into the `/query` request, or `null`.
 */
export function arcgisQuantizationParams(
  zoom: number,
  layerInfo: { geometryType?: string; supportsCoordinatesQuantization?: boolean },
): Record<string, string> | null {
  if (!Number.isFinite(zoom) || zoom >= ARCGIS_GENERALIZE_MAX_ZOOM) return null;
  if (layerInfo.supportsCoordinatesQuantization !== true) return null;
  if (!GENERALIZABLE_GEOMETRY_TYPES.has(layerInfo.geometryType ?? "")) return null;
  // One screen pixel: finer than that cannot be seen, coarser shows as steps.
  const tolerance = (2 * WEB_MERCATOR_HALF_WORLD) / (TILE_SIZE * 2 ** Math.max(0, zoom));
  return {
    f: "json",
    outSR: "102100",
    quantizationParameters: JSON.stringify({
      mode: "view",
      originPosition: "upperLeft",
      tolerance,
      extent: {
        xmin: -WEB_MERCATOR_HALF_WORLD,
        ymin: -WEB_MERCATOR_HALF_WORLD,
        xmax: WEB_MERCATOR_HALF_WORLD,
        ymax: WEB_MERCATOR_HALF_WORLD,
        spatialReference: { wkid: 102100 },
      },
    }),
  };
}

/** The Esri JSON feature set a quantized query returns. */
export interface ArcGISQuantizedFeatureSet {
  exceededTransferLimit?: boolean;
  features: Array<{
    attributes?: Record<string, unknown> | null;
    geometry?: EsriGeometry | null;
  }>;
  objectIdFieldName?: string;
  transform: {
    originPosition?: string;
    scale: number[];
    translate: number[];
  };
}

interface EsriGeometry {
  x?: number;
  y?: number;
  points?: number[][];
  paths?: number[][][];
  rings?: number[][][];
}

/**
 * Whether a parsed `/query` response is a quantized Esri JSON feature set.
 *
 * Args:
 *   value: The parsed response body.
 *
 * Returns:
 *   True for a feature set carrying a quantization transform.
 */
export function isArcGISQuantizedFeatureSet(value: unknown): value is ArcGISQuantizedFeatureSet {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ArcGISQuantizedFeatureSet>;
  const transform = candidate.transform;
  return (
    Array.isArray(candidate.features) &&
    !!transform &&
    Array.isArray(transform.scale) &&
    Array.isArray(transform.translate) &&
    transform.scale.length >= 2 &&
    transform.translate.length >= 2
  );
}

/**
 * Decode a quantized Esri JSON feature set into WGS84 GeoJSON.
 *
 * Args:
 *   featureSet: The parsed `f=json` response of a quantized query.
 *
 * Returns:
 *   The features as a FeatureCollection, ids taken from the ObjectID field,
 *   plus `recordCount`: how many records the server returned, which exceeds
 *   the feature count when shapes collapsed below the grid. Paging must count
 *   records, or a page thinned by collapsed shapes would read as the last one.
 */
export function decodeArcGISQuantizedFeatures(
  featureSet: ArcGISQuantizedFeatureSet,
): FeatureCollection & { exceededTransferLimit: boolean; recordCount: number } {
  const grid = featureSet.transform;
  const [scaleX, scaleY] = grid.scale;
  const [translateX, translateY] = grid.translate;
  // "upperLeft" counts rows down from the top edge; "lowerLeft" counts up.
  const ySign = grid.originPosition === "lowerLeft" ? 1 : -1;
  const toLngLat = (qx: number, qy: number): Position =>
    mercatorToLngLat(translateX + qx * scaleX, translateY + ySign * qy * scaleY);
  // Each path is delta-encoded: its first vertex is absolute, every later one
  // an offset from the vertex before it.
  const decodePath = (path: number[][]): Position[] => {
    let x = 0;
    let y = 0;
    return path.map(([dx, dy], index) => {
      x = index === 0 ? dx : x + dx;
      y = index === 0 ? dy : y + dy;
      return toLngLat(x, y);
    });
  };
  const oidField = featureSet.objectIdFieldName;

  const features: Feature[] = [];
  for (const source of featureSet.features) {
    const geometry = decodeGeometry(source.geometry ?? null, toLngLat, decodePath);
    // A shape smaller than the grid collapses to nothing; it would not have
    // covered a pixel, and it is back at full resolution once zoomed in.
    if (!geometry) continue;
    const properties = { ...(source.attributes ?? {}) };
    const oid = oidField ? properties[oidField] : undefined;
    features.push({
      type: "Feature",
      ...(typeof oid === "number" || typeof oid === "string" ? { id: oid } : {}),
      properties,
      geometry,
    });
  }
  return {
    type: "FeatureCollection",
    features,
    exceededTransferLimit: featureSet.exceededTransferLimit === true,
    recordCount: featureSet.features.length,
  };
}

function decodeGeometry(
  geometry: EsriGeometry | null,
  toLngLat: (qx: number, qy: number) => Position,
  decodePath: (path: number[][]) => Position[],
): Geometry | null {
  if (!geometry) return null;
  if (typeof geometry.x === "number" && typeof geometry.y === "number") {
    // Points are never delta-encoded.
    return { type: "Point", coordinates: toLngLat(geometry.x, geometry.y) };
  }
  if (geometry.points) {
    const points = decodePath(geometry.points);
    return points.length ? { type: "MultiPoint", coordinates: points } : null;
  }
  if (geometry.paths) {
    const paths = geometry.paths.map(decodePath).filter((path) => path.length >= 2);
    if (!paths.length) return null;
    return paths.length === 1
      ? { type: "LineString", coordinates: paths[0] }
      : { type: "MultiLineString", coordinates: paths };
  }
  if (geometry.rings) {
    const polygons = groupRings(
      // A ring the grid collapsed below a triangle has no area left to draw.
      geometry.rings.map(decodePath).filter((ring) => ring.length >= 4),
    );
    if (!polygons.length) return null;
    return polygons.length === 1
      ? { type: "Polygon", coordinates: polygons[0] }
      : { type: "MultiPolygon", coordinates: polygons };
  }
  return null;
}

/**
 * Group Esri rings into GeoJSON polygons. Esri winds outer rings clockwise
 * and holes counter-clockwise; each hole joins the smallest outer ring that
 * contains it. GeoJSON's opposite winding is applied on the way out.
 */
function groupRings(rings: Position[][]): Position[][][] {
  const outers: Array<{ ring: Position[]; area: number; holes: Position[][] }> = [];
  const holes: Position[][] = [];
  for (const ring of rings) {
    const area = signedArea(ring);
    if (area < 0) outers.push({ ring, area: -area, holes: [] });
    else if (area > 0) holes.push(ring);
  }
  for (const hole of holes) {
    let owner: (typeof outers)[number] | undefined;
    for (const outer of outers) {
      if ((!owner || outer.area < owner.area) && pointInRing(hole[0], outer.ring)) owner = outer;
    }
    // A counter-clockwise ring no outer ring holds is a shell wound the other
    // way (as in data from services that ignore the convention), not a hole.
    if (owner) owner.holes.push(hole);
    else outers.push({ ring: [...hole].reverse(), area: signedArea(hole), holes: [] });
  }
  return outers.map(({ ring, holes: ownHoles }) => [
    [...ring].reverse(),
    ...ownHoles.map((hole) => [...hole].reverse()),
  ]);
}

/** Shoelace area; positive for counter-clockwise rings. */
function signedArea(ring: Position[]): number {
  let twiceArea = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    twiceArea += ring[index][0] * ring[index + 1][1] - ring[index + 1][0] * ring[index][1];
  }
  return twiceArea / 2;
}

function pointInRing(point: Position, ring: Position[]): boolean {
  let inside = false;
  for (let current = 0, previous = ring.length - 1; current < ring.length; previous = current++) {
    const [x1, y1] = ring[current];
    const [x2, y2] = ring[previous];
    if (
      y1 > point[1] !== y2 > point[1] &&
      point[0] < ((x2 - x1) * (point[1] - y1)) / (y2 - y1) + x1
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function mercatorToLngLat(x: number, y: number): Position {
  const lng = (x / EARTH_RADIUS) * (180 / Math.PI);
  const lat = (2 * Math.atan(Math.exp(y / EARTH_RADIUS)) - Math.PI / 2) * (180 / Math.PI);
  return [roundCoordinate(lng), roundCoordinate(lat)];
}

/** Seven decimals (~1 cm) is far below the grid, and keeps the JSON small. */
function roundCoordinate(value: number): number {
  return Math.round(value * 1e7) / 1e7;
}
