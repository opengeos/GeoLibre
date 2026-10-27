import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  wkbRowsToGeoArrowBatch,
  createOptimizedVectorLayerData,
  decodeWkbRowsToFeatures,
} from "../apps/geolibre-desktop/src/lib/geoarrow-pipeline";

function makeWkbPoint(x: number, y: number, hasZ = false, z = 0): Uint8Array {
  const len = hasZ ? 29 : 21;
  const buf = new Uint8Array(len);
  const view = new DataView(buf.buffer);
  view.setUint8(0, 1); // little endian
  view.setUint32(1, hasZ ? 1001 : 1, true); // Point or Point Z
  view.setFloat64(5, x, true);
  view.setFloat64(13, y, true);
  if (hasZ) view.setFloat64(21, z, true);
  return buf;
}

function makeWkbLineString(points: [number, number][]): Uint8Array {
  const len = 9 + points.length * 16;
  const buf = new Uint8Array(len);
  const view = new DataView(buf.buffer);
  view.setUint8(0, 1);
  view.setUint32(1, 2, true); // LineString
  view.setUint32(5, points.length, true);
  let o = 9;
  for (const [x, y] of points) {
    view.setFloat64(o, x, true);
    view.setFloat64(o + 8, y, true);
    o += 16;
  }
  return buf;
}

function makeWkbPolygon(rings: [number, number][][]): Uint8Array {
  let len = 9;
  for (const ring of rings) {
    len += 4 + ring.length * 16;
  }
  const buf = new Uint8Array(len);
  const view = new DataView(buf.buffer);
  view.setUint8(0, 1);
  view.setUint32(1, 3, true); // Polygon
  view.setUint32(5, rings.length, true);
  let o = 9;
  for (const ring of rings) {
    view.setUint32(o, ring.length, true);
    o += 4;
    for (const [x, y] of ring) {
      view.setFloat64(o, x, true);
      view.setFloat64(o + 8, y, true);
      o += 16;
    }
  }
  return buf;
}

describe("GeoArrow Desktop Pipeline", () => {
  it("decodes WKB Point rows directly into flat GeoArrowBatch", () => {
    const rows = [
      { id: 1, name: "Alpha", geom_wkb: makeWkbPoint(10.5, 20.5), count: 100n },
      { id: 2, name: "Beta", geom_wkb: makeWkbPoint(-50.2, 75.3), count: 200n },
      { id: 3, name: "NullGeom", geom_wkb: null, count: 0n },
    ];

    const batch = wkbRowsToGeoArrowBatch(rows, "geom_wkb");
    assert.ok(batch);
    assert.equal(batch.geometryType, "Point");
    assert.equal(batch.featureCount, 3);
    assert.equal(batch.coordDimensions, 2);

    // Verify coordinates
    assert.equal(batch.coordinates[0], 10.5);
    assert.equal(batch.coordinates[1], 20.5);
    assert.equal(batch.coordinates[2], -50.2);
    assert.equal(batch.coordinates[3], 75.3);
    assert.ok(Number.isNaN(batch.coordinates[4]));
    assert.ok(Number.isNaN(batch.coordinates[5]));

    // Verify properties normalized
    assert.deepEqual(batch.properties?.[0], { id: 1, name: "Alpha", count: 100 });
    assert.deepEqual(batch.properties?.[1], { id: 2, name: "Beta", count: 200 });
    assert.deepEqual(batch.properties?.[2], { id: 3, name: "NullGeom", count: 0 });

    // Verify bounds
    assert.deepEqual(batch.bbox, [-50.2, 20.5, 10.5, 75.3]);
  });

  it("decodes 3D WKB Point Z rows preserving Z ordinate", () => {
    const rows = [
      { name: "P1", geom: makeWkbPoint(1, 2, true, 100) },
      { name: "P2", geom: makeWkbPoint(3, 4, true, -50) },
    ];
    const batch = wkbRowsToGeoArrowBatch(rows, "geom");
    assert.ok(batch);
    assert.equal(batch.coordDimensions, 3);
    assert.equal(batch.coordinates[0], 1);
    assert.equal(batch.coordinates[1], 2);
    assert.equal(batch.coordinates[2], 100);
    assert.equal(batch.coordinates[3], 3);
    assert.equal(batch.coordinates[4], 4);
    assert.equal(batch.coordinates[5], -50);
  });

  it("decodes WKB LineString rows with offsets", () => {
    const line1: [number, number][] = [
      [0, 0],
      [1, 1],
      [2, 2],
    ];
    const line2: [number, number][] = [
      [10, 10],
      [20, 20],
    ];
    const rows = [
      { route: "RouteA", geom: makeWkbLineString(line1) },
      { route: "RouteB", geom: makeWkbLineString(line2) },
    ];

    const batch = wkbRowsToGeoArrowBatch(rows, "geom");
    assert.ok(batch);
    assert.equal(batch.geometryType, "LineString");
    assert.equal(batch.featureCount, 2);
    assert.deepEqual(Array.from(batch.geomOffsets ?? []), [0, 3, 5]);
    assert.equal(batch.coordinates.length, 10);
  });

  it("decodes WKB Polygon rows with outer ring and inner hole", () => {
    const outer: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ];
    const hole: [number, number][] = [
      [2, 2],
      [4, 2],
      [4, 4],
      [2, 4],
      [2, 2],
    ];
    const rows = [{ name: "Donut", geom: makeWkbPolygon([outer, hole]) }];

    const batch = wkbRowsToGeoArrowBatch(rows, "geom");
    assert.ok(batch);
    assert.equal(batch.geometryType, "Polygon");
    assert.equal(batch.featureCount, 1);
    assert.ok(batch.geomOffsets);
    assert.ok(batch.ringOffsets);
    assert.equal(batch.ringOffsets.length, 3); // 2 rings -> 3 offsets
  });

  it("creates optimized dual layer data with createOptimizedVectorLayerData", () => {
    const rows = [
      { id: 10, geom: makeWkbPoint(5, 15) },
      { id: 20, geom: makeWkbPoint(6, 16) },
    ];
    const { geoarrow, geojson } = createOptimizedVectorLayerData(rows, "geom");
    assert.ok(geoarrow);
    assert.equal(geoarrow.featureCount, 2);
    assert.equal(geojson.features.length, 2);
    assert.deepEqual(geojson.features[0].geometry, { type: "Point", coordinates: [5, 15] });
    assert.deepEqual(geojson.features[1].geometry, { type: "Point", coordinates: [6, 16] });
  });

  it("handles high-volume point batch efficiently", () => {
    const COUNT = 10_000;
    const rows: Record<string, unknown>[] = new Array(COUNT);
    for (let i = 0; i < COUNT; i++) {
      rows[i] = {
        fid: i,
        geom: makeWkbPoint((i % 100) * 0.01, Math.floor(i / 100) * 0.01),
        val: i * 2,
      };
    }

    const t0 = performance.now();
    const batch = wkbRowsToGeoArrowBatch(rows, "geom");
    const elapsed = performance.now() - t0;

    assert.ok(batch);
    assert.equal(batch.featureCount, COUNT);
    assert.equal(batch.coordinates.length, COUNT * 2);
    assert.ok(elapsed < 200, `10k points should decode in <200ms, took ${elapsed.toFixed(1)}ms`);
  });

  it("does not falsely infer Point fast path when last geometry is Point in mixed batch (B2)", () => {
    const poly: [number, number][][] = [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
        [0, 0],
      ],
    ];
    // Case 1: Polygon first, Point second (previously dominantCode ended up as 1!)
    const rowsPolygonFirst = [
      { id: 1, geom: makeWkbPolygon(poly) },
      { id: 2, geom: makeWkbPoint(10, 20) },
    ];
    const batch1 = wkbRowsToGeoArrowBatch(rowsPolygonFirst, "geom");
    // Incompatible mixed types Polygon + Point should return null (or non-Point), NOT an invalid Point batch
    assert.equal(batch1, null);

    // Case 2: Point first, Polygon second
    const rowsPointFirst = [
      { id: 1, geom: makeWkbPoint(10, 20) },
      { id: 2, geom: makeWkbPolygon(poly) },
    ];
    const batch2 = wkbRowsToGeoArrowBatch(rowsPointFirst, "geom");
    assert.equal(batch2, null);
  });

  it("handles conversion failures in createOptimizedVectorLayerData by falling back to GeoJSON-only (B1)", () => {
    const poly: [number, number][][] = [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
        [0, 0],
      ],
    ];
    const incompatibleRows = [
      { id: 1, geom: makeWkbPolygon(poly) },
      { id: 2, geom: makeWkbPoint(10, 20) },
    ];
    const result = createOptimizedVectorLayerData(incompatibleRows, "geom");
    assert.equal(result.geoarrow, undefined, "geoarrow must be undefined on conversion failure");
    assert.ok(result.geojson, "geojson must be preserved");
    assert.equal(result.geojson.features.length, 2);
    assert.equal(result.geojson.features[0].geometry?.type, "Polygon");
    assert.equal(result.geojson.features[1].geometry?.type, "Point");
  });

  it("decodeWkbRowsToFeatures extracts properties and decodes WKB rows directly into GeoJSON features", () => {
    const poly: [number, number][][] = [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
        [0, 0],
      ],
    ];
    const rows = [
      { id: 101, name: "Alpha", geom: makeWkbPolygon(poly) },
      { id: 102, name: "Beta", geom: makeWkbPoint(5, 15) },
    ];
    const features = decodeWkbRowsToFeatures(rows, "geom");
    assert.equal(features.length, 2);
    assert.equal(features[0].properties?.id, 101);
    assert.equal(features[0].properties?.name, "Alpha");
    assert.equal(features[0].geometry?.type, "Polygon");
    assert.equal(features[1].properties?.id, 102);
    assert.equal(features[1].properties?.name, "Beta");
    assert.equal(features[1].geometry?.type, "Point");
  });
});

describe("GeoArrow decoded feature preservation", () => {
  it("keeps empty polygon rings in the GeoJSON view", () => {
    const rows = [{ name: "empty ring", geom: makeWkbPolygon([[]]) }];
    const expected = decodeWkbRowsToFeatures(rows, "geom");
    const result = createOptimizedVectorLayerData(rows, "geom");
    assert.ok(result.geoarrow);
    assert.deepEqual(result.geojson.features, expected);
  });
});

describe("Point WKB dimensional headers", () => {
  it("keeps M out of Z and reads ISO ZM ordinates correctly", () => {
    const m = makeWkbPoint(10, 20, true, 99);
    new DataView(m.buffer).setUint32(1, 0x40000001, true);
    const zm = new Uint8Array(37);
    const view = new DataView(zm.buffer);
    view.setUint8(0, 1);
    view.setUint32(1, 3001, true);
    [30, 40, 50, 999].forEach((value, index) => view.setFloat64(5 + index * 8, value, true));
    const batch = wkbRowsToGeoArrowBatch([{ geom: m }, { geom: zm }], "geom");
    assert.ok(batch);
    assert.equal(batch.coordDimensions, 3);
    assert.deepEqual(Array.from(batch.coordinates), [10, 20, 0, 30, 40, 50]);
  });
});
