// Binary GeoArrow / flat columnar vector representation for GeoLibre.
//
// Above feature-count thresholds, GeoJSON serialization, deep structured cloning,
// and millions of individual JS heap objects create significant memory pressure,
// GC churn, and latency.
//
// This module defines a zero-copy / contiguous typed-array representation compatible
// with the Apache Arrow / GeoArrow specification:
// - Coordinates are stored in a single contiguous Float64Array ([x0, y0, (z0), x1, y1, (z1), ...])
// - Offsets (Int32Array) define boundaries for parts, lines, and polygon rings
// - Properties can be passed as a columnar dictionary or row records
// - Typed arrays can be transferred or cloned as buffers, but row properties and IDs
//   still require structured cloning. The tiler currently reconstructs GeoJSON.

import type {
  Feature,
  FeatureCollection,
  Geometry,
  LineString,
  MultiLineString,
  MultiPoint,
  MultiPolygon,
  Point,
  Polygon,
  Position,
} from "geojson";

/** Supported GeoArrow geometry types. */
export type GeoArrowGeometryType =
  | "Point"
  | "MultiPoint"
  | "LineString"
  | "MultiLineString"
  | "Polygon"
  | "MultiPolygon";

/**
 * A contiguous columnar vector batch compatible with GeoArrow layout.
 */
export interface GeoArrowBatch {
  /** The primary geometry type of the features in this batch. */
  readonly geometryType: GeoArrowGeometryType;
  /**
   * Contiguous coordinates array: [x0, y0, (z0), x1, y1, (z1), ...].
   * Length is coordinateCount * coordDimensions.
   */
  readonly coordinates: Float64Array;
  /** Coordinate dimensions: 2 for XY (default), 3 for XYZ. */
  readonly coordDimensions: 2 | 3;
  /**
   * For Point: omitted (each feature has 1 position).
   * For LineString / MultiPoint: offset into `coordinates` (in vertex units, not ordinate units)
   * for each feature. Length = featureCount + 1.
   * For Polygon: offset into `ringOffsets` for each polygon. Length = featureCount + 1.
   */
  readonly geomOffsets?: Int32Array;
  /**
   * For Polygon / MultiLineString: offset into `coordinates` (in vertex units) for each ring or line.
   * Length = totalRingsCount + 1.
   */
  readonly ringOffsets?: Int32Array;
  /**
   * For MultiPolygon: offset into `geomOffsets` (or ringOffsets) for each feature.
   * Length = featureCount + 1.
   */
  readonly polygonOffsets?: Int32Array;
  /** Total number of features in this batch. */
  readonly featureCount: number;
  /** Feature properties as an array of row objects or column dictionary. */
  readonly properties?: ReadonlyArray<Record<string, unknown>>;
  /** Optional feature identifiers. */
  readonly featureIds?: ReadonlyArray<string | number | undefined>;
  /** Optional precomputed 2D bounding box [minX, minY, maxX, maxY]. */
  readonly bbox?: [number, number, number, number];
}

/**
 * Type guard for {@link GeoArrowBatch}.
 * Validates structure and basic buffer invariants without deep scanning.
 */
export function isGeoArrowBatch(value: unknown): value is GeoArrowBatch {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<GeoArrowBatch>;
  if (
    !["Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon"].includes(
      candidate.geometryType ?? "",
    )
  )
    return false;
  if (!(candidate.coordinates instanceof Float64Array)) return false;
  if (candidate.coordDimensions !== 2 && candidate.coordDimensions !== 3) return false;
  if (!Number.isSafeInteger(candidate.featureCount) || candidate.featureCount! < 0) return false;
  if (candidate.coordinates.length % candidate.coordDimensions !== 0) return false;

  if (candidate.geomOffsets !== undefined && !(candidate.geomOffsets instanceof Int32Array)) {
    return false;
  }
  if (candidate.ringOffsets !== undefined && !(candidate.ringOffsets instanceof Int32Array)) {
    return false;
  }
  if (candidate.polygonOffsets !== undefined && !(candidate.polygonOffsets instanceof Int32Array)) {
    return false;
  }

  const vertexCount = candidate.coordinates.length / candidate.coordDimensions;
  const validOffsets = (offsets: Int32Array | undefined, length: number, end: number) => {
    if (!offsets || offsets.length !== length || offsets[0] !== 0) return false;
    for (let i = 1; i < offsets.length; i++) {
      if (offsets[i] < offsets[i - 1] || offsets[i] > end) return false;
    }
    return offsets[offsets.length - 1] === end;
  };
  const count = candidate.featureCount!;
  if (candidate.geometryType === "Point") {
    if (vertexCount !== count) return false;
  } else if (candidate.geometryType === "LineString" || candidate.geometryType === "MultiPoint") {
    if (!validOffsets(candidate.geomOffsets, count + 1, vertexCount)) return false;
  } else {
    const rings = (candidate.ringOffsets?.length ?? 0) - 1;
    if (!validOffsets(candidate.ringOffsets, rings + 1, vertexCount)) return false;
    if (candidate.geometryType === "MultiPolygon") {
      const polygons = (candidate.geomOffsets?.length ?? 0) - 1;
      if (!validOffsets(candidate.geomOffsets, polygons + 1, rings)) return false;
      if (!validOffsets(candidate.polygonOffsets, count + 1, polygons)) return false;
    } else if (!validOffsets(candidate.geomOffsets, count + 1, rings)) return false;
  }
  if (
    candidate.properties !== undefined &&
    (!Array.isArray(candidate.properties) || candidate.properties.length !== count)
  )
    return false;
  if (
    candidate.featureIds !== undefined &&
    (!Array.isArray(candidate.featureIds) || candidate.featureIds.length !== count)
  )
    return false;

  return true;
}

/**
 * Computes a 2D bounding box [minX, minY, maxX, maxY] for a {@link GeoArrowBatch}
 * in a single fast, vectorized pass over the flat coordinates buffer.
 * Returns null if the batch contains no finite coordinates.
 */
export function computeGeoArrowBBox(batch: GeoArrowBatch): [number, number, number, number] | null {
  if (batch.bbox) return [...batch.bbox];
  const { coordinates, coordDimensions } = batch;
  if (coordinates.length === 0) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const step = coordDimensions;
  for (let i = 0; i < coordinates.length; i += step) {
    const x = coordinates[i];
    const y = coordinates[i + 1];
    if (Number.isFinite(x) && Number.isFinite(y)) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  return minX === Infinity ? null : [minX, minY, maxX, maxY];
}

/**
 * Convert a {@link GeoArrowBatch} to a standard GeoJSON {@link FeatureCollection}.
 * Lossless round-trip converter for renderers or components (Cesium, Attribute Table, Turf)
 * that expect standard GeoJSON objects.
 */
export function geoArrowToFeatureCollection(
  batch: GeoArrowBatch,
): FeatureCollection<Geometry | null> {
  const {
    geometryType,
    coordinates,
    coordDimensions: dim,
    geomOffsets,
    ringOffsets,
    polygonOffsets,
    featureCount,
    properties,
    featureIds,
  } = batch;

  const features: Feature<Geometry | null>[] = new Array(featureCount);

  function readPosition(vertexIdx: number): Position {
    const o = vertexIdx * dim;
    return dim === 3
      ? [coordinates[o], coordinates[o + 1], coordinates[o + 2]]
      : [coordinates[o], coordinates[o + 1]];
  }

  function readLine(startVertex: number, endVertex: number): Position[] {
    const count = endVertex - startVertex;
    const line: Position[] = new Array(count);
    for (let i = 0; i < count; i++) {
      line[i] = readPosition(startVertex + i);
    }
    return line;
  }

  for (let i = 0; i < featureCount; i++) {
    const props = properties ? { ...properties[i] } : {};
    const id = featureIds ? featureIds[i] : undefined;

    let geometry: Geometry | null = null;

    switch (geometryType) {
      case "Point": {
        const o = i * dim;
        if (
          o + 1 < coordinates.length &&
          Number.isFinite(coordinates[o]) &&
          Number.isFinite(coordinates[o + 1])
        ) {
          geometry = {
            type: "Point",
            coordinates: readPosition(i),
          } as Point;
        }
        break;
      }
      case "MultiPoint": {
        if (geomOffsets) {
          const start = geomOffsets[i];
          const end = geomOffsets[i + 1];
          if (end > start) {
            geometry = {
              type: "MultiPoint",
              coordinates: readLine(start, end),
            } as MultiPoint;
          }
        }
        break;
      }
      case "LineString": {
        if (geomOffsets) {
          const start = geomOffsets[i];
          const end = geomOffsets[i + 1];
          if (end > start) {
            geometry = {
              type: "LineString",
              coordinates: readLine(start, end),
            } as LineString;
          }
        }
        break;
      }
      case "MultiLineString": {
        if (geomOffsets && ringOffsets) {
          const startLine = geomOffsets[i];
          const endLine = geomOffsets[i + 1];
          const lines: Position[][] = [];
          for (let l = startLine; l < endLine; l++) {
            const vStart = ringOffsets[l];
            const vEnd = ringOffsets[l + 1];
            if (vEnd > vStart) {
              lines.push(readLine(vStart, vEnd));
            }
          }
          if (lines.length > 0) {
            geometry = {
              type: "MultiLineString",
              coordinates: lines,
            } as MultiLineString;
          }
        }
        break;
      }
      case "Polygon": {
        if (geomOffsets && ringOffsets) {
          const startRing = geomOffsets[i];
          const endRing = geomOffsets[i + 1];
          const rings: Position[][] = [];
          for (let r = startRing; r < endRing; r++) {
            const vStart = ringOffsets[r];
            const vEnd = ringOffsets[r + 1];
            if (vEnd > vStart) {
              rings.push(readLine(vStart, vEnd));
            }
          }
          if (rings.length > 0) {
            geometry = {
              type: "Polygon",
              coordinates: rings,
            } as Polygon;
          }
        }
        break;
      }
      case "MultiPolygon": {
        if (polygonOffsets && geomOffsets && ringOffsets) {
          const startPoly = polygonOffsets[i];
          const endPoly = polygonOffsets[i + 1];
          const polys: Position[][][] = [];
          for (let p = startPoly; p < endPoly; p++) {
            const startRing = geomOffsets[p];
            const endRing = geomOffsets[p + 1];
            const rings: Position[][] = [];
            for (let r = startRing; r < endRing; r++) {
              const vStart = ringOffsets[r];
              const vEnd = ringOffsets[r + 1];
              if (vEnd > vStart) {
                rings.push(readLine(vStart, vEnd));
              }
            }
            if (rings.length > 0) polys.push(rings);
          }
          if (polys.length > 0) {
            geometry = {
              type: "MultiPolygon",
              coordinates: polys,
            } as MultiPolygon;
          }
        }
        break;
      }
    }

    features[i] = {
      type: "Feature",
      id,
      properties: props,
      geometry,
    };
  }

  return {
    type: "FeatureCollection",
    features,
  };
}

function extractVerticesForLineOrMultiPoint(
  geometry: Geometry | null | undefined,
  primaryType: "LineString" | "MultiPoint",
): ReadonlyArray<Position> | null {
  if (!geometry) return null;
  if (primaryType === "LineString") {
    if (geometry.type === "LineString" && Array.isArray(geometry.coordinates)) {
      return geometry.coordinates;
    }
    return null;
  }
  if (primaryType === "MultiPoint") {
    if (geometry.type === "MultiPoint" && Array.isArray(geometry.coordinates)) {
      return geometry.coordinates;
    }
    if (geometry.type === "Point" && Array.isArray(geometry.coordinates)) {
      // Point promoted to MultiPoint: exactly one vertex
      return [geometry.coordinates];
    }
    return null;
  }
  return null;
}

/**
 * Flatten supported Point, MultiPoint, LineString and Polygon collections.
 * Empty collections produce an empty Point batch; unsupported geometries return null.
 */
export function featureCollectionToGeoArrow(
  collection: FeatureCollection<Geometry | null>,
): GeoArrowBatch | null {
  const { features } = collection;
  if (!features || features.length === 0) {
    return {
      geometryType: "Point",
      coordinates: new Float64Array(0),
      coordDimensions: 2,
      featureCount: 0,
      properties: [],
    };
  }

  // Detect dominant geometry type
  let primaryType: GeoArrowGeometryType | null = null;
  let hasZ = false;

  for (const f of features) {
    const g = f.geometry;
    if (!g) continue;
    if (primaryType === null) {
      if (
        g.type === "Point" ||
        g.type === "MultiPoint" ||
        g.type === "LineString" ||
        g.type === "Polygon"
      ) {
        primaryType = g.type;
      } else {
        return null; // GeometryCollection or unsupported
      }
    } else if (g.type !== primaryType) {
      // Mixed geometry collection: promote Point -> MultiPoint, Polygon -> MultiPolygon, etc., or bail
      if (
        (primaryType === "Point" && g.type === "MultiPoint") ||
        (primaryType === "MultiPoint" && g.type === "Point")
      ) {
        primaryType = "MultiPoint";
      } else {
        return null; // Incompatible mixed types
      }
    }

    // Inspect every vertex: Z may first appear later in a line or ring.
    if (!hasZ) {
      const positionHasZ = (position: Position) =>
        position.length > 2 && Number.isFinite(position[2]);
      if (g.type === "Point") hasZ = positionHasZ(g.coordinates);
      else if (g.type === "Polygon") {
        hasZ = g.coordinates.some((ring) => ring.some(positionHasZ));
      } else if (g.type === "LineString" || g.type === "MultiPoint") {
        hasZ = g.coordinates.some(positionHasZ);
      }
    }
  }

  if (!primaryType) primaryType = "Point";
  const dim: 2 | 3 = hasZ ? 3 : 2;

  // Extract feature IDs and properties
  const featureCount = features.length;
  const properties: Record<string, unknown>[] = new Array(featureCount);
  const featureIds: (string | number | undefined)[] = new Array(featureCount);

  for (let i = 0; i < featureCount; i++) {
    properties[i] = features[i].properties ?? {};
    featureIds[i] = features[i].id;
  }

  // Handle Point specialization (no offsets needed)
  if (primaryType === "Point") {
    const coordinates = new Float64Array(featureCount * dim);
    for (let i = 0; i < featureCount; i++) {
      const g = features[i].geometry;
      const o = i * dim;
      if (g && g.type === "Point" && Array.isArray(g.coordinates)) {
        coordinates[o] = Number(g.coordinates[0] ?? NaN);
        coordinates[o + 1] = Number(g.coordinates[1] ?? NaN);
        if (dim === 3) coordinates[o + 2] = Number(g.coordinates[2] ?? 0);
      } else {
        coordinates[o] = NaN;
        coordinates[o + 1] = NaN;
        if (dim === 3) coordinates[o + 2] = NaN;
      }
    }
    const batch: GeoArrowBatch = {
      geometryType: "Point",
      coordinates,
      coordDimensions: dim,
      featureCount,
      properties,
      featureIds,
    };
    const bbox = computeGeoArrowBBox(batch);
    return bbox ? { ...batch, bbox } : batch;
  }

  // Handle LineString / MultiPoint (1 level of offsets)
  if (primaryType === "LineString" || primaryType === "MultiPoint") {
    const geomOffsets = new Int32Array(featureCount + 1);
    let totalVertices = 0;

    for (let i = 0; i < featureCount; i++) {
      geomOffsets[i] = totalVertices;
      const vertices = extractVerticesForLineOrMultiPoint(features[i].geometry, primaryType);
      if (vertices) {
        totalVertices += vertices.length;
      }
    }
    geomOffsets[featureCount] = totalVertices;

    const coordinates = new Float64Array(totalVertices * dim);
    let vIdx = 0;

    for (let i = 0; i < featureCount; i++) {
      const vertices = extractVerticesForLineOrMultiPoint(features[i].geometry, primaryType);
      if (vertices) {
        for (const coord of vertices) {
          const o = vIdx * dim;
          coordinates[o] = Number(coord[0] ?? NaN);
          coordinates[o + 1] = Number(coord[1] ?? NaN);
          if (dim === 3) coordinates[o + 2] = Number(coord[2] ?? 0);
          vIdx++;
        }
      }
    }

    const batch: GeoArrowBatch = {
      geometryType: primaryType,
      coordinates,
      coordDimensions: dim,
      geomOffsets,
      featureCount,
      properties,
      featureIds,
    };
    const bbox = computeGeoArrowBBox(batch);
    return bbox ? { ...batch, bbox } : batch;
  }

  // Handle Polygon (2 levels of offsets: geomOffsets -> ringOffsets -> coordinates)
  if (primaryType === "Polygon") {
    const geomOffsets = new Int32Array(featureCount + 1);
    let totalRings = 0;
    let totalVertices = 0;

    for (let i = 0; i < featureCount; i++) {
      geomOffsets[i] = totalRings;
      const g = features[i].geometry;
      if (g && g.type === "Polygon" && Array.isArray(g.coordinates)) {
        totalRings += g.coordinates.length;
        for (const ring of g.coordinates) {
          totalVertices += ring.length;
        }
      }
    }
    geomOffsets[featureCount] = totalRings;

    const ringOffsets = new Int32Array(totalRings + 1);
    const coordinates = new Float64Array(totalVertices * dim);
    let rIdx = 0;
    let vIdx = 0;

    for (let i = 0; i < featureCount; i++) {
      const g = features[i].geometry;
      if (g && g.type === "Polygon" && Array.isArray(g.coordinates)) {
        for (const ring of g.coordinates) {
          ringOffsets[rIdx++] = vIdx;
          for (const coord of ring) {
            const o = vIdx * dim;
            coordinates[o] = Number(coord[0] ?? NaN);
            coordinates[o + 1] = Number(coord[1] ?? NaN);
            if (dim === 3) coordinates[o + 2] = Number(coord[2] ?? 0);
            vIdx++;
          }
        }
      }
    }
    ringOffsets[totalRings] = vIdx;

    const batch: GeoArrowBatch = {
      geometryType: "Polygon",
      coordinates,
      coordDimensions: dim,
      geomOffsets,
      ringOffsets,
      featureCount,
      properties,
      featureIds,
    };
    const bbox = computeGeoArrowBBox(batch);
    return bbox ? { ...batch, bbox } : batch;
  }

  return null;
}
