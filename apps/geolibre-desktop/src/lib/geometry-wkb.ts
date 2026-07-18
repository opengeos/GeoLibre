import type { Geometry, Position } from "geojson";

/**
 * Encode GeoJSON geometries as little-endian WKB (Well-Known Binary), the
 * geometry encoding used inside a GeoPackage geometry blob. Coordinates are
 * written as x (longitude), y (latitude) doubles; Z/M are dropped.
 */

const WKB_TYPE = {
  Point: 1,
  LineString: 2,
  Polygon: 3,
  MultiPoint: 4,
  MultiLineString: 5,
  MultiPolygon: 6,
  GeometryCollection: 7,
} as const;

/** A growable little-endian byte buffer. */
class ByteWriter {
  private buffer = new Uint8Array(256);
  private view = new DataView(this.buffer.buffer);
  private length = 0;

  private ensure(extra: number): void {
    if (this.length + extra <= this.buffer.length) return;
    let capacity = this.buffer.length * 2;
    while (capacity < this.length + extra) capacity *= 2;
    const next = new Uint8Array(capacity);
    next.set(this.buffer.subarray(0, this.length));
    this.buffer = next;
    this.view = new DataView(this.buffer.buffer);
  }

  u8(value: number): void {
    this.ensure(1);
    this.view.setUint8(this.length, value);
    this.length += 1;
  }

  u32(value: number): void {
    this.ensure(4);
    this.view.setUint32(this.length, value, true);
    this.length += 4;
  }

  f64(value: number): void {
    this.ensure(8);
    this.view.setFloat64(this.length, value, true);
    this.length += 8;
  }

  bytes(): Uint8Array {
    return this.buffer.slice(0, this.length);
  }
}

function writePoint(writer: ByteWriter, position: Position): void {
  writer.f64(Number(position[0]));
  writer.f64(Number(position[1]));
}

function writeLine(writer: ByteWriter, line: Position[]): void {
  writer.u32(line.length);
  for (const point of line) writePoint(writer, point);
}

function writePolygon(writer: ByteWriter, rings: Position[][]): void {
  writer.u32(rings.length);
  for (const ring of rings) writeLine(writer, ring);
}

function writeGeometry(writer: ByteWriter, geometry: Geometry): void {
  writer.u8(1); // little-endian byte order
  switch (geometry.type) {
    case "Point":
      writer.u32(WKB_TYPE.Point);
      writePoint(writer, geometry.coordinates);
      break;
    case "LineString":
      writer.u32(WKB_TYPE.LineString);
      writeLine(writer, geometry.coordinates);
      break;
    case "Polygon":
      writer.u32(WKB_TYPE.Polygon);
      writePolygon(writer, geometry.coordinates);
      break;
    case "MultiPoint":
      writer.u32(WKB_TYPE.MultiPoint);
      writer.u32(geometry.coordinates.length);
      for (const point of geometry.coordinates) {
        writer.u8(1);
        writer.u32(WKB_TYPE.Point);
        writePoint(writer, point);
      }
      break;
    case "MultiLineString":
      writer.u32(WKB_TYPE.MultiLineString);
      writer.u32(geometry.coordinates.length);
      for (const line of geometry.coordinates) {
        writer.u8(1);
        writer.u32(WKB_TYPE.LineString);
        writeLine(writer, line);
      }
      break;
    case "MultiPolygon":
      writer.u32(WKB_TYPE.MultiPolygon);
      writer.u32(geometry.coordinates.length);
      for (const polygon of geometry.coordinates) {
        writer.u8(1);
        writer.u32(WKB_TYPE.Polygon);
        writePolygon(writer, polygon);
      }
      break;
    case "GeometryCollection":
      writer.u32(WKB_TYPE.GeometryCollection);
      writer.u32(geometry.geometries.length);
      for (const child of geometry.geometries) writeGeometry(writer, child);
      break;
    default:
      throw new Error(`Unsupported geometry type for WKB: ${(geometry as Geometry).type}`);
  }
}

/** Encode a GeoJSON geometry as a standalone little-endian WKB buffer. */
export function encodeWkb(geometry: Geometry): Uint8Array {
  const writer = new ByteWriter();
  writeGeometry(writer, geometry);
  return writer.bytes();
}

/**
 * Decode a standalone WKB (Well-Known Binary) buffer into a GeoJSON geometry.
 *
 * The inverse of {@link encodeWkb}, used to read GeoPackage geometry blobs
 * without GDAL (see `gpkg-reader.ts`) and to decode the raw WKB the DuckDB
 * vector loader falls back to for surface geometries (TIN / PolyhedralSurface /
 * Triangle, codes 15-17) that DuckDB Spatial's own WKB reader rejects — the
 * encoding GDAL produces for ESRI MultiPatch shapefiles (issue #1121). Those
 * surfaces have no GeoJSON equivalent, so each is exposed as a MultiPolygon (or
 * Polygon, for a lone Triangle). Handles mixed byte order, ISO WKB
 * dimensionality (Z/M, where the type code is offset by 1000/2000/3000) and the
 * PostGIS EWKB Z/M/SRID high-bit flags. The M ordinate is dropped; Z is kept so
 * a `[x, y, z]` position survives. Throws on the curved geometry types
 * (CircularString and friends, codes 8-12) that GeoJSON cannot represent.
 *
 * @param bytes The WKB buffer (no GeoPackage header).
 * @returns The decoded GeoJSON geometry.
 */
export function decodeWkb(bytes: Uint8Array): Geometry {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;

  function readGeometry(): Geometry {
    const little = view.getUint8(offset) === 1;
    offset += 1;
    const rawType = view.getUint32(offset, little);
    offset += 4;

    // PostGIS EWKB encodes Z/M/SRID in the high bits; ISO WKB encodes Z/M by
    // offsetting the type code (1000 = Z, 2000 = M, 3000 = ZM). Support both so
    // any standards-conformant GeoPackage geometry blob decodes.
    const hasEwkbZ = (rawType & 0x80000000) !== 0;
    const hasEwkbM = (rawType & 0x40000000) !== 0;
    const hasSrid = (rawType & 0x20000000) !== 0;
    const baseType = rawType & 0xffff;
    const isoGroup = Math.floor((baseType % 4000) / 1000);
    const code = baseType % 1000;
    const hasZ = hasEwkbZ || isoGroup === 1 || isoGroup === 3;
    const hasM = hasEwkbM || isoGroup === 2 || isoGroup === 3;

    // An EWKB SRID prefix precedes the coordinates; skip it (the layer CRS is
    // taken from the GeoPackage metadata, not the per-geometry SRID).
    if (hasSrid) offset += 4;

    const readPosition = (): Position => {
      const x = view.getFloat64(offset, little);
      offset += 8;
      const y = view.getFloat64(offset, little);
      offset += 8;
      let z: number | undefined;
      if (hasZ) {
        z = view.getFloat64(offset, little);
        offset += 8;
      }
      if (hasM) offset += 8; // M is not represented in GeoJSON.
      return z === undefined ? [x, y] : [x, y, z];
    };

    const readPositions = (): Position[] => {
      const count = view.getUint32(offset, little);
      offset += 4;
      const positions: Position[] = [];
      for (let i = 0; i < count; i += 1) positions.push(readPosition());
      return positions;
    };

    const readRings = (): Position[][] => {
      const count = view.getUint32(offset, little);
      offset += 4;
      const rings: Position[][] = [];
      for (let i = 0; i < count; i += 1) rings.push(readPositions());
      return rings;
    };

    const readChildren = (): Geometry[] => {
      const count = view.getUint32(offset, little);
      offset += 4;
      const children: Geometry[] = [];
      for (let i = 0; i < count; i += 1) children.push(readGeometry());
      return children;
    };

    switch (code) {
      case 1:
        return { type: "Point", coordinates: readPosition() };
      case 2:
        return { type: "LineString", coordinates: readPositions() };
      case 3:
        return { type: "Polygon", coordinates: readRings() };
      case 4: {
        const points = readChildren();
        return {
          type: "MultiPoint",
          coordinates: points.map((p) => (p as { coordinates: Position }).coordinates),
        };
      }
      case 5: {
        const lines = readChildren();
        return {
          type: "MultiLineString",
          coordinates: lines.map((l) => (l as { coordinates: Position[] }).coordinates),
        };
      }
      case 6: {
        const polygons = readChildren();
        return {
          type: "MultiPolygon",
          coordinates: polygons.map((p) => (p as { coordinates: Position[][] }).coordinates),
        };
      }
      case 7:
        return { type: "GeometryCollection", geometries: readChildren() };
      case 15: {
        // PolyhedralSurface: a set of polygon patches. GeoJSON has no surface
        // type, so expose the patches as a MultiPolygon (each patch keeps its
        // own header, so readChildren decodes them like the members of a
        // MultiPolygon).
        const patches = readChildren();
        return {
          type: "MultiPolygon",
          coordinates: patches.map((patch) => (patch as { coordinates: Position[][] }).coordinates),
        };
      }
      case 16: {
        // TIN (Triangulated Irregular Network): a set of Triangle patches, the
        // encoding GDAL emits for an ESRI MultiPatch shapefile (3D buildings).
        // Each triangle decodes to a Polygon (case 17), so the surface becomes a
        // MultiPolygon that MapLibre/deck.gl can render (issue #1121).
        const triangles = readChildren();
        return {
          type: "MultiPolygon",
          coordinates: triangles.map(
            (triangle) => (triangle as { coordinates: Position[][] }).coordinates,
          ),
        };
      }
      case 17:
        // Triangle: WKB-encoded exactly like a Polygon (rings of positions).
        // Spec-wise it is a single 4-vertex ring, but the bytes are read as a
        // Polygon without enforcing that, matching the ring loop for any polygon.
        return { type: "Polygon", coordinates: readRings() };
      default:
        // Codes 8-12 are the curved geometries (CircularString, CompoundCurve,
        // CurvePolygon, MultiCurve, MultiSurface) that GeoJSON cannot represent.
        throw new Error(
          `Unsupported WKB geometry type ${code}${
            code >= 8 && code <= 12 ? " (curved geometries are not supported)" : ""
          }.`,
        );
    }
  }

  return readGeometry();
}

export interface BoundingBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Expand `box` in place to include every coordinate in `geometry`. */
export function extendBoundingBox(box: BoundingBox, geometry: Geometry): void {
  const visit = (position: Position) => {
    const x = Number(position[0]);
    const y = Number(position[1]);
    if (Number.isFinite(x)) {
      box.minX = Math.min(box.minX, x);
      box.maxX = Math.max(box.maxX, x);
    }
    if (Number.isFinite(y)) {
      box.minY = Math.min(box.minY, y);
      box.maxY = Math.max(box.maxY, y);
    }
  };
  walkPositions(geometry, visit);
}

/** Invoke `visit` for every coordinate position in a geometry. */
export function walkPositions(geometry: Geometry, visit: (position: Position) => void): void {
  switch (geometry.type) {
    case "Point":
      visit(geometry.coordinates);
      break;
    case "LineString":
    case "MultiPoint":
      geometry.coordinates.forEach(visit);
      break;
    case "Polygon":
    case "MultiLineString":
      geometry.coordinates.forEach((part) => part.forEach(visit));
      break;
    case "MultiPolygon":
      geometry.coordinates.forEach((polygon) => polygon.forEach((ring) => ring.forEach(visit)));
      break;
    case "GeometryCollection":
      geometry.geometries.forEach((child) => walkPositions(child, visit));
      break;
  }
}

/** Create an empty bounding box ready for {@link extendBoundingBox}. */
export function emptyBoundingBox(): BoundingBox {
  return {
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
  };
}
