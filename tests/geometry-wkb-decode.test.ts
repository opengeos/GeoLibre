import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Geometry } from "geojson";
import { decodeWkb, encodeWkb } from "../apps/geolibre-desktop/src/lib/geometry-wkb";

/**
 * decodeWkb is the inverse of encodeWkb (used to read GeoPackage geometry blobs
 * without GDAL). Round-tripping every standard geometry type proves the decoder
 * matches the encoder the rest of the app already relies on.
 */
const GEOMETRIES: Geometry[] = [
  { type: "Point", coordinates: [-85.6, 42.9] },
  {
    type: "LineString",
    coordinates: [
      [-85.6, 42.9],
      [-85.5, 43.0],
      [-85.4, 43.1],
    ],
  },
  {
    type: "Polygon",
    coordinates: [
      [
        [-85.6, 42.9],
        [-85.5, 42.9],
        [-85.5, 43.0],
        [-85.6, 43.0],
        [-85.6, 42.9],
      ],
    ],
  },
  {
    type: "MultiPoint",
    coordinates: [
      [-85.6, 42.9],
      [-85.5, 43.0],
    ],
  },
  {
    type: "MultiLineString",
    coordinates: [
      [
        [-85.6, 42.9],
        [-85.5, 43.0],
      ],
      [
        [-85.4, 43.1],
        [-85.3, 43.2],
      ],
    ],
  },
  {
    type: "MultiPolygon",
    coordinates: [
      [
        [
          [-85.6, 42.9],
          [-85.5, 42.9],
          [-85.5, 43.0],
          [-85.6, 42.9],
        ],
      ],
      [
        [
          [-85.4, 42.8],
          [-85.3, 42.8],
          [-85.3, 42.9],
          [-85.4, 42.8],
        ],
      ],
    ],
  },
  {
    type: "GeometryCollection",
    geometries: [
      { type: "Point", coordinates: [-85.6, 42.9] },
      {
        type: "LineString",
        coordinates: [
          [-85.6, 42.9],
          [-85.5, 43.0],
        ],
      },
    ],
  },
];

describe("decodeWkb", () => {
  for (const geometry of GEOMETRIES) {
    it(`round-trips a ${geometry.type}`, () => {
      const decoded = decodeWkb(encodeWkb(geometry));
      assert.deepEqual(decoded, geometry);
    });
  }

  it("reads big-endian WKB", () => {
    // Hand-encode POINT(1 2) big-endian: 00, type 00000001, x=1.0, y=2.0.
    const bytes = new Uint8Array([
      0x00, 0x00, 0x00, 0x00, 0x01, 0x3f, 0xf0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x40, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    assert.deepEqual(decodeWkb(bytes), { type: "Point", coordinates: [1, 2] });
  });

  it("keeps Z and drops M for ISO XYZM points", () => {
    // ISO PointZM has type code 3001; coordinates x,y,z,m.
    const writer = new DataView(new ArrayBuffer(1 + 4 + 8 * 4));
    writer.setUint8(0, 1); // little-endian
    writer.setUint32(1, 3001, true); // PointZM
    writer.setFloat64(5, -85.6, true);
    writer.setFloat64(13, 42.9, true);
    writer.setFloat64(21, 100, true); // Z (kept)
    writer.setFloat64(29, 7, true); // M (dropped)
    const decoded = decodeWkb(new Uint8Array(writer.buffer));
    assert.deepEqual(decoded, { type: "Point", coordinates: [-85.6, 42.9, 100] });
  });

  it("skips the EWKB SRID prefix", () => {
    // EWKB POINT with the SRID flag (0x20000000): byte order, type, 4-byte SRID,
    // then x,y. The SRID is skipped (the CRS comes from GeoPackage metadata).
    const writer = new DataView(new ArrayBuffer(1 + 4 + 4 + 8 + 8));
    writer.setUint8(0, 1); // little-endian
    writer.setUint32(1, 0x20000001, true); // Point + SRID flag
    writer.setUint32(5, 4326, true); // SRID (skipped)
    writer.setFloat64(9, -85.6, true);
    writer.setFloat64(17, 42.9, true);
    assert.deepEqual(decodeWkb(new Uint8Array(writer.buffer)), {
      type: "Point",
      coordinates: [-85.6, 42.9],
    });
  });

  it("throws on unsupported curved geometry types", () => {
    // Type code 8 = CircularString, which GeoJSON cannot represent.
    const bytes = new Uint8Array([0x01, 0x08, 0x00, 0x00, 0x00]);
    assert.throws(() => decodeWkb(bytes), /Unsupported WKB geometry type 8/);
  });
});

/**
 * ESRI MultiPatch shapefiles (3D buildings) come through DuckDB's bundled GDAL
 * as TIN / Triangle / PolyhedralSurface WKB, which DuckDB Spatial's own reader
 * rejects. `encodeWkb` cannot produce these, so the buffers are hand-built to
 * prove {@link decodeWkb} maps each surface to a MultiPolygon/Polygon (issue
 * #1121).
 */
describe("decodeWkb surface geometries", () => {
  const littleEndianU32 = (value: number): number[] => [
    value & 0xff,
    (value >> 8) & 0xff,
    (value >> 16) & 0xff,
    (value >> 24) & 0xff,
  ];
  const littleEndianF64 = (value: number): number[] => {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setFloat64(0, value, true);
    return Array.from(bytes);
  };
  // A closed ring of [x, y, z] positions, serialized as a WKB linear ring.
  const ring = (positions: [number, number, number][]): number[] => [
    ...littleEndianU32(positions.length),
    ...positions.flatMap(([x, y, z]) => [
      ...littleEndianF64(x),
      ...littleEndianF64(y),
      ...littleEndianF64(z),
    ]),
  ];
  // A WKB Triangle Z (type 1017): one exterior ring.
  const triangle = (positions: [number, number, number][]): number[] => [
    0x01,
    ...littleEndianU32(1017),
    ...littleEndianU32(1),
    ...ring(positions),
  ];
  // A WKB Polygon Z (type 1003): one exterior ring.
  const polygonZ = (positions: [number, number, number][]): number[] => [
    0x01,
    ...littleEndianU32(1003),
    ...littleEndianU32(1),
    ...ring(positions),
  ];

  const triA: [number, number, number][] = [
    [0, 0, 10],
    [1, 0, 10],
    [1, 1, 10],
    [0, 0, 10],
  ];
  const triB: [number, number, number][] = [
    [1, 1, 20],
    [2, 1, 20],
    [2, 2, 20],
    [1, 1, 20],
  ];

  it("decodes a Triangle Z to a Polygon, keeping Z", () => {
    assert.deepEqual(decodeWkb(new Uint8Array(triangle(triA))), {
      type: "Polygon",
      coordinates: [triA],
    });
  });

  it("decodes a TIN Z to a MultiPolygon (one polygon per triangle)", () => {
    // TIN Z (type 1016) wrapping two Triangle patches.
    const bytes = new Uint8Array([
      0x01,
      ...littleEndianU32(1016),
      ...littleEndianU32(2),
      ...triangle(triA),
      ...triangle(triB),
    ]);
    assert.deepEqual(decodeWkb(bytes), {
      type: "MultiPolygon",
      coordinates: [[triA], [triB]],
    });
  });

  it("decodes a PolyhedralSurface Z to a MultiPolygon", () => {
    // PolyhedralSurface Z (type 1015) wrapping two Polygon patches.
    const bytes = new Uint8Array([
      0x01,
      ...littleEndianU32(1015),
      ...littleEndianU32(2),
      ...polygonZ(triA),
      ...polygonZ(triB),
    ]);
    assert.deepEqual(decodeWkb(bytes), {
      type: "MultiPolygon",
      coordinates: [[triA], [triB]],
    });
  });
});
