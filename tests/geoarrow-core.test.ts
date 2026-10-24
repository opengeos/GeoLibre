import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeGeoArrowBBox,
  featureCollectionToGeoArrow,
  geoArrowToFeatureCollection,
  isGeoArrowBatch,
  shouldUseTiledRendering,
  type GeoArrowBatch,
} from "@geolibre/core";
import type { FeatureCollection, Polygon } from "geojson";

describe("GeoArrow core data structures and conversions", () => {
  it("validates GeoArrowBatch structures with isGeoArrowBatch", () => {
    assert.equal(isGeoArrowBatch(null), false);
    assert.equal(isGeoArrowBatch({}), false);
    assert.equal(isGeoArrowBatch({ geometryType: "Point" }), false);

    const validPointBatch: GeoArrowBatch = {
      geometryType: "Point",
      coordinates: new Float64Array([10, 20, 30, 40]),
      coordDimensions: 2,
      featureCount: 2,
    };
    assert.equal(isGeoArrowBatch(validPointBatch), true);

    const invalidCoords = {
      geometryType: "Point",
      coordinates: [10, 20],
      coordDimensions: 2,
      featureCount: 1,
    };
    assert.equal(isGeoArrowBatch(invalidCoords), false);

    const invalidOffsets = {
      ...validPointBatch,
      geomOffsets: [0, 1], // not Int32Array
    };
    assert.equal(isGeoArrowBatch(invalidOffsets), false);
  });

  it("computes accurate 2D bounding boxes in a single pass", () => {
    const batch: GeoArrowBatch = {
      geometryType: "Point",
      coordinates: new Float64Array([-122.4, 37.7, -122.2, 37.8, -122.5, 37.6]),
      coordDimensions: 2,
      featureCount: 3,
    };
    const bbox = computeGeoArrowBBox(batch);
    assert.deepEqual(bbox, [-122.5, 37.6, -122.2, 37.8]);

    // Handles empty coordinates
    assert.deepEqual(
      computeGeoArrowBBox({
        geometryType: "Point",
        coordinates: new Float64Array(0),
        coordDimensions: 2,
        featureCount: 0,
      }),
      [0, 0, 0, 0],
    );

    // Ignores NaNs and Infinities
    const withNans: GeoArrowBatch = {
      geometryType: "Point",
      coordinates: new Float64Array([NaN, Infinity, 10, 20, -Infinity, NaN]),
      coordDimensions: 2,
      featureCount: 3,
    };
    assert.deepEqual(computeGeoArrowBBox(withNans), [10, 20, 10, 20]);
  });

  it("converts GeoArrow Point batch to FeatureCollection losslessly", () => {
    const batch: GeoArrowBatch = {
      geometryType: "Point",
      coordinates: new Float64Array([1.5, 2.5, 3.5, 4.5]),
      coordDimensions: 2,
      featureCount: 2,
      featureIds: ["feat-1", 42],
      properties: [{ name: "Alpha", val: 100 }, { name: "Beta", val: null }],
    };

    const fc = geoArrowToFeatureCollection(batch);
    assert.equal(fc.type, "FeatureCollection");
    assert.equal(fc.features.length, 2);

    assert.equal(fc.features[0].id, "feat-1");
    assert.deepEqual(fc.features[0].properties, { name: "Alpha", val: 100 });
    assert.deepEqual(fc.features[0].geometry, { type: "Point", coordinates: [1.5, 2.5] });

    assert.equal(fc.features[1].id, 42);
    assert.deepEqual(fc.features[1].properties, { name: "Beta", val: null });
    assert.deepEqual(fc.features[1].geometry, { type: "Point", coordinates: [3.5, 4.5] });
  });

  it("converts GeoArrow 3D Point batch (XYZ) preserving elevation", () => {
    const batch: GeoArrowBatch = {
      geometryType: "Point",
      coordinates: new Float64Array([1.5, 2.5, 100.25, 3.5, 4.5, -50.5]),
      coordDimensions: 3,
      featureCount: 2,
    };

    const fc = geoArrowToFeatureCollection(batch);
    assert.deepEqual(fc.features[0].geometry, { type: "Point", coordinates: [1.5, 2.5, 100.25] });
    assert.deepEqual(fc.features[1].geometry, { type: "Point", coordinates: [3.5, 4.5, -50.5] });
  });

  it("converts GeoArrow LineString batch to FeatureCollection", () => {
    // 2 features:
    // feat 0: vertices 0..2 (3 points: (0,0), (1,1), (2,2))
    // feat 1: vertices 3..4 (2 points: (10,10), (20,20))
    const coordinates = new Float64Array([0, 0, 1, 1, 2, 2, 10, 10, 20, 20]);
    const geomOffsets = new Int32Array([0, 3, 5]);

    const batch: GeoArrowBatch = {
      geometryType: "LineString",
      coordinates,
      coordDimensions: 2,
      geomOffsets,
      featureCount: 2,
      properties: [{ road: "A1" }, { road: "B2" }],
    };

    const fc = geoArrowToFeatureCollection(batch);
    assert.equal(fc.features.length, 2);
    assert.deepEqual(fc.features[0].geometry, {
      type: "LineString",
      coordinates: [
        [0, 0],
        [1, 1],
        [2, 2],
      ],
    });
    assert.deepEqual(fc.features[1].geometry, {
      type: "LineString",
      coordinates: [
        [10, 10],
        [20, 20],
      ],
    });
  });

  it("converts GeoArrow Polygon batch with outer and inner rings (holes)", () => {
    // 1 polygon feature with 2 rings (outer 5 vertices, hole 5 vertices):
    // outer: (0,0), (10,0), (10,10), (0,10), (0,0)
    // hole:  (2,2), (4,2), (4,4), (2,4), (2,2)
    const coordinates = new Float64Array([
      0, 0, 10, 0, 10, 10, 0, 10, 0, 0,
      2, 2, 4, 2, 4, 4, 2, 4, 2, 2,
    ]);
    const ringOffsets = new Int32Array([0, 5, 10]); // 2 rings
    const geomOffsets = new Int32Array([0, 2]); // 1 polygon having 2 rings

    const batch: GeoArrowBatch = {
      geometryType: "Polygon",
      coordinates,
      coordDimensions: 2,
      geomOffsets,
      ringOffsets,
      featureCount: 1,
      properties: [{ name: "ParkWithLake" }],
    };

    const fc = geoArrowToFeatureCollection(batch);
    assert.equal(fc.features.length, 1);
    const geom = fc.features[0].geometry as Polygon;
    assert.equal(geom.type, "Polygon");
    assert.equal(geom.coordinates.length, 2); // 2 rings
    assert.deepEqual(geom.coordinates[0], [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ]);
    assert.deepEqual(geom.coordinates[1], [
      [2, 2],
      [4, 2],
      [4, 4],
      [2, 4],
      [2, 2],
    ]);
  });

  it("round-trips FeatureCollection to GeoArrow and back without loss", () => {
    const original: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          id: "pt-1",
          properties: { speed: 55, active: true, tag: "fast" },
          geometry: { type: "Point", coordinates: [-73.985, 40.748] },
        },
        {
          type: "Feature",
          id: "pt-2",
          properties: { speed: 30, active: false, tag: null },
          geometry: { type: "Point", coordinates: [-73.986, 40.749] },
        },
      ],
    };

    const batch = featureCollectionToGeoArrow(original);
    assert.ok(batch);
    assert.equal(batch.geometryType, "Point");
    assert.equal(batch.featureCount, 2);

    const roundTripped = geoArrowToFeatureCollection(batch);
    assert.equal(roundTripped.features.length, 2);
    assert.equal(roundTripped.features[0].id, "pt-1");
    assert.deepEqual(roundTripped.features[0].properties, original.features[0].properties);
    assert.deepEqual(roundTripped.features[0].geometry, original.features[0].geometry);

    assert.equal(roundTripped.features[1].id, "pt-2");
    assert.deepEqual(roundTripped.features[1].properties, original.features[1].properties);
    assert.deepEqual(roundTripped.features[1].geometry, original.features[1].geometry);
  });

  it("shouldUseTiledRendering seamlessly supports GeoArrowBatch", () => {
    const smallBatch: GeoArrowBatch = {
      geometryType: "Point",
      coordinates: new Float64Array(2000),
      coordDimensions: 2,
      featureCount: 1000,
    };
    assert.equal(shouldUseTiledRendering(smallBatch), false);

    const largeBatch: GeoArrowBatch = {
      geometryType: "Point",
      coordinates: new Float64Array(100_002 * 2),
      coordDimensions: 2,
      featureCount: 100_002,
    };
    assert.equal(shouldUseTiledRendering(largeBatch), true);

    // Existing GeoJSON support remains 100% intact
    const smallFc: FeatureCollection = { type: "FeatureCollection", features: new Array(50) };
    assert.equal(shouldUseTiledRendering(smallFc), false);
    const largeFc: FeatureCollection = { type: "FeatureCollection", features: new Array(60_000) };
    assert.equal(shouldUseTiledRendering(largeFc), true);
  });
});
