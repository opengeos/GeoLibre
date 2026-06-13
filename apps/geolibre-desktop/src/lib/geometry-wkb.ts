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
      throw new Error(
        `Unsupported geometry type for WKB: ${(geometry as Geometry).type}`,
      );
  }
}

/** Encode a GeoJSON geometry as a standalone little-endian WKB buffer. */
export function encodeWkb(geometry: Geometry): Uint8Array {
  const writer = new ByteWriter();
  writeGeometry(writer, geometry);
  return writer.bytes();
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
export function walkPositions(
  geometry: Geometry,
  visit: (position: Position) => void,
): void {
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
      geometry.coordinates.forEach((polygon) =>
        polygon.forEach((ring) => ring.forEach(visit)),
      );
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
