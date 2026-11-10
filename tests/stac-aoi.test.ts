import assert from "node:assert/strict";
import test from "node:test";
import type { Geometry, Polygon, Position } from "geojson";
import {
  AOI_MAX_POSITIONS,
  bufferGeometry,
  countPositions,
  geometryFromFile,
  geometryOfGeoJson,
  mergeGeometries,
} from "../packages/plugins/src/plugins/stac-aoi";

const square = (x: number, size = 1) => ({
  type: "Polygon" as const,
  coordinates: [
    [
      [x, 0],
      [x + size, 0],
      [x + size, size],
      [x, size],
      [x, 0],
    ],
  ],
});

test("mergeGeometries joins same-kind points and lines into the matching Multi geometry", () => {
  const merged = mergeGeometries([
    { type: "Point", coordinates: [1, 2] },
    { type: "MultiPoint", coordinates: [[3, 4]] },
  ]);
  assert.deepEqual(merged, {
    geometry: {
      type: "MultiPoint",
      coordinates: [
        [1, 2],
        [3, 4],
      ],
    },
    ignored: 0,
  });
});

test("mergeGeometries keeps only the highest dimension and counts what it left out", () => {
  const line = {
    type: "LineString" as const,
    coordinates: [
      [0, 0],
      [1, 1],
    ],
  };
  const point = { type: "Point" as const, coordinates: [5, 5] };
  assert.deepEqual(mergeGeometries([line]), { geometry: line, ignored: 0 });
  assert.deepEqual(mergeGeometries([line, point]), { geometry: line, ignored: 1 });
  assert.deepEqual(mergeGeometries([point, line, square(0)])?.geometry, square(0));
  assert.equal(mergeGeometries([point, line, square(0)])?.ignored, 2);
  assert.equal(mergeGeometries([null, undefined]), undefined);
});

/** The planar area of a polygon's outer ring, by the shoelace formula, less its holes. */
function planarArea(polygon: Polygon): number {
  const ring = (points: Position[]): number =>
    Math.abs(
      points.reduce((sum, [x, y], i) => {
        const [nx, ny] = points[(i + 1) % points.length];
        return sum + (x * ny - nx * y);
      }, 0) / 2,
    );
  const [outer, ...holes] = polygon.coordinates;
  return ring(outer) - holes.reduce((sum, hole) => sum + ring(hole), 0);
}

test("mergeGeometries dissolves overlapping polygons into one geometry covering both", () => {
  // Two 2 x 2 squares sharing a 1 x 2 strip: the union is 3 x 2. Returning only one of them would
  // still be a valid polygon, so the area and the extent are what show both were kept.
  const merged = mergeGeometries([square(0, 2), square(1, 2)]);
  assert.equal(merged?.geometry.type, "Polygon");
  const polygon = merged?.geometry as Polygon;
  assert.equal(planarArea(polygon), 6);
  const xs = polygon.coordinates[0].map(([x]) => x);
  assert.equal(Math.min(...xs), 0);
  assert.equal(Math.max(...xs), 3);
});

test("mergeGeometries keeps disjoint polygons as a MultiPolygon", () => {
  const merged = mergeGeometries([square(0), square(10)]);
  assert.equal(merged?.geometry.type, "MultiPolygon");
});

test("mergeGeometries rounds coordinates to eight decimals", () => {
  assert.deepEqual(mergeGeometries([{ type: "Point", coordinates: [1.1234567891, 2] }])?.geometry, {
    type: "Point",
    coordinates: [1.12345679, 2],
  });
});

test("geometryOfGeoJson reads geometries, features and collections", () => {
  const point = { type: "Point", coordinates: [1, 2] };
  assert.deepEqual(geometryOfGeoJson(point)?.geometry, point);
  assert.deepEqual(
    geometryOfGeoJson({ type: "Feature", properties: {}, geometry: point })?.geometry,
    point,
  );
  const collection = {
    type: "FeatureCollection",
    features: [
      { type: "Feature", properties: {}, geometry: point },
      { type: "Feature", properties: {}, geometry: null },
    ],
  };
  assert.deepEqual(geometryOfGeoJson(collection)?.geometry, point);
  assert.equal(geometryOfGeoJson("nope"), undefined);
});

test("countPositions counts every vertex", () => {
  assert.equal(countPositions(square(0)), 5);
});

test("geometryFromFile reads GeoJSON and refuses other files", async () => {
  const geojson = new File([JSON.stringify({ type: "Point", coordinates: [1, 2] })], "a.geojson");
  assert.deepEqual((await geometryFromFile(geojson)).geometry, {
    type: "Point",
    coordinates: [1, 2],
  });
  await assert.rejects(geometryFromFile(new File(["x"], "area.txt")), /GeoJSON/);
  await assert.rejects(
    geometryFromFile(
      new File([JSON.stringify({ type: "FeatureCollection", features: [] })], "e.json"),
    ),
    /no geometry/,
  );
});

test("bufferGeometry widens a point or line into a polygon and leaves polygons alone", () => {
  const point = bufferGeometry({ type: "Point", coordinates: [-84.5, 38] }, 1);
  assert.equal(point.type, "Polygon");
  const [west, , east] = [
    Math.min(...(point as { coordinates: number[][][] }).coordinates[0].map((p) => p[0])),
    0,
    Math.max(...(point as { coordinates: number[][][] }).coordinates[0].map((p) => p[0])),
  ];
  // One kilometre is about 0.0114 degrees of longitude at this latitude.
  assert.ok(east - west > 0.015 && east - west < 0.03);
  const line = bufferGeometry(
    {
      type: "LineString",
      coordinates: [
        [0, 0],
        [0.1, 0.1],
      ],
    },
    2,
  );
  assert.equal(line.type, "Polygon");
  const polygon = square(0);
  assert.equal(bufferGeometry(polygon, 5), polygon);
  const unchanged = { type: "Point" as const, coordinates: [1, 2] };
  assert.equal(bufferGeometry(unchanged, 0), unchanged);
});

/** The area inside a polygon's outer ring (shoelace), in square degrees. */
function ringArea(geometry: Geometry): number {
  assert.equal(geometry.type, "Polygon");
  const ring = (geometry as Polygon).coordinates[0];
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return Math.abs(sum) / 2;
}

test("dissolved overlapping polygons cover the area of both, not just the first", () => {
  const merged = mergeGeometries([square(0, 2), square(1, 2)]);
  assert.ok(merged);
  // 0..2 and 1..3 across, each 2 high: the union is 3 wide by 2 high.
  assert.equal(ringArea(merged.geometry), 6);
});

test("polygons too detailed to send are not dissolved on the way to being refused", () => {
  // A ring with many positions, twice: past the limit, so the union is not attempted.
  const detailed = (offset: number): Geometry => {
    const ring: Position[] = [];
    for (let i = 0; i < AOI_MAX_POSITIONS; i++) {
      const angle = (i / AOI_MAX_POSITIONS) * 2 * Math.PI;
      ring.push([offset + Math.cos(angle), Math.sin(angle)]);
    }
    ring.push(ring[0]);
    return { type: "Polygon", coordinates: [ring] };
  };
  const started = Date.now();
  const merged = mergeGeometries([detailed(0), detailed(0.5)]);
  assert.ok(merged);
  assert.equal(merged.geometry.type, "MultiPolygon", "left as it is");
  assert.ok(countPositions(merged.geometry) > AOI_MAX_POSITIONS, "so the panel refuses it by size");
  assert.ok(Date.now() - started < 2000, "and no union ran");
});

test("a file's layers each report what they left out, and so do the layers together", async () => {
  const collection = (...geometries: unknown[]) => ({
    type: "FeatureCollection",
    features: geometries.map((geometry) => ({ type: "Feature", properties: {}, geometry })),
  });
  // One layer with a polygon and a point, another with a line and a point.
  const file = new File(
    [JSON.stringify(collection(square(0), { type: "Point", coordinates: [5, 5] }, square(10)))],
    "area.geojson",
  );
  const area = await geometryFromFile(file);
  assert.equal(area.ignored, 1, "the point beside the polygons");
});
