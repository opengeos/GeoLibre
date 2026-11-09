import assert from "node:assert/strict";
import test from "node:test";
import {
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

test("mergeGeometries dissolves overlapping polygons into one valid geometry", () => {
  const merged = mergeGeometries([square(0, 2), square(1, 2)]);
  assert.equal(merged?.geometry.type, "Polygon");
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
